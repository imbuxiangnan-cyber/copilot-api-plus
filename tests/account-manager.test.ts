import { beforeEach, describe, expect, mock, test } from "bun:test"

import type { Account } from "~/lib/account-manager"

import { HTTPError } from "~/lib/error"

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

const getCopilotUsageMock = mock(() => Promise.resolve(defaultUsagePayload))

void mock.module("~/services/github/get-copilot-usage", () => ({
  getCopilotUsage: getCopilotUsageMock,
}))

const { AccountManager } = await import("~/lib/account-manager")

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

describe("AccountManager background refresh", () => {
  beforeEach(() => {
    getCopilotUsageMock.mockClear()
  })

  test("skips banned accounts during refreshAllUsage", async () => {
    const manager = makeManager([
      makeAccount("banned", "banned"),
      makeAccount("disabled", "disabled"),
      makeAccount("active", "active"),
    ])

    await manager.refreshAllUsage()

    expect(getCopilotUsageMock).toHaveBeenCalledTimes(1)
    expect(getCopilotUsageMock).toHaveBeenCalledWith("token-active")
  })

  test("marks account banned when usage payload has no premium quota", async () => {
    getCopilotUsageMock.mockResolvedValueOnce({
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
    } as unknown as typeof defaultUsagePayload)
    const account = makeAccount("missing-premium", "active")
    const manager = makeManager([account])

    await manager.refreshAccountUsage(account)
    const saveTimer = (manager as unknown as ManagerInternals).saveTimer
    if (saveTimer) clearTimeout(saveTimer)

    expect(account.status).toBe("banned")
    expect(account.statusMessage).toBe("Copilot usage unavailable")
  })

  test("marks account banned when usage endpoint returns 401", async () => {
    getCopilotUsageMock.mockRejectedValueOnce(
      new HTTPError(
        "Failed to get Copilot usage",
        new Response("", { status: 401 }),
      ),
    )
    const account = makeAccount("usage-401", "active")
    const manager = makeManager([account])

    await manager.refreshAccountUsage(account)
    const saveTimer = (manager as unknown as ManagerInternals).saveTimer
    if (saveTimer) clearTimeout(saveTimer)

    expect(account.status).toBe("banned")
    expect(account.statusMessage).toBe("GitHub token invalid")
  })
})
