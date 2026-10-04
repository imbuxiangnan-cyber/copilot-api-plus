import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Hono } from "hono"

import { state } from "~/lib/state"
import { handleWebToolFallback } from "~/routes/messages/proxy-web-fallback"
import { directFetch } from "~/services/web/direct-fetch"
import { DuckDuckGoHtmlBackend } from "~/services/web/duckduckgo-html"

const clients = [
  {
    name: "direct fetch",
    run: (signal: AbortSignal) =>
      directFetch("https://public.invalid", { signal }),
  },
  {
    name: "web search",
    run: (signal: AbortSignal) =>
      new DuckDuckGoHtmlBackend().search("test", { signal }),
  },
]
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>

beforeEach(() => {
  fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Unexpected network attempt"),
  )
})

afterEach(() => fetchSpy.mockRestore())

async function failure(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Expected rejection")
}

describe.each(clients)("$name cancellation", ({ run }) => {
  test("pre-aborted caller prevents fetch and preserves the reason", async () => {
    const reason = new Error("caller cancelled")
    const controller = new AbortController()
    controller.abort(reason)
    expect(await failure(run(controller.signal))).toBe(reason)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test.each(["headers", "body"])(
    "cancels while waiting for %s",
    async (stage) => {
      const reason = new Error("caller disconnected")
      const controller = new AbortController()
      let sentSignal: AbortSignal | undefined
      fetchSpy.mockImplementation(
        Object.assign(
          (
            _url: Parameters<typeof fetch>[0],
            init?: RequestInit,
          ): Promise<Response> => {
            sentSignal = init?.signal ?? undefined
            if (stage === "headers")
              return new Promise((_resolve, reject) => {
                sentSignal?.addEventListener("abort", () => reject(reason), {
                  once: true,
                })
              })
            return Promise.resolve(
              new Response(
                new ReadableStream<Uint8Array>({
                  start(body) {
                    sentSignal?.addEventListener(
                      "abort",
                      () => body.error(reason),
                      { once: true },
                    )
                  },
                }),
              ),
            )
          },
          { preconnect: globalThis.fetch.preconnect },
        ),
      )
      const pending = failure(run(controller.signal))
      await Bun.sleep(0)
      controller.abort(reason)
      expect(await pending).toBe(reason)
      expect(sentSignal?.aborted).toBe(true)
      expect(sentSignal?.reason).toBe(reason)
    },
  )
})

test("web fallback cancels an active tool fetch instead of continuing its Chat loop", async () => {
  const previous = { ...state }
  Object.assign(state, {
    copilotToken: "fake-token",
    copilotApiEndpoint: "https://copilot.invalid",
    multiAccountEnabled: false,
    maxThinking: false,
  })
  const controller = new AbortController()
  const reason = new Error("web client disconnected")
  let webSignal: AbortSignal | undefined
  const app = new Hono().post("/", (c) =>
    handleWebToolFallback(
      c,
      {
        model: "client-alias",
        max_tokens: 32,
        messages: [{ role: "user", content: "fetch page" }],
        tools: [{ type: "web_fetch_20250910", name: "web_fetch" }],
      },
      { resolvedModel: "gpt-web-test", signal: c.req.raw.signal },
    ),
  )
  fetchSpy.mockImplementation(
    Object.assign(
      (
        url: Parameters<typeof fetch>[0],
        init?: RequestInit,
      ): Promise<Response> => {
        if (typeof url === "string" && url.endsWith("/chat/completions"))
          return Promise.resolve(
            Response.json({
              id: "chat-web",
              model: "gpt-web-test",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "tool-1",
                        type: "function",
                        function: {
                          name: "__copilot_proxy_web_fetch",
                          arguments: '{"url":"https://public.invalid"}',
                        },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            }),
          )
        webSignal = init?.signal ?? undefined
        return new Promise((_resolve, reject) =>
          webSignal?.addEventListener("abort", () => reject(reason), {
            once: true,
          }),
        )
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  )
  const pending = app.request("/", {
    method: "POST",
    signal: controller.signal,
  })
  try {
    await Bun.sleep(0)
    controller.abort(reason)
    await pending
    expect(webSignal?.aborted).toBe(true)
    expect(webSignal?.reason).toBe(reason)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  } finally {
    controller.abort(reason)
    for (const key of Object.keys(state)) Reflect.deleteProperty(state, key)
    Object.assign(state, previous)
  }
})
