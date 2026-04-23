/* eslint-disable max-lines */
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
  // Thinking cannot be enabled when tool_choice forces tool use.
  // This check must come FIRST — even if the client explicitly set
  // reasoning_effort / thinking_budget, the API will reject the combination.
  if (isToolChoiceForced(payload.tool_choice)) {
    if (payload.reasoning_effort || payload.thinking_budget) {
      const stripped = { ...payload }
      delete stripped.reasoning_effort
      delete stripped.thinking_budget
      consola.debug(
        `Thinking: stripped reasoning params for "${resolvedModel}" because tool_choice forces tool use`,
      )
      return stripped
    }
    return payload
  }

  // Client already specified thinking params — respect them, but still
  // apply the runtime-learned cap if the model rejected "high" previously.
  if (payload.reasoning_effort || payload.thinking_budget) {
    if (
      payload.reasoning_effort
      && payload.reasoning_effort !== "medium"
      && payload.reasoning_effort !== "low"
    ) {
      const cap = reasoningEffortCap.get(resolvedModel)
      if (cap) return { ...payload, reasoning_effort: cap }
    }
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
    const retryResult = handle400ReasoningError(
      error,
      { resolvedModel, thinkingPayload, routedPayload, wasInjected },
      releaseSlot,
    )
    if (retryResult !== undefined) return retryResult

    releaseSlot()
    throw error
  }
}

/**
 * Handle 400 reasoning_effort errors in the outer createChatCompletions catch.
 * Returns a Promise (retry result) if handled, or undefined to re-throw.
 */
function handle400ReasoningError(
  error: unknown,
  ctx: {
    resolvedModel: string
    thinkingPayload: ChatCompletionsPayload
    routedPayload: ChatCompletionsPayload
    wasInjected: boolean
  },
  releaseSlot: () => void,
): Promise<AsyncGenerator | ChatCompletionResponse> | undefined {
  if (!(error instanceof HTTPError) || error.response.status !== 400)
    return undefined
  const errMsg = error.message

  // Case 2: Model rejects the specific value (e.g. "high" not supported, only "medium")
  if (
    errMsg.includes("supported values")
    || (errMsg.includes("is not supported by model")
      && errMsg.includes("reasoning_effort"))
  ) {
    const currentEffort = ctx.thinkingPayload.reasoning_effort
    if (
      currentEffort
      && currentEffort !== "medium"
      && currentEffort !== "low"
    ) {
      reasoningEffortCap.set(ctx.resolvedModel, "medium")
      consola.debug(
        `Model "${ctx.resolvedModel}" rejected reasoning_effort="${currentEffort}" — downgrading to "medium"`,
      )
      return retryWithModifiedPayload(
        { ...ctx.routedPayload, reasoning_effort: "medium" as const },
        releaseSlot,
      )
    }
  }

  // Case 1: Model doesn't support reasoning_effort at all
  if (
    ctx.wasInjected
    && (errMsg.includes("Unrecognized request argument")
      || errMsg.includes("does not support reasoning")
      || errMsg.includes("invalid_reasoning_effort"))
  ) {
    reasoningUnsupportedModels.add(ctx.resolvedModel)
    consola.debug(
      `Model "${ctx.resolvedModel}" does not support reasoning_effort — disabled for future requests`,
    )
    return retryWithModifiedPayload(ctx.routedPayload, releaseSlot)
  }

  return undefined
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
      // reasoning_effort / thinking 相关的 400 是预期内的(会被自动降级重试),
      // 静默到 debug 避免误导用户。其他 400 保留 warn。
      const isExpectedReasoningError =
        errorBody.includes("reasoning_effort")
        || errorBody.includes("invalid_reasoning_effort")
        || errorBody.includes("does not support reasoning")
      const isModelNotSupported = errorBody.includes("model_not_supported")
      if (isExpectedReasoningError || isModelNotSupported) {
        consola.debug(`400 (auto-handled): ${errorBody}`)
      } else {
        consola.warn(`400: ${errorBody}`)
      }
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

/** Try to retry a 400 with downgraded reasoning_effort on the same account. */
async function tryDowngradeReasoningEffort(
  errMsg: string,
  retryContext: { payload: ChatCompletionsPayload; tokenSource: TokenSource },
  accountId: string,
): Promise<AsyncGenerator | ChatCompletionResponse | null> {
  const isEffortRejection =
    errMsg.includes("supported values")
    || (errMsg.includes("is not supported by model")
      && errMsg.includes("reasoning_effort"))
  if (!isEffortRejection) return null

  const currentEffort = retryContext.payload.reasoning_effort
  if (!currentEffort || currentEffort === "medium" || currentEffort === "low")
    return null

  reasoningEffortCap.set(retryContext.payload.model, "medium")
  const downgraded = {
    ...retryContext.payload,
    reasoning_effort: "medium" as const,
  }
  try {
    return await doFetch(downgraded, retryContext.tokenSource, accountId)
  } catch {
    return null
  }
}

/**
 * Whether a 400 error is caused by the request itself (model unavailable,
 * invalid params, etc.) rather than the account. These should NOT trigger
 * account disabling or rotation — rotating to another account would just
 * waste credits hitting the same error.
 */
function isNonAccountError(errMsg: string): boolean {
  return (
    errMsg.includes("model_not_supported")
    || errMsg.includes("The requested model is not supported")
    || errMsg.includes("invalid_request_body")
    || errMsg.includes("invalid_request_error")
    || errMsg.includes("invalid_reasoning_effort")
    || errMsg.includes("reasoning_effort")
    || errMsg.includes("tool_choice")
  )
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
    case 408: {
      // 408 Request Timeout: the upstream timed out reading our request body.
      // This is a network/proxy issue (slow uplink, Clash hiccup), NOT an
      // account problem. Don't mark the account, don't rotate.
      consola.warn(
        `Account ${account.label}: 408 request timeout (network issue, not rotating)`,
      )
      ;(
        error as HTTPError & { __nonAccountError?: boolean }
      ).__nonAccountError = true
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
        recordBreakerFailure(`HTTP ${error.response.status}`)
        return null
      }
      // 400: check if it's a reasoning_effort value rejection first.
      // If so, downgrade to "medium" and retry on the SAME account before
      // falling through to account rotation.
      if (error.response.status === 400) {
        const downgraded = await tryDowngradeReasoningEffort(
          error.message,
          retryContext,
          account.id,
        )
        if (downgraded !== null) return downgraded

        // Non-account 400 errors (model not supported, invalid request body,
        // tool_choice + thinking conflict, etc.) — these are NOT account
        // problems. Return null WITHOUT marking the account as failed,
        // and tag the error so the outer loop knows to stop rotating.
        if (isNonAccountError(error.message)) {
          ;(
            error as HTTPError & { __nonAccountError?: boolean }
          ).__nonAccountError = true
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

// ---------------------------------------------------------------------------
// Circuit breaker for upstream/network failures.
//
// When the upstream (or our path to it via Clash) is broken, we used to keep
// retrying every request, each one waiting ~5–30s before the inevitable
// timeout — a self-inflicted DoS. Instead, after CB_THRESHOLD consecutive
// network/5xx failures we OPEN the circuit: every new request fails fast
// with a 503 for CB_OPEN_MS. After that window we go HALF-OPEN: the next
// request is a probe; success closes the circuit, failure re-opens it.
//
// Tuning: 3 failures / 30s. Standard Hystrix-ish default. Real Clash
// hiccups self-heal in 1–2 retries; 3 means it's actually broken.
// ---------------------------------------------------------------------------
const CB_THRESHOLD = 3
const CB_OPEN_MS = 30_000

const breaker = {
  failures: 0,
  openedAt: 0, // 0 = closed
}

function breakerOpenRemainingMs(): number {
  if (breaker.openedAt === 0) return 0
  const elapsed = Date.now() - breaker.openedAt
  return elapsed >= CB_OPEN_MS ? 0 : CB_OPEN_MS - elapsed
}

function recordBreakerSuccess(): void {
  if (breaker.failures !== 0 || breaker.openedAt !== 0) {
    consola.info("Circuit breaker: closing (request succeeded)")
  }
  breaker.failures = 0
  breaker.openedAt = 0
}

function recordBreakerFailure(reason: string): void {
  breaker.failures += 1
  if (breaker.failures >= CB_THRESHOLD && breaker.openedAt === 0) {
    breaker.openedAt = Date.now()
    consola.warn(
      `Circuit breaker OPEN for ${CB_OPEN_MS / 1000}s after ${breaker.failures} consecutive failures (last: ${reason})`,
    )
  }
}

// eslint-disable-next-line max-lines-per-function, complexity
async function createWithMultiAccount(payload: ChatCompletionsPayload) {
  // Fast-fail if the breaker is open. Half-open: let one probe through.
  const remaining = breakerOpenRemainingMs()
  if (remaining > 0) {
    const err = new HTTPError(
      "Upstream temporarily unavailable",
      new Response(
        JSON.stringify({
          error: {
            type: "service_unavailable",
            message: `Upstream (or proxy) is failing repeatedly. Circuit breaker open; will retry probe in ${Math.ceil(remaining / 1000)}s.`,
          },
        }),
        {
          status: 503,
          statusText: "Service Unavailable",
          headers: {
            "content-type": "application/json",
            "retry-after": String(Math.ceil(remaining / 1000)),
          },
        },
      ),
    )
    throw err
  }

  const triedAccountIds = new Set<string>()
  let lastError: unknown
  // Per-call flag: allow ONE same-account retry after a network error.
  // Reset connection pool first so we don't reuse a dead socket.
  let networkRetried = false

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
      recordBreakerSuccess()
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
        // Non-account error — stop rotating, propagate to client.
        if (
          (error as HTTPError & { __nonAccountError?: boolean })
            .__nonAccountError
        ) {
          throw error
        }
      } else {
        // Network error (ECONNRESET, TLS disconnect, fetch failed, etc.):
        // these are local/proxy/route problems, NOT account problems.
        // Strategy: reset THIS account's connection pool (kill stale
        // sockets) and retry the same account ONCE. If it fails again,
        // throw — let the client (Claude Code) decide whether to retry.
        const errMsg = (error as Error).message || String(error)
        if (!networkRetried) {
          networkRetried = true
          consola.warn(
            `Account ${account.label}: network error, resetting pool and retrying once: ${errMsg}`,
          )
          resetAccountConnections(account.id)
          triedAccountIds.delete(account.id) // allow same account to be picked again
          continue
        }
        consola.warn(
          `Account ${account.label}: network error after retry (giving up): ${errMsg}`,
        )
        recordBreakerFailure(`network: ${errMsg.slice(0, 80)}`)
        throw error
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
      // reasoning_effort / thinking 相关的 400 是预期内的(会被自动降级重试),
      // 静默到 debug 避免误导用户。其他 400 保留 warn。
      const isExpectedReasoningError =
        errorBody.includes("reasoning_effort")
        || errorBody.includes("invalid_reasoning_effort")
        || errorBody.includes("does not support reasoning")
      const isModelNotSupported = errorBody.includes("model_not_supported")
      if (isExpectedReasoningError || isModelNotSupported) {
        consola.debug(`400 (auto-handled): ${errorBody}`)
      } else {
        consola.warn(`400: ${errorBody}`)
      }
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
