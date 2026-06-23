import consola from "consola"
import { Hono } from "hono"

import type { Account } from "~/lib/account-manager"

import { accountManager } from "~/lib/account-manager"
import {
  GITHUB_CLIENT_ID,
  githubBaseUrl,
  standardHeaders,
} from "~/lib/api-config"
import { rootCause } from "~/lib/utils"
import {
  getDeviceCode,
  type DeviceCodeResponse,
} from "~/services/github/get-device-code"

export const accountRoutes = new Hono()

// ---------------------------------------------------------------------------
// Device code cache — prevent frontend retries from generating new codes
// while the user is still authorizing the previous one on GitHub.
// ---------------------------------------------------------------------------
let cachedDeviceCode: DeviceCodeResponse | undefined
let cachedDeviceCodeExpiresAt = 0

// Rate-limit guard — refuse to hit GitHub before the required interval elapses.
// When GitHub returns "slow_down", it tells us how long to wait.  The frontend
// ignores this and keeps polling every ~4 s, which locks us into permanent
// slow_down.  The server enforces the interval instead.
let pollNotBefore = 0

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function maskToken(token: string): string {
  if (token.length <= 8) return "****"
  return `${token.slice(0, 4)}...${token.slice(-4)}`
}

/**
 * Return a sanitised copy of an account safe for API responses.
 * - `githubToken` is masked.
 * - `copilotToken` is fully excluded.
 */
function sanitiseAccount(account: Account) {
  const { copilotToken: _dropped, githubToken, ...rest } = account
  return {
    ...rest,
    githubToken: maskToken(githubToken),
  }
}

// ---------------------------------------------------------------------------
// GET / — List all accounts (token masked)
// ---------------------------------------------------------------------------

accountRoutes.get("/", (c) => {
  try {
    const accounts = accountManager.getAccounts().map((a) => sanitiseAccount(a))
    return c.json({ accounts })
  } catch (error) {
    consola.warn(`Error listing accounts: ${rootCause(error)}`)
    consola.debug("Error listing accounts:", error)
    return c.json({ error: "Failed to list accounts" }, 500)
  }
})

// ---------------------------------------------------------------------------
// POST / — Add account
// ---------------------------------------------------------------------------

accountRoutes.post("/", async (c) => {
  try {
    const body = await c.req.json<{
      githubToken: string
      label: string
      accountType?: string
      proxy?: string
    }>()

    if (!body.githubToken || !body.label) {
      return c.json({ error: "githubToken and label are required" }, 400)
    }

    const account = await accountManager.addAccount(
      body.githubToken,
      body.label,
      body.accountType,
    )

    // Snapshot GitHub /rate_limit at account creation (free endpoint).
    void accountManager.refreshGithubRateLimit(account)

    // Set optional per-account proxy for IP isolation
    if (body.proxy) {
      try {
        const proxyUrl = new URL(body.proxy)
        if (!["http:", "https:", "socks5:"].includes(proxyUrl.protocol)) {
          return c.json(
            {
              error: "proxy must use http://, https://, or socks5:// protocol",
            },
            400,
          )
        }
      } catch {
        return c.json({ error: "proxy must be a valid URL" }, 400)
      }
      account.proxy = body.proxy
      await accountManager.saveAccounts()
    }

    return c.json({ account: sanitiseAccount(account) }, 201)
  } catch (error) {
    consola.warn(`Error adding account: ${rootCause(error)}`)
    consola.debug("Error adding account:", error)
    return c.json({ error: "Failed to add account" }, 500)
  }
})

// ---------------------------------------------------------------------------
// DELETE /:id — Remove account
// ---------------------------------------------------------------------------

accountRoutes.delete("/:id", async (c) => {
  try {
    const id = c.req.param("id")
    const removed = await accountManager.removeAccount(id)

    if (!removed) {
      return c.json({ error: "Account not found" }, 404)
    }

    return c.json({ success: true })
  } catch (error) {
    consola.warn(`Error removing account: ${rootCause(error)}`)
    consola.debug("Error removing account:", error)
    return c.json({ error: "Failed to remove account" }, 500)
  }
})

// ---------------------------------------------------------------------------
// PUT /:id/status — Update account status (enable / disable)
// ---------------------------------------------------------------------------

accountRoutes.put("/:id/status", async (c) => {
  try {
    const id = c.req.param("id")
    const body = await c.req.json<{ status: string }>()

    if (body.status !== "active" && body.status !== "disabled") {
      return c.json({ error: 'status must be "active" or "disabled"' }, 400)
    }

    const account = accountManager.getAccountById(id)
    if (!account) {
      return c.json({ error: "Account not found" }, 404)
    }

    account.status = body.status
    account.statusMessage = undefined

    // When manually activating, also clear cooldown and failure counters
    if (body.status === "active") {
      account.cooldownUntil = undefined
      account.consecutiveFailures = 0
    }

    await accountManager.saveAccounts()

    return c.json({ account: sanitiseAccount(account) })
  } catch (error) {
    consola.warn(`Error updating account status: ${rootCause(error)}`)
    consola.debug("Error updating account status:", error)
    return c.json({ error: "Failed to update account status" }, 500)
  }
})

// ---------------------------------------------------------------------------
// PUT /:id/proxy — Update account proxy
// ---------------------------------------------------------------------------

accountRoutes.put("/:id/proxy", async (c) => {
  try {
    const id = c.req.param("id")
    const body = await c.req.json<{ proxy: string | null }>()

    const account = accountManager.getAccountById(id)
    if (!account) {
      return c.json({ error: "Account not found" }, 404)
    }

    if (body.proxy) {
      try {
        const proxyUrl = new URL(body.proxy)
        if (!["http:", "https:", "socks5:"].includes(proxyUrl.protocol)) {
          return c.json(
            {
              error: "proxy must use http://, https://, or socks5:// protocol",
            },
            400,
          )
        }
      } catch {
        return c.json({ error: "proxy must be a valid URL" }, 400)
      }
      account.proxy = body.proxy
    } else {
      account.proxy = undefined
    }

    await accountManager.saveAccounts()
    return c.json({ account: sanitiseAccount(account) })
  } catch (error) {
    consola.warn(`Error updating account proxy: ${rootCause(error)}`)
    consola.debug("Error updating account proxy:", error)
    return c.json({ error: "Failed to update account proxy" }, 500)
  }
})

// ---------------------------------------------------------------------------
// POST /:id/refresh — Force refresh token + usage for one account
// ---------------------------------------------------------------------------

accountRoutes.post("/:id/refresh", async (c) => {
  try {
    const id = c.req.param("id")
    const account = accountManager.getAccountById(id)

    if (!account) {
      return c.json({ error: "Account not found" }, 404)
    }

    await accountManager.refreshAccountToken(account)
    await accountManager.refreshAccountUsage(account)
    await accountManager.refreshGithubRateLimit(account)

    return c.json({ account: sanitiseAccount(account) })
  } catch (error) {
    consola.warn(`Error refreshing account: ${rootCause(error)}`)
    consola.debug("Error refreshing account:", error)
    return c.json({ error: "Failed to refresh account" }, 500)
  }
})

// ---------------------------------------------------------------------------
// POST /:id/refresh-limits — Force refresh GitHub /rate_limit snapshot only
// ---------------------------------------------------------------------------

accountRoutes.post("/:id/refresh-limits", async (c) => {
  try {
    const id = c.req.param("id")
    const account = accountManager.getAccountById(id)

    if (!account) {
      return c.json({ error: "Account not found" }, 404)
    }

    await accountManager.refreshGithubRateLimit(account)
    return c.json({ account: sanitiseAccount(account) })
  } catch (error) {
    consola.warn(`Error refreshing rate limits: ${rootCause(error)}`)
    consola.debug("Error refreshing rate limits:", error)
    return c.json({ error: "Failed to refresh rate limits" }, 500)
  }
})

// ---------------------------------------------------------------------------
// POST /:id/clear-session-limit — Manually clear the Copilot 5h session marker
// ---------------------------------------------------------------------------

accountRoutes.post("/:id/clear-session-limit", (c) => {
  try {
    const id = c.req.param("id")
    const account = accountManager.getAccountById(id)

    if (!account) {
      return c.json({ error: "Account not found" }, 404)
    }

    accountManager.clearCopilotSessionLimit(id)
    return c.json({ account: sanitiseAccount(account) })
  } catch (error) {
    consola.warn(`Error clearing session limit: ${rootCause(error)}`)
    consola.debug("Error clearing session limit:", error)
    return c.json({ error: "Failed to clear session limit" }, 500)
  }
})

// ---------------------------------------------------------------------------
// POST /auth/start — Initiate GitHub Device Code flow
// ---------------------------------------------------------------------------

accountRoutes.post("/auth/start", async (c) => {
  try {
    // Reuse cached device code if it hasn't expired yet.
    // This prevents frontend retries from generating a new code while the
    // user is still authorizing the previous one on GitHub.
    if (cachedDeviceCode && Date.now() < cachedDeviceCodeExpiresAt) {
      consola.debug("Reusing cached device code (not yet expired)")
      return c.json(cachedDeviceCode)
    }

    const deviceCode = await getDeviceCode()
    // eslint-disable-next-line require-atomic-updates
    cachedDeviceCode = deviceCode
    // eslint-disable-next-line require-atomic-updates
    cachedDeviceCodeExpiresAt = Date.now() + deviceCode.expires_in * 1000
    // Reset rate-limit for the new flow

    pollNotBefore = 0
    return c.json(deviceCode)
  } catch (error) {
    consola.warn(`Error starting device code flow: ${rootCause(error)}`)
    consola.debug("Error starting device code flow:", error)
    return c.json({ error: "Failed to start device code authorization" }, 500)
  }
})

// ---------------------------------------------------------------------------
// POST /auth/poll — Poll for Device Code authorization completion
// ---------------------------------------------------------------------------

/** Reset all auth flow state (device code cache + rate limit). */
function clearAuthFlowState(): void {
  cachedDeviceCode = undefined
  cachedDeviceCodeExpiresAt = 0
  pollNotBefore = 0
}

/** Handle GitHub error responses during device code polling. */
function handlePollError(json: Record<string, unknown>):
  | {
      status: string
      interval?: number
      message?: string
    }
  | undefined {
  if (!("error" in json)) return undefined

  switch (json.error) {
    case "authorization_pending": {
      pollNotBefore = Date.now() + 5_000
      return { status: "pending" }
    }
    case "slow_down": {
      const interval = typeof json.interval === "number" ? json.interval : 10
      pollNotBefore = Date.now() + interval * 1000
      consola.info(
        `Device code poll: GitHub says slow down, waiting ${interval}s`,
      )
      return { status: "pending", interval }
    }
    case "expired_token": {
      clearAuthFlowState()
      return { status: "expired" }
    }
    case "access_denied": {
      clearAuthFlowState()
      return { status: "denied" }
    }
    default: {
      return {
        status: "error",
        message:
          (json.error_description as string | undefined)
          || (json.error as string),
      }
    }
  }
}

accountRoutes.post("/auth/poll", async (c) => {
  try {
    const { device_code, label, account_type } = await c.req.json<{
      device_code: string
      label?: string
      account_type?: string
    }>()

    if (!device_code) {
      return c.json({ error: "device_code is required" }, 400)
    }

    // Server-side rate-limit: if GitHub told us to slow down, don't hit
    // their endpoint again until the required interval has elapsed.
    // Return the cached result so the frontend sees "pending".
    const now = Date.now()
    if (now < pollNotBefore) {
      const waitSec = Math.ceil((pollNotBefore - now) / 1000)
      consola.debug(`Device code poll: throttled, ${waitSec}s remaining`)
      return c.json({ status: "pending", interval: waitSec })
    }

    // Single poll attempt to GitHub's token endpoint
    const response = await fetch(
      `${githubBaseUrl()}/login/oauth/access_token`,
      {
        method: "POST",
        headers: standardHeaders(),
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      },
    )

    if (!response.ok) {
      const errorText = await response.text().catch(() => "")
      consola.warn(
        `Device code poll: GitHub returned ${response.status}: ${errorText}`,
      )
      return c.json({ status: "pending" })
    }

    const rawText = await response.text()
    consola.debug(`Device code poll raw response: ${rawText}`)

    let json: Record<string, unknown>
    try {
      json = JSON.parse(rawText) as Record<string, unknown>
    } catch {
      consola.warn(`Device code poll: GitHub returned non-JSON: ${rawText}`)
      return c.json({ status: "pending" })
    }

    // Handle error responses from GitHub
    const errorResult = handlePollError(json)
    if (errorResult) {
      return c.json(errorResult)
    }

    // Success — we have an access token
    if ("access_token" in json && (json.access_token as string)) {
      clearAuthFlowState()

      const accountLabel = label || `Account ${accountManager.accountCount + 1}`
      const account = await accountManager.addAccount(
        json.access_token as string,
        accountLabel,
        account_type || "individual",
      )
      // Snapshot GitHub /rate_limit at account creation (free endpoint).
      void accountManager.refreshGithubRateLimit(account)
      return c.json({ status: "complete", account: sanitiseAccount(account) })
    }

    // Unexpected response shape
    return c.json({ status: "pending" })
  } catch (error) {
    consola.warn(`Error polling device code: ${rootCause(error)}`)
    consola.debug("Error polling device code:", error)
    return c.json({ error: "Failed to poll device code authorization" }, 500)
  }
})

// ---------------------------------------------------------------------------
// GET /usage — Aggregated usage across all accounts
// ---------------------------------------------------------------------------

accountRoutes.get("/usage", (c) => {
  try {
    const accounts = accountManager.getAccounts()

    const aggregatedUsage = {
      premium_remaining: 0,
      premium_total: 0,
      chat_remaining: 0,
      chat_total: 0,
    }

    const accountSummaries = accounts.map((a) => {
      if (a.usage) {
        aggregatedUsage.premium_remaining += a.usage.premium_remaining
        aggregatedUsage.premium_total += a.usage.premium_total
        aggregatedUsage.chat_remaining += a.usage.chat_remaining
        aggregatedUsage.chat_total += a.usage.chat_total
      }

      return {
        id: a.id,
        label: a.label,
        status: a.status,
        usage: a.usage ?? null,
      }
    })

    return c.json({
      totalAccounts: accounts.length,
      activeAccounts: accounts.filter((a) => a.status === "active").length,
      aggregatedUsage,
      accounts: accountSummaries,
    })
  } catch (error) {
    consola.warn(`Error fetching aggregated usage: ${rootCause(error)}`)
    consola.debug("Error fetching aggregated usage:", error)
    return c.json({ error: "Failed to fetch aggregated usage" }, 500)
  }
})
