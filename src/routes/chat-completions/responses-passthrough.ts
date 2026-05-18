/**
 * Responses-shape passthrough for `/chat/completions`.
 *
 * Background: some clients (Cursor 1.x, ...) POST OpenAI **Responses API**
 * payloads (`input` array, `reasoning`, `text`, etc.) to the
 * `/chat/completions` endpoint instead of `/v1/responses`. The Chat
 * Completions pipeline expects `messages: []` and crashes with
 * `Cannot read properties of undefined (reading 'some')` on those bodies.
 *
 * This module detects that shape and forwards the request straight to
 * Copilot's `/v1/responses` upstream, then translates the upstream reply
 * back into Chat-Completions chunks (reusing
 * `responsesToChatResponse` / `responsesStreamToChatChunks`), so the
 * client sees the response format it expects on `/chat/completions`.
 *
 * Scope: single-account path. Multi-account routing for this passthrough
 * can be added later if needed.
 */

import consola from "consola"
import { events, type ServerSentEventMessage } from "fetch-event-stream"

import { accountManager } from "~/lib/account-manager"
import { runWithAccountRotation } from "~/lib/account-rotation"
import {
  copilotBaseUrl,
  copilotHeaders,
  type TokenSource,
} from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { modelRouter } from "~/lib/model-router"
import { type StreamAccountInfo } from "~/lib/proxy"
import { state } from "~/lib/state"
import { refreshCopilotToken } from "~/lib/token"
import {
  fetchWithRetry,
  fetchWithTimeout,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import {
  responsesStreamToChatChunks,
  responsesToChatResponse,
  type ResponsesPayload,
  type ResponsesResponse,
} from "~/services/copilot/responses-translator"

/**
 * Loose shape of a body that *looks like* a Responses API request.
 * We intentionally don't fully type `input` items — they pass through
 * to upstream as-is.
 */
export interface LooseResponsesPayload {
  model: string
  input: Array<unknown>
  stream?: boolean
  tools?: Array<unknown>
  reasoning?: unknown
  text?: unknown
  instructions?: unknown
  tool_choice?: unknown
  max_output_tokens?: unknown
  temperature?: unknown
  top_p?: unknown
  parallel_tool_calls?: unknown
  store?: unknown
  // any other fields are forwarded
  [k: string]: unknown
}

/**
 * Detect a Responses-API-shaped body: has `input` array but no `messages`.
 * Conservative — only triggers when `input` is a real array.
 */
export function isResponsesShape(body: unknown): body is LooseResponsesPayload {
  if (!body || typeof body !== "object") return false
  const b = body as Record<string, unknown>
  if (!Array.isArray(b.input)) return false
  // If both shapes are present, prefer the Chat pipeline (don't hijack).
  if (Array.isArray(b.messages)) return false
  return typeof b.model === "string"
}

/**
 * Determine `X-Initiator` value from a Responses-shape `input` array.
 * Mirrors the Chat-completions logic (`assistant` / `tool` role ⇒ agent),
 * but inspects Responses-API item types instead of Chat message roles.
 */
function detectAgentCall(input: Array<unknown>): boolean {
  for (const item of input) {
    if (!item || typeof item !== "object") continue
    const it = item as Record<string, unknown>
    // function_call / function_call_output are conversation continuations
    // initiated by the assistant — agent traffic.
    if (it.type === "function_call" || it.type === "function_call_output") {
      return true
    }
    if (it.type === "message" && it.role === "assistant") return true
    // Some clients send {role: "assistant", ...} without an explicit type.
    if (!it.type && it.role === "assistant") return true
  }
  return false
}

/**
 * Detect whether the input contains an `input_image` content part anywhere,
 * which controls the `Copilot-Vision-Request` header.
 */
function detectVision(input: Array<unknown>): boolean {
  for (const item of input) {
    if (!item || typeof item !== "object") continue
    const it = item as Record<string, unknown>
    if (it.type !== "message" && it.type !== undefined) continue
    const content = it.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (
        part
        && typeof part === "object"
        && (part as Record<string, unknown>).type === "input_image"
      ) {
        return true
      }
    }
  }
  return false
}

/**
 * Forward a Responses-shape payload to Copilot `/v1/responses`, then
 * translate the reply back into a Chat-Completions response (or chunk
 * stream). The caller's `/chat/completions` clients see exactly the
 * format they expect.
 *
 * Multi-account mode: when enabled, the same rotation/breaker/jitter logic
 * used by the Chat path is applied via `runWithAccountRotation` so the
 * Responses passthrough fails over identically.
 */
export async function forwardResponsesAsChat(
  body: LooseResponsesPayload,
): Promise<AsyncGenerator<ServerSentEventMessage> | ChatCompletionResponse> {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  // Apply model routing (same as the chat-completions path).
  const requestedModel = body.model
  const resolvedModel = modelRouter.resolveModel(requestedModel)
  if (resolvedModel !== requestedModel) {
    consola.debug(`Model routed: ${requestedModel} → ${resolvedModel}`)
  }

  const upstreamBody: LooseResponsesPayload = {
    ...body,
    model: resolvedModel,
  }

  // Copilot `/v1/responses` rejects max_output_tokens < 16. Clamp values
  // up (or drop non-positive ones) so token-counting pings don't 400.
  if (typeof upstreamBody.max_output_tokens === "number") {
    if (upstreamBody.max_output_tokens > 0) {
      upstreamBody.max_output_tokens = Math.max(
        upstreamBody.max_output_tokens,
        16,
      )
    } else {
      delete upstreamBody.max_output_tokens
    }
  }

  if (state.multiAccountEnabled && accountManager.hasAccounts()) {
    return runWithAccountRotation<
      LooseResponsesPayload,
      AsyncGenerator<ServerSentEventMessage> | ChatCompletionResponse
    >({
      label: "responses-passthrough",
      payload: upstreamBody,
      transport: (p, tokenSource, accountId) =>
        doResponsesFetch(p, requestedModel, { source: tokenSource, accountId }),
      // No `on400` hook: the Chat-specific reasoning_effort 400 retries
      // don't translate to Responses-shape errors (`reasoning: {effort}`
      // is a different field; upstream returns different messages).
      // Non-account 400s are still handled by the generic isNonAccountError.
    })
  }

  return doResponsesFetch(upstreamBody, requestedModel, { source: state })
}

/**
 * Execute one POST to Copilot `/v1/responses` against a given token source.
 * Single-account mode passes `state`; multi-account passes per-account
 * `TokenSource` from the rotation helper.
 *
 * On 401 we attempt a token refresh — for single-account mode that means
 * calling `refreshCopilotToken()` (legacy state-bound refresh). The
 * multi-account path lets the rotation helper handle 401 via its generic
 * `tryRefreshAndRetry`, so a 401 here will just propagate up.
 */
async function doResponsesFetch(
  upstreamBody: LooseResponsesPayload,
  requestedModel: string,
  ctx: { source: TokenSource; accountId?: string },
): Promise<AsyncGenerator<ServerSentEventMessage> | ChatCompletionResponse> {
  const { source, accountId } = ctx
  const enableVision = detectVision(upstreamBody.input)
  const isAgentCall = detectAgentCall(upstreamBody.input)

  const buildHeaders = (): Record<string, string> => ({
    ...copilotHeaders(source, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
  })

  const url = `${copilotBaseUrl(source)}/v1/responses`
  const bodyString = JSON.stringify(upstreamBody as unknown as ResponsesPayload)

  consola.debug("Sending request to Copilot (/v1/responses) [passthrough]:", {
    model: upstreamBody.model,
    endpoint: url,
    stream: upstreamBody.stream,
    accountId: accountId ?? "single-account",
  })

  let response = await fetchWithRetry(
    url,
    () => ({
      method: "POST",
      headers: buildHeaders(),
      body: bodyString,
    }),
    { accountId, accountProxy: source.proxy },
  )

  // Single-account mode handles 401 via the legacy state-bound refresh.
  // In multi-account mode, the rotation helper handles 401 (so accountId
  // is set), and we should NOT call refreshCopilotToken (which only knows
  // about `state.copilotToken`) — let the error propagate.
  if (response.status === 401 && !accountId) {
    consola.warn("Copilot token expired, refreshing and retrying...")
    try {
      await refreshCopilotToken()
      response = await fetchWithTimeout(url, {
        method: "POST",
        headers: buildHeaders(),
        body: bodyString,
      })
    } catch {
      // fall through
    }
  }

  if (!response.ok) {
    const errorBody = await response.text()
    consola.error("Failed /v1/responses request (passthrough)", {
      status: response.status,
      statusText: response.statusText,
      body: errorBody,
    })
    throw new HTTPError(
      `Failed to call /v1/responses: ${response.status} ${errorBody}`,
      response,
    )
  }

  if (upstreamBody.stream) {
    const sse = events(response)
    const translated = responsesStreamToChatChunks(
      sse,
      requestedModel,
    ) as AsyncGenerator<ServerSentEventMessage> & {
      __accountInfo?: StreamAccountInfo
    }
    // Default tag (single-account); the rotation helper overwrites this
    // with the per-account info when applicable.
    translated.__accountInfo = { apiBaseUrl: copilotBaseUrl(source) }
    return translated
  }

  const responsesResult = (await response.json()) as ResponsesResponse
  return responsesToChatResponse(responsesResult, requestedModel)
}
