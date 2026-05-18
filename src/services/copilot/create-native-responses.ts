/**
 * Native `/v1/responses` upstream client.
 *
 * Forwards a Responses-API payload to Copilot `/v1/responses` and returns
 * the raw upstream result (no Chat-Completions translation). Used by the
 * `/responses` and `/v1/responses` proxy endpoints so clients that natively
 * speak the Responses API can use this proxy directly.
 *
 * Shares model routing, multi-account rotation, header construction, and
 * max_output_tokens clamping with the Chat-side passthrough at
 * `~/routes/chat-completions/responses-passthrough.ts`.
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

import { fetchWithRetry, fetchWithTimeout } from "./create-chat-completions"

/**
 * Loose shape of a Responses-API request body. We intentionally don't
 * fully type `input` items — they pass through to upstream as-is.
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
  [k: string]: unknown
}

export type NativeResponsesResult =
  | { __isStream: true; stream: AsyncGenerator<ServerSentEventMessage> }
  | { __isStream?: false; json: unknown }

function detectAgentCall(input: Array<unknown>): boolean {
  for (const item of input) {
    if (!item || typeof item !== "object") continue
    const it = item as Record<string, unknown>
    if (it.type === "function_call" || it.type === "function_call_output") {
      return true
    }
    if (it.type === "message" && it.role === "assistant") return true
    if (!it.type && it.role === "assistant") return true
  }
  return false
}

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
 * Forward a Responses-shape payload to Copilot `/v1/responses` and return
 * the upstream result unchanged (other than streaming framing).
 */
export async function createNativeResponses(
  body: LooseResponsesPayload,
): Promise<NativeResponsesResult> {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const requestedModel = body.model
  const resolvedModel = modelRouter.resolveModel(requestedModel)
  if (resolvedModel !== requestedModel) {
    consola.debug(`Model routed: ${requestedModel} → ${resolvedModel}`)
  }

  const upstreamBody: LooseResponsesPayload = {
    ...body,
    model: resolvedModel,
  }

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
    return runWithAccountRotation<LooseResponsesPayload, NativeResponsesResult>(
      {
        label: "responses-native",
        payload: upstreamBody,
        transport: (p, tokenSource, accountId) =>
          doNativeFetch(p, { source: tokenSource, accountId }),
      },
    )
  }

  return doNativeFetch(upstreamBody, { source: state })
}

async function doNativeFetch(
  upstreamBody: LooseResponsesPayload,
  ctx: { source: TokenSource; accountId?: string },
): Promise<NativeResponsesResult> {
  const { source, accountId } = ctx
  const enableVision = detectVision(upstreamBody.input)
  const isAgentCall = detectAgentCall(upstreamBody.input)

  const buildHeaders = (): Record<string, string> => ({
    ...copilotHeaders(source, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
  })

  const url = `${copilotBaseUrl(source)}/v1/responses`
  const bodyString = JSON.stringify(upstreamBody)

  consola.debug("Sending request to Copilot (/v1/responses) [native]:", {
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
    consola.error("Failed /v1/responses request (native)", {
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
    const tagged = sse as AsyncGenerator<ServerSentEventMessage> & {
      __accountInfo?: StreamAccountInfo
    }
    tagged.__accountInfo = { apiBaseUrl: copilotBaseUrl(source) }
    return { __isStream: true, stream: tagged }
  }

  const jsonResult: unknown = await response.json()
  return { json: jsonResult }
}
