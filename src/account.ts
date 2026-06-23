import { defineCommand } from "citty"
import consola from "consola"

import { accountManager } from "./lib/account-manager"
import { applyProxyConfig } from "./lib/config"
import { ensurePaths } from "./lib/paths"
import { initProxyFromEnv } from "./lib/proxy"
import { state } from "./lib/state"
import { cacheVSCodeVersion, rootCause } from "./lib/utils"
import { getDeviceCode } from "./services/github/get-device-code"
import { pollAccessToken } from "./services/github/poll-access-token"

// ---------------------------------------------------------------------------
// copilot-api-plus add-account
// ---------------------------------------------------------------------------

export const addAccount = defineCommand({
  meta: {
    name: "add-account",
    description: "Add a new GitHub account via Device Code auth",
  },
  args: {
    label: {
      alias: "l",
      type: "string",
      description: "Label for the account",
    },
    "account-type": {
      alias: "a",
      type: "string",
      default: "individual",
      description: "Account type (individual/business/enterprise)",
    },
    "github-base-url": {
      type: "string",
      description: "GitHub web base URL (for GitHub Enterprise device login)",
    },
    "github-api-base-url": {
      type: "string",
      description: "GitHub API base URL (for GitHub Enterprise REST API)",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
  },
  async run({ args }) {
    if (args.verbose) {
      consola.level = 5
      consola.info("Verbose logging enabled")
    }

    try {
      await ensurePaths()
      await applyProxyConfig()
      initProxyFromEnv()
      state.accountType = args["account-type"]
      state.githubBaseUrl = args["github-base-url"]
      state.githubApiBaseUrl = args["github-api-base-url"]
      await cacheVSCodeVersion()

      // Device Code flow
      consola.info("Starting GitHub Device Code authentication...")
      const deviceCode = await getDeviceCode()

      consola.box(
        `Please visit: ${deviceCode.verification_uri}\nand enter code: ${deviceCode.user_code}`,
      )

      const githubToken = await pollAccessToken(deviceCode)
      consola.success("GitHub token obtained")

      // Add account
      await accountManager.loadAccounts()

      const label = args.label || `Account ${accountManager.accountCount + 1}`
      const accountType = args["account-type"]

      const account = await accountManager.addAccount(
        githubToken,
        label,
        accountType,
      )

      consola.success(
        `Account added: ${account.githubLogin} (${account.label})`,
      )
      consola.info(`Total accounts: ${accountManager.accountCount}`)
    } catch (err) {
      consola.warn(`Failed to add account: ${rootCause(err)}`)
      consola.debug("Failed to add account:", err)
      process.exitCode = 1
    }
  },
})

// ---------------------------------------------------------------------------
// copilot-api-plus list-accounts
// ---------------------------------------------------------------------------

export const listAccounts = defineCommand({
  meta: {
    name: "list-accounts",
    description: "List all configured accounts",
  },
  args: {
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
  },
  async run({ args }) {
    if (args.verbose) {
      consola.level = 5
      consola.info("Verbose logging enabled")
    }

    try {
      await ensurePaths()
      await accountManager.loadAccounts()

      const accounts = accountManager.getAccounts()

      if (accounts.length === 0) {
        consola.info("No accounts configured. Use `add-account` to add one.")
        return
      }

      // Calculate column widths
      const rows = accounts.map((a, i) => ({
        num: String(i + 1),
        label: a.label || "-",
        login: a.githubLogin || "unknown",
        status: a.status,
        premium:
          a.usage ?
            `${a.usage.premium_remaining}/${a.usage.premium_total}`
          : "-",
      }))

      const cols = {
        num: Math.max(1, ...rows.map((r) => r.num.length)),
        label: Math.max(5, ...rows.map((r) => r.label.length)),
        login: Math.max(5, ...rows.map((r) => r.login.length)),
        status: Math.max(6, ...rows.map((r) => r.status.length)),
        premium: Math.max(17, ...rows.map((r) => r.premium.length)),
      }

      const pad = (s: string, w: number) => s.padEnd(w)
      const sep = (w: number) => "─".repeat(w)

      const header = `│ ${pad("#", cols.num)} │ ${pad("Label", cols.label)} │ ${pad("Login", cols.login)} │ ${pad("Status", cols.status)} │ ${pad("Premium Remaining", cols.premium)} │`
      const topBorder = `┌─${sep(cols.num)}─┬─${sep(cols.label)}─┬─${sep(cols.login)}─┬─${sep(cols.status)}─┬─${sep(cols.premium)}─┐`
      const midBorder = `├─${sep(cols.num)}─┼─${sep(cols.label)}─┼─${sep(cols.login)}─┼─${sep(cols.status)}─┼─${sep(cols.premium)}─┤`
      const botBorder = `└─${sep(cols.num)}─┴─${sep(cols.label)}─┴─${sep(cols.login)}─┴─${sep(cols.status)}─┴─${sep(cols.premium)}─┘`

      consola.log("")
      consola.log(topBorder)
      consola.log(header)
      consola.log(midBorder)

      for (const row of rows) {
        consola.log(
          `│ ${pad(row.num, cols.num)} │ ${pad(row.label, cols.label)} │ ${pad(row.login, cols.login)} │ ${pad(row.status, cols.status)} │ ${pad(row.premium, cols.premium)} │`,
        )
      }

      consola.log(botBorder)
      consola.log("")
    } catch (err) {
      consola.warn(`Failed to list accounts: ${rootCause(err)}`)
      consola.debug("Failed to list accounts:", err)
      process.exitCode = 1
    }
  },
})

// ---------------------------------------------------------------------------
// copilot-api-plus remove-account
// ---------------------------------------------------------------------------

export const removeAccount = defineCommand({
  meta: {
    name: "remove-account",
    description: "Remove an account by label or index",
  },
  args: {
    id: {
      type: "positional",
      description: "Label or index (1-based) of the account to remove",
      required: false,
    },
    label: {
      alias: "l",
      type: "string",
      description: "Label of the account to remove",
    },
    force: {
      alias: "f",
      type: "boolean",
      default: false,
      description: "Skip confirmation prompt",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
  },
  async run({ args }) {
    if (args.verbose) {
      consola.level = 5
      consola.info("Verbose logging enabled")
    }

    try {
      await ensurePaths()
      await accountManager.loadAccounts()

      const accounts = accountManager.getAccounts()

      if (accounts.length === 0) {
        consola.warn("No accounts configured.")
        return
      }

      // Resolve which account to remove
      const identifier = args.id || args.label
      if (!identifier) {
        consola.error(
          "Please specify an account to remove (by label or index).",
        )
        consola.info("Usage: remove-account <label-or-index>")
        process.exitCode = 1
        return
      }

      let account: (typeof accounts)[0] | undefined

      // Try numeric index first (1-based)
      const idx = Number.parseInt(identifier, 10)
      if (!Number.isNaN(idx) && idx >= 1 && idx <= accounts.length) {
        account = accounts[idx - 1]
      }

      // Try label match
      if (!account) {
        account = accounts.find(
          (a) => a.label.toLowerCase() === identifier.toLowerCase(),
        )
      }

      if (!account) {
        consola.error(`Account not found: ${identifier}`)
        process.exitCode = 1
        return
      }

      // Confirmation
      if (!args.force) {
        const confirmed = await consola.prompt(
          `Remove account "${account.label}" (${account.githubLogin || "unknown"})? [y/N]`,
          { type: "confirm" },
        )
        if (!confirmed) {
          consola.info("Cancelled.")
          return
        }
      }

      const removed = await accountManager.removeAccount(account.id)
      if (removed) {
        consola.success(
          `Account removed: ${account.label} (${account.githubLogin || "unknown"})`,
        )
      } else {
        consola.error("Failed to remove account.")
        process.exitCode = 1
      }
    } catch (err) {
      consola.warn(`Failed to remove account: ${rootCause(err)}`)
      consola.debug("Failed to remove account:", err)
      process.exitCode = 1
    }
  },
})
