import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"

import { modelRouter } from "~/lib/model-router"
import * as proxy from "~/lib/proxy"
import { type RequestOptions } from "~/lib/request-options"
import { state } from "~/lib/state"
import { forwardResponsesAsChat } from "~/routes/chat-completions/responses-passthrough"
import { server } from "~/server"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"
import { createNativeResponses } from "~/services/copilot/create-native-responses"
import { createResponsesAsChat } from "~/services/copilot/create-responses"

const model = "cancellation-resolved-model"
const chatPayload = {
  model: "alias",
  messages: [{ role: "user" as const, content: "Hello" }],
}
const responsesPayload = {
  model: "alias",
  input: [{ role: "user", content: "Hello" }],
}
const clients = [
  {
    name: "Chat",
    call: (options: RequestOptions) =>
      createChatCompletions(chatPayload, options),
  },
  {
    name: "native Responses",
    call: (options: RequestOptions) =>
      createNativeResponses(responsesPayload, options),
  },
  {
    name: "Responses passthrough",
    call: (options: RequestOptions) =>
      forwardResponsesAsChat(responsesPayload, options),
  },
]

let savedState: typeof state
let savedConfig: ReturnType<typeof modelRouter.getConfig>
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>
let resetSpy: ReturnType<typeof spyOn<typeof proxy, "resetConnections">>

beforeEach(() => {
  savedState = { ...state }
  savedConfig = modelRouter.getConfig()
  Object.assign(state, {
    copilotToken: "cancellation-test-token",
    copilotApiEndpoint: "https://copilot.invalid",
    multiAccountEnabled: false,
    models: undefined,
    maxThinking: false,
    apiKeys: undefined,
    manualApprove: false,
    rateLimitSeconds: undefined,
  })
  modelRouter.updateMapping({ alias: model, [model]: "must-not-map-twice" })
  modelRouter.updateConcurrency({ default: 1 })
  fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Unexpected fetch"),
  )
  resetSpy = spyOn(proxy, "resetConnections").mockImplementation(() => {})
})

afterEach(() => {
  fetchSpy.mockRestore()
  resetSpy.mockRestore()
  for (const key of Object.keys(state)) Reflect.deleteProperty(state, key)
  Object.assign(state, savedState)
  modelRouter.updateMapping(savedConfig.mapping)
  modelRouter.updateConcurrency(savedConfig.concurrency)
})

describe.each(clients)("$name cancellation", ({ call }) => {
  test("removes a cancelled queued request without calling upstream", async () => {
    const release = await modelRouter.acquireSlot(model)
    const controller = new AbortController()
    const reason = new Error("cancel queued request")
    const pending = call({
      signal: controller.signal,
      resolvedModel: model,
    }).catch((error: unknown) => error)
    try {
      expect(modelRouter.getStats()[model].queued).toBe(1)
      controller.abort(reason)
      expect(await pending).toBe(reason)
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(modelRouter.getStats()[model]).toMatchObject({
        active: 1,
        queued: 0,
      })
    } finally {
      release()
    }
  })

  test("aborts a pending upstream request without a retry or pool reset", async () => {
    let started!: () => void
    const fetched = new Promise<void>((resolve) => {
      started = resolve
    })
    fetchSpy.mockImplementation(
      ((_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          expect(JSON.parse(init?.body as string)).toMatchObject({ model })
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason as Error),
            { once: true },
          )
          started()
        })) as typeof fetch,
    )
    const controller = new AbortController()
    const reason = new Error("disconnect while waiting for headers")
    const pending = call({
      signal: controller.signal,
      resolvedModel: model,
    }).catch((error: unknown) => error)
    await fetched
    controller.abort(reason)

    expect(await pending).toBe(reason)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(resetSpy).not.toHaveBeenCalled()
    expect(modelRouter.getStats()[model]).toMatchObject({
      active: 0,
      queued: 0,
    })
  })
})

test("direct Responses translation accepts a resolved model and caller signal", async () => {
  const controller = new AbortController()
  fetchSpy.mockResolvedValue(Response.json({ id: "resp-test", output: [] }))
  await createResponsesAsChat(chatPayload, {
    signal: controller.signal,
    resolvedModel: model,
  })
  const [, init] = fetchSpy.mock.calls[0]
  expect(JSON.parse(init?.body as string)).toMatchObject({ model })
  controller.abort()
  expect(init?.signal?.aborted).toBe(true)
})

test.each([
  ...clients,
  {
    name: "direct Responses translation",
    call: (options: RequestOptions) =>
      createResponsesAsChat(chatPayload, options),
  },
])(
  "$name cancels token refresh after a business request returns 401",
  async ({ call }) => {
    let tokenStarted!: () => void
    const refreshing = new Promise<void>((resolve) => {
      tokenStarted = resolve
    })
    let tokenSignal: AbortSignal | null | undefined
    fetchSpy
      .mockImplementation(((_url, init) => {
        tokenSignal = init?.signal
        return new Promise<Response>((_resolve, reject) => {
          tokenSignal?.addEventListener(
            "abort",
            () => reject(tokenSignal?.reason as Error),
            { once: true },
          )
          tokenStarted()
        })
      }) as typeof fetch)
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
    const controller = new AbortController()
    const reason = new Error("client disconnected during token refresh")
    const pending = call({
      signal: controller.signal,
      resolvedModel: model,
    }).catch((error: unknown) => error)
    await refreshing
    controller.abort(reason)

    expect(tokenSignal?.aborted).toBe(true)
    expect(await pending).toBe(reason)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(fetchSpy.mock.calls[1][0]).toContain("/copilot_internal/v2/token")
    expect(resetSpy).not.toHaveBeenCalled()
  },
)

test("Chat reports cancellation that arrives while the JSON body completes", async () => {
  const controller = new AbortController()
  const reason = new Error("cancel while reading JSON")
  const response = Response.json({ id: "chat-cancel", choices: [] })
  const jsonSpy = spyOn(response, "json").mockImplementation(() => {
    controller.abort(reason)
    return Promise.resolve({ id: "chat-cancel", choices: [] })
  })
  fetchSpy.mockResolvedValue(response)
  const result = await createChatCompletions(chatPayload, {
    signal: controller.signal,
    resolvedModel: model,
  }).catch((error: unknown) => error)
  jsonSpy.mockRestore()

  expect(result).toBe(reason)
  expect(fetchSpy).toHaveBeenCalledTimes(1)
  expect(resetSpy).not.toHaveBeenCalled()
  expect(modelRouter.getStats()[model].active).toBe(0)
})

test("cancellation while reading a Chat 400 prevents Responses recovery", async () => {
  const controller = new AbortController()
  const reason = new Error("cancel before fallback")
  const response = Response.json(
    { error: { message: "unsupported_api_for_model" } },
    { status: 400 },
  )
  const text = response.text.bind(response)
  const textSpy = spyOn(response, "text").mockImplementation(async () => {
    const body = await text()
    controller.abort(reason)
    return body
  })
  fetchSpy.mockResolvedValue(response)
  const result = await createChatCompletions(chatPayload, {
    signal: controller.signal,
    resolvedModel: model,
  }).catch((error: unknown) => error)
  textSpy.mockRestore()

  expect(result).toBe(reason)
  expect(fetchSpy).toHaveBeenCalledTimes(1)
  expect(resetSpy).not.toHaveBeenCalled()
  expect(modelRouter.getStats()[model].active).toBe(0)
})

test.each([
  { path: "/chat/completions", payload: chatPayload },
  { path: "/chat/completions", payload: responsesPayload },
  { path: "/v1/responses", payload: responsesPayload },
])(
  "cancelling the client SSE reader aborts upstream: $path",
  async ({ path, payload }) => {
    let upstreamSignal: AbortSignal | null | undefined
    fetchSpy.mockImplementation(((_url, init) => {
      upstreamSignal = init?.signal
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
            ),
          )
          upstreamSignal?.addEventListener(
            "abort",
            () => controller.error(upstreamSignal?.reason),
            { once: true },
          )
        },
      })
      return Promise.resolve(
        new Response(body, {
          headers: { "content-type": "text/event-stream" },
        }),
      )
    }) as typeof fetch)
    const response = await server.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, stream: true }),
    })
    if (!response.body) throw new Error("Expected response body")
    const reader = response.body.getReader()
    await reader.read()
    await reader.cancel()

    expect(upstreamSignal?.aborted).toBe(true)
    expect(modelRouter.getStats()[model]).toMatchObject({
      active: 0,
      queued: 0,
    })
    expect(resetSpy).not.toHaveBeenCalled()
  },
)
