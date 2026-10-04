import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Hono } from "hono"

import { accountManager, type Account } from "~/lib/account-manager"
import { recordBreakerSuccess } from "~/lib/account-rotation"
import { ModelRouter, modelRouter } from "~/lib/model-router"
import { clearRouteCache } from "~/lib/route-resolver"
import { state, type State } from "~/lib/state"
import { messageRoutes } from "~/routes/messages/route"
import { createAnthropicMessages } from "~/services/copilot/create-anthropic-messages"

const nativeModel = "claude-native-control"
const nativeResponse = {
  id: "msg-test",
  type: "message",
  role: "assistant",
  model: nativeModel,
  content: [{ type: "text", text: "Hello" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
}
const app = new Hono().route("/v1/messages", messageRoutes)
const payload = (model = "alias", stream = false) => ({
  model,
  messages: [{ role: "user" as const, content: "Hello" }],
  max_tokens: 32,
  stream,
})

let savedState: State
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>
let router: ModelRouter
let restorers: Array<() => void>

beforeEach(() => {
  savedState = { ...state }
  Object.assign(state, {
    copilotToken: "test-token",
    copilotApiEndpoint: "https://copilot.invalid",
    multiAccountEnabled: false,
    manualApprove: false,
    rateLimitSeconds: undefined,
    maxThinking: false,
    models: undefined,
    disableAnthropicPassthrough: false,
  })
  clearRouteCache()
  recordBreakerSuccess()
  router = new ModelRouter({
    mapping: { alias: nativeModel, [nativeModel]: "must-not-map-twice" },
    concurrency: { default: 1 },
  })
  const resolve = spyOn(modelRouter, "resolveModel").mockImplementation(
    (name) => router.resolveModel(name),
  )
  const acquire = spyOn(modelRouter, "acquireSlot").mockImplementation(
    (name: string, signal?: AbortSignal) => router.acquireSlot(name, signal),
  )
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json(nativeResponse),
  )
  const random = spyOn(Math, "random").mockReturnValue(0)
  restorers = [
    () => resolve.mockRestore(),
    () => acquire.mockRestore(),
    () => fetchSpy.mockRestore(),
    () => random.mockRestore(),
  ]
})

afterEach(() => {
  for (const restore of restorers) restore()
  for (const key of Object.keys(state)) Reflect.deleteProperty(state, key)
  Object.assign(state, savedState)
  clearRouteCache()
  recordBreakerSuccess()
})

async function failure(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Expected rejection")
}

test("native requests map once and share the mapped model's concurrency slot", async () => {
  let release!: (value: Response) => void
  fetchSpy.mockReturnValueOnce(
    new Promise<Response>((resolve) => {
      release = resolve
    }),
  )
  const first = createAnthropicMessages(payload())
  await Bun.sleep(0)
  const second = createAnthropicMessages(payload())
  await Bun.sleep(0)
  try {
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(router.getStats()[nativeModel]).toMatchObject({
      active: 1,
      queued: 1,
    })
  } finally {
    release(Response.json(nativeResponse))
    await Promise.all([first, second])
  }
  for (const [, init] of fetchSpy.mock.calls) {
    expect(JSON.parse(init?.body as string)).toMatchObject({
      model: nativeModel,
    })
  }
  expect(router.getStats()[nativeModel].active).toBe(0)
})

test("native stream keeps its slot until return, even before first next", async () => {
  fetchSpy.mockResolvedValueOnce(new Response('data: {"type":"ping"}\n\n'))
  const result = await createAnthropicMessages(payload("alias", true))
  if (!(Symbol.asyncIterator in result)) throw new Error("Expected stream")
  try {
    expect(router.getStats()[nativeModel].active).toBe(1)
  } finally {
    await result.return(undefined)
  }
  expect(router.getStats()[nativeModel].active).toBe(0)
})

function fakeAccounts() {
  state.multiAccountEnabled = true
  state.copilotToken = undefined
  const accounts: Array<Account> = ["first", "second"].map((id) => ({
    id,
    label: id,
    githubToken: `github-${id}`,
    copilotToken: `copilot-${id}`,
    copilotApiEndpoint: "https://copilot.invalid",
    accountType: "individual",
    status: "active",
    consecutiveFailures: 0,
    addedAt: 0,
  }))
  const has = spyOn(accountManager, "hasAccounts").mockReturnValue(true)
  const select = spyOn(accountManager, "getActiveAccount").mockImplementation(
    (excluded) => accounts.find((account) => !excluded?.has(account.id)),
  )
  const success = spyOn(accountManager, "markAccountSuccess").mockReturnValue(
    undefined,
  )
  const mark = spyOn(accountManager, "markAccountStatus").mockReturnValue(
    undefined,
  )
  const refresh = spyOn(
    accountManager,
    "refreshAccountToken",
  ).mockImplementation((account) => {
    account.copilotToken = "refreshed"
    return Promise.resolve()
  })
  restorers.push(
    () => has.mockRestore(),
    () => select.mockRestore(),
    () => success.mockRestore(),
    () => mark.mockRestore(),
    () => refresh.mockRestore(),
  )
  return { mark, refresh }
}

test.each([403, 500])(
  "native HTTP %s tries an eligible spare account",
  async (status) => {
    fakeAccounts()
    fetchSpy.mockResolvedValueOnce(
      new Response("upstream unavailable", { status }),
    )
    await createAnthropicMessages(payload())
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(
      new Headers(fetchSpy.mock.calls[1][1]?.headers).get("authorization"),
    ).toBe("Bearer copilot-second")
  },
)

test("native refresh followed by 500 does not ban the account", async () => {
  const { mark, refresh } = fakeAccounts()
  fetchSpy.mockResolvedValueOnce(new Response("expired", { status: 401 }))
  fetchSpy.mockResolvedValueOnce(new Response("unavailable", { status: 500 }))
  await createAnthropicMessages(payload())
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(mark.mock.calls.some(([, status]) => status === "banned")).toBe(false)
  expect(fetchSpy).toHaveBeenCalledTimes(3)
})

test.each([400, 422])(
  "native parameter HTTP %s does not rotate or mark accounts",
  async (status) => {
    const { mark } = fakeAccounts()
    fetchSpy.mockResolvedValueOnce(
      new Response("invalid parameter", { status }),
    )
    expect(await failure(createAnthropicMessages(payload()))).toBeInstanceOf(
      Error,
    )
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(mark).not.toHaveBeenCalled()
  },
)

test("Messages selects native protocol after mapping and preserves the client model", async () => {
  const response = await app.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload()),
  })
  expect(response.status).toBe(200)
  expect(fetchSpy.mock.calls[0][0]).toBe("https://copilot.invalid/v1/messages")
  expect(JSON.parse(fetchSpy.mock.calls[0][1]?.body as string)).toMatchObject({
    model: nativeModel,
  })
  expect(await response.json()).toMatchObject({ model: "alias" })
})

test("Messages selects Chat after mapping without mapping again", async () => {
  router.updateMapping({
    "claude-client": "gpt-final",
    "gpt-final": "wrong-model",
  })
  fetchSpy.mockResolvedValueOnce(
    Response.json({
      id: "chat-test",
      model: "gpt-final",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  )
  const response = await app.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload("claude-client")),
  })
  expect(response.status).toBe(200)
  expect(fetchSpy.mock.calls[0][0]).toBe(
    "https://copilot.invalid/chat/completions",
  )
  expect(JSON.parse(fetchSpy.mock.calls[0][1]?.body as string)).toMatchObject({
    model: "gpt-final",
  })
  expect(await response.json()).toMatchObject({ model: "claude-client" })
})
