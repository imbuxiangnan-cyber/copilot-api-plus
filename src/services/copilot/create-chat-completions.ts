import consola from "consola"
import { events } from "fetch-event-stream"

import { accountManager } from "~/lib/account-manager"
import {
  copilotHeaders,
  copilotBaseUrl,
  type TokenSource,
} from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { modelRouter } from "~/lib/model-router"
import { state } from "~/lib/state"
import { refreshCopilotToken } from "~/lib/token"

// ---------------------------------------------------------------------------
// Fetch with timeout helper
// ---------------------------------------------------------------------------

/**
 * Timeout for the initial HTTP connection + headers (not the body/stream).
 * Copilot's slow models (e.g. claude-opus) can take up to ~60s to start
 * streaming, so we give 120s for the connection phase.
 */
const FETCH_TIMEOUT_MS = 120_000

/**
 * Retry delays in ms (exponential back-off).
 * After a network error we wait longer before each retry to let the
 * Copilot backend recover and avoid triggering connection-level throttling.
 */
const RETRY_DELAYS = [2_000, 5_000, 10_000]

/**
 * Wrapper around `fetch()` that aborts if the server doesn't respond within
 * `timeoutMs`.  The timeout only covers the period until the response headers
 * arrive – once the body starts streaming, the timeout is cleared so that
 * long SSE responses are not interrupted.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    })
    return response
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Retry loop for fetch: retries on network errors with exponential back-off.
 *
 * Returns `{ response }` on success.
 * Throws the last network error if all retries are exhausted.
 */
async function fetchWithRetry(
  url: string,
  buildInit: () => RequestInit,
): Promise<Response> {
  let lastError: unknown
  const maxAttempts = RETRY_DELAYS.length + 1 // 1 initial + retries

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fetchWithTimeout(url, buildInit())
    } catch (error: unknown) {
      lastError = error
      if (attempt < maxAttempts - 1) {
        const delay = RETRY_DELAYS[attempt]
        consola.warn(
          `Network error on attempt ${attempt + 1}/${maxAttempts}, retrying in ${delay}ms:`,
          error instanceof Error ? error.message : error,
        )
        await new Promise((r) => setTimeout(r, delay))
      }
    }
  }

  throw lastError instanceof Error ? lastError : (
      new Error("Network request failed")
    )
}

// ---------------------------------------------------------------------------
// Streaming slot release wrapper
// ---------------------------------------------------------------------------

/**
 * Wraps an AsyncGenerator so that `releaseSlot` is called when the generator
 * finishes (return or throw), not when the outer function returns.
 */
async function* wrapGeneratorWithRelease(
  gen: AsyncGenerator,
  releaseSlot: () => void,
): AsyncGenerator {
  try {
    yield* gen
  } finally {
    releaseSlot()
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
) => {
  // Apply model routing
  const resolvedModel = modelRouter.resolveModel(payload.model)
  const routedPayload =
    resolvedModel !== payload.model ?
      { ...payload, model: resolvedModel }
    : payload
  if (resolvedModel !== payload.model) {
    consola.debug(`Model routed: ${payload.model} → ${resolvedModel}`)
  }

  // Acquire concurrency slot
  const releaseSlot = await modelRouter.acquireSlot(resolvedModel)

  try {
    const result =
      state.multiAccountEnabled && accountManager.hasAccounts() ?
        await createWithMultiAccount(routedPayload)
      : await createWithSingleAccount(routedPayload)

    // For streaming responses, wrap the generator so the slot is released
    // when the stream ends (not when this function returns).
    if (Symbol.asyncIterator in result) {
      return wrapGeneratorWithRelease(result, releaseSlot)
    }

    // Non-streaming: release immediately
    releaseSlot()
    return result
  } catch (error) {
    releaseSlot()
    throw error
  }
}

// ---------------------------------------------------------------------------
// Single-account path (original behaviour, unchanged)
// ---------------------------------------------------------------------------

async function createWithSingleAccount(payload: ChatCompletionsPayload) {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const enableVision = payload.messages.some(
    (x) =>
      typeof x.content !== "string"
      && x.content?.some((x) => x.type === "image_url"),
  )

  // Agent/user check for X-Initiator header
  // Determine if any message is from an agent ("assistant" or "tool")
  const isAgentCall = payload.messages.some((msg) =>
    ["assistant", "tool"].includes(msg.role),
  )

  // Build headers fresh each call (token may be refreshed between attempts)
  const buildHeaders = (): Record<string, string> => ({
    ...copilotHeaders(state, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
  })

  consola.debug("Sending request to Copilot:", {
    model: payload.model,
    endpoint: `${copilotBaseUrl(state)}/chat/completions`,
  })

  const url = `${copilotBaseUrl(state)}/chat/completions`

  // Request usage stats in the final stream chunk
  const body =
    payload.stream ?
      { ...payload, stream_options: { include_usage: true } }
    : payload

  const bodyString = JSON.stringify(body)

  // Fetch with timeout + exponential back-off retries
  let response = await fetchWithRetry(url, () => ({
    method: "POST",
    headers: buildHeaders(),
    body: bodyString,
  }))

  // On 401 (token expired), refresh the Copilot token and retry once
  if (response.status === 401) {
    consola.warn("Copilot token expired, refreshing and retrying...")
    try {
      await refreshCopilotToken()
      response = await fetchWithTimeout(url, {
        method: "POST",
        headers: buildHeaders(),
        body: bodyString,
      })
    } catch (refreshError) {
      consola.error("Failed to refresh token:", refreshError)
      // Fall through to the error handling below
    }
  }

  if (!response.ok) {
    const errorBody = await response.text()

    if (response.status === 400) {
      consola.warn(`400: ${errorBody}`)
    } else {
      consola.error("Failed to create chat completions", {
        status: response.status,
        statusText: response.statusText,
        body: errorBody,
      })
    }

    throw new HTTPError(
      `Failed to create chat completions: ${response.status} ${errorBody}`,
      response,
    )
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ChatCompletionResponse
}

// ---------------------------------------------------------------------------
// Multi-account path (failover across accounts)
// ---------------------------------------------------------------------------

/**
 * Attempt to refresh an account's token and retry the request.
 * Returns the result on success, or null if the refresh/retry failed.
 */
async function tryRefreshAndRetry(
  account: import("~/lib/account-manager").Account,
  payload: ChatCompletionsPayload,
  tokenSource: TokenSource,
): Promise<AsyncGenerator | ChatCompletionResponse | null> {
  try {
    await accountManager.refreshAccountToken(account)
    // Update tokenSource with the refreshed token
    tokenSource.copilotToken = account.copilotToken
    const result = await doFetch(payload, tokenSource)
    accountManager.markAccountSuccess(account.id)
    return result
  } catch {
    accountManager.markAccountStatus(
      account.id,
      "error",
      "Token refresh failed",
    )
    return null
  }
}

/**
 * Handle an HTTP error from a multi-account request attempt.
 *
 * For 401 errors, attempts token refresh and retry.
 * Returns the successful retry result, or null if the error was handled
 * without a successful retry.
 */
async function handleMultiAccountHttpError(
  error: HTTPError,
  account: import("~/lib/account-manager").Account,
  retryContext: { payload: ChatCompletionsPayload; tokenSource: TokenSource },
): Promise<AsyncGenerator | ChatCompletionResponse | null> {
  switch (error.response.status) {
    case 401: {
      consola.warn(`Account ${account.label}: 401, refreshing token...`)
      return tryRefreshAndRetry(
        account,
        retryContext.payload,
        retryContext.tokenSource,
      )
    }
    case 403: {
      accountManager.markAccountStatus(account.id, "banned", "403 Forbidden")
      return null
    }
    case 429: {
      accountManager.markAccountStatus(
        account.id,
        "rate_limited",
        "429 Rate limited",
      )
      return null
    }
    default: {
      // 5xx server errors are likely transient — retry once with same account before switching
      if (error.response.status >= 500) {
        consola.warn(
          `Account ${account.label}: upstream ${error.response.status}, retrying in 2s...`,
        )
        await new Promise((r) => setTimeout(r, 2_000))
        try {
          const result = await doFetch(
            retryContext.payload,
            retryContext.tokenSource,
          )
          accountManager.markAccountSuccess(account.id)
          return result
        } catch {
          consola.warn(
            `Account ${account.label}: upstream ${error.response.status} persists, trying next account...`,
          )
          return null
        }
      }
      accountManager.markAccountStatus(
        account.id,
        "error",
        `HTTP ${error.response.status}`,
      )
      return null
    }
  }
}

async function createWithMultiAccount(payload: ChatCompletionsPayload) {
  const triedAccountIds = new Set<string>()
  let lastError: unknown

  // Try up to 3 different accounts
  for (let attempt = 0; attempt < 3; attempt++) {
    const account = accountManager.getActiveAccount()
    if (!account || triedAccountIds.has(account.id)) {
      // No more untried accounts available
      break
    }
    triedAccountIds.add(account.id)

    if (!account.copilotToken) {
      // Token may be missing after restart — try to refresh before giving up
      consola.info(
        `Account ${account.label} has no copilot token, refreshing...`,
      )
      await accountManager.refreshAccountToken(account)

      if (!account.copilotToken) {
        consola.warn(`Account ${account.label}: token refresh failed, skipping`)
        accountManager.markAccountStatus(
          account.id,
          "error",
          "No copilot token",
        )
        continue
      }
    }

    // Build a TokenSource from the account
    const tokenSource: TokenSource = {
      copilotToken: account.copilotToken,
      copilotApiEndpoint: account.copilotApiEndpoint,
      accountType: account.accountType,
      githubToken: account.githubToken,
      vsCodeVersion: state.vsCodeVersion,
    }

    try {
      const result = await doFetch(payload, tokenSource)
      accountManager.markAccountSuccess(account.id)
      return result
    } catch (error) {
      lastError = error

      if (error instanceof HTTPError) {
        const retryResult = await handleMultiAccountHttpError(error, account, {
          payload,
          tokenSource,
        })
        if (retryResult) return retryResult
      } else {
        // Network error or other
        accountManager.markAccountStatus(
          account.id,
          "error",
          (error as Error).message,
        )
      }

      consola.warn(
        `Account ${account.label} failed (attempt ${attempt + 1}), trying next...`,
      )
    }
  }

  // All accounts exhausted
  if (lastError)
    throw lastError instanceof Error ? lastError : (
        new Error("Network request failed")
      )
  throw new Error("No available accounts")
}

// ---------------------------------------------------------------------------
// Shared fetch helper (used by multi-account path)
// ---------------------------------------------------------------------------

/**
 * Execute the actual HTTP request to the Copilot chat/completions endpoint.
 *
 * This is intentionally a thin wrapper so that `createWithMultiAccount` can
 * call it with different `TokenSource` objects while keeping all the header
 * construction / retry / error‐surfacing logic in one place.
 */
async function doFetch(
  payload: ChatCompletionsPayload,
  source: TokenSource,
): Promise<AsyncGenerator | ChatCompletionResponse> {
  const enableVision = payload.messages.some(
    (x) =>
      typeof x.content !== "string"
      && x.content?.some((x) => x.type === "image_url"),
  )

  const isAgentCall = payload.messages.some((msg) =>
    ["assistant", "tool"].includes(msg.role),
  )

  const buildHeaders = (): Record<string, string> => ({
    ...copilotHeaders(source, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
  })

  const url = `${copilotBaseUrl(source)}/chat/completions`

  consola.debug("Sending request to Copilot (multi-account):", {
    model: payload.model,
    endpoint: url,
  })

  const body =
    payload.stream ?
      { ...payload, stream_options: { include_usage: true } }
    : payload

  const bodyString = JSON.stringify(body)

  // Fetch with timeout + exponential back-off retries
  const response = await fetchWithRetry(url, () => ({
    method: "POST",
    headers: buildHeaders(),
    body: bodyString,
  }))

  if (!response.ok) {
    const errorBody = await response.text()

    if (response.status === 400) {
      consola.warn(`400: ${errorBody}`)
    } else {
      consola.error("Failed to create chat completions", {
        status: response.status,
        statusText: response.statusText,
        body: errorBody,
      })
    }

    throw new HTTPError(
      `Failed to create chat completions: ${response.status} ${errorBody}`,
      response,
    )
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ChatCompletionResponse
}

// ===========================================================================
// Types (unchanged)
// ===========================================================================

// Streaming types

export interface ChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<Choice>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
    completion_tokens_details?: {
      accepted_prediction_tokens: number
      rejected_prediction_tokens: number
    }
  }
}

interface Delta {
  content?: string | null
  role?: "user" | "assistant" | "system" | "tool"
  tool_calls?: Array<{
    index: number
    id?: string
    type?: "function"
    function?: {
      name?: string
      arguments?: string
    }
  }>
}

interface Choice {
  index: number
  delta: Delta
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  logprobs: object | null
}

// Non-streaming types

export interface ChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<ChoiceNonStreaming>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
  }
}

interface ResponseMessage {
  role: "assistant"
  content: string | null
  tool_calls?: Array<ToolCall>
}

interface ChoiceNonStreaming {
  index: number
  message: ResponseMessage
  logprobs: object | null
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter"
}

// Payload types

export interface ChatCompletionsPayload {
  messages: Array<Message>
  model: string
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  stop?: string | Array<string> | null
  n?: number | null
  stream?: boolean | null

  frequency_penalty?: number | null
  presence_penalty?: number | null
  logit_bias?: Record<string, number> | null
  logprobs?: boolean | null
  response_format?: { type: "json_object" } | null
  seed?: number | null
  tools?: Array<Tool> | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | null
  user?: string | null
}

export interface Tool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool" | "developer"
  content: string | Array<ContentPart> | null

  name?: string
  tool_calls?: Array<ToolCall>
  tool_call_id?: string
}

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ContentPart = TextPart | ImagePart

export interface TextPart {
  type: "text"
  text: string
}

export interface ImagePart {
  type: "image_url"
  image_url: {
    url: string
    detail?: "low" | "high" | "auto"
  }
}
