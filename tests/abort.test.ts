import { expect, test } from "bun:test"

import { abortableSleep } from "~/lib/abort"

test("retry delays reject immediately with the original cancellation reason", async () => {
  const controller = new AbortController()
  const reason = "caller cancelled"
  const pending = abortableSleep(60_000, controller.signal).catch(
    (error: unknown) => error,
  )
  controller.abort(reason)
  expect(await pending).toBe(reason)
})

test("supports completed delays and rejects pre-cancelled waits", async () => {
  const controller = new AbortController()
  await abortableSleep(0, controller.signal)
  controller.abort()
  const result = await abortableSleep(60_000, controller.signal).catch(
    (error: unknown) => error,
  )
  expect(result).toBe(controller.signal.reason)
})
