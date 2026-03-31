import consola from "consola"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"

import { HTTPError } from "~/lib/error"
import { PATHS } from "~/lib/paths"
import { getCopilotToken } from "~/services/github/get-copilot-token"
import { getCopilotUsage } from "~/services/github/get-copilot-usage"
import { getGitHubUser } from "~/services/github/get-user"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AccountStatus =
  | "active"
  | "exhausted"
  | "rate_limited"
  | "banned"
  | "error"
  | "disabled"

export interface Account {
  id: string
  label: string
  githubToken: string
  /** Short-lived Copilot JWT – kept in memory only, never persisted. */
  copilotToken?: string
  /** API endpoint extracted from the Copilot token response. */
  copilotApiEndpoint?: string
  accountType: string // "individual" | "business" | "enterprise"

  // Status
  status: AccountStatus
  statusMessage?: string
  lastUsedAt?: number
  consecutiveFailures: number
  cooldownUntil?: number

  // Quota snapshot (refreshed periodically)
  usage?: {
    premium_remaining: number
    premium_total: number
    chat_remaining: number
    chat_total: number
    quotaResetDate: string
    lastCheckedAt: number
  }

  // Metadata
  githubLogin?: string
  addedAt: number
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/** Fields excluded from the JSON file (short-lived / runtime-only). */
type PersistedAccount = Omit<Account, "copilotToken">

const ACCOUNTS_PATH = PATHS.ACCOUNTS_PATH

// ---------------------------------------------------------------------------
// AccountManager
// ---------------------------------------------------------------------------

const COOLDOWN_MS = 60 * 1000 // 60 seconds

export class AccountManager {
  private accounts: Array<Account> = []
  private refreshInterval?: ReturnType<typeof setInterval>
  private usageInterval?: ReturnType<typeof setInterval>

  // Debounced save
  private saveTimer?: ReturnType<typeof setTimeout>
  private savePending = false

  // ---------- Persistence ------------------------------------------------

  /**
   * Load accounts from the JSON file on disk.
   * Missing file is treated as empty list – not an error.
   */
  async loadAccounts(): Promise<void> {
    try {
      // eslint-disable-next-line unicorn/prefer-json-parse-buffer
      const raw = await fs.readFile(ACCOUNTS_PATH, "utf8")
      const parsed = JSON.parse(raw) as Array<PersistedAccount>
      this.accounts = parsed.map((a) => ({ ...a, copilotToken: undefined }))
      consola.info(`Loaded ${this.accounts.length} account(s) from disk`)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.accounts = []
        return
      }
      consola.error("Failed to load accounts:", err)
      this.accounts = []
    }
  }

  /**
   * Persist accounts to disk. `copilotToken` is excluded because it is
   * short-lived and will be refreshed on every startup.
   */
  async saveAccounts(): Promise<void> {
    const data: Array<PersistedAccount> = this.accounts.map(
      ({ copilotToken: _dropped, ...rest }) => rest,
    )
    try {
      await fs.writeFile(ACCOUNTS_PATH, JSON.stringify(data, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      })
    } catch (err) {
      consola.error("Failed to save accounts:", err)
    }
  }

  /** Schedule a debounced save (coalesces rapid status updates). */
  private debouncedSave(): void {
    if (this.saveTimer) return // already scheduled
    this.savePending = true
    this.saveTimer = setTimeout(async () => {
      this.saveTimer = undefined
      if (this.savePending) {
        this.savePending = false
        await this.saveAccounts()
      }
    }, 1_000)
  }

  // ---------- CRUD -------------------------------------------------------

  /**
   * Add a new account.
   *
   * 1. Validates the GitHub token by fetching user info.
   * 2. Obtains an initial Copilot token.
   * 3. Persists the account to disk.
   */
  async addAccount(
    githubToken: string,
    label: string,
    accountType: string = "individual",
  ): Promise<Account> {
    // 1. Validate token – get GitHub login (pass token explicitly, no state mutation)
    const user = await getGitHubUser(githubToken)

    // 2. Obtain Copilot token – pass token directly (no state mutation)
    const tokenData = await getCopilotToken(githubToken)

    const account: Account = {
      id: randomUUID(),
      label,
      githubToken,
      copilotToken: tokenData.token,
      copilotApiEndpoint: tokenData.endpoints?.api,
      accountType,
      status: "active",
      consecutiveFailures: 0,
      githubLogin: user.login,
      addedAt: Date.now(),
    }

    this.accounts.push(account)
    await this.saveAccounts()

    consola.success(`Account added: ${label} (${user.login})`)
    return account
  }

  async removeAccount(id: string): Promise<boolean> {
    const idx = this.accounts.findIndex((a) => a.id === id)
    if (idx === -1) return false
    const [removed] = this.accounts.splice(idx, 1)
    await this.saveAccounts()
    consola.info(`Account removed: ${removed.label}`)
    return true
  }

  getAccounts(): Array<Account> {
    return this.accounts
  }

  getAccountById(id: string): Account | undefined {
    return this.accounts.find((a) => a.id === id)
  }

  // ---------- Smart account selection ------------------------------------

  /**
   * Pick the best available account.
   *
   * 1. Filter out disabled, banned, exhausted, and accounts still in cooldown.
   * 2. Prefer accounts with more remaining premium quota.
   * 3. Fall back to round-robin (least-recently-used) when quotas are equal
   *    or unknown.
   */
  getActiveAccount(): Account | undefined {
    const now = Date.now()

    const eligible = this.accounts.filter((a) => {
      if (
        a.status === "disabled"
        || a.status === "banned"
        || a.status === "exhausted"
      ) {
        return false
      }
      if (a.cooldownUntil && a.cooldownUntil > now) return false
      return true
    })

    if (eligible.length === 0) {
      // Fallback: if there is exactly one account and it's only cooling down
      // (not banned/disabled/exhausted), return it anyway.  With a single
      // account there is nothing to "switch to", so blocking all requests
      // for the cooldown period would be a self-inflicted outage.
      if (this.accounts.length === 1) {
        const solo = this.accounts[0]
        if (
          solo.status !== "disabled"
          && solo.status !== "banned"
          && solo.status !== "exhausted"
        ) {
          return solo
        }
      }
      return undefined
    }

    eligible.sort((a, b) => {
      const aRemaining = a.usage?.premium_remaining ?? -1
      const bRemaining = b.usage?.premium_remaining ?? -1

      // Higher remaining quota first
      if (aRemaining !== bRemaining) return bRemaining - aRemaining

      // Equal / unknown → least recently used first (round-robin)
      const aUsed = a.lastUsedAt ?? 0
      const bUsed = b.lastUsedAt ?? 0
      return aUsed - bUsed
    })

    return eligible[0]
  }

  // ---------- Status management ------------------------------------------

  markAccountStatus(id: string, status: AccountStatus, message?: string): void {
    const account = this.getAccountById(id)
    if (!account) return

    account.status = status
    account.statusMessage = message

    switch (status) {
      case "rate_limited":
      case "error": {
        // Only apply cooldown when there are other accounts to switch to.
        // With a single account, cooldown would block ALL requests with
        // "No available accounts" — effectively a self-inflicted outage.
        if (this.accounts.length > 1) {
          account.cooldownUntil = Date.now() + COOLDOWN_MS
        }
        account.consecutiveFailures += 1

        break
      }
      case "banned": {
        account.consecutiveFailures += 1

        break
      }
      case "active": {
        // Recovering from a failure state — reset
        account.consecutiveFailures = 0
        account.cooldownUntil = undefined

        break
      }
      // No default
    }
    // "exhausted" and "disabled" don't touch consecutiveFailures

    this.debouncedSave()
  }

  markAccountSuccess(id: string): void {
    const account = this.getAccountById(id)
    if (!account) return

    account.consecutiveFailures = 0
    account.lastUsedAt = Date.now()

    if (account.status === "error" || account.status === "rate_limited") {
      account.status = "active"
      account.statusMessage = undefined
      account.cooldownUntil = undefined
    }

    this.debouncedSave()
  }

  // ---------- Token & usage refresh (per account) ------------------------

  /**
   * Refresh the short-lived Copilot JWT for a single account.
   *
   * Passes the account's GitHub token directly to `getCopilotToken()` so that
   * global `state.githubToken` is never mutated — safe for concurrent use.
   */
  async refreshAccountToken(account: Account): Promise<void> {
    try {
      const data = await getCopilotToken(account.githubToken)
      // eslint-disable-next-line require-atomic-updates
      account.copilotToken = data.token
      if (data.endpoints?.api) {
        // eslint-disable-next-line require-atomic-updates
        account.copilotApiEndpoint = data.endpoints.api
      }
    } catch (err: unknown) {
      if (err instanceof HTTPError && err.response.status === 401) {
        this.markAccountStatus(account.id, "banned", "GitHub token invalid")
        consola.warn(
          `Account ${account.label}: token invalid, marked as banned`,
        )
      } else {
        consola.error(
          `Account ${account.label}: failed to refresh Copilot token:`,
          err,
        )
      }
    }
  }

  /**
   * Refresh the usage / quota snapshot for a single account.
   *
   * Passes the account's GitHub token directly to `getCopilotUsage()` so that
   * global `state.githubToken` is never mutated — safe for concurrent use.
   */
  async refreshAccountUsage(account: Account): Promise<void> {
    try {
      const data = await getCopilotUsage(account.githubToken)
      const snap = data.quota_snapshots

      // eslint-disable-next-line require-atomic-updates
      account.usage = {
        premium_remaining: snap.premium_interactions.remaining,
        premium_total: snap.premium_interactions.entitlement,
        chat_remaining: snap.chat.remaining,
        chat_total: snap.chat.entitlement,
        quotaResetDate: data.quota_reset_date,
        lastCheckedAt: Date.now(),
      }

      // Transition between active ↔ exhausted
      if (account.usage.premium_remaining <= 0 && account.status === "active") {
        this.markAccountStatus(
          account.id,
          "exhausted",
          "Premium quota exhausted",
        )
      } else if (
        account.usage.premium_remaining > 0
        && account.status === "exhausted"
      ) {
        account.status = "active"
        account.statusMessage = undefined
        account.consecutiveFailures = 0
        this.debouncedSave()
      }
    } catch (err) {
      consola.error(`Account ${account.label}: failed to refresh usage:`, err)
    }
  }

  // ---------- Background refresh -----------------------------------------

  /** Refresh Copilot tokens for all non-disabled accounts. */
  async refreshAllTokens(): Promise<void> {
    const targets = this.accounts.filter((a) => a.status !== "disabled")
    await Promise.allSettled(targets.map((a) => this.refreshAccountToken(a)))
  }

  /** Refresh usage snapshots for all non-disabled accounts. */
  async refreshAllUsage(): Promise<void> {
    const targets = this.accounts.filter((a) => a.status !== "disabled")
    await Promise.allSettled(targets.map((a) => this.refreshAccountUsage(a)))
  }

  /**
   * Start periodic background refresh loops.
   *
   * The initial token refresh is awaited to ensure accounts are ready before
   * the first request arrives.  Usage refresh runs in the background.
   *
   * @param tokenIntervalMs  Token refresh interval (default 25 min).
   * @param usageIntervalMs  Usage refresh interval (default 5 min).
   */
  async startBackgroundRefresh(
    tokenIntervalMs: number = 25 * 60 * 1000,
    usageIntervalMs: number = 5 * 60 * 1000,
  ): Promise<void> {
    this.stopBackgroundRefresh()

    // Initial refresh — await token refresh so accounts are ready for requests
    await this.refreshAllTokens()
    void this.refreshAllUsage()

    this.refreshInterval = setInterval(() => {
      void this.refreshAllTokens()
    }, tokenIntervalMs)

    this.usageInterval = setInterval(() => {
      void this.refreshAllUsage()
    }, usageIntervalMs)

    consola.info(
      `Background refresh started (tokens: ${tokenIntervalMs / 60_000}m, usage: ${usageIntervalMs / 60_000}m)`,
    )
  }

  stopBackgroundRefresh(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval)
      this.refreshInterval = undefined
    }
    if (this.usageInterval) {
      clearInterval(this.usageInterval)
      this.usageInterval = undefined
    }
  }

  // ---------- Helpers ----------------------------------------------------

  get accountCount(): number {
    return this.accounts.length
  }

  get activeAccountCount(): number {
    return this.accounts.filter((a) => a.status === "active").length
  }

  hasAccounts(): boolean {
    return this.accounts.length > 0
  }

  // ---------- Legacy migration -------------------------------------------

  /**
   * Create an Account entry from the legacy single-account global state.
   * Useful for seamless upgrade from single-account to multi-account mode.
   *
   * Falls back to creating a minimal entry if API validation fails — the
   * background refresh will fill in the missing data later.
   */
  async migrateFromLegacy(
    githubToken: string,
    accountType: string,
  ): Promise<Account> {
    // Check if this token is already registered
    const existing = this.accounts.find((a) => a.githubToken === githubToken)
    if (existing) {
      consola.info("Legacy account already migrated, skipping")
      return existing
    }

    try {
      const account = await this.addAccount(
        githubToken,
        "Primary (migrated)",
        accountType,
      )
      consola.success("Legacy single-account migrated to multi-account manager")
      return account
    } catch (error) {
      // API validation failed — create a minimal entry anyway so the account
      // is visible in the management UI.  Background token/usage refresh will
      // fill in the missing data.
      consola.warn(
        "Could not fully validate legacy account, adding with limited info:",
        error,
      )

      const account: Account = {
        id: randomUUID(),
        label: "Primary (migrated)",
        githubToken,
        copilotToken: undefined,
        accountType,
        status: "active",
        consecutiveFailures: 0,
        addedAt: Date.now(),
      }

      this.accounts.push(account)
      await this.saveAccounts()
      return account
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const accountManager = new AccountManager()
