import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"

import { state } from "~/lib/state"
import { forwardResponsesAsChat } from "~/routes/chat-completions/responses-passthrough"
import { createNativeResponses } from "~/services/copilot/create-native-responses"

const clients = [
  { name: "native", call: createNativeResponses },
  { name: "Chat passthrough", call: forwardResponsesAsChat },
]
let savedState: typeof state
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>

beforeEach(() => {
  savedState = { ...state }
  Object.assign(state, {
    copilotToken: "fake-token",
    copilotApiEndpoint: "https://copilot.invalid",
    multiAccountEnabled: false,
  })
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ id: "response-test", object: "response", output: [] }),
  )
})
afterEach(() => {
  fetchSpy.mockRestore()
  for (const key of Object.keys(state)) Reflect.deleteProperty(state, key)
  Object.assign(state, savedState)
})

describe.each(clients)("$name tool vision headers", ({ call }) => {
  test.each(["function_call_output", "custom_tool_call_output"])(
    "detects image blocks in %s",
    async (type) => {
      const input = [
        {
          type,
          call_id: "call-1",
          output: [
            { type: "input_text", text: "screenshot" },
            {
              type: "input_image",
              image_url: "data:image/png;base64,ZmFrZQ==",
            },
          ],
        },
      ]
      await call({ model: "vision-test", input })
      const [, init] = fetchSpy.mock.calls[0]
      expect(new Headers(init?.headers).get("copilot-vision-request")).toBe(
        "true",
      )
      expect(JSON.parse(init?.body as string)).toMatchObject({ input })
    },
  )
  test.each([
    {
      input: [
        {
          type: "function_call_output",
          call_id: "call-1",
          output: '{"type":"input_image"}',
        },
      ],
    },
    {
      input: [
        {
          type: "function_call",
          name: "lookup",
          arguments: '{"type":"input_image"}',
        },
      ],
    },
    {
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: 'An example: {"type":"input_image"}' },
          ],
        },
      ],
    },
  ])(
    "ignores image-looking strings and non-content fields: $input",
    async ({ input }) => {
      await call({ model: "vision-test", input: [...input] })
      expect(
        new Headers(fetchSpy.mock.calls[0][1]?.headers).get(
          "copilot-vision-request",
        ),
      ).toBeNull()
    },
  )
})
