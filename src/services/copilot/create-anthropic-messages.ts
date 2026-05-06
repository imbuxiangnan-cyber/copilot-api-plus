/**
 * Native Copilot `/v1/messages` passthrough.
 *
 * Mirrors the multi-account / single-account / 401-refresh / error-handling
 * structure of `create-chat-completions.ts`, but forwards the Anthropic
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
import {
  getAccountDispatcher,
  resetAccountConnections,
  type StreamAccountInfo,
} from "~/lib/proxy"
import { state } from "~/lib/state"
import { refreshCopilotToken } from "~/lib/token"
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
}

// ---------------------------------------------------------------------------
// Fetch helpers (timeout, retry, dispatcher)
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 120_000

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  {
    timeoutMs = FETCH_TIMEOUT_MS,
    accountId,
    accountProxy,
    externalSignal,
  }: {
    timeoutMs?: number
    accountId?: string
    accountProxy?: string
    externalSignal?: AbortSignal
  } = {},
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onExternalAbort = () => controller.abort()
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort()
    else
      externalSignal.addEventListener("abort", onExternalAbort, { once: true })
  }

  try {
    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      ...init,
      signal: controller.signal,
    }
    if (accountId) {
      fetchOptions.dispatcher = getAccountDispatcher(accountId, accountProxy)
    }
    return await fetch(url, fetchOptions)
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timer)
    if (externalSignal)
      externalSignal.removeEventListener("abort", onExternalAbort)
  }
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
  // Default to maximum thinking budget when the client did not specify one.
  // Adaptive-thinking models get { type: "adaptive" }; others get the
  // model's max_thinking_budget. Existing client preference is respected.
  injectMaxThinkingBudget(payload)

  // Proactively strip assistant thinking/redacted_thinking blocks from
  // history. Copilot's Vertex backend (req_vrtx_*) rejects replayed
  // thinking signatures across requests, so any multi-turn conversation
  // would otherwise hit a 400 + signature-retry on every request. We
  // strip up-front to skip that round trip.
  //
  // The `try/catch` block below still keeps the retry as a safety net for
  // any future / non-Vertex backend that might surface the same error
  // through a different code path.
  const preStripped = stripAssistantThinkingBlocks(payload)
  let workingPayload = payload
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

  try {
    return await dispatchAnthropicRequest(workingPayload, options)
  } catch (error) {
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
}

async function dispatchAnthropicRequest(
  payload: AnthropicMessagesPayload,
  options?: CreateOptions,
): Promise<AnthropicMessagesResult> {
  if (state.multiAccountEnabled && accountManager.hasAccounts()) {
    return createWithMultiAccount(payload, options)
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
    consola.warn("Copilot token expired, refreshing and retrying...")
    try {
      await refreshCopilotToken()
      response = await fetchWithTimeout(url, {
        method: "POST",
        headers: buildHeaders(),
        body: bodyString,
        signal: options?.signal,
      })
    } catch (refreshError) {
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
// Multi-account path (failover across accounts, mirrors chat-completions)
// ---------------------------------------------------------------------------

interface FetchContext {
  payload: AnthropicMessagesPayload
  source: TokenSource
  accountId: string
  options?: CreateOptions
}

function buildTokenSource(
  account: ReturnType<typeof accountManager.getActiveAccount> & object,
): TokenSource {
  return {
    copilotToken: account.copilotToken,
    copilotApiEndpoint: account.copilotApiEndpoint,
    accountType: account.accountType,
    githubToken: account.githubToken,
    vsCodeVersion: state.vsCodeVersion,
    machineId: account.machineId,
    sessionId: account.sessionId,
    proxy: account.proxy,
  }
}

function tagStreamWithAccount(
  result: AnthropicMessagesResult,
  account: { id: string; proxy?: string },
  source: TokenSource,
): AnthropicMessagesResult {
  if (typeof result === "object" && Symbol.asyncIterator in result) {
    ;(
      result as AsyncGenerator & { __accountInfo?: StreamAccountInfo }
    ).__accountInfo = {
      accountId: account.id,
      accountProxy: account.proxy,
      apiBaseUrl: copilotBaseUrl(source),
    }
  }
  return result
}

async function handleMultiAccount401(
  ctx: FetchContext,
  account: NonNullable<ReturnType<typeof accountManager.getActiveAccount>>,
): Promise<AnthropicMessagesResult> {
  try {
    await accountManager.refreshAccountToken(account)
    ctx.source.copilotToken = account.copilotToken
    const retried = await doFetchAnthropic(ctx)
    accountManager.markAccountSuccess(account.id)
    return tagStreamWithAccount(retried, account, ctx.source)
  } catch (refreshError) {
    accountManager.markAccountStatus(
      account.id,
      "banned",
      "GitHub token invalid",
    )
    throw refreshError
  }
}

async function createWithMultiAccount(
  payload: AnthropicMessagesPayload,
  options?: CreateOptions,
): Promise<AnthropicMessagesResult> {
  const triedAccountIds = new Set<string>()
  let lastError: unknown
  let networkRetried = false

  for (let attempt = 0; attempt < 3; attempt++) {
    const account = accountManager.getActiveAccount()
    if (!account || triedAccountIds.has(account.id)) break
    triedAccountIds.add(account.id)

    if (!account.copilotToken) {
      consola.debug(
        `Account ${account.label} has no copilot token, refreshing...`,
      )
      await accountManager.refreshAccountToken(account)
      if (!account.copilotToken) {
        accountManager.markAccountStatus(
          account.id,
          "error",
          "No copilot token",
        )
        continue
      }
    }

    const ctx: FetchContext = {
      payload,
      source: buildTokenSource(account),
      accountId: account.id,
      options,
    }

    try {
      const result = await doFetchAnthropic(ctx)
      account.lastRequestAt = Date.now()
      accountManager.markAccountSuccess(account.id)
      return tagStreamWithAccount(result, account, ctx.source)
    } catch (error) {
      lastError = error

      if (error instanceof HTTPError) {
        if (error.response.status === 401) {
          return handleMultiAccount401(ctx, account)
        }
        if (error.response.status >= 400 && error.response.status < 500) {
          throw error
        }
        consola.warn(
          `Account ${account.label}: 5xx from /v1/messages, trying next account`,
        )
        continue
      }

      const errMsg = (error as Error).message || String(error)
      if (!networkRetried) {
        networkRetried = true
        consola.warn(
          `Account ${account.label}: network error on /v1/messages, resetting pool and retrying once: ${errMsg}`,
        )
        resetAccountConnections(account.id)
        triedAccountIds.delete(account.id)
        continue
      }
      consola.warn(
        `Account ${account.label}: network error after retry on /v1/messages (giving up): ${errMsg}`,
      )
      throw error
    }
  }

  if (lastError)
    throw lastError instanceof Error ? lastError : (
        new Error("Network request failed")
      )
  throw new Error("No available accounts")
}

// ---------------------------------------------------------------------------
// Shared upstream fetch + error throw
// ---------------------------------------------------------------------------

async function doFetchAnthropic(
  ctx: FetchContext,
): Promise<AnthropicMessagesResult> {
  const { payload, source, accountId, options } = ctx
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
    { accountId, accountProxy: source.proxy, externalSignal: options?.signal },
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
  throw new HTTPError(
    `Failed to call /v1/messages: ${response.status} ${errorBody}`,
    response,
  )
}
