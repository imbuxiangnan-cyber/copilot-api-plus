/**
 * Generic multi-account rotation helper.
 *
 * Extracted from `services/copilot/create-chat-completions.ts` so that the
 * same orchestration (breaker fast-fail, account selection with retries,
 * frequency limiting, inter-account jitter, 401 token refresh, 408
 * propagation, network-error single-retry, circuit-breaker bookkeeping) can
 * be reused by other endpoints — currently:
 *
 *   - `/chat/completions` Chat-API path (`createWithMultiAccount`)
 *   - `/chat/completions` Responses-API passthrough (`forwardResponsesAsChat`)
 *
 * The caller injects the per-request bits via a small set of callbacks:
 *
 *   - `transport`   — actually performs the HTTP call for one account
 *   - `extractStreamInfo` — tag streaming results with account info for the
 *                          keepalive/proxy machinery
 *   - `on400`       — optional Chat-specific 400 retry hooks (downgrade
 *                     reasoning_effort, strip reasoning when tools present).
 *                     The Responses passthrough does NOT pass this since
 *                     those Chat-shape error messages don't apply.
 *
 * Everything else (account selection, marking, refresh, jitter) is generic.
 */

import consola from "consola"

import { accountManager, type Account } from "~/lib/account-manager"
import { copilotBaseUrl, type TokenSource } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { resetAccountConnections, type StreamAccountInfo } from "~/lib/proxy"
import { state } from "~/lib/state"

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

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------
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

export function breakerOpenRemainingMs(): number {
  if (breaker.openedAt === 0) return 0
  const elapsed = Date.now() - breaker.openedAt
  return elapsed >= CB_OPEN_MS ? 0 : CB_OPEN_MS - elapsed
}

export function recordBreakerSuccess(): void {
  if (breaker.failures !== 0 || breaker.openedAt !== 0) {
    consola.info("Circuit breaker: closing (request succeeded)")
  }
  breaker.failures = 0
  breaker.openedAt = 0
}

export function recordBreakerFailure(reason: string): void {
  breaker.failures += 1
  if (breaker.failures >= CB_THRESHOLD && breaker.openedAt === 0) {
    breaker.openedAt = Date.now()
    consola.warn(
      `Circuit breaker OPEN for ${CB_OPEN_MS / 1000}s after ${breaker.failures} consecutive failures (last: ${reason})`,
    )
  }
}

/**
 * Throw a 503 if the breaker is open (caller-facing fast-fail).
 */
export function throwIfBreakerOpen(): void {
  const remaining = breakerOpenRemainingMs()
  if (remaining <= 0) return
  throw new HTTPError(
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
}

// ---------------------------------------------------------------------------
// Generic rotation runner
// ---------------------------------------------------------------------------

/**
 * Result tag — present on streaming generators so the keepalive layer can
 * scope its connection management to the right account.
 */
type Taggable = AsyncGenerator & { __accountInfo?: StreamAccountInfo }

interface HandleErrorContext<TPayload, TResult> {
  payload: TPayload
  tokenSource: TokenSource
  hasOtherAccount: boolean
  /** Re-run the transport for a same-account retry (e.g. token refresh). */
  redoTransport: (
    payload: TPayload,
    tokenSource: TokenSource,
    accountId: string,
  ) => Promise<TResult>
}

export interface RunWithAccountRotationOptions<TPayload, TResult> {
  /** A short label for logs (e.g. `"chat"`, `"responses-passthrough"`). */
  label: string

  /** The opaque payload — passed through to `transport` and `on400`. */
  payload: TPayload

  /**
   * Executes one HTTP attempt against a single account.
   * Should throw `HTTPError` for HTTP failures and `Error` for network ones.
   */
  transport: (
    payload: TPayload,
    tokenSource: TokenSource,
    accountId: string,
  ) => Promise<TResult>

  /**
   * Optional 400-recovery hooks (Chat-specific). If provided and the
   * function returns a non-null `TResult`, the rotation terminates with
   * that result. If it returns null, error handling continues.
   */
  on400?: (
    error: HTTPError,
    ctx: HandleErrorContext<TPayload, TResult>,
    account: Account,
  ) => Promise<TResult | null>
}

/**
 * Orchestrate up to 3 account attempts with rotation, jitter, breaker,
 * 401/403/408/429/5xx handling, and one same-account retry on network
 * errors. The caller supplies the actual HTTP call via `transport`.
 *
 * Behavior mirrors the previous in-file implementation of
 * `createWithMultiAccount` in `create-chat-completions.ts`.
 */
// eslint-disable-next-line max-lines-per-function, complexity
export async function runWithAccountRotation<TPayload, TResult>(
  opts: RunWithAccountRotationOptions<TPayload, TResult>,
): Promise<TResult> {
  throwIfBreakerOpen()

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
      // Frequency limiting: minimum interval between requests on same account
      if (account.lastRequestAt) {
        const elapsed = Date.now() - account.lastRequestAt
        if (elapsed < MIN_SAME_ACCOUNT_INTERVAL_MS) {
          await new Promise((r) =>
            setTimeout(r, MIN_SAME_ACCOUNT_INTERVAL_MS - elapsed),
          )
        }
      }

      // Inter-account jitter: random delay when switching between accounts
      if (lastUsedAccountId && lastUsedAccountId !== account.id) {
        const jitter =
          ACCOUNT_SWITCH_JITTER_MIN_MS
          + Math.random()
            * (ACCOUNT_SWITCH_JITTER_MAX_MS - ACCOUNT_SWITCH_JITTER_MIN_MS)
        consola.debug(
          `[${opts.label}] Account switch jitter: ${Math.round(jitter)}ms (${lastUsedAccountId.slice(0, 8)} → ${account.id.slice(0, 8)})`,
        )
        await new Promise((r) => setTimeout(r, jitter))
      }
      // eslint-disable-next-line require-atomic-updates
      lastUsedAccountId = account.id

      const result = await opts.transport(opts.payload, tokenSource, account.id)
      account.lastRequestAt = Date.now()
      accountManager.markAccountSuccess(account.id)
      recordBreakerSuccess()

      // Tag streaming results with account info for keepalive targeting
      if (
        typeof result === "object"
        && result !== null
        && Symbol.asyncIterator in (result as object)
      ) {
        ;(result as unknown as Taggable).__accountInfo = {
          accountId: account.id,
          accountProxy: account.proxy,
          apiBaseUrl: copilotBaseUrl(tokenSource),
        }
      }
      return result
    } catch (error) {
      lastError = error

      if (error instanceof HTTPError) {
        const retryResult = await handleHttpError(error, account, {
          payload: opts.payload,
          tokenSource,
          hasOtherAccount: hasAnotherAccountToTry(triedAccountIds),
          redoTransport: opts.transport,
          on400: opts.on400,
        })
        if (retryResult !== null) return retryResult
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
        const errMsg = (error as Error).message || String(error)
        if (!networkRetried) {
          networkRetried = true
          consola.warn(
            `[${opts.label}] Account ${account.label}: network error, resetting pool and retrying once: ${errMsg}`,
          )
          resetAccountConnections(account.id)
          triedAccountIds.delete(account.id) // allow same account to be picked again
          continue
        }
        consola.warn(
          `[${opts.label}] Account ${account.label}: network error after retry (giving up): ${errMsg}`,
        )
        recordBreakerFailure(`network: ${errMsg.slice(0, 80)}`)
        throw error
      }

      consola.warn(
        `[${opts.label}] Account ${account.label} failed (attempt ${attempt + 1})${
          hasAnotherAccountToTry(triedAccountIds) ? ", trying next..." : (
            " — no other accounts available, propagating error"
          )
        }`,
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

/**
 * Peek at whether `getActiveAccount()` would return an untried account on
 * the next iteration. Used purely for honest log messaging.
 */
function hasAnotherAccountToTry(triedAccountIds: Set<string>): boolean {
  const next = accountManager.getActiveAccount()
  return next !== undefined && !triedAccountIds.has(next.id)
}

// ---------------------------------------------------------------------------
// HTTP error handling (account-level: rotate / mark / refresh)
// ---------------------------------------------------------------------------

/**
 * Try to refresh the account's token and retry the transport once.
 * Returns the success result or null on failure.
 */
async function tryRefreshAndRetry<TPayload, TResult>(
  account: Account,
  ctx: HandleErrorContext<TPayload, TResult>,
): Promise<TResult | null> {
  try {
    await accountManager.refreshAccountToken(account)
    ctx.tokenSource.copilotToken = account.copilotToken
    const result = await ctx.redoTransport(
      ctx.payload,
      ctx.tokenSource,
      account.id,
    )
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
 * Handle a 429 from upstream: detect Copilot 5h Pro+ session-limit signature,
 * snapshot GitHub /rate_limit, and decide whether to mark the account or
 * propagate the error to the client (single-account guard).
 */
async function handle429(
  error: HTTPError,
  account: Account,
  hasOtherAccount: boolean,
): Promise<null> {
  let body: string
  try {
    body = await error.response.clone().text()
  } catch {
    body = error.message || ""
  }
  const isCopilotSessionLimit = body.includes(
    "user_global_rate_limited:pro_plus",
  )
  if (isCopilotSessionLimit) {
    accountManager.markCopilotSessionLimit(
      account.id,
      "user_global_rate_limited:pro_plus",
    )
  }
  void accountManager.refreshGithubRateLimit(account)

  if (!hasOtherAccount) {
    consola.warn(
      `Account ${account.label}: 429 — only account, propagating to client without marking`,
    )
    ;(error as HTTPError & { __nonAccountError?: boolean }).__nonAccountError =
      true
    return null
  }
  accountManager.markAccountStatus(
    account.id,
    "rate_limited",
    isCopilotSessionLimit ? "429 Copilot 5h session limit" : "429 Rate limited",
  )
  return null
}

async function handleHttpError<TPayload, TResult>(
  error: HTTPError,
  account: Account,
  ctx: HandleErrorContext<TPayload, TResult> & {
    on400?: RunWithAccountRotationOptions<TPayload, TResult>["on400"]
  },
): Promise<TResult | null> {
  switch (error.response.status) {
    case 401: {
      consola.warn(`Account ${account.label}: 401, refreshing token...`)
      return tryRefreshAndRetry(account, ctx)
    }
    case 403: {
      // Single-account guard: marking the only account as banned would
      // disable the proxy for everything. Propagate to the client instead.
      if (!ctx.hasOtherAccount) {
        consola.warn(
          `Account ${account.label}: 403 — only account, propagating to client without marking`,
        )
        ;(
          error as HTTPError & { __nonAccountError?: boolean }
        ).__nonAccountError = true
        return null
      }
      accountManager.markAccountStatus(account.id, "banned", "403 Forbidden")
      return null
    }
    case 429: {
      return handle429(error, account, ctx.hasOtherAccount)
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
      // 400: caller-supplied hooks may downgrade/strip params and retry on
      // the SAME account before we fall through to rotation.
      if (error.response.status === 400 && ctx.on400) {
        const hookResult = await ctx.on400(error, ctx, account)
        if (hookResult !== null) return hookResult
      }
      // Non-account 400 errors (model not supported, invalid request body,
      // tool_choice + thinking conflict, etc.) — these are NOT account
      // problems. Return null WITHOUT marking the account as failed,
      // and tag the error so the outer loop knows to stop rotating.
      if (error.response.status === 400 && isNonAccountError(error.message)) {
        ;(
          error as HTTPError & { __nonAccountError?: boolean }
        ).__nonAccountError = true
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

/**
 * Whether a 400 error is caused by the request itself (model unavailable,
 * invalid params, etc.) rather than the account. These should NOT trigger
 * account disabling or rotation — rotating to another account would just
 * waste credits hitting the same error.
 */
export function isNonAccountError(errMsg: string): boolean {
  return (
    errMsg.includes("model_not_supported")
    || errMsg.includes("unsupported_api_for_model")
    || errMsg.includes("not accessible via the /chat/completions endpoint")
    || errMsg.includes("The requested model is not supported")
    || errMsg.includes("invalid_request_body")
    || errMsg.includes("invalid_request_error")
    || errMsg.includes("invalid_reasoning_effort")
    || errMsg.includes("reasoning_effort")
    || errMsg.includes("tool_choice")
  )
}
