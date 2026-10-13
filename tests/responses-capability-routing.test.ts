import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"

import { modelRouter } from "~/lib/model-router"
import { state } from "~/lib/state"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"
import { type Model } from "~/services/copilot/get-models"

let savedState: typeof state
let savedConfig: ReturnType<typeof modelRouter.getConfig>
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>

function modelWithEndpoints(
  id: string,
  endpoints?: ReadonlyArray<string>,
): Model {
  return {
    id,
    name: id,
    object: "model",
    model_picker_enabled: true,
    preview: false,
    vendor: "test",
    version: "1",
    supported_endpoints: endpoints ? [...endpoints] : undefined,
    capabilities: {
      family: "test",
      type: "chat",
      object: "model_capabilities",
      tokenizer: "cl100k_base",
      limits: {},
      supports: {},
    },
  }
}

function success() {
  return Response.json({
    id: "response-test",
    object: "response",
    output: [],
    choices: [],
  })
}

function call(model: string) {
  return createChatCompletions({
    model,
    messages: [{ role: "user", content: "Hello" }],
  })
}

beforeEach(() => {
  savedState = { ...state }
  savedConfig = modelRouter.getConfig()
  Object.assign(state, {
    copilotToken: "fake-token",
    copilotApiEndpoint: "https://copilot.invalid",
    multiAccountEnabled: false,
    maxThinking: false,
    models: { object: "list", data: [] },
  })
  modelRouter.updateMapping({})
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(success())
})

afterEach(() => {
  fetchSpy.mockRestore()
  for (const key of Object.keys(state)) Reflect.deleteProperty(state, key)
  Object.assign(state, savedState)
  modelRouter.updateMapping(savedConfig.mapping)
})

test.each(["/responses", " /V1/RESPONSES/ ", "responses/"])(
  "uses advertised HTTP Responses for a future model: %s",
  async (endpoint) => {
    state.models = {
      object: "list",
      data: [modelWithEndpoints("future-model", [endpoint])],
    }
    modelRouter.updateMapping({ alias: "future-model" })
    await call("alias")
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "https://copilot.invalid/v1/responses",
    )
    expect(JSON.parse(fetchSpy.mock.calls[0][1]?.body as string)).toMatchObject(
      { model: "future-model" },
    )
  },
)

test.each([
  { endpoints: ["/chat/completions"] },
  { endpoints: [" /V1/CHAT/COMPLETIONS/ ", "/responses"] },
  { endpoints: ["ws:/responses"] },
  { endpoints: ["WSS:/V1/RESPONSES/"] },
])(
  "does not let a name hint override explicit HTTP capabilities: $endpoints",
  async ({ endpoints }) => {
    const id = "gpt-5.5-capabilities"
    state.models = { object: "list", data: [modelWithEndpoints(id, endpoints)] }
    await call(id)
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "https://copilot.invalid/chat/completions",
    )
  },
)

test("keeps the known-model hint when endpoint metadata is missing", async () => {
  const id = "gpt-5.5-legacy-hint"
  state.models = { object: "list", data: [modelWithEndpoints(id)] }
  await call(id)
  expect(fetchSpy.mock.calls[0][0]).toBe("https://copilot.invalid/v1/responses")
})

test("learns a Chat rejection within a snapshot and forgets it after catalog refresh", async () => {
  const id = "changing-model"
  state.models = {
    object: "list",
    data: [modelWithEndpoints(id, ["/chat/completions"])],
  }
  fetchSpy.mockResolvedValueOnce(
    Response.json(
      { error: { message: "unsupported_api_for_model" } },
      { status: 400 },
    ),
  )
  fetchSpy
    .mockResolvedValueOnce(success())
    .mockResolvedValueOnce(success())
    .mockResolvedValueOnce(success())
  await call(id)
  await call(id)
  state.models = {
    object: "list",
    data: [modelWithEndpoints(id, ["/chat/completions"])],
  }
  await call(id)
  expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
    "https://copilot.invalid/chat/completions",
    "https://copilot.invalid/v1/responses",
    "https://copilot.invalid/v1/responses",
    "https://copilot.invalid/chat/completions",
  ])
})

test("a late rejection from an old snapshot cannot poison refreshed routing", async () => {
  const id = "late-rejection-model"
  state.models = {
    object: "list",
    data: [modelWithEndpoints(id, ["/chat/completions"])],
  }
  let rejectOldRequest!: (response: Response) => void
  fetchSpy.mockReturnValueOnce(
    new Promise<Response>((resolve) => {
      rejectOldRequest = resolve
    }),
  )
  fetchSpy
    .mockResolvedValueOnce(success())
    .mockResolvedValueOnce(success())
    .mockResolvedValueOnce(success())
  const oldRequest = call(id)
  await Bun.sleep(0)
  state.models = {
    object: "list",
    data: [modelWithEndpoints(id, ["/chat/completions"])],
  }
  await call(id)
  rejectOldRequest(
    Response.json(
      { error: { message: "unsupported_api_for_model" } },
      { status: 400 },
    ),
  )
  await oldRequest
  await call(id)
  expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
    "https://copilot.invalid/chat/completions",
    "https://copilot.invalid/chat/completions",
    "https://copilot.invalid/v1/responses",
    "https://copilot.invalid/chat/completions",
  ])
})
