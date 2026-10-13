import { expect, mock, spyOn, test } from "bun:test"

import { accountManager, type Account } from "~/lib/account-manager"
import {
  breakerOpenRemainingMs,
  recordBreakerSuccess,
  runWithAccountRotation,
} from "~/lib/account-rotation"
import { HTTPError } from "~/lib/error"
import { type ChatCompletionChunk } from "~/services/copilot/create-chat-completions"
import {
  responsesStreamToChatChunks,
  responsesToChatResponse,
  type ResponsesResponse,
} from "~/services/copilot/responses-translator"

function incomplete(
  reason?: string,
): ResponsesResponse & { incomplete_details: { reason?: string } } {
  return {
    id: "resp-partial",
    object: "response",
    model: "test",
    status: "incomplete",
    incomplete_details: { reason },
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "partial" }],
      },
    ],
    usage: {
      input_tokens: 12,
      output_tokens: 4,
      total_tokens: 16,
      input_tokens_details: { cached_tokens: 3 },
    },
  }
}

async function* events(items: Array<unknown>) {
  for (const item of items)
    yield await Promise.resolve({ data: JSON.stringify(item) })
}

async function collect(items: Array<unknown>) {
  const frames: Array<{ data?: string }> = []
  for await (const frame of responsesStreamToChatChunks(
    events(items),
    "requested-model",
  ))
    frames.push(frame)
  const chunks = frames
    .filter((frame) => frame.data !== "[DONE]")
    .map((frame) => JSON.parse(frame.data ?? "{}") as ChatCompletionChunk)
  return { frames, chunks }
}

test.each([
  { reason: "max_output_tokens", finish: "length" },
  { reason: "max_messages", finish: "length" },
  { reason: "content_filter", finish: "content_filter" },
])(
  "preserves incomplete JSON output and usage: $reason",
  ({ reason, finish }) => {
    const result = responsesToChatResponse(
      incomplete(reason),
      "requested-model",
    )
    expect(result.choices[0].finish_reason).toBe(finish)
    expect(result.choices[0].message.content).toBe("partial")
    expect(result.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 4,
      total_tokens: 16,
      prompt_tokens_details: { cached_tokens: 3 },
    })
  },
)

test.each([false, true])(
  "incomplete SSE finishes once and keeps partial text/usage (delta=%s)",
  async (hasDelta) => {
    const terminal = {
      type: "response.incomplete",
      response: incomplete("max_output_tokens"),
    }
    const input: Array<unknown> =
      hasDelta ?
        [{ type: "response.output_text.delta", delta: "partial" }, terminal]
      : [terminal]
    const { frames, chunks } = await collect([...input, terminal])
    expect(frames.filter((frame) => frame.data === "[DONE]")).toHaveLength(1)
    expect(
      chunks
        .flatMap((chunk) => chunk.choices)
        .filter((choice) => choice.finish_reason),
    ).toMatchObject([{ finish_reason: "length" }])
    expect(
      chunks
        .flatMap((chunk) => chunk.choices)
        .map((choice) => choice.delta.content ?? "")
        .join(""),
    ).toBe("partial")
    expect(chunks.find((chunk) => chunk.usage)?.usage).toMatchObject({
      prompt_tokens: 12,
      completion_tokens: 4,
      total_tokens: 16,
      prompt_tokens_details: { cached_tokens: 3 },
    })
  },
)

test("a truncated tool call finishes with length rather than tool_calls", async () => {
  const response = incomplete("max_output_tokens")
  response.output = [
    {
      type: "function_call",
      call_id: "call-1",
      name: "lookup",
      arguments: '{"query":',
    },
  ]
  expect(
    responsesToChatResponse(response, "test").choices[0].finish_reason,
  ).toBe("length")
  const { chunks } = await collect([{ type: "response.incomplete", response }])
  expect(
    chunks
      .flatMap((chunk) => chunk.choices)
      .some((choice) => choice.finish_reason === "length"),
  ).toBe(true)
})

test.each(["steered", "future_reason", undefined])(
  "unrepresentable incomplete reason is an error: %s",
  async (reason) => {
    expect(() => responsesToChatResponse(incomplete(reason), "test")).toThrow(
      "incomplete",
    )
    let failure: unknown
    try {
      await collect([
        { type: "response.incomplete", response: incomplete(reason) },
      ])
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain("incomplete")
  },
)

test("an incompatible incomplete response does not rotate, penalize accounts or open the breaker", async () => {
  const accounts: Array<Account> = [
    "incomplete-a",
    "incomplete-b",
    "incomplete-c",
  ].map((id) => ({
    id,
    label: id,
    githubToken: "fake-github",
    copilotToken: "fake-copilot",
    accountType: "individual",
    status: "active",
    consecutiveFailures: 0,
    addedAt: 0,
  }))
  const mark = spyOn(accountManager, "markAccountStatus").mockReturnValue(
    undefined,
  )
  const refresh = spyOn(
    accountManager,
    "refreshAccountToken",
  ).mockResolvedValue(undefined)
  const save = spyOn(accountManager, "saveAccounts").mockResolvedValue(
    undefined,
  )
  const fetch = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Unexpected network request"),
  )
  const spies = [
    mark,
    refresh,
    save,
    fetch,
    spyOn(accountManager, "getActiveAccount").mockImplementation((excluded) =>
      accounts.find((account) => !excluded?.has(account.id)),
    ),
    spyOn(accountManager, "markAccountSuccess").mockReturnValue(undefined),
    spyOn(Math, "random").mockReturnValue(0),
  ]
  const transport = mock(() =>
    Promise.resolve().then(() =>
      responsesToChatResponse(incomplete("steered"), "test"),
    ),
  )
  recordBreakerSuccess()
  try {
    const result = await runWithAccountRotation({
      label: "incomplete-test",
      payload: null,
      transport,
    }).catch((error: unknown) => error)
    expect(result).toBeInstanceOf(HTTPError)
    expect((result as HTTPError).response.status).toBe(502)
    expect(transport).toHaveBeenCalledTimes(1)
    expect(mark).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(breakerOpenRemainingMs()).toBe(0)
  } finally {
    for (const spy of spies) spy.mockRestore()
    recordBreakerSuccess()
  }
})
