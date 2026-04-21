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
import {
  getAccountDispatcher,
  notifyStreamEnd,
  notifyStreamStart,
  resetAccountConnections,
  resetConnections,
  type StreamAccountInfo,
} from "~/lib/proxy"
import { state } from "~/lib/state"
import { refreshCopilotToken } from "~/lib/token"
import { findModel, rootCause } from "~/lib/utils"

// ---------------------------------------------------------------------------
// Fetch with timeout helper
// ---------------------------------------------------------------------------

/**
 * Timeout for the initial HTTP connection + headers (not the body/stream).
 * Copilot's slow models (e.g. claude-opus with thinking) can take up to
 * ~120s to start streaming, so we give a generous timeout for headers.
 */
const FETCH_TIMEOUT_MS = 120_000

// ---------------------------------------------------------------------------
// Anti-correlation: jitter & frequency limiting
// ---------------------------------------------------------------------------

/** Minimum interval (ms) between requests on the same account. */
const MIN_SAME_ACCOUNT_INTERVAL_MS = 1_000

/** Random jitter range (ms) added when switching between accounts. */
const ACCOUNT_SWITCH_JITTER_MIN_MS = 1_000
const ACCOUNT_SWITCH_JITTER_MAX_MS = 5_000

/** Track the last-used account ID to detect account switches. */
let lastUsedAccountId: string | undefined

/**
 * Wrapper around `fetch()` that aborts if the server doesn't respond within
 * `timeoutMs`.  The timeout only covers the period until the response headers
 * arrive – once the body starts streaming, the timeout is cleared so that
 * long SSE responses are not interrupted.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  {
    timeoutMs = FETCH_TIMEOUT_MS,
    accountId,
    accountProxy,
  }: {
    timeoutMs?: number
    accountId?: string
    accountProxy?: string
  } = {},
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    // Use per-account connection pool when in multi-account mode
    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      ...init,
      signal: controller.signal,
    }
    if (accountId) {
      fetchOptions.dispatcher = getAccountDispatcher(accountId, accountProxy)
    }
    const response = await fetch(url, fetchOptions)
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
 * Single-attempt fetch with connection pool reset on network errors.
 *
 * Retries are intentionally disabled — each Copilot request consumes a
 * credit, and the caller (e.g. Claude Code) already retries at the
 * application level.  Our retry + caller retry created a request cascade
 * that caused account bans (367 requests in 52 minutes).
 *
 * On network failure (NOT timeout), the pooled connections are destroyed
 * so that the caller's next attempt gets a fresh socket instantly.
 */
async function fetchWithRetry(
  url: string,
  buildInit: () => RequestInit,
  {
    accountId,
    accountProxy,
  }: { accountId?: string; accountProxy?: string } = {},
): Promise<Response> {
  try {
    return await fetchWithTimeout(url, buildInit(), {
      timeoutMs: FETCH_TIMEOUT_MS,
      accountId,
      accountProxy,
    })
  } catch (error: unknown) {
    // Timeout errors mean the request likely reached Copilot (credit
    // already consumed) or the upstream is genuinely slow — don't reset
    // the pool, just propagate.
    const msg = error instanceof Error ? error.message : String(error)
    if (!msg.includes("timed out")) {
      // Network error: destroy pooled connections so the caller's next
      // attempt uses fresh sockets instead of stale ones.
      if (accountId) {
        resetAccountConnections(accountId)
      } else {
        resetConnections()
      }
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// Streaming slot release wrapper
// ---------------------------------------------------------------------------

/**
 * Wraps an AsyncGenerator so that `releaseSlot` is called when the generator
 * finishes (return or throw), not when the outer function returns.
 * Also tracks active streams for the proxy-tunnel keepalive mechanism.
 */
async function* wrapGeneratorWithRelease(
  gen: AsyncGenerator,
  releaseSlot: () => void,
  accountInfo?: StreamAccountInfo,
): AsyncGenerator {
  notifyStreamStart(accountInfo)
  let streamError = false
  try {
    yield* gen
  } catch (error) {
    streamError = true
    throw error
  } finally {
    notifyStreamEnd(accountInfo)
    releaseSlot()
    // After a stream error, destroy all pooled connections so the next
    // request from the client gets a fresh socket instantly instead of
    // waiting ~60s on a stale one.
    if (streamError) {
      if (accountInfo?.accountId) {
        resetAccountConnections(accountInfo.accountId)
      } else {
        resetConnections()
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Reasoning-effort auto-detection cache
// ---------------------------------------------------------------------------

/**
 * Models that are known NOT to support the `reasoning_effort` parameter.
 * Populated at runtime: the first time a model returns 400 with
 * "Unrecognized request argument", it is added here and all future
 * requests to that model skip the injection automatically.
 */
const reasoningUnsupportedModels = new Set<string>()

/**
 * Models whose reasoning_effort must be capped at a lower level.
 * e.g. claude-opus-4.7 rejects "high" but accepts "medium".
 * When a model returns 400 with "is not supported by model", it is added
 * here with its maximum supported effort level.
 */
const reasoningEffortCap = new Map<string, "low" | "medium">()

/**
 * Compute an appropriate thinking_budget from model capabilities.
 * Returns undefined if the model does not support thinking.
 */
function getThinkingBudget(
  model: import("~/services/copilot/get-models").Model | undefined,
): number | undefined {
  if (!model) return undefined
  const { supports, limits } = model.capabilities
  const maxBudget = supports.max_thinking_budget
  if (!maxBudget || maxBudget <= 0) return undefined
  const maxOutput = limits.max_output_tokens ?? 0
  const upperBound = Math.min(maxBudget, Math.max(maxOutput - 1, 0))
  const lowerBound = supports.min_thinking_budget ?? 1024
  return Math.max(upperBound, lowerBound)
}

/**
 * Check whether tool_choice forces tool use (not "auto" or "none").
 * Thinking/reasoning cannot be enabled when tool_choice forces a tool.
 */
function isToolChoiceForced(
  toolChoice: ChatCompletionsPayload["tool_choice"],
): boolean {
  if (!toolChoice) return false
  if (toolChoice === "auto" || toolChoice === "none") return false
  // "required" or { type: "function", ... } are forced
  return true
}

/**
 * Inject thinking parameters into the payload based on model capabilities.
 *
 * Strategy (in priority order):
 *   1. If the client already set reasoning_effort or thinking_budget → keep as-is
 *   2. If tool_choice forces tool use → skip (API rejects the combination)
 *   3. If model capabilities declare max_thinking_budget → inject thinking_budget
 *   4. Otherwise → inject reasoning_effort at the highest level the model supports:
 *      - "high" by default (maximum thinking for most models)
 *      - Capped to "medium"/"low" if the model previously rejected "high"
 *
 * The fallback to reasoning_effort ensures thinking works even when the
 * /models endpoint doesn't expose thinking budget fields.
 */
function injectThinking(
  payload: ChatCompletionsPayload,
  resolvedModel: string,
): ChatCompletionsPayload {
  // Client already specified thinking params — respect them
  if (payload.reasoning_effort || payload.thinking_budget) {
    return payload
  }

  // Thinking cannot be enabled when tool_choice forces tool use
  if (isToolChoiceForced(payload.tool_choice)) {
    return payload
  }

  // Try model-capability-based injection (thinking_budget)
  const model = findModel(resolvedModel)
  const budget = getThinkingBudget(model)
  if (budget) {
    return { ...payload, thinking_budget: budget }
  }

  // Fallback: inject reasoning_effort at the highest supported level.
  // Default is "high"; auto-downgraded at runtime if a model rejects it.
  if (reasoningUnsupportedModels.has(resolvedModel)) {
    return payload
  }
  const effort = reasoningEffortCap.get(resolvedModel) ?? "high"
  return {
    ...payload,
    reasoning_effort: effort as ChatCompletionsPayload["reasoning_effort"],
  }
}

// ---------------------------------------------------------------------------
// Thinking injection logging (debug level)
// ---------------------------------------------------------------------------

function logThinkingInjection(
  original: ChatCompletionsPayload,
  injected: ChatCompletionsPayload,
  resolvedModel: string,
) {
  if (original.reasoning_effort || original.thinking_budget) {
    consola.debug(
      `Thinking: translated (reasoning_effort=${original.reasoning_effort ?? "none"} / thinking_budget=${original.thinking_budget ?? "none"})`,
    )
  } else if (
    injected.thinking_budget
    && injected.thinking_budget !== original.thinking_budget
  ) {
    consola.debug(
      `Thinking: injected thinking_budget=${injected.thinking_budget} for "${resolvedModel}"`,
    )
  } else if (
    injected.reasoning_effort
    && injected.reasoning_effort !== original.reasoning_effort
  ) {
    consola.debug(
      `Thinking: injected reasoning_effort=${injected.reasoning_effort} for "${resolvedModel}"`,
    )
  } else if (reasoningUnsupportedModels.has(resolvedModel)) {
    consola.debug(
      `Thinking: skipped — "${resolvedModel}" does not support reasoning`,
    )
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

  // ---------------------------------------------------------------------------
  // Thinking injection: use model capabilities to decide strategy
  // ---------------------------------------------------------------------------
  const thinkingPayload = injectThinking(routedPayload, resolvedModel)
  const wasInjected =
    thinkingPayload.reasoning_effort !== routedPayload.reasoning_effort
    || thinkingPayload.thinking_budget !== routedPayload.thinking_budget

  logThinkingInjection(routedPayload, thinkingPayload, resolvedModel)

  // Acquire concurrency slot
  const releaseSlot = await modelRouter.acquireSlot(resolvedModel)

  try {
    const result = await dispatchRequest(thinkingPayload)

    // For streaming responses, wrap the generator so the slot is released
    // when the stream ends (not when this function returns).
    if (Symbol.asyncIterator in result) {
      const accountInfo = (
        result as AsyncGenerator & {
          __accountInfo?: StreamAccountInfo
        }
      ).__accountInfo
      const wrapped = wrapGeneratorWithRelease(result, releaseSlot, accountInfo)
      // Propagate accountInfo so handler.ts can determine proxy status
      ;(
        wrapped as AsyncGenerator & {
          __accountInfo?: StreamAccountInfo
        }
      ).__accountInfo = accountInfo
      return wrapped
    }

    // Non-streaming: release immediately
    releaseSlot()
    return result
  } catch (error) {
    if (error instanceof HTTPError && error.response.status === 400) {
      const errMsg = error.message

      // Case 1: Model doesn't support reasoning_effort at all
      // → strip reasoning params and retry
      if (
        wasInjected
        && (errMsg.includes("Unrecognized request argument")
          || errMsg.includes("does not support reasoning")
          || errMsg.includes("invalid_reasoning_effort"))
      ) {
        reasoningUnsupportedModels.add(resolvedModel)
        consola.debug(
          `Model "${resolvedModel}" does not support reasoning_effort — disabled for future requests`,
        )
        return retryWithModifiedPayload(routedPayload, releaseSlot)
      }

      // Case 2: Model rejects the specific reasoning_effort value
      // (e.g. claude-opus-4.7 rejects "high", only accepts "medium")
      // → downgrade to "medium" and retry; remember for future requests
      if (errMsg.includes("is not supported by model")) {
        const currentEffort = thinkingPayload.reasoning_effort
        if (
          currentEffort
          && currentEffort !== "medium"
          && currentEffort !== "low"
        ) {
          reasoningEffortCap.set(resolvedModel, "medium")
          consola.debug(
            `Model "${resolvedModel}" rejected reasoning_effort="${currentEffort}" — downgrading to "medium" for future requests`,
          )
          const downgraded = {
            ...routedPayload,
            reasoning_effort: "medium" as const,
          }
          return retryWithModifiedPayload(downgraded, releaseSlot)
        }
      }
    }

    releaseSlot()
    throw error
  }
}

/**
 * Retry a request after modifying the payload (e.g. stripping or
 * downgrading reasoning_effort).
 * Handles slot release for both streaming and non-streaming responses.
 */
async function retryWithModifiedPayload(
  payload: ChatCompletionsPayload,
  releaseSlot: () => void,
) {
  try {
    const result = await dispatchRequest(payload)
    if (Symbol.asyncIterator in result) {
      const accountInfo = (
        result as AsyncGenerator & {
          __accountInfo?: StreamAccountInfo
        }
      ).__accountInfo
      const wrapped = wrapGeneratorWithRelease(result, releaseSlot, accountInfo)
      // Propagate accountInfo so handler.ts can determine proxy status
      ;(
        wrapped as AsyncGenerator & {
          __accountInfo?: StreamAccountInfo
        }
      ).__accountInfo = accountInfo
      return wrapped
    }
    releaseSlot()
    return result
  } catch (retryError) {
    releaseSlot()
    throw retryError
  }
}

/**
 * Dispatch request to either single-account or multi-account path.
 */
function dispatchRequest(payload: ChatCompletionsPayload) {
  return state.multiAccountEnabled && accountManager.hasAccounts() ?
      createWithMultiAccount(payload)
    : createWithSingleAccount(payload)
}

// ---------------------------------------------------------------------------
// Single-account path (original behaviour, unchanged)
// ---------------------------------------------------------------------------

async function createWithSingleAccount(payload: ChatCompletionsPayload) {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const enableVision = payload.messages.some(
    (msg) =>
      typeof msg.content !== "string"
      && msg.content?.some((part) => part.type === "image_url"),
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
      consola.warn(`Failed to refresh token: ${rootCause(refreshError)}`)
      consola.debug("Failed to refresh token:", refreshError)
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
    const gen = events(response) as AsyncGenerator & {
      __accountInfo?: StreamAccountInfo
    }
    gen.__accountInfo = { apiBaseUrl: copilotBaseUrl(state) }
    return gen
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
    const result = await doFetch(payload, tokenSource, account.id)
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
      // 5xx: upstream error — don't retry to avoid wasting request credits.
      if (error.response.status >= 500) {
        accountManager.markAccountStatus(
          account.id,
          "error",
          `HTTP ${error.response.status}`,
        )
        return null
      }
      // 400: model/parameter incompatibility — don't penalise the account,
      // just skip it for this request so it remains available for others.
      if (error.response.status === 400) {
        return null
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
      consola.debug(
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
      machineId: account.machineId,
      sessionId: account.sessionId,
      proxy: account.proxy,
    }

    try {
      // --- Anti-correlation: frequency limiting ---
      // Enforce minimum interval between requests on the same account
      if (account.lastRequestAt) {
        const elapsed = Date.now() - account.lastRequestAt
        if (elapsed < MIN_SAME_ACCOUNT_INTERVAL_MS) {
          await new Promise((r) =>
            setTimeout(r, MIN_SAME_ACCOUNT_INTERVAL_MS - elapsed),
          )
        }
      }

      // --- Anti-correlation: inter-account jitter ---
      // Add random delay when switching between accounts
      if (lastUsedAccountId && lastUsedAccountId !== account.id) {
        const jitter =
          ACCOUNT_SWITCH_JITTER_MIN_MS
          + Math.random()
            * (ACCOUNT_SWITCH_JITTER_MAX_MS - ACCOUNT_SWITCH_JITTER_MIN_MS)
        consola.debug(
          `Account switch jitter: ${Math.round(jitter)}ms (${lastUsedAccountId.slice(0, 8)} → ${account.id.slice(0, 8)})`,
        )
        await new Promise((r) => setTimeout(r, jitter))
      }
      // eslint-disable-next-line require-atomic-updates
      lastUsedAccountId = account.id

      const result = await doFetch(payload, tokenSource, account.id)
      account.lastRequestAt = Date.now()
      accountManager.markAccountSuccess(account.id)
      // Tag streaming results with account info for keepalive targeting
      if (Symbol.asyncIterator in result) {
        ;(
          result as AsyncGenerator & {
            __accountInfo?: StreamAccountInfo
          }
        ).__accountInfo = {
          accountId: account.id,
          accountProxy: account.proxy,
          apiBaseUrl: copilotBaseUrl(tokenSource),
        }
      }
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
  accountId?: string,
): Promise<AsyncGenerator | ChatCompletionResponse> {
  const enableVision = payload.messages.some(
    (msg) =>
      typeof msg.content !== "string"
      && msg.content?.some((part) => part.type === "image_url"),
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
  const response = await fetchWithRetry(
    url,
    () => ({
      method: "POST",
      headers: buildHeaders(),
      body: bodyString,
    }),
    { accountId, accountProxy: source.proxy },
  )

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
  reasoning_content?: string | null
  reasoning_text?: string | null
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
  reasoning_content?: string | null
  reasoning_text?: string | null
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

  // OpenAI reasoning_effort parameter — triggers Copilot thinking mode
  reasoning_effort?: "low" | "medium" | "high" | "max" | null

  // Copilot thinking budget — number of tokens allocated for thinking
  thinking_budget?: number | null
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
