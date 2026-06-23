import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { Account } from "~/lib/account-manager"

const defaultUsagePayload = {
  quota_reset_date: "2026-06-01",
  quota_snapshots: {
    chat: {
      entitlement: 100,
      overage_count: 0,
      overage_permitted: false,
      percent_remaining: 100,
      quota_id: "chat",
      quota_remaining: 100,
      remaining: 100,
      unlimited: false,
    },
    premium_interactions: {
      entitlement: 100,
      overage_count: 0,
      overage_permitted: false,
      percent_remaining: 100,
      quota_id: "premium",
      quota_remaining: 100,
      remaining: 100,
      unlimited: false,
    },
  },
}

function makeUsagePayload(
  premiumRemaining: number,
  overagePermitted: boolean,
): typeof defaultUsagePayload {
  return {
    ...defaultUsagePayload,
    quota_snapshots: {
      ...defaultUsagePayload.quota_snapshots,
      premium_interactions: {
        ...defaultUsagePayload.quota_snapshots.premium_interactions,
        overage_permitted: overagePermitted,
        quota_remaining: premiumRemaining,
        remaining: premiumRemaining,
      },
    },
  }
}

const originalFetch = globalThis.fetch
const fetchMock = mock(() => Promise.resolve(jsonResponse(defaultUsagePayload)))

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  })
}

const { AccountManager } = await import("~/lib/account-manager")

afterEach(() => {
  globalThis.fetch = originalFetch
})

type ManagerInternals = {
  accounts: Array<Account>
  saveTimer?: ReturnType<typeof setTimeout>
}

function makeAccount(id: string, status: Account["status"]): Account {
  return {
    id,
    label: id,
    githubToken: `token-${id}`,
    accountType: "individual",
    status,
    consecutiveFailures: 0,
    addedAt: Date.now(),
  }
}

function makeManager(
  accounts: Array<Account>,
): InstanceType<typeof AccountManager> {
  const manager = new AccountManager()
  ;(manager as unknown as ManagerInternals).accounts = accounts
  manager.saveAccounts = async () => {}
  return manager
}

describe("AccountManager account selection", () => {
  test("selects an exhausted-only usable account", () => {
    const account = makeAccount("exhausted", "exhausted")
    const manager = makeManager([account])

    expect(manager.getActiveAccount()).toBe(account)
  })

  test("prefers active account over exhausted account with higher remaining quota", () => {
    const exhausted = makeAccount("exhausted", "exhausted")
    exhausted.usage = {
      premium_remaining: 100,
      premium_total: 100,
      chat_remaining: 100,
      chat_total: 100,
      quotaResetDate: "2026-06-01",
      lastCheckedAt: Date.now(),
    }
    const active = makeAccount("active", "active")
    active.usage = {
      premium_remaining: 1,
      premium_total: 100,
      chat_remaining: 100,
      chat_total: 100,
      quotaResetDate: "2026-06-01",
      lastCheckedAt: Date.now(),
    }

    const manager = makeManager([exhausted, active])

    expect(manager.getActiveAccount()).toBe(active)
  })
})

describe("AccountManager background refresh", () => {
  beforeEach(() => {
    fetchMock.mockClear()
    fetchMock.mockResolvedValue(jsonResponse(defaultUsagePayload))
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  test("skips banned accounts during refreshAllUsage", async () => {
    const manager = makeManager([
      makeAccount("banned", "banned"),
      makeAccount("disabled", "disabled"),
      makeAccount("active", "active"),
    ])

    await manager.refreshAllUsage()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).authorization).toBe(
      "token token-active",
    )
  })

  test("marks account banned when usage payload has no premium quota", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        quota_reset_date: "2026-06-01",
        quota_snapshots: {
          chat: {
            entitlement: 100,
            overage_count: 0,
            overage_permitted: false,
            percent_remaining: 100,
            quota_id: "chat",
            quota_remaining: 100,
            remaining: 100,
            unlimited: false,
          },
        },
      }),
    )
    const account = makeAccount("missing-premium", "active")
    const manager = makeManager([account])

    await manager.refreshAccountUsage(account)
    const saveTimer = (manager as unknown as ManagerInternals).saveTimer
    if (saveTimer) clearTimeout(saveTimer)

    expect(account.status).toBe("banned")
    expect(account.statusMessage).toBe("Copilot usage unavailable")
  })

  test("keeps no-overage exhausted usage snapshot active with advisory message", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeUsagePayload(0, false)))
    const account = makeAccount("no-overage", "active")
    const manager = makeManager([account])

    await manager.refreshAccountUsage(account)
    const saveTimer = (manager as unknown as ManagerInternals).saveTimer
    if (saveTimer) clearTimeout(saveTimer)

    expect(account.status).toBe("active")
    expect(account.statusMessage).toBe("Premium quota exhausted")
    expect(account.usage?.premium_remaining).toBe(0)
    expect(account.usage?.premium_overage_permitted).toBe(false)
  })

  test("keeps overage-permitted negative remaining usage active and clears advisory message", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeUsagePayload(-3, true)))
    const account = makeAccount("overage", "active")
    account.statusMessage = "Premium quota exhausted"
    const manager = makeManager([account])

    await manager.refreshAccountUsage(account)
    const saveTimer = (manager as unknown as ManagerInternals).saveTimer
    if (saveTimer) clearTimeout(saveTimer)

    expect(account.status).toBe("active")
    expect(account.statusMessage).toBeUndefined()
    expect(account.usage?.premium_remaining).toBe(-3)
    expect(account.usage?.premium_overage_permitted).toBe(true)
  })

  test("recovers stale exhausted status when overage is permitted", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeUsagePayload(-1, true)))
    const account = makeAccount("stale-exhausted", "exhausted")
    account.consecutiveFailures = 2
    account.statusMessage = "Premium quota exhausted"
    const manager = makeManager([account])

    await manager.refreshAccountUsage(account)
    const saveTimer = (manager as unknown as ManagerInternals).saveTimer
    if (saveTimer) clearTimeout(saveTimer)

    expect(account.status).toBe("active")
    expect(account.statusMessage).toBeUndefined()
    expect(account.consecutiveFailures).toBe(0)
    expect(account.usage?.premium_remaining).toBe(-1)
    expect(account.usage?.premium_overage_permitted).toBe(true)
  })

  test("markAccountSuccess clears stale exhausted status", () => {
    const account = makeAccount("success", "exhausted")
    account.consecutiveFailures = 3
    account.statusMessage = "Premium quota exhausted"
    account.cooldownUntil = Date.now() + 10_000
    const manager = makeManager([account])

    manager.markAccountSuccess(account.id)
    const saveTimer = (manager as unknown as ManagerInternals).saveTimer
    if (saveTimer) clearTimeout(saveTimer)

    expect(account.status).toBe("active")
    expect(account.statusMessage).toBeUndefined()
    expect(account.consecutiveFailures).toBe(0)
    expect(account.cooldownUntil).toBeUndefined()
    expect(account.lastUsedAt).toBeGreaterThan(0)
  })

  test("marks account banned when usage endpoint returns 401", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 401 }))
    const account = makeAccount("usage-401", "active")
    const manager = makeManager([account])

    await manager.refreshAccountUsage(account)
    const saveTimer = (manager as unknown as ManagerInternals).saveTimer
    if (saveTimer) clearTimeout(saveTimer)

    expect(account.status).toBe("banned")
    expect(account.statusMessage).toBe("GitHub token invalid")
  })
})
