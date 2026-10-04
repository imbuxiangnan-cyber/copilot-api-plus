import { beforeEach, expect, mock, test } from "bun:test"

import { releaseWhenStreamEnds } from "~/lib/model-slot"

const release = mock(() => {})

beforeEach(() => {
  release.mockClear()
})

async function* sourceWithCleanup() {
  try {
    yield await Promise.resolve("first")
  } finally {
    yield "cleanup"
  }
}

async function* sourceWithRecovery() {
  try {
    yield await Promise.resolve("first")
  } catch {
    yield "recovered"
  }
}

test("keeps the slot when return yields from a generator finally block", async () => {
  const stream = sourceWithCleanup()
  releaseWhenStreamEnds(stream, release)

  await stream.next()
  expect(await stream.return(undefined)).toEqual({
    done: false,
    value: "cleanup",
  })
  expect(release).not.toHaveBeenCalled()
  expect((await stream.next()).done).toBe(true)
  await stream.return(undefined)
  expect(release).toHaveBeenCalledTimes(1)
})

test("keeps the slot when a generator catches throw and continues", async () => {
  const stream = sourceWithRecovery()
  releaseWhenStreamEnds(stream, release)

  await stream.next()
  expect(await stream.throw(new Error("recoverable"))).toEqual({
    done: false,
    value: "recovered",
  })
  expect(release).not.toHaveBeenCalled()
  expect((await stream.next()).done).toBe(true)
  await stream.return(undefined)
  expect(release).toHaveBeenCalledTimes(1)
})
