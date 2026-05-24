import consola from "consola"
import { randomBytes, randomUUID } from "node:crypto"
import fs from "node:fs/promises"

import { HTTPError } from "~/lib/error"
import { PATHS } from "~/lib/paths"
import { startConnectionRecycling, stopConnectionRecycling } from "~/lib/proxy"
import { rootCause } from "~/lib/utils"
import { getCopilotToken } from "~/services/github/get-copilot-token"
import { getCopilotUsage } from "~/services/github/get-copilot-usage"
import {
  getGitHubRateLimit,
  type GithubRateLimitResource,
} from "~/services/github/get-rate-limit"
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
    /** Whether the upstream account is allowed to exceed its monthly quota. */
    premium_overage_permitted?: boolean
    quotaResetDate: string
    lastCheckedAt: number
  }

  /**
   * Rate-limit snapshots — surfaced on the web UI as countdowns and injected
   * into 429 error responses so downstream clients (Claude Code / Codex) can
   * display the remaining cooldown to the user.
   */
  limits?: {
    /** GitHub REST API limits (from GET /rate_limit). */
    github?: {
      /** Backward-compatible alias for `resources.core`. */
      limit: number
      remaining: number
      used: number
      /** Reset time as unix seconds (matches GitHub API). */
      reset: number
      /** Top-level `rate` block returned by GitHub (usually aliases core). */
      rate?: GithubRateLimitResource
      /** Per-resource quota snapshots keyed by GitHub resource name. */
      resources?: Record<string, GithubRateLimitResource>
      fetchedAt: number
    }
    /**
     * Copilot ~5h session-level rate limit (Pro+ only). Surfaced when
     * upstream returns 429 `user_global_rate_limited:pro_plus`. We estimate
     * the reset 5h after the first 429 since GitHub does not expose it
     * directly today.
     */
    copilotSession?: {
      blockedAt: number
      /** ms epoch — estimated `blockedAt + 5h`. */
      estimatedResetAt: number
      reason: string
    }
  }

  // Anti-correlation
  /** Stable per-account machine identifier – persisted to disk. */
  machineId?: string
  /** Runtime-only session identifier – regenerated on every startup. */
  sessionId?: string
  /** Timestamp of the last request sent using this account. */
  lastRequestAt?: number
  /** Optional per-account proxy URL (e.g. "http://proxy:8080" or "socks5://proxy:1080"). */
  proxy?: string

  // Metadata
  githubLogin?: string
  addedAt: number
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/** Fields excluded from the JSON file (short-lived / runtime-only). */
type PersistedAccount = Omit<Account, "copilotToken" | "sessionId">

const ACCOUNTS_PATH = PATHS.ACCOUNTS_PATH

// ---------------------------------------------------------------------------
// AccountManager
// ---------------------------------------------------------------------------

const COOLDOWN_MS = 60 * 1000 // 60 seconds
const PREMIUM_QUOTA_EXHAUSTED_MESSAGE = "Premium quota exhausted"

function shouldBackgroundRefresh(account: Account): boolean {
  return account.status !== "disabled" && account.status !== "banned"
}

export class AccountManager {
  private accounts: Array<Account> = []
  private refreshInterval?: ReturnType<typeof setInterval>
  private usageInterval?: ReturnType<typeof setInterval>

  // Debounced save
  private saveTimer?: ReturnType<typeof setTimeout>
  private savePending = false

  /** True if accounts.json existed on disk when loadAccounts() was called. */
  accountsFileExisted = false

  // ---------- Persistence ------------------------------------------------

  /**
   * Load accounts from the JSON file on disk.
   * Missing file is treated as empty list – not an error.
   */
  async loadAccounts(): Promise<void> {
    try {
      // eslint-disable-next-line unicorn/prefer-json-parse-buffer
      const raw = await fs.readFile(ACCOUNTS_PATH, "utf8")
      this.accountsFileExisted = true
      const parsed = JSON.parse(raw) as Array<PersistedAccount>
      this.accounts = parsed.map((a) => ({
        ...a,
        copilotToken: undefined,
        sessionId: randomUUID(),
        machineId: a.machineId || randomBytes(32).toString("hex"),
      }))
      consola.info(`Loaded ${this.accounts.length} account(s) from disk`)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.accountsFileExisted = false
        this.accounts = []
        return
      }
      consola.warn(`Failed to load accounts: ${rootCause(err)}`)
      consola.debug("Failed to load accounts:", err)
      this.accounts = []
    }
  }

  /**
   * Persist accounts to disk. `copilotToken` is excluded because it is
   * short-lived and will be refreshed on every startup.
   */
  async saveAccounts(): Promise<void> {
    const data: Array<PersistedAccount> = this.accounts.map(
      ({ copilotToken: _dropped, sessionId: _session, ...rest }) => rest,
    )
    try {
      await fs.writeFile(ACCOUNTS_PATH, JSON.stringify(data, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      })
    } catch (err) {
      consola.warn(`Failed to save accounts: ${rootCause(err)}`)
      consola.debug("Failed to save accounts:", err)
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
      machineId: randomBytes(32).toString("hex"),
      sessionId: randomUUID(),
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
   * 1. Filter out disabled, banned, and accounts still in cooldown.
   * 2. Prefer accounts not marked exhausted; quota exhaustion is advisory and
   *    upstream 429/403 responses remain authoritative.
   * 3. Within each status group, prefer more remaining premium quota.
   * 4. Fall back to round-robin (least-recently-used) when quotas are equal
   *    or unknown.
   */
  getActiveAccount(): Account | undefined {
    const now = Date.now()

    const eligible = this.accounts.filter((a) => {
      if (a.status === "disabled" || a.status === "banned") {
        return false
      }
      if (a.cooldownUntil && a.cooldownUntil > now) return false
      return true
    })

    if (eligible.length === 0) {
      // Fallback: if there is exactly one account and it's only cooling down
      // (not banned/disabled), return it anyway. With a single account there is
      // nothing to "switch to", so blocking all requests for the cooldown period
      // would be a self-inflicted outage.
      if (this.accounts.length === 1) {
        const solo = this.accounts[0]
        if (solo.status !== "disabled" && solo.status !== "banned") {
          return solo
        }
      }
      return undefined
    }

    eligible.sort((a, b) => {
      const aExhausted = a.status === "exhausted"
      const bExhausted = b.status === "exhausted"

      // Quota exhaustion is advisory: keep exhausted accounts eligible, but use
      // non-exhausted accounts first when there is a choice.
      if (aExhausted !== bExhausted) return aExhausted ? 1 : -1

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

    if (
      account.status === "error"
      || account.status === "rate_limited"
      || account.status === "exhausted"
    ) {
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
    if (!shouldBackgroundRefresh(account)) return

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
        consola.warn(
          `Account ${account.label}: failed to refresh Copilot token: ${rootCause(err)}`,
        )
        consola.debug(
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
    if (!shouldBackgroundRefresh(account)) return

    try {
      const data = await getCopilotUsage(account.githubToken)
      const snap = data.quota_snapshots as Partial<typeof data.quota_snapshots>
      const premium = snap.premium_interactions
      const chat = snap.chat

      if (premium === undefined || chat === undefined) {
        this.markAccountStatus(
          account.id,
          "banned",
          "Copilot usage unavailable",
        )
        consola.warn(
          `Account ${account.label}: Copilot usage unavailable, marked as banned`,
        )
        return
      }

      // eslint-disable-next-line require-atomic-updates
      account.usage = {
        premium_remaining: premium.remaining,
        premium_total: premium.entitlement,
        chat_remaining: chat.remaining,
        chat_total: chat.entitlement,
        premium_overage_permitted: premium.overage_permitted,
        quotaResetDate: data.quota_reset_date,
        lastCheckedAt: Date.now(),
      }

      const overagePermitted = premium.overage_permitted

      const quotaLooksExhausted =
        account.usage.premium_remaining <= 0 && !overagePermitted

      if (quotaLooksExhausted) {
        account.statusMessage = PREMIUM_QUOTA_EXHAUSTED_MESSAGE
      } else if (account.statusMessage === PREMIUM_QUOTA_EXHAUSTED_MESSAGE) {
        account.statusMessage = undefined
      }

      if (account.status === "exhausted" && !quotaLooksExhausted) {
        account.status = "active"
        account.cooldownUntil = undefined
        account.consecutiveFailures = 0
      }

      this.debouncedSave()
    } catch (err) {
      if (err instanceof HTTPError && err.response.status === 401) {
        this.markAccountStatus(account.id, "banned", "GitHub token invalid")
        consola.warn(
          `Account ${account.label}: usage auth failed, marked as banned`,
        )
        return
      }
      consola.warn(
        `Account ${account.label}: failed to refresh usage: ${rootCause(err)}`,
      )
      consola.debug(`Account ${account.label}: failed to refresh usage:`, err)
    }
  }

  // ---------- Background refresh -----------------------------------------

  /**
   * Refresh GitHub REST API rate-limit snapshot for a single account.
   *
   * Stored on `account.limits.github`. Called on startup, after account
   * creation, and after upstream 429s — the endpoint itself is free.
   */
  async refreshGithubRateLimit(account: Account): Promise<void> {
    if (!shouldBackgroundRefresh(account)) return

    try {
      const data = await getGitHubRateLimit(account.githubToken)
      const core = data.resources.core

      account.limits = {
        ...account.limits,
        github: {
          limit: core.limit,
          remaining: core.remaining,
          used: core.used,
          reset: core.reset,
          rate: data.rate,
          resources: data.resources,
          fetchedAt: Date.now(),
        },
      }
      this.debouncedSave()
    } catch (err) {
      consola.debug(
        `Account ${account.label}: failed to refresh GitHub rate_limit:`,
        err,
      )
    }
  }

  /**
   * Mark a Copilot ~5h session-level rate limit. Called when upstream returns
   * 429 with `user_global_rate_limited:pro_plus` (the Pro+ 5h cooldown).
   *
   * The reset time is *estimated* (blockedAt + 5h) because GitHub does not
   * surface the actual reset moment. UI/error responses display a "≤ 5h"
   * countdown so users know roughly when the cooldown lifts.
   */
  markCopilotSessionLimit(id: string, reason: string): void {
    const account = this.accounts.find((a) => a.id === id)
    if (!account) return
    const now = Date.now()
    account.limits = {
      ...account.limits,
      copilotSession: {
        blockedAt: now,
        estimatedResetAt: now + 5 * 60 * 60 * 1000,
        reason,
      },
    }
    this.debouncedSave()
  }

  /** Clear the Copilot 5h session marker (e.g. after a successful request). */
  clearCopilotSessionLimit(id: string): void {
    const account = this.accounts.find((a) => a.id === id)
    if (!account?.limits?.copilotSession) return
    const { copilotSession: _drop, ...rest } = account.limits
    account.limits = rest
    this.debouncedSave()
  }

  /** Refresh Copilot tokens for all non-disabled, non-banned accounts. */
  async refreshAllTokens(): Promise<void> {
    const targets = this.accounts.filter((a) => shouldBackgroundRefresh(a))
    await Promise.allSettled(targets.map((a) => this.refreshAccountToken(a)))
  }

  /** Refresh usage snapshots for all non-disabled, non-banned accounts. */
  async refreshAllUsage(): Promise<void> {
    const targets = this.accounts.filter((a) => shouldBackgroundRefresh(a))
    await Promise.allSettled(targets.map((a) => this.refreshAccountUsage(a)))
  }

  /** Refresh GitHub /rate_limit for all non-disabled, non-banned accounts. */
  async refreshAllGithubRateLimits(): Promise<void> {
    const targets = this.accounts.filter((a) => shouldBackgroundRefresh(a))
    await Promise.allSettled(targets.map((a) => this.refreshGithubRateLimit(a)))
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
    // Query GitHub /rate_limit for already-authorized accounts at startup.
    // The endpoint is free (does not consume quota), so this is safe.
    void this.refreshAllGithubRateLimits()

    this.refreshInterval = setInterval(() => {
      void this.refreshAllTokens()
    }, tokenIntervalMs)

    this.usageInterval = setInterval(() => {
      void this.refreshAllUsage()
      void this.refreshAllGithubRateLimits()
    }, usageIntervalMs)

    consola.debug(
      `Background refresh started (tokens: ${tokenIntervalMs / 60_000}m, usage: ${usageIntervalMs / 60_000}m)`,
    )

    // Start periodic connection pool recycling (~4h with jitter)
    startConnectionRecycling()
  }

  stopBackgroundRefresh(): void {
    stopConnectionRecycling()
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
      consola.debug("Legacy account already migrated, skipping")
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
        machineId: randomBytes(32).toString("hex"),
        sessionId: randomUUID(),
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
