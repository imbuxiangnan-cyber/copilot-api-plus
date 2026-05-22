import type { Context } from "hono"
import type { SSEStreamingApi } from "hono/streaming"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import {
  overrideAnthropicResponseModel,
  overrideMessageStartEventModel,
} from "~/lib/anthropic-sanitizer"
import { isUnsupportedWebToolError } from "~/lib/anthropic-web-tools"
import { awaitApproval } from "~/lib/approval"
import {
  isAccountProxied,
  isProxyActive,
  resetConnections,
  type StreamAccountInfo,
} from "~/lib/proxy"
import { checkRateLimit } from "~/lib/rate-limit"
import { resolveAnthropicRoute } from "~/lib/route-resolver"
import { state } from "~/lib/state"
import {
  createAnthropicMessages,
  type AnthropicMessagesResult,
} from "~/services/copilot/create-anthropic-messages"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import type { AnthropicResponse } from "./anthropic-types"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
} from "./anthropic-types"
import { injectIntoAnthropicPayload } from "./inject-system-override"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { handleWebToolFallback } from "./proxy-web-fallback"
import {
  translateChunkToAnthropicEvents,
  translateErrorToAnthropicErrorEvent,
} from "./stream-translation"
import { stripSystemReminders } from "./strip-reminders"

// ---------------------------------------------------------------------------
// SSE heartbeat / upstream-timeout configuration
// ---------------------------------------------------------------------------

/** Heartbeat interval — keeps the downstream connection alive. */
const HEARTBEAT_PROXIED_MS = 10_000
const HEARTBEAT_DIRECT_MS = 30_000

/**
 * Upstream silence timeout — if no SSE data arrives for this long,
 * treat the upstream as dead and close the stream with an error.
 */
const UPSTREAM_TIMEOUT_PROXIED_MS = 90_000
const UPSTREAM_TIMEOUT_DIRECT_MS = 300_000

/** Sentinel value returned by the sleep branch of Promise.race. */
const HEARTBEAT = Symbol("heartbeat")

/** Simple non-cancellable sleep that resolves to a sentinel. */
function heartbeatDelay(ms: number): Promise<typeof HEARTBEAT> {
  return new Promise((resolve) => setTimeout(() => resolve(HEARTBEAT), ms))
}

// ---------------------------------------------------------------------------
// Streaming helpers
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function anthropicErrorPayload(error: unknown) {
  return {
    type: "error",
    error: {
      type: "api_error",
      message: errorMessage(error),
    },
  }
}

/** Send an error event to the downstream client, ignoring write failures. */
async function sendErrorEvent(
  stream: SSEStreamingApi,
  error?: unknown,
): Promise<void> {
  try {
    const errorEvent = translateErrorToAnthropicErrorEvent(
      error === undefined ? undefined : errorMessage(error),
    )
    await stream.writeSSE({
      event: errorEvent.type,
      data: JSON.stringify(errorEvent),
    })
  } catch {
    // Client already disconnected
  }
}

function handlePreStreamAnthropicError(
  c: Context,
  payload: AnthropicMessagesPayload,
  error: unknown,
): Response {
  if (payload.stream) {
    return streamSSE(c, async (stream) => {
      await sendErrorEvent(stream, error)
    })
  }
  return c.json(anthropicErrorPayload(error), 500)
}

/**
 * Consume the upstream SSE async iterator with heartbeat injection.
 *
 * Uses `Promise.race` between the next upstream event and a heartbeat
 * timer.  The same `iter.next()` promise is reused across heartbeat
 * cycles to prevent data loss.
 *
 * No external requests are made — heartbeat pings are written to the
 * downstream HTTP response only.
 */
async function consumeStreamWithHeartbeat(
  response: AsyncGenerator,
  stream: SSEStreamingApi,
  opts: {
    streamState: AnthropicStreamState
    heartbeatMs: number
    upstreamTimeoutMs: number
    abortSignal?: AbortSignal
  },
): Promise<void> {
  const { streamState, heartbeatMs, upstreamTimeoutMs, abortSignal } = opts
  const iter = response[Symbol.asyncIterator]()
  let pendingNext = iter.next()
  let lastDataAt = Date.now()

  try {
    while (true) {
      // Check if client disconnected
      if (abortSignal?.aborted) {
        consola.debug("Client disconnected, stopping SSE consumption")
        break
      }

      const raceResult = await Promise.race([
        pendingNext.then((r) => ({ kind: "data" as const, result: r })),
        heartbeatDelay(heartbeatMs),
      ])

      if (raceResult === HEARTBEAT) {
        const silenceMs = Date.now() - lastDataAt
        if (silenceMs >= upstreamTimeoutMs) {
          consola.warn(
            `Upstream silent for ${Math.round(silenceMs / 1000)}s (limit ${upstreamTimeoutMs / 1000}s), closing stream`,
          )
          resetConnections()
          await sendErrorEvent(stream, "Upstream stream timed out")
          break
        }

        // Anthropic-protocol ping — keeps downstream connection alive
        await stream.writeSSE({ event: "ping", data: '{"type":"ping"}' })
        consola.debug(
          `SSE heartbeat ping sent (silent ${Math.round(silenceMs / 1000)}s)`,
        )
        continue
      }

      // Data arrived from upstream
      const { result: iterResult } = raceResult
      if (iterResult.done) break

      lastDataAt = Date.now()
      // Create next promise AFTER consuming current value
      pendingNext = iter.next()

      const rawEvent = iterResult.value as { data?: string }
      if (rawEvent.data === "[DONE]") break
      if (!rawEvent.data) continue

      let chunk: ChatCompletionChunk
      try {
        chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      } catch {
        consola.debug("Skipping malformed SSE chunk")
        continue
      }

      for (const event of translateChunkToAnthropicEvents(chunk, streamState)) {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }
  } finally {
    // Explicitly close the upstream generator to release resources
    try {
      await iter.return(undefined)
    } catch {
      // Generator already closed or errored
    }
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()

  consola.debug("Anthropic request:", {
    model: anthropicPayload.model,
    stream: anthropicPayload.stream,
    thinking: anthropicPayload.thinking,
    tool_choice: anthropicPayload.tool_choice,
    tools_count: anthropicPayload.tools ? anthropicPayload.tools.length : 0,
    messages_count: anthropicPayload.messages.length,
    max_tokens: anthropicPayload.max_tokens,
  })

  if (state.manualApprove) {
    await awaitApproval()
  }

  const route = resolveAnthropicRoute(anthropicPayload.model)
  consola.debug(`Anthropic route resolved: ${route}`)

  if (route === "native-anthropic") {
    return handleNativePassthrough(c, anthropicPayload)
  }
  return handleTranslatedCompletion(c, anthropicPayload)
}

// ---------------------------------------------------------------------------
// Native passthrough — forward Anthropic events directly
// ---------------------------------------------------------------------------

async function handleNativePassthrough(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
): Promise<Response> {
  const anthropicBeta = c.req.header("anthropic-beta")
  const sanitized = injectIntoAnthropicPayload(
    stripSystemReminders(anthropicPayload),
  )

  let result: AnthropicMessagesResult
  try {
    result = await createAnthropicMessages(sanitized, { anthropicBeta })
  } catch (error) {
    const message = (error as Error).message || String(error)
    // Vertex AI org policy violation: Copilot load-balances /v1/messages
    // between Vertex and Anthropic-direct backends. Vertex's GCP project
    // doesn't allow structured_outputs (which Vertex synthesizes from
    // Anthropic tools), so requests routed there fail. The next request
    // usually lands on Anthropic-direct. We retry once transparently
    // — still direct, still Anthropic protocol, no translation.
    if (
      /vertexai\.allowedPartnerModelFeatures.*?structured_outputs/i.test(
        message,
      )
    ) {
      consola.debug(
        `Native /v1/messages: Vertex GCP policy 400, retrying once (Copilot will likely route to Anthropic-direct)`,
      )
      try {
        result = await createAnthropicMessages(sanitized, { anthropicBeta })
      } catch (retryError) {
        const retryMessage = (retryError as Error).message || String(retryError)
        consola.warn(
          `Native /v1/messages: Vertex GCP policy 400 on both attempts, propagating to client: ${retryMessage}`,
        )
        return handlePreStreamAnthropicError(c, anthropicPayload, retryError)
      }
    } else {
      // Copilot rejects Anthropic server-side WebSearch/WebFetch with
      // "The use of the web search tool is not supported." Run the
      // zero-config proxy fallback (DuckDuckGo HTML + direct fetch)
      // instead of propagating the error to the client.
      if (await isUnsupportedWebToolError(anthropicPayload, error)) {
        consola.warn(
          `Native /v1/messages: Copilot rejected WebSearch/WebFetch — switching to proxy fallback`,
        )
        try {
          return await handleWebToolFallback(c, anthropicPayload)
        } catch (fallbackError) {
          consola.warn(
            `Proxy web fallback failed: ${(fallbackError as Error).message || String(fallbackError)}`,
          )
          return handlePreStreamAnthropicError(
            c,
            anthropicPayload,
            fallbackError,
          )
        }
      }
      consola.warn(`Native /v1/messages failed: ${message}`)
      return handlePreStreamAnthropicError(c, anthropicPayload, error)
    }
  }

  if (!anthropicPayload.stream) {
    return c.json(
      overrideAnthropicResponseModel(
        result as AnthropicResponse,
        anthropicPayload.model,
      ),
    )
  }

  const stream = result as AsyncGenerator & {
    __accountInfo?: StreamAccountInfo
  }
  const accountInfo = stream.__accountInfo
  const proxied =
    accountInfo ? isAccountProxied(accountInfo.accountProxy) : isProxyActive()

  const heartbeatMs = proxied ? HEARTBEAT_PROXIED_MS : HEARTBEAT_DIRECT_MS
  const upstreamTimeoutMs =
    proxied ? UPSTREAM_TIMEOUT_PROXIED_MS : UPSTREAM_TIMEOUT_DIRECT_MS

  consola.debug(
    `Native SSE config: proxied=${proxied}, heartbeat=${heartbeatMs / 1000}s, timeout=${upstreamTimeoutMs / 1000}s`,
  )

  return streamSSE(c, async (sse) => {
    const abortController = new AbortController()
    sse.onAbort(() => abortController.abort())

    try {
      await consumeNativeStreamWithHeartbeat(stream, sse, {
        heartbeatMs,
        upstreamTimeoutMs,
        abortSignal: abortController.signal,
        requestedModel: anthropicPayload.model,
      })
    } catch (error) {
      if (!abortController.signal.aborted) {
        const message = (error as Error).message || String(error)
        consola.warn(`Native SSE stream interrupted: ${message}`)
        resetConnections()
        await sendErrorEvent(sse, error)
      }
    }
  })
}

/** Resolve the Anthropic event type for a raw SSE frame. */
function resolveAnthropicEventType(rawEvent: {
  event?: string
  data?: string
}): string | undefined {
  if (rawEvent.event) return rawEvent.event
  if (!rawEvent.data) return undefined
  try {
    return (JSON.parse(rawEvent.data) as { type?: string }).type
  } catch {
    return undefined
  }
}

/** Result of processing a single tick of the native stream loop. */
type NativeTickResult =
  | { action: "continue" }
  | { action: "break" }
  | { action: "data"; iterResult: IteratorResult<unknown> }

async function handleNativeHeartbeatTick(
  stream: SSEStreamingApi,
  silenceMs: number,
  upstreamTimeoutMs: number,
): Promise<NativeTickResult> {
  if (silenceMs >= upstreamTimeoutMs) {
    consola.warn(
      `Upstream silent for ${Math.round(silenceMs / 1000)}s (limit ${upstreamTimeoutMs / 1000}s), closing native stream`,
    )
    resetConnections()
    await sendErrorEvent(stream, "Upstream stream timed out")
    return { action: "break" }
  }
  await stream.writeSSE({ event: "ping", data: '{"type":"ping"}' })
  return { action: "continue" }
}

/** Forward one native event; returns true if it was `message_stop`. */
async function forwardNativeEvent(
  stream: SSEStreamingApi,
  rawEvent: { event?: string; data?: string },
  requestedModel?: string,
): Promise<{ forwarded: boolean; isMessageStop: boolean }> {
  if (rawEvent.data === "[DONE]")
    return { forwarded: false, isMessageStop: false }
  if (!rawEvent.data) return { forwarded: true, isMessageStop: false }

  const eventType = resolveAnthropicEventType(rawEvent)
  if (!eventType) {
    consola.debug("Skipping native SSE chunk with no resolvable type")
    return { forwarded: true, isMessageStop: false }
  }

  const dataToSend =
    eventType === "message_start" && requestedModel ?
      overrideMessageStartEventModel(rawEvent.data, requestedModel)
    : rawEvent.data

  await stream.writeSSE({ event: eventType, data: dataToSend })
  return { forwarded: true, isMessageStop: eventType === "message_stop" }
}

/**
 * Consume an upstream Anthropic SSE generator and forward events untouched.
 * Heartbeat and upstream-timeout logic mirrors the translated path.
 */
async function consumeNativeStreamWithHeartbeat(
  response: AsyncGenerator,
  stream: SSEStreamingApi,
  opts: {
    heartbeatMs: number
    upstreamTimeoutMs: number
    abortSignal?: AbortSignal
    requestedModel?: string
  },
): Promise<void> {
  const { heartbeatMs, upstreamTimeoutMs, abortSignal, requestedModel } = opts
  const iter = response[Symbol.asyncIterator]()
  let pendingNext = iter.next()
  let lastDataAt = Date.now()
  let sawMessageStop = false

  try {
    while (true) {
      if (abortSignal?.aborted) {
        consola.debug("Client disconnected, stopping native SSE consumption")
        break
      }

      const raceResult = await Promise.race([
        pendingNext.then((r) => ({ kind: "data" as const, result: r })),
        heartbeatDelay(heartbeatMs),
      ])

      if (raceResult === HEARTBEAT) {
        const tick = await handleNativeHeartbeatTick(
          stream,
          Date.now() - lastDataAt,
          upstreamTimeoutMs,
        )
        if (tick.action === "break") break
        continue
      }

      const { result: iterResult } = raceResult
      if (iterResult.done) break

      lastDataAt = Date.now()
      pendingNext = iter.next()

      const rawEvent = iterResult.value as { event?: string; data?: string }
      const result = await forwardNativeEvent(stream, rawEvent, requestedModel)
      if (!result.forwarded) break
      if (result.isMessageStop) sawMessageStop = true
    }

    // Synthesize message_stop if upstream closed without one — many
    // Anthropic clients hang waiting for it.
    if (!sawMessageStop && !abortSignal?.aborted) {
      try {
        await stream.writeSSE({
          event: "message_stop",
          data: '{"type":"message_stop"}',
        })
      } catch {
        // client gone
      }
    }
  } finally {
    try {
      await iter.return(undefined)
    } catch {
      // already closed
    }
  }
}

// ---------------------------------------------------------------------------
// Translated path (existing OpenAI chat-completions translation)
// ---------------------------------------------------------------------------

async function handleTranslatedCompletion(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
): Promise<Response> {
  const openAIPayload = translateToOpenAI(
    injectIntoAnthropicPayload(stripSystemReminders(anthropicPayload)),
  )

  let response: Awaited<ReturnType<typeof createChatCompletions>>
  try {
    response = await createChatCompletions(openAIPayload)
  } catch (error) {
    consola.warn(
      `Translated /v1/messages failed before stream start: ${errorMessage(error)}`,
    )
    return handlePreStreamAnthropicError(c, anthropicPayload, error)
  }

  if (isNonStreaming(response)) {
    return c.json(translateToAnthropic(response))
  }

  // Determine whether this stream goes through a proxy — affects
  // heartbeat interval and upstream timeout aggressiveness.
  const accountInfo = (
    response as AsyncGenerator & {
      __accountInfo?: StreamAccountInfo
    }
  ).__accountInfo
  const proxied =
    accountInfo ? isAccountProxied(accountInfo.accountProxy) : isProxyActive()

  const heartbeatMs = proxied ? HEARTBEAT_PROXIED_MS : HEARTBEAT_DIRECT_MS
  const upstreamTimeoutMs =
    proxied ? UPSTREAM_TIMEOUT_PROXIED_MS : UPSTREAM_TIMEOUT_DIRECT_MS

  consola.debug(
    `SSE stream config: proxied=${proxied}, heartbeat=${heartbeatMs / 1000}s, timeout=${upstreamTimeoutMs / 1000}s`,
  )

  return streamSSE(c, async (stream) => {
    // Detect client disconnect via AbortController
    const abortController = new AbortController()
    stream.onAbort(() => {
      abortController.abort()
    })

    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
      thinkingRequested: Boolean(anthropicPayload.thinking),
    }

    try {
      await consumeStreamWithHeartbeat(response, stream, {
        streamState,
        heartbeatMs,
        upstreamTimeoutMs,
        abortSignal: abortController.signal,
      })
    } catch (error) {
      // Only log and send error if client is still connected
      if (!abortController.signal.aborted) {
        const message = (error as Error).message || String(error)
        consola.warn(`SSE stream interrupted: ${message}`)
        resetConnections()
        await sendErrorEvent(stream, error)
      }
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
