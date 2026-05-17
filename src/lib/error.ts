import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

import { accountManager } from "~/lib/account-manager"
import { rootCause } from "~/lib/utils"

export class HTTPError extends Error {
  response: Response

  constructor(message: string, response: Response) {
    super(message)
    this.response = response
  }
}

/**
 * Compute the earliest "retry after" timestamp (ms epoch) across all
 * accounts' known rate-limit windows. Used to surface a countdown to
 * downstream clients (Claude Code / Codex) so the user sees when the
 * proxy is expected to recover.
 *
 * Returns:
 *  - the earliest resetAt timestamp in ms,
 *  - the source label ("copilot-5h", "github-core", "github-search", ...),
 *  - the seconds remaining until that reset.
 *
 * Returns undefined if no account has a known active limit.
 */
type RateLimitReset = {
  resetAt: number
  source: string
  secondsRemaining: number
}

function earlierReset(
  current: RateLimitReset | undefined,
  candidate: { resetAt: number; source: string },
  now: number,
): RateLimitReset | undefined {
  if (candidate.resetAt <= now) return current
  if (current && candidate.resetAt >= current.resetAt) return current
  return {
    resetAt: candidate.resetAt,
    source: candidate.source,
    secondsRemaining: Math.ceil((candidate.resetAt - now) / 1000),
  }
}

function earliestRateLimitReset(): RateLimitReset | undefined {
  const now = Date.now()
  let earliest: RateLimitReset | undefined

  for (const account of accountManager.getAccounts()) {
    const limits = account.limits
    if (!limits) continue

    const session = limits.copilotSession
    if (session) {
      earliest = earlierReset(
        earliest,
        { resetAt: session.estimatedResetAt, source: "copilot-5h" },
        now,
      )
    }

    // GitHub REST API quotas (reset is unix seconds). Prefer the full
    // resources map when available; fall back to the legacy core-shaped object.
    const gh = limits.github
    const ghResources = gh?.resources ?? (gh ? { core: gh } : undefined)
    if (!ghResources) continue

    for (const [name, resource] of Object.entries(ghResources)) {
      if (resource.limit <= 0 || resource.remaining !== 0) continue
      earliest = earlierReset(
        earliest,
        { resetAt: resource.reset * 1000, source: `github-${name}` },
        now,
      )
    }
  }

  return earliest
}

/** Format seconds as a compact human countdown ("≤ 4h 32m" / "12m 03s"). */
function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "now"
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `≤ ${h}h ${m}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`
  return `${s}s`
}

export async function forwardError(c: Context, error: unknown) {
  if (error instanceof HTTPError) {
    // Try to read error body, but it may already be consumed by the caller
    let errorText: string
    try {
      errorText = await error.response.text()
    } catch {
      // Body already read — fall back to the error message
      errorText = error.message
    }

    // 400 errors: concise log, already detailed upstream
    if (error.response.status === 400) {
      // no extra logging, upstream already printed details
    } else {
      let errorJson: unknown
      try {
        errorJson = JSON.parse(errorText)
      } catch {
        errorJson = errorText
      }
      consola.warn(`Error occurred: ${rootCause(error)}`)
      consola.debug("HTTP error:", errorJson)
    }

    const isCopilotSessionLimit =
      error.response.status === 429
      && errorText.includes("user_global_rate_limited:pro_plus")
    if (isCopilotSessionLimit) {
      c.header("x-should-retry", "false")
    }

    // For 429 (or any flavour we surface as 403), add a countdown so
    // downstream clients can display "X minutes until proxy recovers".
    let augmentedMessage = errorText
    let retrySeconds: number | undefined
    if (error.response.status === 429 || isCopilotSessionLimit) {
      const reset = earliestRateLimitReset()
      if (reset) {
        retrySeconds = reset.secondsRemaining
        c.header("retry-after", String(reset.secondsRemaining))
        c.header("x-ratelimit-reset", String(Math.floor(reset.resetAt / 1000)))
        c.header("x-ratelimit-source", reset.source)
        const suffix = `\n\nProxy rate-limit (${reset.source}): retry in ${formatCountdown(reset.secondsRemaining)} (resets at ${new Date(reset.resetAt).toISOString()}).`
        augmentedMessage = `${errorText}${suffix}`
      }
    }

    return c.json(
      {
        error: {
          message: augmentedMessage,
          type: "error",
          ...(retrySeconds !== undefined && {
            retry_after_seconds: retrySeconds,
          }),
        },
      },
      (isCopilotSessionLimit ? 403 : (
        error.response.status
      )) as ContentfulStatusCode,
    )
  }

  // Network errors (fetch failed, TLS disconnect, etc.) — concise log
  const message = (error as Error).message || String(error)
  const cause = (error as { cause?: Error }).cause
  if (cause) {
    consola.error(`${message}: ${cause.message}`)
  } else {
    consola.error(message)
  }
  return c.json(
    {
      error: {
        message: (error as Error).message,
        type: "error",
      },
    },
    500,
  )
}
