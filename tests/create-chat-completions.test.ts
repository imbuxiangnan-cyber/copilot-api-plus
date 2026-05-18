import { test, expect, mock } from "bun:test"

import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"

import { state } from "../src/lib/state"
import { createChatCompletions } from "../src/services/copilot/create-chat-completions"
import { responsesStreamToChatChunks } from "../src/services/copilot/responses-translator"

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

test("rejects malformed payload missing `messages` array with HTTP 400", async () => {
  // Simulates a Responses-API-shape body slipping past the dispatcher
  // (or any other client that POSTs garbage to /chat/completions).
  // Must produce a readable 400, NOT a 500 from
  // `Cannot read properties of undefined (reading 'some')`.
  const malformed = {
    model: "gpt-5-mini",
    input: [{ role: "user", content: "hi" }],
  } as unknown as ChatCompletionsPayload

  try {
    await createChatCompletions(malformed)
    throw new Error("expected createChatCompletions to throw")
  } catch (err) {
    expect(err).toBeInstanceOf(Error)
    const e = err as Error & { response?: Response }
    expect(e.response).toBeDefined()
    expect(e.response?.status).toBe(400)
    expect(e.message).toMatch(/messages/i)
  }
})

test("Responses-only fallback returns empty string when output has no text", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "ping" }],
    model: "gpt-5.5-test-empty-output",
  }
  let callCount = 0
  const mockFetch = mock((url: string) => {
    callCount++
    if (url.endsWith("/chat/completions")) {
      return new Response(
        JSON.stringify({
          error: {
            code: "unsupported_api_for_model",
            message:
              "This model is not accessible via the /chat/completions endpoint.",
          },
        }),
        { status: 400, statusText: "Bad Request" },
      )
    }
    return new Response(
      JSON.stringify({
        id: "resp-empty",
        object: "response",
        created_at: 123,
        model: payload.model,
        output: [
          {
            type: "reasoning",
            id: "rs_1",
            summary: [],
          },
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
            status: "completed",
            content: [],
          },
        ],
      }),
      { status: 200 },
    )
  })
  // @ts-expect-error - Mock fetch doesn't implement all fetch properties
  globalThis.fetch = mockFetch

  const result = await createChatCompletions(payload)

  expect(callCount).toBe(2)
  expect(Symbol.asyncIterator in result).toBe(false)
  const chat = result as Awaited<ReturnType<typeof createChatCompletions>> & {
    choices: Array<{ message: { content: unknown } }>
  }
  expect(chat.choices[0].message.content).toBe("")
})

test("Responses streaming translator emits role chunk for ignored no-text events", async () => {
  const chunks: Array<{ data?: string }> = []
  for await (const chunk of responsesStreamToChatChunks(
    emptyNoTextResponsesStream(),
    "gpt-5.5-test-stream-empty-output",
  )) {
    chunks.push(chunk)
  }

  expect(chunks.length).toBeGreaterThanOrEqual(3)
  const parsedChunks = parseStreamChunks(chunks)
  const roleChunks = parsedChunks.filter(
    (chunk) => chunk.choices?.[0]?.delta?.role === "assistant",
  )
  const contentDeltas = parsedChunks
    .map((chunk) => chunk.choices?.[0]?.delta?.content)
    .filter((content) => content !== undefined)
  expect(roleChunks).toHaveLength(1)
  expect(roleChunks[0].choices?.[0]?.delta?.content).toBe("")
  expect(contentDeltas).toEqual([""])
  expect(chunks.filter((chunk) => chunk.data === "[DONE]")).toHaveLength(1)
})

test("Responses streaming translator emits completed output text when no text delta arrived", async () => {
  const chunks: Array<{ data?: string }> = []
  for await (const chunk of responsesStreamToChatChunks(
    completedTextResponsesStream(),
    "gpt-5.5-test-stream-completed-text",
  )) {
    chunks.push(chunk)
  }

  const parsedChunks = parseStreamChunks(chunks)
  const contentDeltas = parsedChunks
    .map((chunk) => chunk.choices?.[0]?.delta?.content)
    .filter((content) => content !== undefined)
  const finishIndex = parsedChunks.findIndex(
    (chunk) => chunk.choices?.[0]?.finish_reason === "stop",
  )
  const pongChunkIndex = parsedChunks.findIndex(
    (chunk) => chunk.choices?.[0]?.delta?.content === "pong",
  )

  expect(contentDeltas).toEqual(["", "pong"])
  expect(pongChunkIndex).toBeGreaterThanOrEqual(0)
  expect(finishIndex).toBeGreaterThan(pongChunkIndex)
  expect(chunks.at(-1).data).toBe("[DONE]")
})

test("Responses streaming translator does not duplicate completed output after text delta", async () => {
  const chunks: Array<{ data?: string }> = []
  for await (const chunk of responsesStreamToChatChunks(
    textDeltaThenCompletedResponsesStream(),
    "gpt-5.5-test-stream-no-duplicate",
  )) {
    chunks.push(chunk)
  }

  const contentDeltas = parseStreamChunks(chunks)
    .map((chunk) => chunk.choices?.[0]?.delta?.content)
    .filter((content) => content !== undefined)
  expect(contentDeltas).toEqual(["", "pong"])
  expect(chunks.filter((chunk) => chunk.data === "[DONE]")).toHaveLength(1)
})
type ChatCompletionStreamChunk = {
  choices?: Array<{
    delta?: { role?: string; content?: string }
    finish_reason?: string | null
  }>
}

function parseStreamChunks(chunks: Array<{ data?: string }>) {
  return chunks
    .filter((chunk) => chunk.data && chunk.data !== "[DONE]")
    .map((chunk) => JSON.parse(chunk.data ?? "{}") as ChatCompletionStreamChunk)
}

async function* emptyNoTextResponsesStream() {
  await Promise.resolve()
  yield {
    data: JSON.stringify({
      type: "response.created",
      response: {
        id: "resp-stream-empty",
        object: "response",
        created_at: 123,
        model: "gpt-5.5-test-stream-empty-output",
        output: [],
      },
    }),
  }
  yield {
    data: JSON.stringify({
      type: "response.reasoning_summary_text.delta",
      delta: "thinking",
    }),
  }
  yield {
    data: JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp-stream-empty",
        object: "response",
        created_at: 123,
        model: "gpt-5.5-test-stream-empty-output",
        output: [
          { type: "reasoning", id: "rs_1", summary: [] },
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
            status: "completed",
            content: [],
          },
        ],
      },
    }),
  }
}

async function* completedTextResponsesStream() {
  await Promise.resolve()
  yield {
    data: JSON.stringify({
      type: "response.created",
      response: {
        id: "resp-stream-completed-text",
        object: "response",
        created_at: 123,
        model: "gpt-5.5-test-stream-completed-text",
        output: [],
      },
    }),
  }
  yield {
    data: JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp-stream-completed-text",
        object: "response",
        created_at: 123,
        model: "gpt-5.5-test-stream-completed-text",
        output: [
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "pong" }],
          },
        ],
      },
    }),
  }
}

async function* textDeltaThenCompletedResponsesStream() {
  await Promise.resolve()
  yield {
    data: JSON.stringify({
      type: "response.output_text.delta",
      delta: "pong",
    }),
  }
  yield {
    data: JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp-stream-no-duplicate",
        object: "response",
        created_at: 123,
        model: "gpt-5.5-test-stream-no-duplicate",
        output: [
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "pong" }],
          },
        ],
      },
    }),
  }
}
