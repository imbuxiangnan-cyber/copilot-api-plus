import { afterEach, expect, test } from "bun:test"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { serve } from "srvx"

let transportServer: ReturnType<typeof serve> | undefined

afterEach(async () => {
  const closingServer = transportServer
  transportServer = undefined
  await closingServer?.close(true)
})

async function startTransport(app: Hono): Promise<string> {
  transportServer = serve({
    hostname: "127.0.0.1",
    port: 0,
    silent: true,
    gracefulShutdown: false,
    fetch: app.fetch,
  })
  await transportServer.ready()
  const url = transportServer.url
  if (!url || new URL(url).hostname !== "127.0.0.1") {
    throw new Error("Expected an isolated loopback listener")
  }
  return url.replace(/\/$/, "")
}

async function beforeDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Local transport timed out")),
          2000,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

test("srvx serves a Hono JSON request over loopback", async () => {
  const app = new Hono().post("/json", async (c) => {
    const body: unknown = await c.req.json()
    return c.json({ received: body }, 201)
  })
  const origin = await startTransport(app)

  const response = await fetch(`${origin}/json`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "local-only" }),
    proxy: "",
    signal: AbortSignal.timeout(2000),
  })

  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({ received: { message: "local-only" } })
})

test("srvx delivers a complete Hono SSE response over loopback", async () => {
  const app = new Hono().get("/events", (c) =>
    streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "message", data: "first", id: "1" })
      await stream.writeSSE({ event: "message", data: "second", id: "2" })
    }),
  )
  const origin = await startTransport(app)

  const response = await fetch(`${origin}/events`, {
    proxy: "",
    signal: AbortSignal.timeout(2000),
  })

  expect(response.headers.get("content-type")).toContain("text/event-stream")
  expect(await response.text()).toBe(
    "event: message\ndata: first\nid: 1\n\nevent: message\ndata: second\nid: 2\n\n",
  )
})

test("client cancellation reaches the srvx request and Hono SSE stream", async () => {
  const requestAborted = Promise.withResolvers<undefined>()
  const streamAborted = Promise.withResolvers<undefined>()
  const finishStream = Promise.withResolvers<undefined>()
  const app = new Hono().get("/events", (c) => {
    c.req.raw.signal.addEventListener(
      "abort",
      () => requestAborted.resolve(undefined),
      { once: true },
    )
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => streamAborted.resolve(undefined))
      await stream.writeSSE({ data: "ready" })
      await finishStream.promise
    })
  })
  const origin = await startTransport(app)
  const controller = new AbortController()
  let reader:
    | Pick<
        ReadableStreamDefaultReader<Uint8Array>,
        "read" | "cancel" | "releaseLock"
      >
    | undefined

  try {
    const response = await fetch(`${origin}/events`, {
      proxy: "",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]),
    })
    reader = response.body?.getReader()
    if (!reader) throw new Error("Expected a local SSE body")
    const firstChunk = await beforeDeadline(reader.read())
    expect(new TextDecoder().decode(firstChunk.value)).toContain("data: ready")
    controller.abort()
    await beforeDeadline(
      Promise.all([requestAborted.promise, streamAborted.promise]),
    )
    expect(controller.signal.aborted).toBe(true)
  } finally {
    controller.abort()
    finishStream.resolve(undefined)
    await reader?.cancel().catch(() => {})
    reader?.releaseLock()
  }
})
