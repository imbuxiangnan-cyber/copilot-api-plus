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
import { modelRouter } from "~/lib/model-router"
import { type StreamAccountInfo } from "~/lib/proxy"
import { type RequestOptions } from "~/lib/request-options"
import { state } from "~/lib/state"
import { refreshCopilotToken } from "~/lib/token"
import { fetchWithRetry, fetchWithTimeout } from "~/lib/upstream-fetch"

import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
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
 * Supports single-account token refresh and shared multi-account rotation.
 */
export async function createResponsesAsChat(
  payload: ChatCompletionsPayload,
  options: RequestOptions = {},
): Promise<AsyncGenerator<ServerSentEventMessage> | ChatCompletionResponse> {
  options.signal?.throwIfAborted()
  const routedPayload = {
    ...payload,
    model: options.resolvedModel ?? modelRouter.resolveModel(payload.model),
  }
  if (state.multiAccountEnabled && accountManager.hasAccounts()) {
    return runWithAccountRotation<
      ChatCompletionsPayload,
      AsyncGenerator<ServerSentEventMessage> | ChatCompletionResponse
    >({
      label: "responses",
      payload: routedPayload,
      signal: options.signal,
      transport: (p, tokenSource, accountId) =>
        doResponsesFetch(p, tokenSource, { accountId, signal: options.signal }),
    })
  }

  if (!state.copilotToken) throw new Error("Copilot token not found")
  return doResponsesFetch(routedPayload, state, { signal: options.signal })
}

async function doResponsesFetch(
  payload: ChatCompletionsPayload,
  source: TokenSource,
  ctx: { accountId?: string; signal?: AbortSignal } = {},
): Promise<AsyncGenerator<ServerSentEventMessage> | ChatCompletionResponse> {
  ctx.signal?.throwIfAborted()
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
      signal: ctx.signal,
    }),
    { accountId: ctx.accountId, accountProxy: source.proxy },
  )

  if (response.status === 401 && !ctx.accountId) {
    consola.warn("Copilot token expired, refreshing and retrying...")
    try {
      ctx.signal?.throwIfAborted()
      await refreshCopilotToken(ctx.signal)
      ctx.signal?.throwIfAborted()
      response = await fetchWithTimeout(url, {
        method: "POST",
        headers: buildHeaders(),
        body: bodyString,
        signal: ctx.signal,
      })
    } catch {
      ctx.signal?.throwIfAborted()
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
