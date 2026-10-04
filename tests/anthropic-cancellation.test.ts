import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Hono } from "hono"

import { ModelRouter, modelRouter } from "~/lib/model-router"
import { clearRouteCache } from "~/lib/route-resolver"
import { state, type State } from "~/lib/state"
import { messageRoutes } from "~/routes/messages/route"
import { createAnthropicMessages } from "~/services/copilot/create-anthropic-messages"

const model = "claude-cancel-test"
const app = new Hono().route("/v1/messages", messageRoutes)
const payload = {
  model,
  messages: [{ role: "user" as const, content: "Hello" }],
  max_tokens: 32,
}
let savedState: State
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>
let router: ModelRouter
let restore: Array<() => void>

beforeEach(() => {
  savedState = { ...state }
  Object.assign(state, {
    copilotToken: "fake-token",
    copilotApiEndpoint: "https://copilot.invalid",
    multiAccountEnabled: false,
    manualApprove: false,
    maxThinking: false,
    rateLimitSeconds: undefined,
    disableAnthropicPassthrough: false,
    models: undefined,
  })
  clearRouteCache()
  router = new ModelRouter({ mapping: {}, concurrency: { default: 1 } })
  const resolve = spyOn(modelRouter, "resolveModel").mockImplementation(
    (name) => router.resolveModel(name),
  )
  const acquire = spyOn(modelRouter, "acquireSlot").mockImplementation(
    (name: string, signal?: AbortSignal) => router.acquireSlot(name, signal),
  )
  fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Unexpected fetch"),
  )
  restore = [
    () => resolve.mockRestore(),
    () => acquire.mockRestore(),
    () => fetchSpy.mockRestore(),
  ]
})

afterEach(() => {
  for (const fn of restore) fn()
  for (const key of Object.keys(state)) Reflect.deleteProperty(state, key)
  Object.assign(state, savedState)
  clearRouteCache()
})

async function failure(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Expected rejection")
}

test("native pre-aborted request never fetches", async () => {
  const controller = new AbortController()
  const reason = new Error("client left")
  controller.abort(reason)
  expect(
    await failure(
      createAnthropicMessages(payload, { signal: controller.signal }),
    ),
  ).toBe(reason)
  expect(fetchSpy).not.toHaveBeenCalled()
})

test("native queued cancellation removes the waiter without fetching", async () => {
  fetchSpy.mockResolvedValueOnce(new Response('data: {"type":"ping"}\n\n'))
  const first = await createAnthropicMessages({ ...payload, stream: true })
  if (!(Symbol.asyncIterator in first)) throw new Error("Expected stream")
  const controller = new AbortController()
  const reason = new Error("queued client left")
  const second = failure(
    createAnthropicMessages(payload, { signal: controller.signal }),
  )
  await Bun.sleep(0)
  controller.abort(reason)
  try {
    expect(await second).toBe(reason)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(router.getStats()[model]).toMatchObject({ active: 1, queued: 0 })
  } finally {
    await first.return(undefined)
  }
})

test.each(["native", "translated"])(
  "Messages %s forwards cancellation before response headers",
  async (route) => {
    const controller = new AbortController()
    const reason = new Error("request disconnected")
    let upstreamSignal: AbortSignal | undefined
    const implementation = Object.assign(
      (
        _input: Parameters<typeof fetch>[0],
        init?: RequestInit,
      ): Promise<Response> => {
        upstreamSignal = init?.signal ?? undefined
        return new Promise((_resolve, reject) =>
          upstreamSignal?.addEventListener("abort", () => reject(reason), {
            once: true,
          }),
        )
      },
      { preconnect: globalThis.fetch.preconnect },
    )
    fetchSpy.mockImplementation(implementation)
    const pending = app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        ...payload,
        model: route === "native" ? model : "gpt-cancel-test",
      }),
    })
    await Bun.sleep(0)
    controller.abort(reason)
    await pending
    expect(upstreamSignal?.aborted).toBe(true)
    expect(upstreamSignal?.reason).toBe(reason)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  },
)

test.each(["native", "translated"])(
  "Messages %s reader cancellation aborts the upstream body and frees its slot",
  async (route) => {
    const upstreamModel = route === "native" ? model : "gpt-cancel-test"
    const firstEvent =
      route === "native" ?
        { type: "message_start", message: { model: upstreamModel } }
      : {
          id: "chat-test",
          model: upstreamModel,
          choices: [
            { index: 0, delta: { role: "assistant", content: "Hello" } },
          ],
        }
    let upstreamSignal: AbortSignal | undefined
    const implementation = Object.assign(
      (
        _input: Parameters<typeof fetch>[0],
        init?: RequestInit,
      ): Promise<Response> => {
        upstreamSignal = init?.signal ?? undefined
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify(firstEvent)}\n\n`,
                  ),
                )
                upstreamSignal?.addEventListener(
                  "abort",
                  () => controller.error(upstreamSignal?.reason),
                  { once: true },
                )
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        )
      },
      { preconnect: globalThis.fetch.preconnect },
    )
    fetchSpy.mockImplementation(implementation)
    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, model: upstreamModel, stream: true }),
    })
    const reader = response.body?.getReader()
    if (!reader) throw new Error("Expected stream")
    await reader.read()
    await reader.cancel()
    await Bun.sleep(0)
    expect(upstreamSignal?.aborted).toBe(true)
    expect(router.getStats()[upstreamModel].active).toBe(0)
  },
)

test.each(["native", "translated"])(
  "Messages %s stream preserves the client model after mapping",
  async (route) => {
    const finalModel = route === "native" ? model : "gpt-stream-test"
    router.updateMapping({
      alias: finalModel,
      [finalModel]: "must-not-map-again",
    })
    const events =
      route === "native" ?
        [
          { type: "message_start", message: { model: finalModel } },
          { type: "message_stop" },
        ]
      : [
          {
            id: "chat-test",
            model: finalModel,
            choices: [
              { index: 0, delta: { role: "assistant", content: "Hello" } },
            ],
          },
          {
            id: "chat-test",
            model: finalModel,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
        ]
    const body = events
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("")
    fetchSpy.mockResolvedValueOnce(
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
    )
    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, model: "alias", stream: true }),
    })
    expect(await response.text()).toContain('"model":"alias"')
    expect(JSON.parse(fetchSpy.mock.calls[0][1]?.body as string)).toMatchObject(
      { model: finalModel },
    )
    expect(router.getStats()[finalModel].active).toBe(0)
  },
)
