import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import consola from "consola"
import { Hono } from "hono"

import { state, type State } from "~/lib/state"
import { responsesRoutes } from "~/routes/responses/route"

const app = new Hono()
app.route("/responses", responsesRoutes)
app.route("/v1/responses", responsesRoutes)

const upstreamResponse = {
  id: "resp-native-test",
  object: "response",
  status: "completed",
  output: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Hello" }],
    },
  ],
}

const upstreamEvents = [
  {
    type: "response.output_text.delta",
    delta: "Hello",
    output_index: 0,
    content_index: 0,
  },
  { type: "response.completed", response: upstreamResponse },
]
const upstreamStream = upstreamEvents
  .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  .join("")

let savedState: State
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>
let promptSpy: ReturnType<typeof spyOn<typeof consola, "prompt">>

beforeEach(() => {
  savedState = { ...state }
  Object.assign(state, {
    copilotToken: "responses-route-test-token",
    copilotApiEndpoint: "https://copilot.invalid",
    vsCodeVersion: "1.0.0",
    multiAccountEnabled: false,
    manualApprove: false,
    rateLimitSeconds: undefined,
    lastRequestTimestamp: undefined,
    rateLimitWait: false,
  })
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json(upstreamResponse),
  )
  promptSpy = spyOn(consola, "prompt").mockResolvedValue(true)
})

afterEach(() => {
  fetchSpy.mockRestore()
  promptSpy.mockRestore()
  for (const key of Object.keys(state)) Reflect.deleteProperty(state, key)
  Object.assign(state, savedState)
})

function makePayload(stream: boolean) {
  return {
    model: "responses-route-test-model",
    input: [{ role: "user", content: "Hello" }],
    instructions: "Keep the native instructions.",
    reasoning: { effort: "medium" },
    text: { verbosity: "low" },
    store: false,
    stream,
  }
}

function request(path: string, stream: boolean) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(makePayload(stream)),
  })
}

describe.each(["/responses", "/v1/responses"])("POST %s", (path) => {
  test.each([false, true])(
    "rejects rate-limited requests before approval or fetch (stream=%s)",
    async (stream) => {
      state.rateLimitSeconds = 60
      state.lastRequestTimestamp = Date.now()
      state.manualApprove = true

      const response = await request(path, stream)

      expect(response.status).toBe(429)
      expect(await response.text()).toContain("Rate limit exceeded")
      expect(promptSpy).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
    },
  )

  test.each([false, true])(
    "rejects requests denied by manual approval (stream=%s)",
    async (stream) => {
      state.manualApprove = true
      promptSpy.mockResolvedValue(false)

      const response = await request(path, stream)

      expect(response.status).toBe(403)
      expect(await response.text()).toContain("Request rejected")
      expect(promptSpy).toHaveBeenCalledTimes(1)
      expect(fetchSpy).not.toHaveBeenCalled()
    },
  )

  test.each([false, true])(
    "forwards approved native requests and responses (stream=%s)",
    async (stream) => {
      state.manualApprove = true
      state.rateLimitSeconds = 60
      if (stream) {
        fetchSpy.mockResolvedValue(
          new Response(upstreamStream, {
            headers: { "content-type": "text/event-stream" },
          }),
        )
      }

      const response = await request(path, stream)

      expect(response.status).toBe(200)
      if (stream) {
        expect(response.headers.get("content-type")).toContain(
          "text/event-stream",
        )
        expect(await response.text()).toBe(upstreamStream)
      } else {
        expect(await response.json()).toEqual(upstreamResponse)
      }
      expect(state.lastRequestTimestamp).toBeGreaterThan(0)
      expect(promptSpy).toHaveBeenCalledTimes(1)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const [url, init] = fetchSpy.mock.calls[0]
      expect(url).toBe("https://copilot.invalid/v1/responses")
      expect(init?.method).toBe("POST")
      expect(JSON.parse(init?.body as string)).toEqual(makePayload(stream))
    },
  )
})
