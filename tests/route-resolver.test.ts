import { describe, test, expect, beforeEach } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import { clearRouteCache, resolveAnthropicRoute } from "~/lib/route-resolver"
import { state } from "~/lib/state"

function setModels(models: Array<Partial<Model> & { id: string }>): void {
  state.models = {
    object: "list",
    data: models as Array<Model>,
  }
  clearRouteCache()
}

describe("resolveAnthropicRoute", () => {
  beforeEach(() => {
    state.disableAnthropicPassthrough = false
    state.models = undefined
    clearRouteCache()
  })

  test("returns translate-openai when force-disabled", () => {
    state.disableAnthropicPassthrough = true
    setModels([
      { id: "claude-opus-4-5", supported_endpoints: ["anthropic-messages"] },
    ])
    expect(resolveAnthropicRoute("claude-opus-4-5")).toBe("translate-openai")
  })

  test("uses supported_endpoints when present", () => {
    setModels([
      { id: "claude-opus-4-5", supported_endpoints: ["anthropic-messages"] },
      { id: "gpt-4o", supported_endpoints: ["chat-completions"] },
    ])
    expect(resolveAnthropicRoute("claude-opus-4-5")).toBe("native-anthropic")
    expect(resolveAnthropicRoute("gpt-4o")).toBe("translate-openai")
  })

  test("falls back to claude-* heuristic when capability missing", () => {
    setModels([{ id: "claude-opus-4-5" }, { id: "gpt-4o" }])
    expect(resolveAnthropicRoute("claude-opus-4-5")).toBe("native-anthropic")
    expect(resolveAnthropicRoute("gpt-4o")).toBe("translate-openai")
  })

  test("heuristic also fires for unknown claude-* models", () => {
    setModels([])
    expect(resolveAnthropicRoute("claude-unknown")).toBe("native-anthropic")
    expect(resolveAnthropicRoute("o1-preview")).toBe("translate-openai")
  })

  test("results are cached per model id", () => {
    setModels([
      { id: "claude-opus-4-5", supported_endpoints: ["anthropic-messages"] },
    ])
    const first = resolveAnthropicRoute("claude-opus-4-5")
    // Mutate models without clearing — cached value should still apply.
    state.models = { object: "list", data: [] }
    const second = resolveAnthropicRoute("claude-opus-4-5")
    expect(first).toBe(second)
    expect(second).toBe("native-anthropic")
  })

  test("respects empty supported_endpoints by falling through to heuristic", () => {
    setModels([{ id: "claude-opus-4-5", supported_endpoints: [] }])
    // empty array is treated as missing capability → heuristic
    expect(resolveAnthropicRoute("claude-opus-4-5")).toBe("native-anthropic")
  })

  test("supported_endpoints WITHOUT anthropic-messages → translate", () => {
    setModels([
      { id: "claude-opus-4-5", supported_endpoints: ["chat-completions"] },
    ])
    expect(resolveAnthropicRoute("claude-opus-4-5")).toBe("translate-openai")
  })
})
