import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"

import * as proxy from "~/lib/proxy"
import {
  fetchWithRetry,
  fetchWithTimeout,
} from "~/services/copilot/create-chat-completions"

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>
let resetSpy: ReturnType<typeof spyOn<typeof proxy, "resetConnections">>

beforeEach(() => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))
  resetSpy = spyOn(proxy, "resetConnections").mockImplementation(() => {})
})

afterEach(() => {
  fetchSpy.mockRestore()
  resetSpy.mockRestore()
})

test("does not fetch when the caller is already cancelled", async () => {
  const reason = new Error("request cancelled")
  const result = await fetchWithRetry("https://upstream.invalid", () => ({
    signal: AbortSignal.abort(reason),
  })).catch((error: unknown) => error)

  expect(result).toBe(reason)
  expect(fetchSpy).not.toHaveBeenCalled()
  expect(resetSpy).not.toHaveBeenCalled()
})

test("keeps caller cancellation attached after receiving headers", async () => {
  const controller = new AbortController()
  await fetchWithTimeout("https://upstream.invalid", {
    signal: controller.signal,
  })
  const signal = fetchSpy.mock.calls[0][1]?.signal
  const reason = new Error("response consumer disconnected")
  controller.abort(reason)

  expect(signal?.aborted).toBe(true)
  expect(signal?.reason).toBe(reason)
})

test("reports a header timeout and does not confuse it with caller cancellation", async () => {
  fetchSpy.mockImplementation(((_url, init) => {
    const signal = init?.signal
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason as Error), {
        once: true,
      })
    })
  }) as typeof fetch)

  const result = await fetchWithTimeout(
    "https://upstream.invalid",
    {},
    {
      timeoutMs: 0,
    },
  ).catch((error: unknown) => error)

  expect(result).toBeInstanceOf(Error)
  expect((result as Error).message).toBe("Request timed out after 0ms")
})

test("combines external and init signals and preserves the first cancellation reason", async () => {
  const caller = new AbortController()
  const external = new AbortController()
  fetchSpy.mockImplementation(
    ((_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason as Error),
          { once: true },
        )
      })) as typeof fetch,
  )
  const pending = fetchWithRetry(
    "https://upstream.invalid",
    () => ({ signal: caller.signal }),
    { externalSignal: external.signal },
  ).catch((error: unknown) => error)
  const reason = new Error("first caller cancellation")
  caller.abort(reason)
  external.abort(new Error("later external cancellation"))

  expect(await pending).toBe(reason)
  expect(fetchSpy).toHaveBeenCalledTimes(1)
  expect(resetSpy).not.toHaveBeenCalled()
})
