import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"

import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import type { ChatResponseFormat } from "~/services/copilot/response-format"

import { state } from "~/lib/state"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"
import { type Model } from "~/services/copilot/get-models"
import { chatToResponsesPayload } from "~/services/copilot/responses-translator"

const jsonSchema = {
  name: "answer",
  description: "A structured answer",
  schema: {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  },
  strict: true,
}

function payload(): ChatCompletionsPayload {
  return {
    model: "controls-test",
    messages: [{ role: "user", content: "Return a JSON answer." }],
  }
}

describe("Chat to Responses request controls", () => {
  test.each([
    { type: "text" },
    { type: "json_object" },
    { type: "json_schema", json_schema: jsonSchema },
  ] satisfies Array<ChatResponseFormat>)(
    "preserves $type output format",
    (format) => {
      const request = { ...payload(), response_format: format }
      const before = structuredClone(request)
      const translated = chatToResponsesPayload(request)

      expect(translated.text?.format).toEqual(
        format.type === "json_schema" ?
          { ...jsonSchema, type: "json_schema" }
        : format,
      )
      expect(translated).not.toHaveProperty("response_format")
      expect(request).toEqual(before)
    },
  )

  test.each([undefined, null])(
    "omits an unset response format (%s)",
    (format) => {
      expect(
        chatToResponsesPayload({ ...payload(), response_format: format }).text,
      ).toBeUndefined()
    },
  )

  test.each([true, false, null, undefined])(
    "preserves Chat tool strictness (%s), including its non-strict default",
    (strict) => {
      const request: ChatCompletionsPayload = {
        ...payload(),
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              description: "Look up an optional query",
              parameters: {
                type: "object",
                properties: { query: { type: "string" } },
              },
              strict,
            },
          },
        ],
      }
      const before = structuredClone(request)
      expect(chatToResponsesPayload(request).tools?.[0]).toEqual({
        type: "function",
        name: "lookup",
        description: "Look up an optional query",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
        },
        strict: strict ?? false,
      })
      expect(request).toEqual(before)
    },
  )

  test.each([false, true, undefined, null])(
    "preserves parallel_tool_calls (%s)",
    (parallel) => {
      expect(
        chatToResponsesPayload({ ...payload(), parallel_tool_calls: parallel })
          .parallel_tool_calls,
      ).toBe(parallel ?? undefined)
    },
  )
})

describe("Responses routing preserves request controls", () => {
  let savedState: typeof state
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>

  beforeEach(() => {
    savedState = { ...state }
    Object.assign(state, {
      copilotToken: "fake-token",
      copilotApiEndpoint: "https://copilot.invalid",
      multiAccountEnabled: false,
      maxThinking: false,
      models: undefined,
    })
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        id: "response-controls",
        object: "response",
        model: "controls-test",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: '{"answer":"ok"}' }],
          },
        ],
      }),
    )
  })

  afterEach(() => {
    fetchSpy.mockRestore()
    for (const key of Object.keys(state)) Reflect.deleteProperty(state, key)
    Object.assign(state, savedState)
  })

  test.each(["catalog", "fallback"])(
    "keeps settings through %s routing",
    async (route) => {
      const model = `request-controls-${route}`
      if (route === "catalog") {
        state.models = {
          object: "list",
          data: [
            {
              id: model,
              name: model,
              object: "model",
              model_picker_enabled: true,
              preview: false,
              vendor: "test",
              version: "1",
              supported_endpoints: ["/responses"],
              capabilities: {
                family: "test",
                type: "chat",
                object: "model_capabilities",
                tokenizer: "cl100k_base",
                limits: {},
                supports: {},
              },
            } satisfies Model,
          ],
        }
      } else {
        fetchSpy.mockResolvedValueOnce(
          Response.json(
            { error: { code: "unsupported_api_for_model" } },
            { status: 400 },
          ),
        )
      }
      const request: ChatCompletionsPayload = {
        ...payload(),
        model,
        response_format: { type: "json_schema", json_schema: jsonSchema },
        parallel_tool_calls: false,
        tools: [
          {
            type: "function",
            function: { name: "lookup", parameters: {}, strict: true },
          },
        ],
      }
      const response = await createChatCompletions(request, {
        resolvedModel: model,
      })
      expect(fetchSpy).toHaveBeenCalledTimes(route === "catalog" ? 1 : 2)
      const lastCall = fetchSpy.mock.calls.at(-1)
      expect(lastCall?.[0]).toBe("https://copilot.invalid/v1/responses")
      const forwarded: unknown = JSON.parse(lastCall?.[1]?.body as string)
      expect(forwarded).toMatchObject({
        text: { format: { ...jsonSchema, type: "json_schema" } },
        parallel_tool_calls: false,
        tools: [{ type: "function", name: "lookup", strict: true }],
      })
      expect(response).toMatchObject({
        choices: [{ message: { content: '{"answer":"ok"}' } }],
      })
    },
  )
})
