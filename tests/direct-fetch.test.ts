import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"

import {
  directFetch,
  isPrivateHost,
  validateFetchUrl,
} from "~/services/web/direct-fetch"
import { DuckDuckGoHtmlBackend } from "~/services/web/duckduckgo-html"

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>

beforeEach(() => {
  fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Unexpected network attempt"),
  )
})

afterEach(() => fetchSpy.mockRestore())

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Expected rejection")
}

async function failureMessage(promise: Promise<unknown>): Promise<string> {
  const error = await rejection(promise)
  expect(error).toBeInstanceOf(Error)
  return (error as Error).message
}

describe("WebFetch destination validation", () => {
  test.each([
    "http://localhost./",
    "http://service.localhost/",
    "http://0.1.2.3/",
    "http://100.100.100.200/",
    "http://[::]/",
    "http://[::1]/",
    "http://[fd12:3456::1]/",
    "http://[fc01::1]/",
    "http://[febf::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:192.168.1.1]/",
    "http://[::ffff:a00:1]/",
  ])("refuses local/private destination %s", async (url) => {
    expect(validateFetchUrl(url).ok).toBe(false)
    expect(await failureMessage(directFetch(url))).toContain("WebFetch refused")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test.each([
    "https://example.com/",
    "http://100.128.0.1/",
    "http://[2606:4700:4700::1111]/",
    "http://[::ffff:8.8.8.8]/",
  ])("allows public destination %s", (url) => {
    expect(validateFetchUrl(url).ok).toBe(true)
  })

  test("recognizes mapped IPv4 passed directly as a hostname", () => {
    expect(isPrivateHost("::ffff:127.0.0.1")).toBe(true)
    expect(isPrivateHost("not:an:ipv6:address")).toBe(false)
  })
})

describe("WebFetch redirects", () => {
  test.each([301, 302, 303, 307, 308])(
    "checks destinations before following HTTP %s",
    async (status) => {
      let cancelled = false
      fetchSpy.mockResolvedValue(
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true
            },
          }),
          { status, headers: { location: "http://169.254.169.254/latest" } },
        ),
      )

      expect(
        await failureMessage(directFetch("https://public.invalid/")),
      ).toContain("blocked private/loopback host")
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(fetchSpy.mock.calls[0][1]?.redirect).toBe("manual")
      expect(cancelled).toBe(true)
    },
  )

  test("follows relative and public redirects and returns the final URL", async () => {
    const first = new Response("redirect", {
      status: 302,
      headers: { location: "../next" },
    })
    const second = new Response("redirect", {
      status: 307,
      headers: { location: "https://other.invalid/final" },
    })
    const final = new Response("final content")
    fetchSpy
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(final)

    expect(await directFetch("https://public.invalid/dir/start")).toMatchObject(
      {
        url: "https://other.invalid/final",
        text: "final content",
        status: 200,
      },
    )
    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
      "https://public.invalid/dir/start",
      "https://public.invalid/next",
      "https://other.invalid/final",
    ])
    expect(first.bodyUsed).toBe(true)
    expect(second.bodyUsed).toBe(true)
    expect(final.body?.locked).toBe(false)
    const signal = fetchSpy.mock.calls[0][1]?.signal
    expect(
      fetchSpy.mock.calls.every(([, init]) => init?.signal === signal),
    ).toBe(true)
  })

  test("stops redirect loops after the Fetch standard limit", async () => {
    let cancelled = 0
    fetchSpy.mockImplementation(
      Object.assign(
        () =>
          Promise.resolve(
            new Response(
              new ReadableStream({
                cancel() {
                  cancelled++
                },
              }),
              { status: 302, headers: { location: "/again" } },
            ),
          ),
        { preconnect: globalThis.fetch.preconnect },
      ),
    )

    expect(
      await failureMessage(directFetch("https://public.invalid/")),
    ).toContain("exceeded 20 redirects")
    expect(fetchSpy).toHaveBeenCalledTimes(21)
    expect(cancelled).toBe(21)
  })

  test("preserves cancellation during redirect-body cleanup", async () => {
    const controller = new AbortController()
    const reason = new Error("client disconnected between redirects")
    fetchSpy.mockResolvedValue(
      new Response(
        new ReadableStream({
          cancel() {
            controller.abort(reason)
          },
        }),
        { status: 302, headers: { location: "/next" } },
      ),
    )

    const result = await directFetch("https://public.invalid/", {
      signal: controller.signal,
    }).catch((error: unknown) => error)
    expect(result).toBe(reason)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test("releases a redirect response with an invalid target", async () => {
    const response = new Response("redirect body", {
      status: 302,
      headers: { location: "http://[invalid" },
    })
    fetchSpy.mockResolvedValue(response)

    expect(
      await rejection(directFetch("https://public.invalid/")),
    ).toBeInstanceOf(Error)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(response.bodyUsed).toBe(true)
  })
})

test("WebFetch cancels and unlocks oversized bodies", async () => {
  let cancelled = false
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("oversized"))
      },
      cancel() {
        cancelled = true
      },
    }),
  )
  fetchSpy.mockResolvedValue(response)

  expect(
    await directFetch("https://public.invalid/", { maxBytes: 4 }),
  ).toMatchObject({ text: "over", truncated: true })
  expect(cancelled).toBe(true)
  expect(response.body?.locked).toBe(false)
})

test("WebSearch cancels unread HTTP error bodies", async () => {
  let cancelled = false
  fetchSpy.mockResolvedValue(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true
        },
      }),
      { status: 503 },
    ),
  )

  expect(
    await failureMessage(new DuckDuckGoHtmlBackend().search("test")),
  ).toContain("HTTP 503")
  expect(cancelled).toBe(true)
})
