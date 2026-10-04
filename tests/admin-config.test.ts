import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { state } from "~/lib/state"
import { adminRoutes } from "~/routes/admin/route"

let originalThinking: Pick<typeof state, "maxThinking" | "thinkingEffort">

beforeEach(() => {
  originalThinking = {
    maxThinking: state.maxThinking,
    thinkingEffort: state.thinkingEffort,
  }
  state.maxThinking = true
  state.thinkingEffort = "auto"
})

afterEach(() => {
  Object.assign(state, originalThinking)
})

function updateConfig(body: unknown): Promise<Response> | Response {
  return adminRoutes.request("/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("runtime config updates", () => {
  test("rejects the entire update when a later field is invalid", async () => {
    const response = await updateConfig({
      maxThinking: false,
      thinkingEffort: "invalid",
    })

    expect(response.status).toBe(400)
    expect(state.maxThinking).toBe(true)
    expect(state.thinkingEffort).toBe("auto")
  })

  test("rejects arrays instead of treating them as config objects", async () => {
    const response = await updateConfig([])

    expect(response.status).toBe(400)
    expect(state.maxThinking).toBe(true)
    expect(state.thinkingEffort).toBe("auto")
  })

  test("applies valid fields together and exposes them through GET", async () => {
    const response = await updateConfig({
      maxThinking: false,
      thinkingEffort: "low",
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      updated: { maxThinking: false, thinkingEffort: "low" },
    })
    const config = await adminRoutes.request("/config")
    expect(await config.json()).toMatchObject({
      maxThinking: false,
      thinkingEffort: "low",
    })
  })
})
