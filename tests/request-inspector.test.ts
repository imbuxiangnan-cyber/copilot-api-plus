import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { clearRequests } from "~/lib/request-inspector"
import { state } from "~/lib/state"
import { server } from "~/server"

let originalState: typeof state
let originalFetch: typeof fetch
const fetchMock = mock(
  (
    _input: Parameters<typeof fetch>[0],
    _init?: RequestInit,
  ): Promise<Response> => {
    throw new Error("Unexpected upstream request in request inspector test")
  },
)

beforeEach(() => {
  originalState = { ...state }
  originalFetch = globalThis.fetch
  Object.assign(state, {
    copilotToken: "test-copilot-token",
    copilotApiEndpoint: undefined,
    vsCodeVersion: "1.0.0",
    accountType: "individual",
    multiAccountEnabled: false,
    models: undefined,
    apiKeys: undefined,
    manualApprove: false,
    rateLimitSeconds: undefined,
    lastRequestTimestamp: undefined,
  })
  fetchMock.mockReset()
  fetchMock.mockImplementation(() => {
    throw new Error("Unexpected upstream request in request inspector test")
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  clearRequests()
})

afterEach(() => {
  clearRequests()
  globalThis.fetch = originalFetch
  for (const key of Object.keys(state)) {
    if (!Object.hasOwn(originalState, key)) Reflect.deleteProperty(state, key)
  }
  Object.assign(state, originalState)
})

describe("request inspector", () => {
  test("records business requests and exposes them through /api/requests", async () => {
    const chunk = {
      id: "chat-inspector",
      object: "chat.completion.chunk",
      created: 123,
      model: "gpt-test",
      choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
    }
    fetchMock.mockImplementationOnce((input, init) => {
      expect(input).toBe("https://api.githubcopilot.com/chat/completions")
      expect(init?.method).toBe("POST")
      return Promise.resolve(
        new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        }),
      )
    })
    const businessResponse = await server.request("/chat/completions?trace=1", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
        "X-Api-Key": "secret-key",
        "X-Trace-Id": "trace-123",
      },
      body: JSON.stringify({
        model: "gpt-test",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    const streamBody = await businessResponse.text()
    expect(businessResponse.status).toBe(200)
    expect(businessResponse.headers.get("content-type")).toContain(
      "text/event-stream",
    )
    expect(streamBody).toContain(JSON.stringify(chunk))
    expect(streamBody).toContain("data: [DONE]")
    expect(fetchMock).toHaveBeenCalledTimes(1)

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
    const upstreamResponse = {
      id: "resp-inspector",
      object: "response",
      model: "gpt-test",
      output: [],
    }
    fetchMock.mockImplementationOnce((input, init) => {
      expect(input).toBe("https://api.githubcopilot.com/v1/responses")
      expect(init?.method).toBe("POST")
      return Promise.resolve(Response.json(upstreamResponse))
    })
    const businessResponse = await server.request("/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        input: [{ role: "user", content: "hi" }],
      }),
    })
    expect(businessResponse.status).toBe(200)
    expect(await businessResponse.json()).toEqual(upstreamResponse)
    expect(fetchMock).toHaveBeenCalledTimes(1)

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
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("inspector runs after api key authentication", async () => {
    state.apiKeys = ["correct-key"]

    const response = await server.request("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-test" }),
    })

    expect(response.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()

    const adminResponse = await server.request("/api/requests", {
      headers: { Authorization: "Bearer correct-key" },
    })
    expect(adminResponse.status).toBe(200)
    const payload = (await adminResponse.json()) as { requests: Array<unknown> }

    expect(payload.requests).toHaveLength(0)
  })
})
