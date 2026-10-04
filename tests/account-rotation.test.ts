import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"

import {
  accountManager,
  AccountManager,
  type Account,
} from "~/lib/account-manager"
import {
  breakerOpenRemainingMs,
  recordBreakerFailure,
  recordBreakerSuccess,
  runWithAccountRotation,
  throwIfBreakerOpen,
} from "~/lib/account-rotation"
import { HTTPError } from "~/lib/error"

const spies: Array<{ mockRestore: () => void }> = []

afterEach(() => {
  for (const spy of spies) spy.mockRestore()
  spies.length = 0
  recordBreakerSuccess()
})

function makeAccount(id: string): Account {
  return {
    id,
    label: id,
    githubToken: `test-github-${id}`,
    copilotToken: `test-copilot-${id}`,
    accountType: "individual",
    status: "active",
    consecutiveFailures: 0,
    addedAt: 1,
  }
}

function httpError(status: number): HTTPError {
  return new HTTPError(
    `Upstream ${status}`,
    new Response("upstream failure", { status }),
  )
}

function openBreaker(): void {
  for (let attempt = 0; attempt < 3; attempt++) {
    recordBreakerFailure("test upstream failure")
  }
}

let manager: AccountManager
let markStatusSpy: ReturnType<
  typeof spyOn<typeof accountManager, "markAccountStatus">
>
let refreshTokenSpy: ReturnType<
  typeof spyOn<typeof accountManager, "refreshAccountToken">
>
let refreshRateLimitSpy: ReturnType<
  typeof spyOn<typeof accountManager, "refreshGithubRateLimit">
>
let sessionLimitSpy: ReturnType<
  typeof spyOn<typeof accountManager, "markCopilotSessionLimit">
>

function prepareRotation(): void {
  recordBreakerSuccess()
  manager = new AccountManager()
  markStatusSpy = spyOn(accountManager, "markAccountStatus").mockImplementation(
    () => {},
  )
  refreshTokenSpy = spyOn(
    accountManager,
    "refreshAccountToken",
  ).mockResolvedValue(undefined)
  refreshRateLimitSpy = spyOn(
    accountManager,
    "refreshGithubRateLimit",
  ).mockResolvedValue(undefined)
  sessionLimitSpy = spyOn(
    accountManager,
    "markCopilotSessionLimit",
  ).mockImplementation(() => {})
  spies.push(
    markStatusSpy,
    refreshTokenSpy,
    refreshRateLimitSpy,
    sessionLimitSpy,
    spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Unexpected live fetch in account rotation test"),
    ),
    spyOn(Math, "random").mockReturnValue(0),
    spyOn(accountManager, "getActiveAccount").mockImplementation(
      (excluded?: ReadonlySet<string>) => manager.getActiveAccount(excluded),
    ),
    spyOn(accountManager, "markAccountSuccess").mockImplementation(() => {}),
    spyOn(accountManager, "saveAccounts").mockResolvedValue(undefined),
  )
}

function assertNoLiveFetch(): void {
  expect(globalThis.fetch).not.toHaveBeenCalled()
}

async function* streamResponse() {
  yield await Promise.resolve("chunk")
}

describe("account rotation", () => {
  beforeEach(prepareRotation)
  afterEach(assertNoLiveFetch)

  test("does not dispatch an already cancelled request", async () => {
    manager.getAccounts().push(makeAccount("cancelled"))
    const controller = new AbortController()
    const reason = new Error("request cancelled")
    controller.abort(reason)
    let calls = 0
    const result = await runWithAccountRotation({
      label: "test",
      payload: {},
      signal: controller.signal,
      transport: () => {
        calls++
        return Promise.resolve("unexpected result")
      },
    }).catch((error: unknown) => error)
    expect(result).toBe(reason)
    expect(calls).toBe(0)
    expect(markStatusSpy).not.toHaveBeenCalled()
  })

  test("does not retry or penalize an account when transport is cancelled", async () => {
    manager.getAccounts().push(makeAccount("cancelled-transport"))
    const controller = new AbortController()
    const reason = new Error("request cancelled during fetch")
    let calls = 0
    const result = await runWithAccountRotation({
      label: "test",
      payload: {},
      signal: controller.signal,
      transport: () => {
        calls++
        controller.abort(reason)
        return Promise.reject(reason)
      },
    }).catch((error: unknown) => error)
    expect(result).toBe(reason)
    expect(calls).toBe(1)
    expect(markStatusSpy).not.toHaveBeenCalled()
  })

  test("propagates tagged request errors without marking an account", async () => {
    manager.getAccounts().push(makeAccount("invalid-request"))
    const error = Object.assign(httpError(422), { __nonAccountError: true })
    const result = await runWithAccountRotation({
      label: "test",
      payload: {},
      transport: () => Promise.reject(error),
    }).catch((caught: unknown) => caught)
    expect(result).toBe(error)
    expect(markStatusSpy).not.toHaveBeenCalled()
  })

  test("preserves streaming account metadata after a successful 401 retry", async () => {
    const account = makeAccount("refreshed-stream")
    account.copilotApiEndpoint = "https://copilot.invalid"
    account.proxy = "http://proxy.invalid:8080"
    manager.getAccounts().push(account)
    let calls = 0
    const result = await runWithAccountRotation({
      label: "test",
      payload: {},
      transport: () => {
        calls++
        return calls === 1 ?
            Promise.reject(httpError(401))
          : Promise.resolve(streamResponse())
      },
    })
    expect(calls).toBe(2)
    expect(Reflect.get(result, "__accountInfo")).toEqual({
      accountId: account.id,
      accountProxy: account.proxy,
      apiBaseUrl: account.copilotApiEndpoint,
    })
    await result.return(undefined)
  })
})

describe("account rotation recovery", () => {
  beforeEach(prepareRotation)
  afterEach(assertNoLiveFetch)

  test("uses the refreshed endpoint and records a successful 401 recovery", async () => {
    const account = makeAccount("refreshed-endpoint")
    account.copilotApiEndpoint = "https://old.invalid"
    manager.getAccounts().push(account)
    refreshTokenSpy.mockImplementation((target) => {
      target.copilotToken = "refreshed-token"
      target.copilotApiEndpoint = "https://new.invalid"
      return Promise.resolve()
    })
    const sources: Array<{ endpoint?: string; token?: string }> = []

    const result = await runWithAccountRotation({
      label: "test",
      payload: {},
      transport: (_payload, source) => {
        sources.push({
          endpoint: source.copilotApiEndpoint,
          token: source.copilotToken,
        })
        return sources.length === 1 ?
            Promise.reject(httpError(401))
          : Promise.resolve(streamResponse())
      },
    })

    expect(sources).toEqual([
      {
        endpoint: "https://old.invalid",
        token: "test-copilot-refreshed-endpoint",
      },
      { endpoint: "https://new.invalid", token: "refreshed-token" },
    ])
    expect(Reflect.get(result, "__accountInfo")).toMatchObject({
      accountId: account.id,
      apiBaseUrl: "https://new.invalid",
    })
    expect(account.lastRequestAt).toBeGreaterThan(0)
    await result.return(undefined)
  })

  test("propagates a request error after 401 recovery without penalizing the account", async () => {
    manager.getAccounts().push(makeAccount("retry-invalid"))
    const invalidRequest = new HTTPError(
      "invalid_request_error",
      new Response("invalid request", { status: 400 }),
    )
    let calls = 0

    const result = await runWithAccountRotation({
      label: "test",
      payload: {},
      transport: () => {
        calls++
        return Promise.reject(calls === 1 ? httpError(401) : invalidRequest)
      },
    }).catch((error: unknown) => error)

    expect(result).toBe(invalidRequest)
    expect(calls).toBe(2)
    expect(refreshTokenSpy).toHaveBeenCalledTimes(1)
    expect(markStatusSpy).not.toHaveBeenCalled()
  })

  test("does not update an account when cancellation occurs while reading a 429 body", async () => {
    manager
      .getAccounts()
      .push(makeAccount("cancelled-429"), makeAccount("backup-429"))
    const controller = new AbortController()
    const reason = new Error("cancelled while reading the error body")
    const error = httpError(429)
    const cloned = new Response("user_global_rate_limited:pro_plus")
    spies.push(
      spyOn(error.response, "clone").mockReturnValue(cloned),
      spyOn(cloned, "text").mockImplementation(() => {
        controller.abort(reason)
        return Promise.resolve("user_global_rate_limited:pro_plus")
      }),
    )

    const result = await runWithAccountRotation({
      label: "test",
      payload: {},
      signal: controller.signal,
      transport: () => Promise.reject(error),
    }).catch((caught: unknown) => caught)

    expect(result).toBe(reason)
    expect(markStatusSpy).not.toHaveBeenCalled()
    expect(sessionLimitSpy).not.toHaveBeenCalled()
    expect(refreshRateLimitSpy).not.toHaveBeenCalled()
  })
})

describe("account rotation failover", () => {
  beforeEach(prepareRotation)
  afterEach(assertNoLiveFetch)

  test.each([403, 429])(
    "tries the backup account after HTTP %i",
    async (status) => {
      const accounts = [makeAccount("primary"), makeAccount("backup")]
      manager.getAccounts().push(...accounts)
      const tried: Array<string> = []

      const result = await runWithAccountRotation({
        label: "test",
        payload: {},
        transport: (_payload, _source, accountId) => {
          tried.push(accountId)
          return accountId === "primary" ?
              Promise.reject(httpError(status))
            : Promise.resolve("backup result")
        },
      })

      expect(result).toBe("backup result")
      expect(tried).toEqual(["primary", "backup"])
      expect(markStatusSpy).toHaveBeenCalledWith(
        "primary",
        status === 403 ? "banned" : "rate_limited",
        status === 403 ? "403 Forbidden" : "429 Rate limited",
      )
    },
  )

  test("tries at most three distinct accounts even if failed accounts remain eligible", async () => {
    manager
      .getAccounts()
      .push(
        ...["first", "second", "third", "fourth"].map((id) => makeAccount(id)),
      )
    const tried: Array<string> = []
    const error = httpError(500)

    const result = await runWithAccountRotation({
      label: "test",
      payload: {},
      transport: (_payload, _source, accountId) => {
        tried.push(accountId)
        return Promise.reject(error)
      },
    }).catch((caught: unknown) => caught)

    expect(result).toBe(error)
    expect(tried).toEqual(["first", "second", "third"])
  })

  test.each([403, 429])(
    "preserves the only account after HTTP %i",
    async (status) => {
      const account = makeAccount("solo")
      manager.getAccounts().push(account)
      const error = httpError(status)

      const result = await runWithAccountRotation({
        label: "test",
        payload: {},
        transport: () => Promise.reject(error),
      }).catch((caught: unknown) => caught)

      expect(result).toBe(error)
      expect(markStatusSpy).not.toHaveBeenCalled()
      expect(manager.getActiveAccount()).toBe(account)
    },
  )

  test("still retries the same account once after a network failure", async () => {
    manager.getAccounts().push(makeAccount("network-retry"))
    const tried: Array<string> = []

    const result = await runWithAccountRotation({
      label: "test",
      payload: {},
      transport: (_payload, _source, accountId) => {
        tried.push(accountId)
        return tried.length === 1 ?
            Promise.reject(new Error("test network failure"))
          : Promise.resolve("retried result")
      },
    })

    expect(result).toBe("retried result")
    expect(tried).toEqual(["network-retry", "network-retry"])
    expect(markStatusSpy).not.toHaveBeenCalled()
  })
})

describe("account rotation circuit breaker", () => {
  let now: number

  beforeEach(() => {
    recordBreakerSuccess()
    now = 1_000_000
    spies.push(spyOn(Date, "now").mockImplementation(() => now))
  })

  test("reopens for a full cooldown after a failed probe", () => {
    openBreaker()
    expect(breakerOpenRemainingMs()).toBe(30_000)

    now += 30_001
    expect(() => throwIfBreakerOpen()).not.toThrow()
    recordBreakerFailure("test probe failure")

    expect(breakerOpenRemainingMs()).toBe(30_000)
    expect(() => throwIfBreakerOpen()).toThrow(HTTPError)
  })

  test("does not extend an open cooldown for failures already in flight", () => {
    openBreaker()
    now += 10_000

    recordBreakerFailure("test in-flight failure")

    expect(breakerOpenRemainingMs()).toBe(20_000)
  })

  test("a successful probe resets the failure threshold", () => {
    openBreaker()
    now += 30_001
    recordBreakerSuccess()
    recordBreakerFailure("first failure after recovery")
    recordBreakerFailure("second failure after recovery")

    expect(breakerOpenRemainingMs()).toBe(0)
    recordBreakerFailure("third failure after recovery")
    expect(breakerOpenRemainingMs()).toBe(30_000)
  })
})
