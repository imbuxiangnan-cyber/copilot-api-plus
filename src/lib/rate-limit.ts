import consola from "consola"

import type { State } from "./state"

import { HTTPError } from "./error"
import { sleep } from "./utils"

/** Serialize concurrent rate-limit checks so only one request passes at a time. */
let rateLimitLock: Promise<void> = Promise.resolve()

export async function checkRateLimit(state: State) {
  if (state.rateLimitSeconds === undefined) return

  // Chain on the previous check so concurrent requests are serialized
  const previous = rateLimitLock
  let resolve!: () => void
  rateLimitLock = new Promise<void>((r) => {
    resolve = r
  })

  try {
    await previous

    const now = Date.now()

    if (!state.lastRequestTimestamp) {
      state.lastRequestTimestamp = now
      return
    }

    const elapsedSeconds = (now - state.lastRequestTimestamp) / 1000

    if (elapsedSeconds > state.rateLimitSeconds) {
      state.lastRequestTimestamp = now
      return
    }

    const waitTimeSeconds = Math.ceil(state.rateLimitSeconds - elapsedSeconds)

    if (!state.rateLimitWait) {
      consola.warn(
        `Rate limit exceeded. Need to wait ${waitTimeSeconds} more seconds.`,
      )
      throw new HTTPError(
        "Rate limit exceeded",
        Response.json({ message: "Rate limit exceeded" }, { status: 429 }),
      )
    }

    const waitTimeMs = waitTimeSeconds * 1000
    consola.warn(
      `Rate limit reached. Waiting ${waitTimeSeconds} seconds before proceeding...`,
    )
    await sleep(waitTimeMs)
    // eslint-disable-next-line require-atomic-updates -- serialized by rateLimitLock
    state.lastRequestTimestamp = Date.now()
    consola.debug("Rate limit wait completed, proceeding with request")
  } finally {
    resolve()
  }
}
