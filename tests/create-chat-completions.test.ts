import { test, expect, mock } from "bun:test"

import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"

import { state } from "../src/lib/state"
import { createChatCompletions } from "../src/services/copilot/create-chat-completions"
import {
  responsesStreamToChatChunks,
  responsesToChatResponse,
} from "../src/services/copilot/responses-translator"

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
    model: "test-unknown-empty-output",
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

test("Responses non-streaming translator preserves reasoning summary", () => {
  const result = responsesToChatResponse(
    {
      id: "resp-reasoning",
      object: "response",
      created_at: 123,
      model: "gpt-5.5-test-reasoning",
      output: [
        {
          type: "reasoning",
          id: "rs_1",
          summary: [
            { type: "summary_text", text: "I should inspect the files." },
            { type: "summary_text", text: " Then answer." },
          ],
        },
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "done" }],
        },
      ],
    },
    "gpt-5.5-test-reasoning",
  )

  expect(result.choices[0].message.reasoning_content).toBe(
    "I should inspect the files. Then answer.",
  )
  expect(result.choices[0].message.content).toBe("done")
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
  const reasoningDeltas = parsedChunks
    .map((chunk) => chunk.choices?.[0]?.delta?.reasoning_content)
    .filter((content) => content !== undefined)
  expect(roleChunks).toHaveLength(1)
  expect(roleChunks[0].choices?.[0]?.delta?.content).toBe("")
  expect(reasoningDeltas).toEqual(["thinking"])
  expect(contentDeltas).toEqual([""])
  expect(chunks.filter((chunk) => chunk.data === "[DONE]")).toHaveLength(1)
})

test("Responses streaming translator ignores empty reasoning item", async () => {
  const chunks: Array<{ data?: string }> = []
  for await (const chunk of responsesStreamToChatChunks(
    reasoningItemAddedResponsesStream(),
    "gpt-5.5-test-stream-reasoning-added",
  )) {
    chunks.push(chunk)
  }

  const reasoningDeltas = parseStreamChunks(chunks)
    .map((chunk) => chunk.choices?.[0]?.delta?.reasoning_content)
    .filter((content) => content !== undefined)
  expect(reasoningDeltas).toEqual([])
})

test("Responses streaming translator emits completed reasoning summary when no reasoning delta arrived", async () => {
  const chunks: Array<{ data?: string }> = []
  for await (const chunk of responsesStreamToChatChunks(
    completedReasoningResponsesStream(),
    "gpt-5.5-test-stream-completed-reasoning",
  )) {
    chunks.push(chunk)
  }

  const reasoningDeltas = parseStreamChunks(chunks)
    .map((chunk) => chunk.choices?.[0]?.delta?.reasoning_content)
    .filter((content) => content !== undefined)
  expect(reasoningDeltas).toEqual(["I should think."])
  expect(chunks.at(-1)?.data).toBe("[DONE]")
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
  expect(chunks.at(-1)?.data).toBe("[DONE]")
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

test("Responses streaming translator routes arguments deltas to the added tool_call", async () => {
  // Regression: upstream `output_item.added` carries both `call_id` (the
  // `call_xxx` echoed to clients) and `id` (the internal `fc_xxx`), while
  // subsequent `function_call_arguments.delta` events reference the item
  // by `item_id` (= `fc_xxx`). Both must map to the SAME tool_call slot,
  // otherwise arguments stream into a nameless second tool_call and the
  // real one ends up with `arguments: ""` (= tool invoked with no params).
  const chunks: Array<{ data?: string }> = []
  for await (const chunk of responsesStreamToChatChunks(
    toolCallWithArgumentsResponsesStream(),
    "gpt-5.5-test-stream-tool-call",
  )) {
    chunks.push(chunk)
  }

  type ToolCallDelta = {
    index: number
    id?: string
    type?: string
    function?: { name?: string; arguments?: string }
  }
  type StreamChunk = {
    choices?: Array<{
      delta?: { tool_calls?: Array<ToolCallDelta> }
      finish_reason?: string | null
    }>
  }
  const parsed = chunks
    .filter((c) => c.data && c.data !== "[DONE]")
    .map((c) => JSON.parse(c.data ?? "{}") as StreamChunk)

  const indices = new Set<number>()
  const argsByIndex = new Map<number, string>()
  const nameByIndex = new Map<number, string>()
  for (const ch of parsed) {
    for (const tc of ch.choices?.[0]?.delta?.tool_calls ?? []) {
      indices.add(tc.index)
      if (tc.function?.arguments !== undefined) {
        argsByIndex.set(
          tc.index,
          (argsByIndex.get(tc.index) ?? "") + tc.function.arguments,
        )
      }
      if (tc.function?.name) nameByIndex.set(tc.index, tc.function.name)
    }
  }

  // Exactly one tool_call slot — added id and arguments item_id must merge.
  expect(indices.size).toBe(1)
  const idx = [...indices][0]
  expect(nameByIndex.get(idx)).toBe("Bash")
  expect(argsByIndex.get(idx)).toBe('{"command":"ls"}')
})

test("Responses streaming translator uses output_index when argument item_id changes", async () => {
  // Real Copilot gpt-5.5 obfuscates each function_call_arguments.delta with a
  // different item_id; output_index is the stable key tying all argument chunks
  // back to the added function_call. If we key by item_id, Bash receives {}.
  const chunks: Array<{ data?: string }> = []
  for await (const chunk of responsesStreamToChatChunks(
    toolCallWithChangingArgumentItemIdsResponsesStream(),
    "gpt-5.5-test-stream-changing-item-ids",
  )) {
    chunks.push(chunk)
  }

  type ToolCallDelta = {
    index: number
    id?: string
    type?: string
    function?: { name?: string; arguments?: string }
  }
  type StreamChunk = {
    choices?: Array<{
      delta?: { tool_calls?: Array<ToolCallDelta> }
      finish_reason?: string | null
    }>
  }
  const parsed = chunks
    .filter((c) => c.data && c.data !== "[DONE]")
    .map((c) => JSON.parse(c.data ?? "{}") as StreamChunk)

  const indices = new Set<number>()
  let args = ""
  let name: string | undefined
  for (const ch of parsed) {
    for (const tc of ch.choices?.[0]?.delta?.tool_calls ?? []) {
      indices.add(tc.index)
      args += tc.function?.arguments ?? ""
      name = tc.function?.name ?? name
    }
  }

  expect(indices.size).toBe(1)
  expect(name).toBe("Bash")
  expect(args).toBe('{"command":"echo hi"}')
})

test("Responses streaming translator emits completed-only tool_call as fallback", async () => {
  // Regression: when upstream skips `output_item.added` and
  // `function_call_arguments.delta` entirely and only puts the
  // function_call in the final `response.completed.response.output`,
  // the client must still see a complete tool_call with name+args+id.
  const chunks: Array<{ data?: string }> = []
  for await (const chunk of responsesStreamToChatChunks(
    completedOnlyToolCallResponsesStream(),
    "gpt-5.5-test-stream-completed-tool",
  )) {
    chunks.push(chunk)
  }

  type ToolCallDelta = {
    index: number
    id?: string
    type?: string
    function?: { name?: string; arguments?: string }
  }
  type StreamChunk = {
    choices?: Array<{
      delta?: { tool_calls?: Array<ToolCallDelta> }
      finish_reason?: string | null
    }>
  }
  const parsed = chunks
    .filter((c) => c.data && c.data !== "[DONE]")
    .map((c) => JSON.parse(c.data ?? "{}") as StreamChunk)

  const argsByIndex = new Map<number, string>()
  const nameByIndex = new Map<number, string>()
  const idByIndex = new Map<number, string>()
  let finishReason: string | null | undefined
  for (const ch of parsed) {
    const choice = ch.choices?.[0]
    if (choice?.finish_reason) finishReason = choice.finish_reason
    for (const tc of choice?.delta?.tool_calls ?? []) {
      if (tc.function?.arguments !== undefined) {
        argsByIndex.set(
          tc.index,
          (argsByIndex.get(tc.index) ?? "") + tc.function.arguments,
        )
      }
      if (tc.function?.name) nameByIndex.set(tc.index, tc.function.name)
      if (tc.id) idByIndex.set(tc.index, tc.id)
    }
  }

  expect(nameByIndex.get(0)).toBe("Bash")
  expect(argsByIndex.get(0)).toBe('{"command":"pwd"}')
  expect(idByIndex.get(0)).toBe("call_xyz")
  expect(finishReason).toBe("tool_calls")
})

type ChatCompletionStreamChunk = {
  choices?: Array<{
    delta?: { role?: string; content?: string; reasoning_content?: string }
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

async function* reasoningItemAddedResponsesStream() {
  await Promise.resolve()
  yield {
    data: JSON.stringify({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "reasoning", id: "rs_1", summary: [] },
    }),
  }
  yield {
    data: JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp-stream-reasoning-added",
        object: "response",
        created_at: 123,
        model: "gpt-5.5-test-stream-reasoning-added",
        output: [{ type: "reasoning", id: "rs_1", summary: [] }],
      },
    }),
  }
}

async function* completedReasoningResponsesStream() {
  await Promise.resolve()
  yield {
    data: JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp-stream-completed-reasoning",
        object: "response",
        created_at: 123,
        model: "gpt-5.5-test-stream-completed-reasoning",
        output: [
          {
            type: "reasoning",
            id: "rs_1",
            summary: [{ type: "summary_text", text: "I should think." }],
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

async function* toolCallWithArgumentsResponsesStream() {
  await Promise.resolve()
  // Upstream sends both `call_id` and `id` on the added item, then routes
  // argument deltas by the internal `fc_xxx` `item_id`.
  yield {
    data: JSON.stringify({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_abc",
        call_id: "call_xyz",
        name: "Bash",
        arguments: "",
        status: "in_progress",
      },
    }),
  }
  yield {
    data: JSON.stringify({
      type: "response.function_call_arguments.delta",
      item_id: "fc_abc",
      output_index: 0,
      delta: '{"command":',
    }),
  }
  yield {
    data: JSON.stringify({
      type: "response.function_call_arguments.delta",
      item_id: "fc_abc",
      output_index: 0,
      delta: '"ls"}',
    }),
  }
  yield {
    data: JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp-stream-tool-call",
        object: "response",
        created_at: 123,
        model: "gpt-5.5-test-stream-tool-call",
        output: [
          {
            type: "function_call",
            id: "fc_abc",
            call_id: "call_xyz",
            name: "Bash",
            arguments: '{"command":"ls"}',
            status: "completed",
          },
        ],
      },
    }),
  }
}

async function* toolCallWithChangingArgumentItemIdsResponsesStream() {
  await Promise.resolve()
  yield {
    data: JSON.stringify({
      type: "response.output_item.added",
      output_index: 1,
      item: {
        type: "function_call",
        id: "fc_added",
        call_id: "call_xyz",
        name: "Bash",
        arguments: "",
        status: "in_progress",
      },
    }),
  }
  for (const [itemId, delta] of [
    ["opaque_1", '{"'],
    ["opaque_2", "command"],
    ["opaque_3", '":"'],
    ["opaque_4", "echo hi"],
    ["opaque_5", '"}'],
  ]) {
    yield {
      data: JSON.stringify({
        type: "response.function_call_arguments.delta",
        item_id: itemId,
        output_index: 1,
        delta,
      }),
    }
  }
  yield {
    data: JSON.stringify({
      type: "response.function_call_arguments.done",
      item_id: "opaque_done",
      output_index: 1,
      arguments: '{"command":"echo hi"}',
    }),
  }
  yield {
    data: JSON.stringify({
      type: "response.output_item.done",
      output_index: 1,
      item: {
        type: "function_call",
        id: "fc_done",
        call_id: "call_xyz",
        name: "Bash",
        arguments: '{"command":"echo hi"}',
        status: "completed",
      },
    }),
  }
  yield {
    data: JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp-stream-changing-item-ids",
        object: "response",
        created_at: 123,
        model: "gpt-5.5-test-stream-changing-item-ids",
        output: [
          { type: "reasoning", id: "rs_1", summary: [] },
          {
            type: "function_call",
            id: "fc_done",
            call_id: "call_xyz",
            name: "Bash",
            arguments: '{"command":"echo hi"}',
            status: "completed",
          },
        ],
      },
    }),
  }
}

async function* completedOnlyToolCallResponsesStream() {
  await Promise.resolve()
  yield {
    data: JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp-stream-completed-tool",
        object: "response",
        created_at: 123,
        model: "gpt-5.5-test-stream-completed-tool",
        output: [
          {
            type: "function_call",
            id: "fc_abc",
            call_id: "call_xyz",
            name: "Bash",
            arguments: '{"command":"pwd"}',
            status: "completed",
          },
        ],
      },
    }),
  }
}
