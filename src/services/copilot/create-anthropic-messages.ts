/**
 * Native Copilot `/v1/messages` passthrough.
 *
 * Shares model slots, account rotation and cancellable transport with the
 * Chat and Responses clients, but forwards the Anthropic
 * payload as-is to the native Copilot endpoint instead of translating it
 * through OpenAI chat-completions.
 *
 * Returns either:
 *   - non-streaming JSON `AnthropicResponse`
 *   - an SSE async-iterator that yields raw upstream events (already in
 *     Anthropic event shape — no translation)
 */

import consola from "consola"
import { events } from "fetch-event-stream"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicToolResultBlock,
  AnthropicUserContentBlock,
} from "~/routes/messages/anthropic-types"

import { accountManager } from "~/lib/account-manager"
import { runWithAccountRotation } from "~/lib/account-rotation"
import {
  injectMaxThinkingBudget,
  isInvalidThinkingSignatureError,
  normalizeAdaptiveThinkingForCopilot,
  sanitizeForCopilotBackend,
  stripAssistantThinkingBlocks,
} from "~/lib/anthropic-sanitizer"
import {
  copilotBaseUrl,
  copilotHeaders,
  type TokenSource,
} from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { modelRouter } from "~/lib/model-router"
import { runWithModelSlot } from "~/lib/model-slot"
import { type StreamAccountInfo } from "~/lib/proxy"
import { state } from "~/lib/state"
import { refreshCopilotToken } from "~/lib/token"
import { fetchWithTimeout } from "~/lib/upstream-fetch"
import { rootCause } from "~/lib/utils"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AnthropicMessagesResult =
  | AnthropicResponse
  | (AsyncGenerator & { __accountInfo?: StreamAccountInfo })

interface CreateOptions {
  /** Forwarded as the `anthropic-beta` request header (e.g. for prompt caching). */
  anthropicBeta?: string
  /** Optional abort signal forwarded to fetch. */
  signal?: AbortSignal
  /** Already mapped by the route handler; do not apply mapping twice. */
  resolvedModel?: string
}

// ---------------------------------------------------------------------------
// Header construction
// ---------------------------------------------------------------------------

function messageContainsVisionInput(
  message: AnthropicMessagesPayload["messages"][number],
): boolean {
  if (message.role !== "user" || !Array.isArray(message.content)) return false
  return message.content.some(
    (block) =>
      block.type === "image"
      || (block.type === "tool_result" && toolResultContainsImage(block)),
  )
}

function toolResultContainsImage(block: AnthropicToolResultBlock): boolean {
  if (!Array.isArray(block.content)) return false
  return (block.content as Array<AnthropicUserContentBlock>).some(
    (contentBlock) => contentBlock.type === "image",
  )
}

function messageContinuesAgentLoop(
  message: AnthropicMessagesPayload["messages"][number],
): boolean {
  if (message.role === "assistant") return true
  if (!Array.isArray(message.content)) return false
  return message.content.some(
    (block): block is AnthropicToolResultBlock => block.type === "tool_result",
  )
}

function buildAnthropicHeaders(
  payload: AnthropicMessagesPayload,
  source: TokenSource,
  options?: CreateOptions,
): Record<string, string> {
  const enableVision = payload.messages.some((m) =>
    messageContainsVisionInput(m),
  )
  const isAgentCall = payload.messages.some((m) => messageContinuesAgentLoop(m))

  return {
    ...copilotHeaders(source, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
    ...(options?.anthropicBeta ?
      { "anthropic-beta": options.anthropicBeta }
    : {}),
  }
}

// ---------------------------------------------------------------------------
// Public entry — sanitizes, dispatches, and self-heals signature errors
// ---------------------------------------------------------------------------

export async function createAnthropicMessages(
  payload: AnthropicMessagesPayload,
  options?: CreateOptions,
): Promise<AnthropicMessagesResult> {
  const resolvedModel =
    options?.resolvedModel ?? modelRouter.resolveModel(payload.model)
  const mappedPayload = { ...payload, model: resolvedModel }

  // Default to maximum thinking budget when the client did not specify one.
  // Adaptive-thinking models get { type: "adaptive" }; others get the
  // model's max_thinking_budget. Existing client preference is respected.
  injectMaxThinkingBudget(mappedPayload)

  // Proactively strip assistant thinking/redacted_thinking blocks from
  // history. Copilot's Vertex backend (req_vrtx_*) rejects replayed
  // thinking signatures across requests, so any multi-turn conversation
  // would otherwise hit a 400 + signature-retry on every request. We
  // strip up-front to skip that round trip.
  //
  // The `try/catch` block below still keeps the retry as a safety net for
  // any future / non-Vertex backend that might surface the same error
  // through a different code path.
  const preStripped = stripAssistantThinkingBlocks(mappedPayload)
  let workingPayload = mappedPayload
  if (preStripped.stripped) {
    consola.debug(
      `Pre-stripped ${preStripped.strippedBlocks} assistant thinking block(s) from history (Copilot/Vertex does not accept replay)`,
    )
    workingPayload = preStripped.payload
  }

  // Surgical strip of fields the Copilot backend rejects.
  // Mutates the payload in place — safe because the handler clones via
  // stripSystemReminders before passing it down.
  sanitizeForCopilotBackend(workingPayload)
  normalizeAdaptiveThinkingForCopilot(workingPayload)

  return runWithModelSlot(
    resolvedModel,
    async () => {
      try {
        return await dispatchAnthropicRequest(workingPayload, options)
      } catch (error) {
        options?.signal?.throwIfAborted()
        if (!(await isInvalidThinkingSignatureError(error))) throw error

        const stripped = stripAssistantThinkingBlocks(workingPayload)
        if (!stripped.stripped) throw error

        const droppedSuffix =
          stripped.droppedAssistantMessages > 0 ?
            ` and dropping ${stripped.droppedAssistantMessages} thinking-only assistant turn(s)`
          : ""
        consola.warn(
          `Native /v1/messages signature retry: stripped ${stripped.strippedBlocks} thinking block(s)${droppedSuffix}`,
        )
        return await dispatchAnthropicRequest(stripped.payload, options)
      }
    },
    (result) => (Symbol.asyncIterator in result ? result : undefined),
    options?.signal,
  )
}

async function dispatchAnthropicRequest(
  payload: AnthropicMessagesPayload,
  options?: CreateOptions,
): Promise<AnthropicMessagesResult> {
  if (state.multiAccountEnabled && accountManager.hasAccounts()) {
    return runWithAccountRotation<
      AnthropicMessagesPayload,
      AnthropicMessagesResult
    >({
      label: "native-anthropic",
      payload,
      signal: options?.signal,
      transport: (request, source, accountId) =>
        doFetchAnthropic({ payload: request, source, accountId, options }),
    })
  }
  return createWithSingleAccount(payload, options)
}

// ---------------------------------------------------------------------------
// Single-account path
// ---------------------------------------------------------------------------

async function createWithSingleAccount(
  payload: AnthropicMessagesPayload,
  options?: CreateOptions,
): Promise<AnthropicMessagesResult> {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const url = `${copilotBaseUrl(state)}/v1/messages`
  const buildHeaders = () => buildAnthropicHeaders(payload, state, options)
  const bodyString = JSON.stringify(payload)

  consola.debug("Sending request to Copilot (native Anthropic):", {
    model: payload.model,
    endpoint: url,
    stream: payload.stream,
  })

  let response = await fetchWithTimeout(url, {
    method: "POST",
    headers: buildHeaders(),
    body: bodyString,
    signal: options?.signal,
  })

  if (response.status === 401) {
    options?.signal?.throwIfAborted()
    consola.warn("Copilot token expired, refreshing and retrying...")
    try {
      await refreshCopilotToken(options?.signal)
      response = await fetchWithTimeout(url, {
        method: "POST",
        headers: buildHeaders(),
        body: bodyString,
        signal: options?.signal,
      })
    } catch (refreshError) {
      options?.signal?.throwIfAborted()
      consola.warn(`Failed to refresh token: ${rootCause(refreshError)}`)
      consola.debug("Failed to refresh token:", refreshError)
    }
  }

  if (!response.ok) {
    await throwUpstreamError(response)
  }

  if (payload.stream) {
    const gen = events(response) as AsyncGenerator & {
      __accountInfo?: StreamAccountInfo
    }
    gen.__accountInfo = { apiBaseUrl: copilotBaseUrl(state) }
    return gen
  }

  return (await response.json()) as AnthropicResponse
}

// ---------------------------------------------------------------------------
// Multi-account transport used by the shared rotation helper
// ---------------------------------------------------------------------------

interface FetchContext {
  payload: AnthropicMessagesPayload
  source: TokenSource
  accountId: string
  options?: CreateOptions
}

// ---------------------------------------------------------------------------
// Shared upstream fetch + error throw
// ---------------------------------------------------------------------------

async function doFetchAnthropic(
  ctx: FetchContext,
): Promise<AnthropicMessagesResult> {
  const { payload, source, accountId, options } = ctx
  if (!source.copilotToken) throw new Error("Copilot token not found")
  const url = `${copilotBaseUrl(source)}/v1/messages`
  const bodyString = JSON.stringify(payload)

  consola.debug(
    "Sending request to Copilot (multi-account, native Anthropic):",
    {
      model: payload.model,
      endpoint: url,
      stream: payload.stream,
    },
  )

  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: buildAnthropicHeaders(payload, source, options),
      body: bodyString,
      signal: options?.signal,
    },
    { accountId, accountProxy: source.proxy },
  )

  if (!response.ok) {
    await throwUpstreamError(response)
  }

  if (payload.stream) {
    return events(response) as AsyncGenerator
  }
  return (await response.json()) as AnthropicResponse
}

async function throwUpstreamError(response: Response): Promise<never> {
  const errorBody = await response.text()
  if (response.status === 400) {
    consola.debug(`/v1/messages 400: ${errorBody}`)
  } else {
    consola.error("Failed native Anthropic request", {
      status: response.status,
      statusText: response.statusText,
      body: errorBody,
    })
  }
  const error = new HTTPError(
    `Failed to call /v1/messages: ${response.status} ${errorBody}`,
    response,
  )
  if (
    response.status >= 400
    && response.status < 500
    && ![401, 403, 429].includes(response.status)
  ) {
    ;(error as HTTPError & { __nonAccountError?: boolean }).__nonAccountError =
      true
  }
  throw error
}
