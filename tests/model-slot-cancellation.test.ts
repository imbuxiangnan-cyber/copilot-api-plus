import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"

import { modelRouter } from "~/lib/model-router"
import { runWithModelSlot } from "~/lib/model-slot"

const release = mock(() => {})
let acquireSpy: ReturnType<typeof spyOn<typeof modelRouter, "acquireSlot">>

async function* unreadSource() {
  yield await Promise.resolve("data")
}

beforeEach(() => {
  release.mockClear()
  acquireSpy = spyOn(modelRouter, "acquireSlot").mockResolvedValue(release)
})

afterEach(() => {
  acquireSpy.mockRestore()
})

test("cancellation after admission skips transport and releases the slot", async () => {
  const controller = new AbortController()
  const reason = new Error("cancelled after admission")
  const request = mock(() => Promise.resolve("response"))
  const pending = runWithModelSlot(
    "model",
    request,
    () => undefined,
    controller.signal,
  ).catch((error: unknown) => error)
  controller.abort(reason)
  expect(await pending).toBe(reason)
  expect(request).not.toHaveBeenCalled()
  expect(release).toHaveBeenCalledTimes(1)
})

test("cancellation releases an unread stream and preserves the abort reason", async () => {
  const controller = new AbortController()
  const reason = new Error("cancelled unread stream")
  const stream = await runWithModelSlot(
    "model",
    () => Promise.resolve(unreadSource()),
    (result) => result,
    controller.signal,
  )
  controller.abort(reason)
  expect(release).toHaveBeenCalledTimes(1)
  expect(await stream.next().catch((error: unknown) => error)).toBe(reason)
  await stream.return(undefined)
  expect(release).toHaveBeenCalledTimes(1)
})

test("cancellation closes a started generator so its cleanup runs", async () => {
  const controller = new AbortController()
  const cleanup = mock(() => {})
  async function* source() {
    try {
      yield await Promise.resolve("data")
    } finally {
      cleanup()
    }
  }
  const stream = await runWithModelSlot(
    "model",
    () => Promise.resolve(source()),
    (result) => result,
    controller.signal,
  )
  await stream.next()
  controller.abort()
  await Promise.resolve()
  expect(cleanup).toHaveBeenCalledTimes(1)
  expect(release).toHaveBeenCalledTimes(1)
})

test("does not deliver a buffered chunk that resolves after cancellation", async () => {
  const controller = new AbortController()
  const reason = new Error("cancelled pending next")
  const chunk = Promise.withResolvers<string>()
  async function* source() {
    yield await chunk.promise
  }
  const stream = await runWithModelSlot(
    "model",
    () => Promise.resolve(source()),
    (result) => result,
    controller.signal,
  )
  const pending = stream.next().catch((error: unknown) => error)
  controller.abort(reason)
  chunk.resolve("buffered data")
  expect(await pending).toBe(reason)
  await stream.return(undefined)
  expect(release).toHaveBeenCalledTimes(1)
})
