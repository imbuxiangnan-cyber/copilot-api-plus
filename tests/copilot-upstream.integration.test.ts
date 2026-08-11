import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import { clearRequests } from "~/lib/request-inspector"
import { clearRouteCache } from "~/lib/route-resolver"
import { state } from "~/lib/state"
import { server } from "~/server"

const originalFetch = globalThis.fetch

type FetchInput = Parameters<typeof fetch>[0]

function fetchInputUrl(input: FetchInput): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return input.url
}

function requestBodyText(body: RequestInit["body"]): string {
  if (typeof body === "string") return body
  throw new TypeError("Expected JSON string request body")
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  })
}

function makeModel(
  id: string,
  supports: Model["capabilities"]["supports"],
  supportedEndpoints: Array<string> = ["/v1/messages"],
): Model {
  return {
    id,
    name: id,
    object: "model",
    model_picker_enabled: true,
    preview: false,
    vendor: "anthropic",
    version: "1",
    supported_endpoints: supportedEndpoints,
    capabilities: {
      family: "claude",
      limits: {},
      object: "model_capabilities",
      supports,
      tokenizer: "cl100k_base",
      type: "chat",
    },
  }
}

function setModels(models: Array<Model>): void {
  state.models = {
    object: "list",
    data: models,
  }
}

function anthropicMessage(model = "upstream-model") {
  return {
    id: "msg_mock",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

async function postMessage(
  payload: Record<string, unknown>,
): Promise<Response> {
  return await server.request("http://test/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
}

beforeEach(() => {
  clearRouteCache()
  state.copilotToken = "test-copilot-token"
  state.copilotApiEndpoint = undefined
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
  state.disableAnthropicPassthrough = false
  state.maxThinking = true
  state.thinkingEffort = "auto"
  state.models = undefined
  state.multiAccountEnabled = false
  state.apiKeys = undefined
  state.manualApprove = false
  state.rateLimitSeconds = undefined
  state.lastRequestTimestamp = undefined
  clearRequests()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  clearRouteCache()
  clearRequests()
  state.models = undefined
})

describe("mock Copilot upstream integration", () => {
  test("GET /v1/models fetches Copilot models and caches native capabilities", async () => {
    const upstreamModel = makeModel("claude-opus-4.8", {
      adaptive_thinking: true,
      reasoning_effort: ["medium"],
    })
    const fetchMock = mock((input: FetchInput) => {
      expect(fetchInputUrl(input)).toBe("https://api.githubcopilot.com/models")
      return jsonResponse({ object: "list", data: [upstreamModel] })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await server.request("http://test/v1/models")
    const body = (await res.json()) as { data: Array<{ id: string }> }

    expect(res.status).toBe(200)
    expect(body.data[0].id).toBe("claude-opus-4.8")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(state.models?.data[0].supported_endpoints).toEqual(["/v1/messages"])
    expect(state.models?.data[0].capabilities.supports.adaptive_thinking).toBe(
      true,
    )
  })

  test("POST /v1/messages routes native and sanitizes payload before Copilot upstream", async () => {
    setModels([
      makeModel("claude-opus-4.8", {
        adaptive_thinking: true,
        reasoning_effort: ["medium"],
        sampling_parameters: false,
      } as Model["capabilities"]["supports"]),
    ])

    const fetchMock = mock((input: FetchInput, init?: RequestInit) => {
      expect(fetchInputUrl(input)).toBe(
        "https://api.githubcopilot.com/v1/messages",
      )
      expect(init?.method).toBe("POST")
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer test-copilot-token",
      )
      expect((init?.headers as Record<string, string>)["X-Initiator"]).toBe(
        "user",
      )

      const upstream = JSON.parse(requestBodyText(init?.body)) as Record<
        string,
        unknown
      >
      expect("context_management" in upstream).toBe(false)
      expect("effort" in upstream).toBe(false)
      expect("temperature" in upstream).toBe(false)
      expect("top_p" in upstream).toBe(false)
      expect("top_k" in upstream).toBe(false)
      expect(upstream.thinking).toEqual({ type: "adaptive" })
      expect((upstream.output_config as { effort?: string }).effort).toBe(
        "medium",
      )
      expect(
        (upstream.output_config as { format: { schema?: unknown } }).format
          .schema,
      ).toEqual({ type: "object" })
      const format = (
        upstream.output_config as { format: Record<string, unknown> }
      ).format
      expect("json_schema" in format).toBe(false)
      expect("name" in format).toBe(false)
      expect("strict" in format).toBe(false)

      return jsonResponse(anthropicMessage())
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await postMessage({
      model: "claude-opus-4.8",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      context_management: { clear_function_results: true },
      effort: "max",
      temperature: 0.2,
      top_p: 0.8,
      top_k: 50,
      output_config: {
        format: {
          type: "json_schema",
          json_schema: { schema: { type: "object" } },
          name: "response",
          strict: true,
        },
      },
    })
    const body = (await res.json()) as { model: string }

    expect(res.status).toBe(200)
    expect(body.model).toBe("claude-opus-4.8")
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const inspectorPayload = (await (
      await server.request("http://test/api/requests")
    ).json()) as {
      requests: Array<{ trace: Array<{ action: string; detail?: string }> }>
    }
    const trace = inspectorPayload.requests[0].trace
    const traceActions = trace.map((item) => item.action)
    expect(traceActions).toContain("strip_context_management")
    expect(traceActions).toContain("strip_effort")
    expect(traceActions).toContain("strip_temperature")
    expect(traceActions).toContain("strip_top_p")
    expect(traceActions).toContain("strip_top_k")
    expect(traceActions).toContain("flatten_output_config_format_schema")
    expect(traceActions).toContain("strip_output_config_format_json_schema")
    expect(traceActions).toContain("strip_output_config_format_name")
    expect(traceActions).toContain("strip_output_config_format_strict")
    expect(traceActions).toContain("inject_adaptive_thinking")
    expect(trace).toContainEqual({
      action: "set_output_config_effort",
      detail: "medium",
    })
  })

  test("legacy non-thinking native request keeps sampling parameters", async () => {
    setModels([
      makeModel("claude-opus-4.5", {
        adaptive_thinking: false,
      }),
    ])

    const fetchMock = mock((_input: FetchInput, init?: RequestInit) => {
      const upstream = JSON.parse(requestBodyText(init?.body)) as Record<
        string,
        unknown
      >
      expect(upstream.temperature).toBe(0.2)
      expect(upstream.top_p).toBe(0.8)
      expect(upstream.top_k).toBe(50)
      expect(upstream.thinking).toBeUndefined()
      return jsonResponse(anthropicMessage())
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await postMessage({
      model: "claude-opus-4.5",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.2,
      top_p: 0.8,
      top_k: 50,
    })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
