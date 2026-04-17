import type { Context } from "hono"
import type { SSEStreamingApi } from "hono/streaming"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import {
  isAccountProxied,
  isProxyActive,
  resetConnections,
  type StreamAccountInfo,
} from "~/lib/proxy"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import {
  translateChunkToAnthropicEvents,
  translateErrorToAnthropicErrorEvent,
} from "./stream-translation"

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

/** Send an error event to the downstream client, ignoring write failures. */
async function sendErrorEvent(stream: SSEStreamingApi): Promise<void> {
  try {
    const errorEvent = translateErrorToAnthropicErrorEvent()
    await stream.writeSSE({
      event: errorEvent.type,
      data: JSON.stringify(errorEvent),
    })
  } catch {
    // Client already disconnected
  }
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
          await sendErrorEvent(stream)
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

  const openAIPayload = translateToOpenAI(anthropicPayload)

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createChatCompletions(openAIPayload)

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
        await sendErrorEvent(stream)
      }
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
