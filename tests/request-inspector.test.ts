import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { clearRequests } from "~/lib/request-inspector"
import { state } from "~/lib/state"
import { server } from "~/server"

const ORIGINAL_API_KEYS = state.apiKeys

beforeEach(() => {
  clearRequests()
})

afterEach(() => {
  clearRequests()
  state.apiKeys = ORIGINAL_API_KEYS
})

describe("request inspector", () => {
  test("records business requests and exposes them through /api/requests", async () => {
    const businessResponse = await server.request("/chat/completions?trace=1", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
        "X-Api-Key": "secret-key",
        "X-Trace-Id": "trace-123",
      },
      body: JSON.stringify({ model: "gpt-test", stream: true, messages: [] }),
    })

    expect(businessResponse.status).toBeGreaterThanOrEqual(200)

    const adminResponse = await server.request("/api/requests")
    expect(adminResponse.status).toBe(200)

    const payload = (await adminResponse.json()) as {
      requests: Array<{
        method: string
        path: string
        query: string
        status: number
        model?: string
        stream?: boolean
        bodyPreview: string
        headers: Record<string, string>
      }>
    }

    expect(payload.requests).toHaveLength(1)
    expect(payload.requests[0].method).toBe("POST")
    expect(payload.requests[0].path).toBe("/chat/completions")
    expect(payload.requests[0].query).toBe("?trace=1")
    expect(payload.requests[0].status).toBe(businessResponse.status)
    expect(payload.requests[0].model).toBe("gpt-test")
    expect(payload.requests[0].stream).toBe(true)
    expect(payload.requests[0].bodyPreview).toContain("gpt-test")
    expect(payload.requests[0].headers.authorization).toBe("[redacted]")
    expect(payload.requests[0].headers["x-api-key"]).toBe("[redacted]")
    expect(payload.requests[0].headers["x-trace-id"]).toBe("trace-123")
  })

  test("DELETE /api/requests clears records", async () => {
    await server.request("/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-test" }),
    })

    const beforeClear = (await (
      await server.request("/api/requests")
    ).json()) as {
      requests: Array<unknown>
    }
    expect(beforeClear.requests).toHaveLength(1)

    const deleteResponse = await server.request("/api/requests", {
      method: "DELETE",
    })
    expect(deleteResponse.status).toBe(200)

    const afterClear = (await (
      await server.request("/api/requests")
    ).json()) as {
      requests: Array<unknown>
    }
    expect(afterClear.requests).toHaveLength(0)
  })

  test("/api/requests itself is not recorded", async () => {
    await server.request("/api/requests")
    await server.request("/api/requests")

    const response = await server.request("/api/requests")
    const payload = (await response.json()) as { requests: Array<unknown> }

    expect(payload.requests).toHaveLength(0)
  })

  test("inspector runs after api key authentication", async () => {
    state.apiKeys = ["correct-key"]

    const response = await server.request("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-test" }),
    })

    expect(response.status).toBe(401)

    state.apiKeys = ORIGINAL_API_KEYS
    const adminResponse = await server.request("/api/requests")
    const payload = (await adminResponse.json()) as { requests: Array<unknown> }

    expect(payload.requests).toHaveLength(0)
  })
})
