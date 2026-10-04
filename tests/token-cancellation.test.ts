import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"

import { AccountManager, type Account } from "~/lib/account-manager"
import { state, type State } from "~/lib/state"
import { refreshCopilotToken } from "~/lib/token"
import { getCopilotToken } from "~/services/github/get-copilot-token"

let savedState: State
let manager: AccountManager
let account: Account
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>
let statusSpy: ReturnType<typeof spyOn<AccountManager, "markAccountStatus">>
let saveSpy: ReturnType<typeof spyOn<AccountManager, "saveAccounts">>
const responseSpies: Array<{ mockRestore: () => void }> = []
const tokenResponse = {
  token: "new-copilot-token",
  refresh_in: 1800,
  expires_at: 2000000000,
  endpoints: { api: "https://new.invalid" },
}

beforeEach(() => {
  savedState = { ...state }
  Object.assign(state, {
    githubToken: "test-github-token",
    copilotToken: "old-copilot-token",
    copilotApiEndpoint: "https://old.invalid",
    showToken: false,
  })
  account = {
    id: "token-cancellation-test",
    label: "test",
    githubToken: "test-account-github-token",
    copilotToken: "old-account-token",
    copilotApiEndpoint: "https://old-account.invalid",
    accountType: "individual",
    status: "active",
    consecutiveFailures: 0,
    addedAt: 1,
  }
  manager = new AccountManager()
  manager.getAccounts().push(account)
  statusSpy = spyOn(manager, "markAccountStatus").mockImplementation(() => {})
  saveSpy = spyOn(manager, "saveAccounts").mockResolvedValue(undefined)
  fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Unexpected live fetch"),
  )
})

afterEach(() => {
  for (const spy of responseSpies) spy.mockRestore()
  responseSpies.length = 0
  fetchSpy.mockRestore()
  statusSpy.mockRestore()
  saveSpy.mockRestore()
  for (const key of Object.keys(state)) Reflect.deleteProperty(state, key)
  Object.assign(state, savedState)
})

function expectUnchangedCredentials(): void {
  expect(state.copilotToken).toBe("old-copilot-token")
  expect(state.copilotApiEndpoint).toBe("https://old.invalid")
  expect(account.copilotToken).toBe("old-account-token")
  expect(account.copilotApiEndpoint).toBe("https://old-account.invalid")
  expect(statusSpy).not.toHaveBeenCalled()
  expect(saveSpy).not.toHaveBeenCalled()
}

function mockFetch(
  implementation: (
    ...args: Parameters<typeof fetch>
  ) => ReturnType<typeof fetch>,
): void {
  fetchSpy.mockImplementation(
    Object.assign(implementation, { preconnect: () => {} }),
  )
}

const clients = [
  {
    name: "direct token fetch",
    call: (signal: AbortSignal) => getCopilotToken("test-token", signal),
  },
  {
    name: "single-account refresh",
    call: (signal: AbortSignal) => refreshCopilotToken(signal),
  },
  {
    name: "multi-account refresh",
    call: (signal: AbortSignal) => manager.refreshAccountToken(account, signal),
  },
]

describe.each(clients)("$name cancellation", ({ call }) => {
  test("rejects an already cancelled request before fetching", async () => {
    const reason = new Error("cancelled before refresh")
    const result = await call(AbortSignal.abort(reason)).catch(
      (error: unknown) => error,
    )

    expect(result).toBe(reason)
    expect(fetchSpy).not.toHaveBeenCalled()
    expectUnchangedCredentials()
  })

  test("aborts pending fetch without retrying or changing credentials", async () => {
    const controller = new AbortController()
    const reason = new Error("cancelled during token fetch")
    const started = Promise.withResolvers<undefined>()
    mockFetch((_url, init) => {
      started.resolve(undefined)
      if (!init?.signal)
        return Promise.reject(new Error("Missing abort signal"))
      const signal = init.signal
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason as Error), {
          once: true,
        })
      })
    })
    const pending = call(controller.signal).catch((error: unknown) => error)
    await started.promise
    controller.abort(reason)

    expect(await pending).toBe(reason)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expectUnchangedCredentials()
  })

  test("does not apply credentials when cancelled while decoding JSON", async () => {
    const controller = new AbortController()
    const reason = new Error("cancelled during token JSON")
    const response = Response.json(tokenResponse)
    responseSpies.push(
      spyOn(response, "json").mockImplementation(() => {
        controller.abort(reason)
        return Promise.resolve(tokenResponse)
      }),
    )
    fetchSpy.mockResolvedValue(response)

    const result = await call(controller.signal).catch(
      (error: unknown) => error,
    )

    expect(result).toBe(reason)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expectUnchangedCredentials()
  })
})

test("cancellation interrupts the token retry delay", async () => {
  const controller = new AbortController()
  const reason = new Error("cancelled during token backoff")
  const started = Promise.withResolvers<undefined>()
  mockFetch(() => {
    started.resolve(undefined)
    return Promise.reject(new Error("test network failure"))
  })
  const pending = getCopilotToken("test-token", controller.signal).catch(
    (error: unknown) => error,
  )
  await started.promise
  await Promise.resolve()
  controller.abort(reason)

  expect(await pending).toBe(reason)
  expect(fetchSpy).toHaveBeenCalledTimes(1)
  expectUnchangedCredentials()
})

test("a cancelled refresh does not mark an account banned after HTTP 401", async () => {
  const controller = new AbortController()
  const reason = new Error("cancelled before token response handling")
  mockFetch(() => {
    controller.abort(reason)
    return Promise.resolve(new Response("invalid token", { status: 401 }))
  })

  const result = await manager
    .refreshAccountToken(account, controller.signal)
    .catch((error: unknown) => error)

  expect(result).toBe(reason)
  expect(fetchSpy).toHaveBeenCalledTimes(1)
  expectUnchangedCredentials()
})

test("background refresh calls remain compatible without a signal", async () => {
  mockFetch(() => Promise.resolve(Response.json(tokenResponse)))

  await refreshCopilotToken()
  await manager.refreshAccountToken(account)

  expect(fetchSpy).toHaveBeenCalledTimes(2)
  expect(state.copilotToken).toBe(tokenResponse.token)
  expect(state.copilotApiEndpoint).toBe(tokenResponse.endpoints.api)
  expect(account.copilotToken).toBe(tokenResponse.token)
  expect(account.copilotApiEndpoint).toBe(tokenResponse.endpoints.api)
  expect(statusSpy).not.toHaveBeenCalled()
  expect(saveSpy).not.toHaveBeenCalled()
})
