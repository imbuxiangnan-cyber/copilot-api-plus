import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
  type Mock,
} from "bun:test"

import { accountManager, type Account } from "~/lib/account-manager"
import { ModelRouter, modelRouter } from "~/lib/model-router"
import { type StreamAccountInfo } from "~/lib/proxy"
import { state, type State } from "~/lib/state"
import { forwardResponsesAsChat } from "~/routes/chat-completions/responses-passthrough"
import { createNativeResponses } from "~/services/copilot/create-native-responses"

const model = "responses-concurrency-resolved"
const responseBody = {
  id: "resp-concurrency-test",
  object: "response",
  model,
  created_at: 1,
  status: "completed",
  output: [],
}
const delta = 'data: {"type":"response.output_text.delta","delta":"Hello"}\n\n'
const completed = `data: ${JSON.stringify({
  type: "response.completed",
  response: responseBody,
})}\n\n`
const clients = [
  { name: "native", call: createNativeResponses },
  { name: "chat passthrough", call: forwardResponsesAsChat },
]

let savedState: State
let router: ModelRouter
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>
let releases: Array<Mock<() => void>>
let restorers: Array<() => void>

beforeEach(() => {
  savedState = { ...state }
  Object.assign(state, {
    copilotToken: "single-test-token",
    copilotApiEndpoint: "https://copilot.invalid",
    multiAccountEnabled: false,
  })
  router = new ModelRouter({
    mapping: { alias: model, [model]: "must-not-resolve-twice" },
    concurrency: { [model]: 1, default: 10 },
  })
  releases = []
  const resolveSpy = spyOn(modelRouter, "resolveModel").mockImplementation(
    (requested) => router.resolveModel(requested),
  )
  const acquireSpy = spyOn(modelRouter, "acquireSlot").mockImplementation(
    async (resolved) => {
      const release = mock(await router.acquireSlot(resolved))
      releases.push(release)
      return release
    },
  )
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json(responseBody),
  )
  restorers = [
    () => resolveSpy.mockRestore(),
    () => acquireSpy.mockRestore(),
    () => fetchSpy.mockRestore(),
  ]
})

afterEach(() => {
  for (const restore of restorers) restore()
  for (const key of Object.keys(state)) Reflect.deleteProperty(state, key)
  Object.assign(state, savedState)
})

function expectReleased(count = 1) {
  expect(router.getStats()[model].active).toBe(0)
  expect(router.getStats()[model].queued).toBe(0)
  expect(releases).toHaveLength(count)
  for (const release of releases) expect(release).toHaveBeenCalledTimes(1)
}

function getStream(
  result: Awaited<ReturnType<(typeof clients)[number]["call"]>>,
) {
  if ("__isStream" in result && result.__isStream) return result.stream
  if (Symbol.asyncIterator in result) return result
  throw new Error("Expected a streaming result")
}

async function expectFailure(result: Promise<unknown>, message?: string) {
  let failure: unknown
  try {
    await result
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(Error)
  if (message) expect((failure as Error).message).toContain(message)
}

describe.each(clients)("$name Responses concurrency", ({ call }) => {
  test("serializes JSON requests on the final mapped model", async () => {
    let finishFetch!: (response: Response) => void
    const pendingResponse = new Promise<Response>((resolve) => {
      finishFetch = resolve
    })
    fetchSpy.mockReturnValueOnce(pendingResponse)
    const first = call({ model: "alias", input: [] })
    await Bun.sleep(0)
    const second = call({ model: "alias", input: [] })
    await Bun.sleep(0)
    try {
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(router.getStats()[model]).toMatchObject({ active: 1, queued: 1 })
    } finally {
      finishFetch(Response.json(responseBody))
      await Promise.all([first, second])
    }
    expectReleased(2)
    for (const [, init] of fetchSpy.mock.calls) {
      expect(JSON.parse(init?.body as string)).toMatchObject({ model })
    }
  })

  test("releases the slot after an HTTP error", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("bad request", { status: 400 }))
    await expectFailure(call({ model: "alias", input: [] }), "bad request")
    expectReleased()
  })

  test("releases the slot after JSON parsing fails", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("invalid JSON"))
    await expectFailure(call({ model: "alias", input: [] }))
    expectReleased()
  })

  test.each(["complete", "return", "return-before-next", "throw"])(
    "holds the slot until stream termination: %s",
    async (termination) => {
      fetchSpy.mockResolvedValueOnce(
        new Response(delta + completed, {
          headers: { "content-type": "text/event-stream" },
        }),
      )
      const stream = getStream(
        await call({ model: "alias", input: [], stream: true }),
      )
      try {
        expect(router.getStats()[model].active).toBe(1)
        if (termination !== "return-before-next") await stream.next()
        if (termination === "complete") {
          for await (const _chunk of stream) {
            expect(router.getStats()[model].active).toBe(1)
          }
        } else if (termination === "throw") {
          await expectFailure(
            stream.throw(new Error("client stopped")),
            "client stopped",
          )
        } else {
          await stream.return(undefined)
        }
        expectReleased()
      } finally {
        await stream.return(undefined)
      }
      expectReleased()
    },
  )

  test("releases the slot when the upstream stream fails", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
        controller.enqueue(new TextEncoder().encode(delta))
      },
    })
    fetchSpy.mockResolvedValueOnce(new Response(body))
    const stream = getStream(
      await call({ model: "alias", input: [], stream: true }),
    )
    await stream.next()
    controller.error(new Error("upstream failed"))
    await expectFailure(
      (async () => {
        for await (const _chunk of stream) {
          // Drain any already-translated chunks before observing the failure.
        }
      })(),
      "upstream failed",
    )
    expectReleased()
  })

  test("rejects a missing single-account token and releases the slot", async () => {
    state.copilotToken = undefined
    await expectFailure(
      call({ model: "alias", input: [] }),
      "Copilot token not found",
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    expectReleased()
  })

  test.each([false, true])(
    "uses the selected account token (stream=%s)",
    async (stream) => {
      const randomSpy = spyOn(Math, "random").mockReturnValue(0)
      restorers.push(() => randomSpy.mockRestore())
      state.copilotToken = undefined
      state.multiAccountEnabled = true
      const account: Account = {
        id: "responses-concurrency-account",
        label: "Test account",
        githubToken: "github-test-token",
        copilotToken: "account-test-token",
        copilotApiEndpoint: "https://account.invalid",
        accountType: "individual",
        status: "active",
        consecutiveFailures: 0,
        addedAt: 0,
      }
      const hasSpy = spyOn(accountManager, "hasAccounts").mockReturnValue(true)
      const activeSpy = spyOn(
        accountManager,
        "getActiveAccount",
      ).mockReturnValue(account)
      const successSpy = spyOn(
        accountManager,
        "markAccountSuccess",
      ).mockReturnValue(undefined)
      restorers.push(
        () => hasSpy.mockRestore(),
        () => activeSpy.mockRestore(),
        () => successSpy.mockRestore(),
      )

      if (stream)
        fetchSpy.mockResolvedValueOnce(new Response(delta + completed))
      const result = await call({ model: "alias", input: [], stream })
      if (stream) {
        const iterator = getStream(result)
        const tagged = iterator as typeof iterator & {
          __accountInfo?: StreamAccountInfo
        }
        expect(tagged.__accountInfo).toMatchObject({
          accountId: account.id,
          apiBaseUrl: account.copilotApiEndpoint,
        })
        await iterator.return(undefined)
      }

      const [url, init] = fetchSpy.mock.calls[0]
      expect(url).toBe("https://account.invalid/v1/responses")
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer account-test-token",
      )
      expectReleased()
    },
  )
})
