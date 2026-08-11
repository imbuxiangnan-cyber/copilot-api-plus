import { describe, test, expect, beforeEach } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { Model } from "~/services/copilot/get-models"

import {
  injectMaxThinkingBudget,
  isInvalidThinkingSignatureError,
  normalizeAdaptiveThinkingForCopilot,
  overrideAnthropicResponseModel,
  overrideMessageStartEventModel,
  sanitizeForCopilotBackend,
  stripAssistantThinkingBlocks,
} from "~/lib/anthropic-sanitizer"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

function basePayload(
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload {
  return {
    model: "claude-opus-4-5",
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  }
}

function buildHTTPError(status: number, body: string): HTTPError {
  return new HTTPError(
    `boom`,
    new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    }),
  )
}

describe("sanitizeForCopilotBackend", () => {
  beforeEach(() => {
    state.models = undefined
  })

  test("strips context_management", () => {
    const payload = basePayload() as AnthropicMessagesPayload & {
      context_management?: unknown
    }
    payload.context_management = { foo: "bar" }
    sanitizeForCopilotBackend(payload)
    expect("context_management" in payload).toBe(false)
  })

  test("flattens nested json_schema → schema", () => {
    const payload = basePayload() as AnthropicMessagesPayload & {
      output_config?: { format?: Record<string, unknown> }
    }
    payload.output_config = {
      format: {
        type: "json_schema",
        json_schema: { schema: { type: "object" } },
        name: "x",
        strict: true,
      },
    }
    sanitizeForCopilotBackend(payload)
    const fmt = (payload.output_config as { format: Record<string, unknown> })
      .format
    expect(fmt.schema).toEqual({ type: "object" })
    expect("json_schema" in fmt).toBe(false)
    expect("name" in fmt).toBe(false)
    expect("strict" in fmt).toBe(false)
  })

  test("ignores non-json_schema format", () => {
    const payload = basePayload() as AnthropicMessagesPayload & {
      output_config?: { format?: Record<string, unknown> }
    }
    payload.output_config = { format: { type: "text" } }
    sanitizeForCopilotBackend(payload)
    expect(payload.output_config.format).toEqual({ type: "text" })
  })

  test("strips effort field (Copilot backend rejects it with 400)", () => {
    const payload = basePayload({ effort: "max" })
    sanitizeForCopilotBackend(payload)
    expect(payload.effort).toBeUndefined()
  })

  test("strips sampling parameters for Claude 4.7+ native messages models", () => {
    const payload = basePayload({
      model: "claude-opus-5",
      temperature: 0.2,
      top_p: 0.8,
      top_k: 50,
    })
    sanitizeForCopilotBackend(payload)
    expect(payload.temperature).toBeUndefined()
    expect(payload.top_p).toBeUndefined()
    expect(payload.top_k).toBeUndefined()
  })

  test("strips sampling parameters when thinking is enabled", () => {
    const payload = basePayload({
      temperature: 1,
      top_p: 0.9,
      top_k: 40,
      thinking: { type: "enabled", budget_tokens: 32000 },
    })
    sanitizeForCopilotBackend(payload)
    expect(payload.temperature).toBeUndefined()
    expect(payload.top_p).toBeUndefined()
    expect(payload.top_k).toBeUndefined()
  })

  test("keeps sampling parameters for legacy non-thinking requests", () => {
    const payload = basePayload({
      model: "claude-opus-4-5",
      temperature: 0.2,
      top_p: 0.8,
      top_k: 50,
    })
    sanitizeForCopilotBackend(payload)
    expect(payload.temperature).toBe(0.2)
    expect(payload.top_p).toBe(0.8)
    expect(payload.top_k).toBe(50)
  })
})

describe("normalizeAdaptiveThinkingForCopilot", () => {
  beforeEach(() => {
    state.models = undefined
    state.thinkingEffort = "auto"
  })

  test("strips budget_tokens_max from adaptive thinking", () => {
    const payload = basePayload() as AnthropicMessagesPayload & {
      thinking?: Record<string, unknown>
    }
    payload.thinking = { type: "adaptive", budget_tokens_max: 5000 }
    normalizeAdaptiveThinkingForCopilot(payload)
    expect("budget_tokens_max" in payload.thinking).toBe(false)
    expect(payload.thinking.type).toBe("adaptive")
  })

  test("leaves enabled thinking untouched when model is unknown", () => {
    const payload = basePayload() as AnthropicMessagesPayload & {
      thinking?: Record<string, unknown>
    }
    payload.thinking = { type: "enabled", budget_tokens: 1024 }
    normalizeAdaptiveThinkingForCopilot(payload)
    expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 1024 })
  })

  test("coerces enabled→adaptive for adaptive-only models (Opus 4.7)", () => {
    setModelCapability("claude-opus-4.7", {
      adaptive_thinking: true,
      reasoning_effort: ["medium"],
    })
    const payload = basePayload({
      model: "claude-opus-4.7",
      thinking: { type: "enabled", budget_tokens: 32000 },
    })
    normalizeAdaptiveThinkingForCopilot(payload)
    expect(payload.thinking).toEqual({ type: "adaptive" })
    expect(payload.output_config?.effort).toBe("medium")
  })

  test("coerce honors explicit thinkingEffort by downgrading to model whitelist", () => {
    state.thinkingEffort = "high"
    setModelCapability("claude-opus-4.7", {
      adaptive_thinking: true,
      reasoning_effort: ["medium"],
    })
    const payload = basePayload({
      model: "claude-opus-4.7",
      thinking: { type: "enabled", budget_tokens: 32000 },
    })
    normalizeAdaptiveThinkingForCopilot(payload)
    expect(payload.thinking).toEqual({ type: "adaptive" })
    expect(payload.output_config?.effort).toBe("medium")
  })

  test("coerce preserves explicit client output_config.effort", () => {
    state.thinkingEffort = "high"
    setModelCapability("claude-opus-4.7", {
      adaptive_thinking: true,
      reasoning_effort: ["medium"],
    })
    const payload = basePayload({
      model: "claude-opus-4.7",
      thinking: { type: "enabled", budget_tokens: 32000 },
      output_config: { effort: "low" as never },
    })
    normalizeAdaptiveThinkingForCopilot(payload)
    expect(payload.thinking).toEqual({ type: "adaptive" })
    expect(payload.output_config?.effort).toBe("low")
  })

  test("does not coerce enabled thinking for non-adaptive models", () => {
    setModelCapability("claude-opus-4.5", {
      max_thinking_budget: 32000,
      adaptive_thinking: false,
    })
    const payload = basePayload({
      model: "claude-opus-4.5",
      thinking: { type: "enabled", budget_tokens: 1024 },
    })
    normalizeAdaptiveThinkingForCopilot(payload)
    expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 1024 })
  })
})

describe("stripAssistantThinkingBlocks", () => {
  test("returns stripped=false when nothing to strip", () => {
    const payload = basePayload()
    const result = stripAssistantThinkingBlocks(payload)
    expect(result.stripped).toBe(false)
    expect(result.payload).toBe(payload)
  })

  test("removes thinking and redacted_thinking blocks", () => {
    const payload = basePayload({
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "..." },
            { type: "text", text: "hello" },
            { type: "redacted_thinking", data: "..." },
          ],
        } as never,
      ],
    })
    const result = stripAssistantThinkingBlocks(payload)
    expect(result.stripped).toBe(true)
    expect(result.strippedBlocks).toBe(2)
    expect(result.droppedAssistantMessages).toBe(0)
    const assistantMsg = result.payload.messages[1] as {
      content: Array<{ type: string }>
    }
    expect(assistantMsg.content).toHaveLength(1)
    expect(assistantMsg.content[0].type).toBe("text")
  })

  test("drops assistant turns left empty after strip", () => {
    const payload = basePayload({
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "..." }],
        } as never,
        { role: "user", content: "ok" },
      ],
    })
    const result = stripAssistantThinkingBlocks(payload)
    expect(result.stripped).toBe(true)
    expect(result.strippedBlocks).toBe(1)
    expect(result.droppedAssistantMessages).toBe(1)
    expect(result.payload.messages).toHaveLength(2)
  })

  test("does not mutate input payload", () => {
    const payload = basePayload({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "..." },
            { type: "text", text: "hi" },
          ],
        } as never,
      ],
    })
    const originalContent = (payload.messages[0] as { content: unknown })
      .content
    stripAssistantThinkingBlocks(payload)
    expect((payload.messages[0] as { content: unknown }).content).toBe(
      originalContent,
    )
  })
})

describe("isInvalidThinkingSignatureError", () => {
  test("matches the upstream phrasing on a 400", async () => {
    const err = buildHTTPError(
      400,
      JSON.stringify({
        error: { message: "Invalid `signature` in `thinking` block" },
      }),
    )
    expect(await isInvalidThinkingSignatureError(err)).toBe(true)
  })

  test("returns false for unrelated 400", async () => {
    const err = buildHTTPError(
      400,
      JSON.stringify({ error: { message: "bad request" } }),
    )
    expect(await isInvalidThinkingSignatureError(err)).toBe(false)
  })

  test("returns false for non-HTTPError", async () => {
    expect(await isInvalidThinkingSignatureError(new Error("nope"))).toBe(false)
  })

  test("matches when body is consumed but message contains the body (real-world case)", async () => {
    // This mirrors what `throwUpstreamError` produces: it pre-reads the
    // body via `await response.text()`, embeds it in the HTTPError
    // message, and the body stream is then drained. The detection must
    // still fire from the message.
    const body = JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "messages.1.content.0: Invalid signature in thinking block",
      },
      request_id: "req_vrtx_xxx",
    })
    const response = new Response(body, {
      status: 400,
      headers: { "content-type": "application/json" },
    })
    // Drain the body to simulate `throwUpstreamError` having read it.
    await response.text()
    const err = new HTTPError(
      `Failed to call /v1/messages: 400 ${body}`,
      response,
    )
    expect(await isInvalidThinkingSignatureError(err)).toBe(true)
  })

  test("returns false on non-400 status", async () => {
    const err = buildHTTPError(
      500,
      JSON.stringify({
        error: { message: "Invalid signature in thinking block" },
      }),
    )
    expect(await isInvalidThinkingSignatureError(err)).toBe(false)
  })
})

describe("overrideAnthropicResponseModel", () => {
  test("rewrites model name", () => {
    const result = overrideAnthropicResponseModel(
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-5-20251101",
        content: [],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      } as never,
      "claude-opus-4-5",
    )
    expect(result.model).toBe("claude-opus-4-5")
  })
})

describe("overrideMessageStartEventModel", () => {
  test("rewrites model in message_start", () => {
    const data = JSON.stringify({
      type: "message_start",
      message: { id: "x", model: "claude-opus-4-5-20251101" },
    })
    const result = overrideMessageStartEventModel(data, "claude-opus-4-5")
    expect(JSON.parse(result)).toEqual({
      type: "message_start",
      message: { id: "x", model: "claude-opus-4-5" },
    })
  })

  test("leaves non-message_start events untouched", () => {
    const data = JSON.stringify({ type: "ping" })
    expect(overrideMessageStartEventModel(data, "claude-x")).toBe(data)
  })

  test("returns original on parse error", () => {
    expect(overrideMessageStartEventModel("not-json", "claude-x")).toBe(
      "not-json",
    )
  })
})

function setModelCapability(
  id: string,
  supports: {
    max_thinking_budget?: number
    adaptive_thinking?: boolean
    reasoning_effort?: Array<string>
  },
): void {
  state.models = {
    object: "list",
    data: [
      {
        id,
        name: id,
        object: "model",
        model_picker_enabled: true,
        preview: false,
        vendor: "anthropic",
        version: "1",
        capabilities: {
          family: "claude",
          limits: {},
          object: "model_capabilities",
          supports,
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
    ] as Array<Model>,
  }
}

describe("injectMaxThinkingBudget", () => {
  beforeEach(() => {
    state.models = undefined
    state.maxThinking = true
    state.thinkingEffort = "auto"
  })

  test("injects adaptive thinking + highest allowed effort for adaptive-capable model", () => {
    setModelCapability("claude-sonnet-4.6", {
      max_thinking_budget: 32000,
      adaptive_thinking: true,
      reasoning_effort: ["low", "medium", "high"],
    })
    const payload = basePayload({ model: "claude-sonnet-4.6" })
    injectMaxThinkingBudget(payload)
    expect(payload.thinking).toEqual({ type: "adaptive" })
    expect(payload.output_config?.effort).toBe("high")
  })

  test("explicit high downgrades to medium when model only allows medium", () => {
    state.thinkingEffort = "high"
    setModelCapability("claude-opus-4.8", {
      max_thinking_budget: 32000,
      adaptive_thinking: true,
      reasoning_effort: ["medium"],
    })
    const payload = basePayload({ model: "claude-opus-4.8" })
    injectMaxThinkingBudget(payload)
    expect(payload.thinking).toEqual({ type: "adaptive" })
    expect(payload.output_config?.effort).toBe("medium")
  })

  test("explicit xhigh downgrades to high when model allows low through high", () => {
    state.thinkingEffort = "xhigh"
    setModelCapability("claude-sonnet-4.6", {
      max_thinking_budget: 32000,
      adaptive_thinking: true,
      reasoning_effort: ["low", "medium", "high"],
    })
    const payload = basePayload({ model: "claude-sonnet-4.6" })
    injectMaxThinkingBudget(payload)
    expect(payload.thinking).toEqual({ type: "adaptive" })
    expect(payload.output_config?.effort).toBe("high")
  })

  test("omits effort when explicit effort is below model whitelist", () => {
    state.thinkingEffort = "low"
    setModelCapability("claude-opus-4.8", {
      max_thinking_budget: 32000,
      adaptive_thinking: true,
      reasoning_effort: ["medium"],
    })
    const payload = basePayload({ model: "claude-opus-4.8" })
    injectMaxThinkingBudget(payload)
    expect(payload.thinking).toEqual({ type: "adaptive" })
    expect(payload.output_config).toBeUndefined()
  })

  test("omits effort when model has no reasoning_effort whitelist", () => {
    setModelCapability("some-future-adaptive-model", {
      max_thinking_budget: 32000,
      adaptive_thinking: true,
    })
    const payload = basePayload({ model: "some-future-adaptive-model" })
    injectMaxThinkingBudget(payload)
    expect(payload.thinking).toEqual({ type: "adaptive" })
    expect(payload.output_config).toBeUndefined()
  })

  test("coerces enabled thinking to adaptive for Opus 4.8", () => {
    setModelCapability("claude-opus-4.8", {
      max_thinking_budget: 32000,
      adaptive_thinking: true,
      reasoning_effort: ["medium"],
    })
    const payload = basePayload({
      model: "claude-opus-4.8",
      thinking: { type: "enabled", budget_tokens: 10_000 },
    })
    normalizeAdaptiveThinkingForCopilot(payload)
    expect(payload.thinking).toEqual({ type: "adaptive" })
    expect(payload.output_config?.effort).toBe("medium")
  })

  test("preserves client-supplied output_config.effort", () => {
    setModelCapability("claude-sonnet-4.6", {
      max_thinking_budget: 32000,
      adaptive_thinking: true,
      reasoning_effort: ["low", "medium", "high"],
    })
    const payload = basePayload({
      model: "claude-sonnet-4.6",
      output_config: { effort: "low" },
    })
    injectMaxThinkingBudget(payload)
    expect(payload.thinking).toEqual({ type: "adaptive" })
    expect(payload.output_config?.effort).toBe("low")
  })

  test("legacy non-adaptive thinking stays enabled + budget tokens and ignores thinkingEffort", () => {
    state.thinkingEffort = "max"
    setModelCapability("claude-opus-4.5", {
      max_thinking_budget: 32000,
      adaptive_thinking: false,
    })
    const payload = basePayload({ model: "claude-opus-4.5" })
    injectMaxThinkingBudget(payload)
    expect(payload.thinking).toEqual({
      type: "enabled",
      budget_tokens: 32000,
    })
  })

  test("respects existing client thinking field", () => {
    setModelCapability("claude-opus-4.7", {
      max_thinking_budget: 32000,
      adaptive_thinking: true,
    })
    const payload = basePayload({
      model: "claude-opus-4.7",
      thinking: { type: "enabled", budget_tokens: 1024 },
    })
    injectMaxThinkingBudget(payload)
    expect(payload.thinking).toEqual({
      type: "enabled",
      budget_tokens: 1024,
    })
  })

  test("does nothing when model has no thinking capability", () => {
    setModelCapability("gpt-4o", {})
    const payload = basePayload({ model: "gpt-4o" })
    injectMaxThinkingBudget(payload)
    expect(payload.thinking).toBeUndefined()
  })

  test("does nothing when model is unknown", () => {
    state.models = undefined
    const payload = basePayload({ model: "unknown-model" })
    injectMaxThinkingBudget(payload)
    expect(payload.thinking).toBeUndefined()
  })

  test("does nothing when max_thinking_budget is 0", () => {
    setModelCapability("weird-model", { max_thinking_budget: 0 })
    const payload = basePayload({ model: "weird-model" })
    injectMaxThinkingBudget(payload)
    expect(payload.thinking).toBeUndefined()
  })

  test("does nothing when state.maxThinking is false even with thinkingEffort", () => {
    state.maxThinking = false
    state.thinkingEffort = "max"
    setModelCapability("claude-opus-4.7", {
      max_thinking_budget: 32000,
      adaptive_thinking: true,
    })
    const payload = basePayload({ model: "claude-opus-4.7" })
    injectMaxThinkingBudget(payload)
    expect(payload.thinking).toBeUndefined()
  })

  test("kill switch does NOT override explicit client thinking", () => {
    // When the user disables auto-injection, an explicit client-supplied
    // `thinking` field must still flow through untouched. The kill switch
    // only suppresses the proxy's own injection, not user intent.
    state.maxThinking = false
    setModelCapability("claude-opus-4.7", {
      max_thinking_budget: 32000,
      adaptive_thinking: true,
    })
    const payload = basePayload({
      model: "claude-opus-4.7",
      thinking: { type: "enabled", budget_tokens: 5000 },
    })
    injectMaxThinkingBudget(payload)
    expect(payload.thinking).toEqual({
      type: "enabled",
      budget_tokens: 5000,
    })
  })
})
