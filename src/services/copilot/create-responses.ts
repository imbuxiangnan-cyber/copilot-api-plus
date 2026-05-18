/**
 * Copilot `/v1/responses` client.
 *
 * Some Copilot models (gpt-5.5 and likely future reasoning-only models)
 * are only accessible via the OpenAI Responses API. This module accepts a
 * Chat Completions payload, translates it to Responses, calls Copilot,
 * and translates the result back so the caller never sees the difference.
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
import { type StreamAccountInfo } from "~/lib/proxy"
import { state } from "~/lib/state"
import { refreshCopilotToken } from "~/lib/token"

import {
  fetchWithRetry,
  fetchWithTimeout,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "./create-chat-completions"
import {
  chatToResponsesPayload,
  responsesStreamToChatChunks,
  responsesToChatResponse,
  type ResponsesResponse,
} from "./responses-translator"

/**
 * Call Copilot's `/v1/responses` with a Chat Completions payload and
 * return either a Chat-style response or an SSE generator that yields
 * already-translated Chat Completion chunks (one per `data:` line).
 *
 * Currently only supports single-account mode. Multi-account routing
 * for Responses-only models can be added in a follow-up if needed.
 */
export async function createResponsesAsChat(
  payload: ChatCompletionsPayload,
): Promise<AsyncGenerator<ServerSentEventMessage> | ChatCompletionResponse> {
  if (state.multiAccountEnabled && accountManager.hasAccounts()) {
    return runWithAccountRotation<
      ChatCompletionsPayload,
      AsyncGenerator<ServerSentEventMessage> | ChatCompletionResponse
    >({
      label: "responses",
      payload,
      transport: (p, tokenSource, accountId) =>
        doResponsesFetch(p, tokenSource, { accountId }),
    })
  }

  if (!state.copilotToken) throw new Error("Copilot token not found")
  return doResponsesFetch(payload, state)
}

async function doResponsesFetch(
  payload: ChatCompletionsPayload,
  source: TokenSource,
  ctx: { accountId?: string } = {},
): Promise<AsyncGenerator<ServerSentEventMessage> | ChatCompletionResponse> {
  const responsesPayload = chatToResponsesPayload(payload)
  const url = `${copilotBaseUrl(source)}/v1/responses`

  const enableVision = responsesPayload.input.some(
    (item) =>
      item.type === "message"
      && item.content.some((c) => c.type === "input_image"),
  )

  const isAgentCall = payload.messages.some((m) =>
    ["assistant", "tool"].includes(m.role),
  )

  const buildHeaders = (): Record<string, string> => ({
    ...copilotHeaders(source, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
  })

  const bodyString = JSON.stringify(responsesPayload)

  consola.debug("Sending request to Copilot (/v1/responses):", {
    model: responsesPayload.model,
    endpoint: url,
    stream: responsesPayload.stream,
    accountId: ctx.accountId ?? "single-account",
  })

  let response = await fetchWithRetry(
    url,
    () => ({
      method: "POST",
      headers: buildHeaders(),
      body: bodyString,
    }),
    { accountId: ctx.accountId, accountProxy: source.proxy },
  )

  if (response.status === 401 && !ctx.accountId) {
    consola.warn("Copilot token expired, refreshing and retrying...")
    try {
      await refreshCopilotToken()
      response = await fetchWithTimeout(url, {
        method: "POST",
        headers: buildHeaders(),
        body: bodyString,
      })
    } catch {
      // Fall through to error handling
    }
  }

  if (!response.ok) {
    const errorBody = await response.text()
    consola.error("Failed /v1/responses request", {
      status: response.status,
      statusText: response.statusText,
      body: errorBody,
    })
    throw new HTTPError(
      `Failed to call /v1/responses: ${response.status} ${errorBody}`,
      response,
    )
  }

  if (payload.stream) {
    const sse = events(response)
    const translated = responsesStreamToChatChunks(
      sse,
      payload.model,
    ) as AsyncGenerator<ServerSentEventMessage> & {
      __accountInfo?: StreamAccountInfo
    }
    translated.__accountInfo = {
      accountId: ctx.accountId,
      apiBaseUrl: copilotBaseUrl(source),
      accountProxy: source.proxy,
    }
    return translated
  }

  const responsesResult = (await response.json()) as ResponsesResponse
  return responsesToChatResponse(responsesResult, payload.model)
}
