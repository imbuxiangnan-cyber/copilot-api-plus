import { test, expect, mock } from "bun:test"

import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"

import { state } from "../src/lib/state"
import { createChatCompletions } from "../src/services/copilot/create-chat-completions"

// Mock state
state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

// Helper to mock fetch
const fetchMock = mock(
  (_url: string, opts: { headers: Record<string, string> }) => {
    return {
      ok: true,
      json: () => ({ id: "123", object: "chat.completion", choices: [] }),
      headers: opts.headers,
    }
  },
)
// @ts-expect-error - Mock fetch doesn't implement all fetch properties
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

test("sets X-Initiator to agent if tool/assistant present", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "tool", content: "tool call" },
    ],
    model: "gpt-test",
  }
  await createChatCompletions(payload)
  expect(fetchMock).toHaveBeenCalled()
  const headers = (
    fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["X-Initiator"]).toBe("agent")
})

test("sets X-Initiator to user if only user present", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "user", content: "hello again" },
    ],
    model: "gpt-test",
  }
  await createChatCompletions(payload)
  expect(fetchMock).toHaveBeenCalled()
  const headers = (
    fetchMock.mock.calls[1][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["X-Initiator"]).toBe("user")
})

// ---------------------------------------------------------------------------
// max_completion_tokens runtime learning
// ---------------------------------------------------------------------------

// Access internals for testing via re-import (they are module-level variables)
// We test the behavior indirectly: first request gets max_tokens rejected,
// second request should send max_completion_tokens automatically.

test("normalizeMaxTokens: passes max_tokens unchanged for unknown model", async () => {
  // Fresh model not in maxCompletionTokensModels set → max_tokens preserved
  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "some-unknown-model",
    max_tokens: 1000,
  }
  const mockFetch = mock(() => ({
    ok: true,
    json: () => ({ id: "1", object: "chat.completion", choices: [] }),
    headers: new Headers(),
  }))
  // @ts-expect-error - Mock fetch doesn't implement all fetch properties
  globalThis.fetch = mockFetch
  await createChatCompletions(payload)
  const sentBody = JSON.parse(
    (mockFetch.mock.calls[0] as unknown as [unknown, { body: string }])[1].body,
  ) as Record<string, unknown>
  expect(sentBody["max_tokens"]).toBe(1000)
  expect(sentBody["max_completion_tokens"]).toBeUndefined()
})

test("normalizeMaxTokens: switches to max_completion_tokens after 400 rejection", async () => {
  // First call → 400 with max_tokens/max_completion_tokens message
  // Second call (retry) → should use max_completion_tokens with same value
  const model = "gpt-5.4-test-runtime"
  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model,
    max_tokens: 8192,
  }
  let callCount = 0
  const mockFetch = mock(() => {
    callCount++
    if (callCount === 1) {
      return {
        ok: false,
        status: 400,
        statusText: "Bad Request",
        text: () =>
          Promise.resolve(
            JSON.stringify({
              error: {
                message:
                  "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
                code: "invalid_request_body",
              },
            }),
          ),
        json: () => Promise.resolve({}),
        headers: new Headers(),
        clone: function () {
          return this
        },
      }
    }
    return {
      ok: true,
      json: () => ({ id: "2", object: "chat.completion", choices: [] }),
      headers: new Headers(),
    }
  })
  // @ts-expect-error - Mock fetch doesn't implement all fetch properties
  globalThis.fetch = mockFetch

  await createChatCompletions(payload)

  // Second call body: max_tokens renamed to max_completion_tokens, value unchanged
  const retryBody = JSON.parse(
    (mockFetch.mock.calls[1] as unknown as [unknown, { body: string }])[1].body,
  ) as Record<string, unknown>
  expect(retryBody["max_completion_tokens"]).toBe(8192)
  expect(retryBody["max_tokens"]).toBeUndefined()
})
