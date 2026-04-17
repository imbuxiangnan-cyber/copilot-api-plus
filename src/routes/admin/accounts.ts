import consola from "consola"
import { Hono } from "hono"

import type { Account } from "~/lib/account-manager"

import { accountManager } from "~/lib/account-manager"
import {
  GITHUB_BASE_URL,
  GITHUB_CLIENT_ID,
  standardHeaders,
} from "~/lib/api-config"
import { rootCause } from "~/lib/utils"
import { getDeviceCode } from "~/services/github/get-device-code"

export const accountRoutes = new Hono()

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

    // Set optional per-account proxy for IP isolation
    if (body.proxy) {
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

    return c.json({ account: sanitiseAccount(account) })
  } catch (error) {
    consola.warn(`Error refreshing account: ${rootCause(error)}`)
    consola.debug("Error refreshing account:", error)
    return c.json({ error: "Failed to refresh account" }, 500)
  }
})

// ---------------------------------------------------------------------------
// POST /auth/start — Initiate GitHub Device Code flow
// ---------------------------------------------------------------------------

accountRoutes.post("/auth/start", async (c) => {
  try {
    const deviceCode = await getDeviceCode()
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

    // Single poll attempt to GitHub's token endpoint
    const response = await fetch(
      `${GITHUB_BASE_URL}/login/oauth/access_token`,
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
      return c.json({ status: "pending" })
    }

    const json = (await response.json()) as
      | { access_token: string; token_type: string; scope: string }
      | { error: string; error_description?: string }

    // Handle error responses from GitHub
    if ("error" in json) {
      switch (json.error) {
        case "authorization_pending": {
          return c.json({ status: "pending" })
        }
        case "slow_down": {
          return c.json({ status: "pending", interval: 10 })
        }
        case "expired_token": {
          return c.json({ status: "expired" })
        }
        case "access_denied": {
          return c.json({ status: "denied" })
        }
        default: {
          return c.json({
            status: "error",
            message: json.error_description || json.error,
          })
        }
      }
    }

    // Success — we have an access token
    if ("access_token" in json && json.access_token) {
      const accountLabel = label || `Account ${accountManager.accountCount + 1}`
      const account = await accountManager.addAccount(
        json.access_token,
        accountLabel,
        account_type || "individual",
      )
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
