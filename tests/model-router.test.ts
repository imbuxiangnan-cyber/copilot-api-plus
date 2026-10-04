import { describe, expect, test } from "bun:test"

import { ModelRouter } from "~/lib/model-router"

describe("ModelRouter concurrency", () => {
  test("rejects an already cancelled request without acquiring a slot", async () => {
    const router = new ModelRouter()
    const controller = new AbortController()
    const reason = new Error("cancelled before queueing")
    controller.abort(reason)
    const result = await router
      .acquireSlot("cancelled", controller.signal)
      .then(
        (release) => {
          release()
          return "acquired"
        },
        (error: unknown) => error,
      )
    expect(result).toBe(reason)
    expect(router.getStats().cancelled).toBeUndefined()
  })

  test("removes a cancelled waiter without blocking the next request", async () => {
    const router = new ModelRouter({ mapping: {}, concurrency: { default: 1 } })
    const releaseFirst = await router.acquireSlot("model")
    const controller = new AbortController()
    const reason = new Error("cancelled while queued")
    const cancelled = router.acquireSlot("model", controller.signal).then(
      (release) => {
        release()
        return "acquired"
      },
      (error: unknown) => error,
    )
    const next = router.acquireSlot("model")
    controller.abort(reason)
    try {
      expect(router.getStats().model).toMatchObject({ active: 1, queued: 1 })
    } finally {
      releaseFirst()
      const releaseNext = await next
      releaseNext()
    }
    expect(await cancelled).toBe(reason)
    expect(router.getStats().model).toMatchObject({
      active: 0,
      queued: 0,
      totalRequests: 2,
    })
  })

  test("raising a limit immediately admits queued requests in FIFO order", async () => {
    const router = new ModelRouter({ mapping: {}, concurrency: { default: 1 } })
    const releaseFirst = await router.acquireSlot("model")
    const admitted: Array<number> = []
    const pending = [2, 3, 4].map((index) =>
      router.acquireSlot("model").then((release) => {
        admitted.push(index)
        return release
      }),
    )

    router.updateConcurrency({ default: 3 })

    expect(router.getStats().model).toEqual({
      active: 3,
      queued: 1,
      maxConcurrency: 3,
      totalRequests: 3,
    })
    const [releaseSecond, releaseThird] = await Promise.all(pending.slice(0, 2))
    expect(admitted).toEqual([2, 3])
    releaseSecond()
    const releaseFourth = await pending[2]
    expect(admitted).toEqual([2, 3, 4])
    releaseFirst()
    releaseThird()
    releaseFourth()
    expect(router.getStats().model).toMatchObject({ active: 0, queued: 0 })
  })

  test("default limit updates preserve per-model overrides", async () => {
    const router = new ModelRouter({
      mapping: {},
      concurrency: { default: 1, capped: 1 },
    })
    const releaseFallback = await router.acquireSlot("fallback")
    const releaseCapped = await router.acquireSlot("capped")
    const fallbackWaiter = router.acquireSlot("fallback")
    const cappedWaiter = router.acquireSlot("capped")

    router.updateConcurrency({ default: 2, capped: 1 })

    expect(router.getStats().fallback).toMatchObject({ active: 2, queued: 0 })
    expect(router.getStats().capped).toMatchObject({ active: 1, queued: 1 })
    const releaseNextFallback = await fallbackWaiter
    releaseCapped()
    const releaseNextCapped = await cappedWaiter
    releaseFallback()
    releaseNextFallback()
    releaseNextCapped()
  })

  test("lowering a limit waits for active requests to fall below the new limit", async () => {
    const router = new ModelRouter({ mapping: {}, concurrency: { default: 3 } })
    const releases = await Promise.all(
      [1, 2, 3].map(() => router.acquireSlot("model")),
    )
    const firstWaiter = router.acquireSlot("model")
    const secondWaiter = router.acquireSlot("model")

    router.updateConcurrency({ default: 1 })
    expect(router.getStats().model).toMatchObject({ active: 3, queued: 2 })
    releases[0]()
    expect(router.getStats().model).toMatchObject({ active: 2, queued: 2 })
    releases[1]()
    expect(router.getStats().model).toMatchObject({ active: 1, queued: 2 })
    releases[2]()
    const releaseFirstWaiter = await firstWaiter
    expect(router.getStats().model).toMatchObject({ active: 1, queued: 1 })
    releaseFirstWaiter()
    const releaseSecondWaiter = await secondWaiter
    expect(router.getStats().model).toMatchObject({ active: 1, queued: 0 })
    releaseSecondWaiter()
    expect(router.getStats().model).toMatchObject({ active: 0, queued: 0 })
  })

  test("immediate and queued release functions are idempotent", async () => {
    const router = new ModelRouter({ mapping: {}, concurrency: { default: 1 } })
    const releaseFirst = await router.acquireSlot("model")
    const secondWaiter = router.acquireSlot("model")
    const thirdWaiter = router.acquireSlot("model")

    releaseFirst()
    releaseFirst()
    expect(router.getStats().model).toMatchObject({
      active: 1,
      queued: 1,
      totalRequests: 2,
    })
    const releaseSecond = await secondWaiter
    releaseSecond()
    releaseSecond()
    expect(router.getStats().model).toMatchObject({
      active: 1,
      queued: 0,
      totalRequests: 3,
    })
    const releaseThird = await thirdWaiter
    releaseThird()
    releaseThird()
    expect(router.getStats().model).toMatchObject({ active: 0, queued: 0 })
  })

  test("aliases share slots and statistics under the already-resolved model", async () => {
    const router = new ModelRouter({
      mapping: {
        first: "actual",
        second: "actual",
        actual: "other",
        "*": "fallback",
      },
      concurrency: { default: 3, actual: 1 },
    })
    const releaseFirst = await router.acquireSlot(router.resolveModel("first"))
    const secondWaiter = router.acquireSlot(router.resolveModel("second"))

    expect(router.resolveModel("unknown")).toBe("fallback")
    expect(router.getStats()).toEqual({
      actual: { active: 1, queued: 1, maxConcurrency: 1, totalRequests: 1 },
    })
    router.updateConcurrency({ default: 3, actual: 2 })
    expect(router.getStats().actual).toMatchObject({
      active: 2,
      queued: 0,
      totalRequests: 2,
    })
    const releaseSecond = await secondWaiter
    router.resetStats()
    expect(router.getStats().actual).toMatchObject({
      active: 2,
      totalRequests: 0,
    })
    releaseFirst()
    releaseSecond()
    router.updateMapping({})
    expect(router.resolveModel("first")).toBe("first")
  })
})
