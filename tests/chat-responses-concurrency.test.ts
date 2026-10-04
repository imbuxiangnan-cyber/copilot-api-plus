import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"

import { HTTPError } from "~/lib/error"
import { modelRouter } from "~/lib/model-router"
import { state } from "~/lib/state"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"

let savedState: typeof state
let savedConfig: ReturnType<typeof modelRouter.getConfig>
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>

beforeEach(() => {
  savedState = { ...state }
  savedConfig = modelRouter.getConfig()
  Object.assign(state, {
    copilotToken: "test-token",
    copilotApiEndpoint: "https://copilot.invalid",
    vsCodeVersion: "1.0.0",
    multiAccountEnabled: false,
    models: undefined,
    maxThinking: false,
  })
  modelRouter.updateMapping({})
  modelRouter.updateConcurrency({ default: 1 })
  modelRouter.resetStats()
  fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Unexpected upstream request in concurrency test"),
  )
})

afterEach(() => {
  fetchSpy.mockRestore()
  for (const key of Object.keys(state)) Reflect.deleteProperty(state, key)
  Object.assign(state, savedState)
  modelRouter.updateMapping(savedConfig.mapping)
  modelRouter.updateConcurrency(savedConfig.concurrency)
  modelRouter.resetStats()
})

function upstreamResponse(stream: boolean): Response {
  const response = {
    id: "resp-concurrency",
    object: "response",
    output: [],
  }
  return stream ?
      new Response(
        `data: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )
    : Response.json(response)
}

async function drainResult(
  result: Awaited<ReturnType<typeof createChatCompletions>>,
): Promise<void> {
  if (Symbol.asyncIterator in result) {
    for await (const chunk of result) {
      expect(chunk).toBeDefined()
    }
  }
}

describe("Chat requests routed to Responses", () => {
  test("does not retry a Responses rejection through Chat-specific recovery", async () => {
    const model = "gpt-5.5-rejected-responses-concurrency"
    const errorBody = { error: { message: "unsupported_api_for_model" } }
    fetchSpy
      .mockResolvedValueOnce(Response.json(errorBody, { status: 400 }))
      .mockResolvedValueOnce(Response.json(errorBody, { status: 400 }))

    const result = await createChatCompletions({
      model,
      messages: [{ role: "user", content: "Hello" }],
    }).catch((error: unknown) => error)

    expect(result).toBeInstanceOf(HTTPError)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(modelRouter.getStats()[model].active).toBe(0)
  })

  test.each([false, true])(
    "known Responses-only models wait for a slot (stream=%s)",
    async (stream) => {
      const model = `gpt-5.5-concurrency-${String(stream)}`
      fetchSpy.mockResolvedValue(upstreamResponse(stream))
      const releaseBlocker = await modelRouter.acquireSlot(model)
      const pending = createChatCompletions({
        model,
        messages: [{ role: "user", content: "Hello" }],
        stream,
      })

      try {
        await Promise.resolve()
        expect(fetchSpy).not.toHaveBeenCalled()
        expect(modelRouter.getStats()[model]).toMatchObject({
          active: 1,
          queued: 1,
        })
      } finally {
        releaseBlocker()
        const result = await pending
        await drainResult(result)
      }

      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(fetchSpy.mock.calls[0][0]).toBe(
        "https://copilot.invalid/v1/responses",
      )
      expect(modelRouter.getStats()[model]).toMatchObject({
        active: 0,
        queued: 0,
        totalRequests: 2,
      })
    },
  )

  test("a learned Responses fallback keeps a single slot and uses it again", async () => {
    const model = "learned-responses-concurrency-model"
    fetchSpy
      .mockResolvedValueOnce(
        Response.json(
          { error: { message: "unsupported_api_for_model" } },
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(upstreamResponse(false))
      .mockResolvedValueOnce(upstreamResponse(false))

    const payload = {
      model,
      messages: [{ role: "user" as const, content: "Hi" }],
    }
    await createChatCompletions(payload)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(modelRouter.getStats()[model]).toMatchObject({
      active: 0,
      totalRequests: 1,
    })

    await createChatCompletions(payload)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    expect(modelRouter.getStats()[model]).toMatchObject({
      active: 0,
      totalRequests: 2,
    })
  })

  test.each(["gpt-5.5-unstarted-stream", "chat-unstarted-stream"])(
    "releases a stream closed before reading its first chunk (%s)",
    async (model) => {
      fetchSpy.mockResolvedValue(upstreamResponse(true))
      const result = await createChatCompletions({
        model,
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      })
      if (!(Symbol.asyncIterator in result)) {
        throw new Error("Expected a streaming response")
      }

      expect(modelRouter.getStats()[model].active).toBe(1)
      await result.return(undefined)
      expect(modelRouter.getStats()[model].active).toBe(0)
    },
  )
})
