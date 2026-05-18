/* eslint-disable max-lines */
import consola from "consola"
import { events } from "fetch-event-stream"

import { accountManager } from "~/lib/account-manager"
import { runWithAccountRotation } from "~/lib/account-rotation"
import { pickHighestSupportedEffort } from "~/lib/anthropic-sanitizer"
import {
  copilotHeaders,
  copilotBaseUrl,
  type TokenSource,
} from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { modelRouter } from "~/lib/model-router"
import {
  getAccountDispatcher,
  notifyStreamEnd,
  notifyStreamStart,
  resetAccountConnections,
  resetConnections,
  type StreamAccountInfo,
} from "~/lib/proxy"
import { state } from "~/lib/state"
import { refreshCopilotToken } from "~/lib/token"
import { findModel, rootCause } from "~/lib/utils"

// ---------------------------------------------------------------------------
// Fetch with timeout helper
// ---------------------------------------------------------------------------

/**
 * Timeout for the initial HTTP connection + headers (not the body/stream).
 * Copilot's slow models (e.g. claude-opus with thinking) can take up to
 * ~120s to start streaming, so we give a generous timeout for headers.
 */
const FETCH_TIMEOUT_MS = 120_000

/**
 * Wrapper around `fetch()` that aborts if the server doesn't respond within
 * `timeoutMs`.  The timeout only covers the period until the response headers
 * arrive – once the body starts streaming, the timeout is cleared so that
 * long SSE responses are not interrupted.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  {
    timeoutMs = FETCH_TIMEOUT_MS,
    accountId,
    accountProxy,
  }: {
    timeoutMs?: number
    accountId?: string
    accountProxy?: string
  } = {},
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    // Use per-account connection pool when in multi-account mode
    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      ...init,
      signal: controller.signal,
    }
    if (accountId) {
      ;(fetchOptions as { dispatcher?: unknown }).dispatcher =
        getAccountDispatcher(accountId, accountProxy)
    }
    const response = await fetch(url, fetchOptions)
    return response
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Single-attempt fetch with connection pool reset on network errors.
 *
 * Retries are intentionally disabled — each Copilot request consumes a
 * credit, and the caller (e.g. Claude Code) already retries at the
 * application level.  Our retry + caller retry created a request cascade
 * that caused account bans (367 requests in 52 minutes).
 *
 * On network failure (NOT timeout), the pooled connections are destroyed
 * so that the caller's next attempt gets a fresh socket instantly.
 */
export async function fetchWithRetry(
  url: string,
  buildInit: () => RequestInit,
  {
    accountId,
    accountProxy,
  }: { accountId?: string; accountProxy?: string } = {},
): Promise<Response> {
  try {
    return await fetchWithTimeout(url, buildInit(), {
      timeoutMs: FETCH_TIMEOUT_MS,
      accountId,
      accountProxy,
    })
  } catch (error: unknown) {
    // Timeout errors mean the request likely reached Copilot (credit
    // already consumed) or the upstream is genuinely slow — don't reset
    // the pool, just propagate.
    const msg = error instanceof Error ? error.message : String(error)
    if (!msg.includes("timed out")) {
      // Network error: destroy pooled connections so the caller's next
      // attempt uses fresh sockets instead of stale ones.
      if (accountId) {
        resetAccountConnections(accountId)
      } else {
        resetConnections()
      }
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// Streaming slot release wrapper
// ---------------------------------------------------------------------------

/**
 * Wraps an AsyncGenerator so that `releaseSlot` is called when the generator
 * finishes (return or throw), not when the outer function returns.
 * Also tracks active streams for the proxy-tunnel keepalive mechanism.
 */
async function* wrapGeneratorWithRelease(
  gen: AsyncGenerator,
  releaseSlot: () => void,
  accountInfo?: StreamAccountInfo,
): AsyncGenerator {
  notifyStreamStart(accountInfo)
  let streamError = false
  try {
    yield* gen
  } catch (error) {
    streamError = true
    throw error
  } finally {
    notifyStreamEnd(accountInfo)
    releaseSlot()
    // After a stream error, destroy all pooled connections so the next
    // request from the client gets a fresh socket instantly instead of
    // waiting ~60s on a stale one.
    if (streamError) {
      if (accountInfo?.accountId) {
        resetAccountConnections(accountInfo.accountId)
      } else {
        resetConnections()
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Reasoning-effort auto-detection cache
// ---------------------------------------------------------------------------

/**
 * Models known to require `max_completion_tokens` instead of `max_tokens`.
 * Populated at runtime: when a model returns 400 with a message containing
 * "max_completion_tokens", that model is added here and all subsequent
 * requests use the correct field name automatically.
 */
const maxCompletionTokensModels = new Set<string>()

/**
 * Normalize the payload for models that use `max_completion_tokens`
 * instead of `max_tokens`.  Only applied when the model has been seen
 * to reject `max_tokens` at runtime.
 */
function normalizeMaxTokens(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  if (!maxCompletionTokensModels.has(payload.model)) return payload
  if (!payload.max_tokens) return payload
  const { max_tokens, ...rest } = payload
  return {
    ...rest,
    max_completion_tokens: max_tokens,
  } as ChatCompletionsPayload
}

/**
 * Models that are known NOT to support the `reasoning_effort` parameter.
 * Populated at runtime: the first time a model returns 400 with
 * "Unrecognized request argument", it is added here and all future
 * requests to that model skip the injection automatically.
 */
const reasoningUnsupportedModels = new Set<string>()

/**
 * Models whose reasoning_effort must be capped at a lower level.
 * e.g. claude-opus-4.7 rejects "high" but accepts "medium".
 * When a model returns 400 with "is not supported by model", it is added
 * here with its maximum supported effort level.
 */
const reasoningEffortCap = new Map<string, "low" | "medium">()

/**
 * Models that reject `reasoning_effort` when function tools are present.
 * e.g. gpt-5.4 returns "Function tools with reasoning_effort are not
 * supported ... Please use /v1/responses instead."
 * Populated at runtime on first 400.
 */
const reasoningWithToolsUnsupported = new Set<string>()

/**
 * Compute an appropriate thinking_budget from model capabilities.
 * Returns undefined if the model does not support thinking.
 */
function getThinkingBudget(
  model: import("~/services/copilot/get-models").Model | undefined,
): number | undefined {
  if (!model) return undefined
  const { supports, limits } = model.capabilities
  const maxBudget = supports.max_thinking_budget
  if (!maxBudget || maxBudget <= 0) return undefined
  const maxOutput = limits.max_output_tokens ?? 0
  const upperBound = Math.min(maxBudget, Math.max(maxOutput - 1, 0))
  const lowerBound = supports.min_thinking_budget ?? 1024
  return Math.max(upperBound, lowerBound)
}

/**
 * Check whether tool_choice forces tool use (not "auto" or "none").
 * Thinking/reasoning cannot be enabled when tool_choice forces a tool.
 */
function isToolChoiceForced(
  toolChoice: ChatCompletionsPayload["tool_choice"],
): boolean {
  if (!toolChoice) return false
  if (toolChoice === "auto" || toolChoice === "none") return false
  // "required" or { type: "function", ... } are forced
  return true
}

/**
 * Inject thinking parameters into the payload based on model capabilities.
 *
 * Strategy (in priority order):
 *   1. If the client already set reasoning_effort or thinking_budget → keep as-is
 *   2. If tool_choice forces tool use → skip (API rejects the combination)
 *   3. If model capabilities declare max_thinking_budget → inject thinking_budget
 *   4. Otherwise → inject reasoning_effort at the highest level the model supports:
 *      - "high" by default (maximum thinking for most models)
 *      - Capped to "medium"/"low" if the model previously rejected "high"
 *
 * The fallback to reasoning_effort ensures thinking works even when the
 * /models endpoint doesn't expose thinking budget fields.
 */
function injectThinking(
  payload: ChatCompletionsPayload,
  resolvedModel: string,
): ChatCompletionsPayload {
  // Thinking must be stripped when:
  // 1. tool_choice forces tool use (API rejects the combination), or
  // 2. the model is known to reject reasoning_effort when ANY tools are
  //    present (e.g. gpt-5.4 — learned at runtime).
  const hasTools = payload.tools && payload.tools.length > 0
  const mustStripThinking =
    isToolChoiceForced(payload.tool_choice)
    || (hasTools && reasoningWithToolsUnsupported.has(resolvedModel))

  if (mustStripThinking) {
    if (payload.reasoning_effort || payload.thinking_budget) {
      const stripped = { ...payload }
      delete stripped.reasoning_effort
      delete stripped.thinking_budget
      consola.debug(
        `Thinking: stripped reasoning params for "${resolvedModel}" (tool conflict)`,
      )
      return stripped
    }
    return payload
  }

  // Client already specified thinking params — respect them, but still
  // apply the runtime-learned cap if the model rejected "high" previously.
  if (payload.reasoning_effort || payload.thinking_budget) {
    if (
      payload.reasoning_effort
      && payload.reasoning_effort !== "medium"
      && payload.reasoning_effort !== "low"
    ) {
      const cap = reasoningEffortCap.get(resolvedModel)
      if (cap) return { ...payload, reasoning_effort: cap }
    }
    return payload
  }

  // Try model-capability-based injection (thinking_budget)
  const model = findModel(resolvedModel)
  const budget = getThinkingBudget(model)
  if (budget) {
    return { ...payload, thinking_budget: budget }
  }

  return injectDefaultReasoningEffort(payload, resolvedModel, model)
}

/**
 * Pick the highest reasoning_effort the model accepts and inject it.
 *
 * Preference order:
 *   1. Runtime-learned cap (set after a past 400 from this model)
 *   2. Highest level in /models supports.reasoning_effort whitelist
 *      (e.g. gpt-5.5 advertises [..., "xhigh"], so we pick "xhigh")
 *   3. Hardcoded "high" fallback for models without a whitelist
 */
function injectDefaultReasoningEffort(
  payload: ChatCompletionsPayload,
  resolvedModel: string,
  model: import("~/services/copilot/get-models").Model | undefined,
): ChatCompletionsPayload {
  if (reasoningUnsupportedModels.has(resolvedModel)) {
    return payload
  }
  const cap = reasoningEffortCap.get(resolvedModel)
  const advertised = pickHighestSupportedEffort(
    model?.capabilities.supports.reasoning_effort,
  )
  const effort = cap ?? advertised ?? "high"
  return {
    ...payload,
    reasoning_effort: effort as ChatCompletionsPayload["reasoning_effort"],
  }
}

// ---------------------------------------------------------------------------
// Thinking injection logging (debug level)
// ---------------------------------------------------------------------------

function logThinkingInjection(
  original: ChatCompletionsPayload,
  injected: ChatCompletionsPayload,
  resolvedModel: string,
) {
  if (original.reasoning_effort || original.thinking_budget) {
    consola.debug(
      `Thinking: translated (reasoning_effort=${original.reasoning_effort ?? "none"} / thinking_budget=${original.thinking_budget ?? "none"})`,
    )
  } else if (
    injected.thinking_budget
    && injected.thinking_budget !== original.thinking_budget
  ) {
    consola.debug(
      `Thinking: injected thinking_budget=${injected.thinking_budget} for "${resolvedModel}"`,
    )
  } else if (
    injected.reasoning_effort
    && injected.reasoning_effort
      !== (original.reasoning_effort as string | null | undefined)
  ) {
    consola.debug(
      `Thinking: injected reasoning_effort=${injected.reasoning_effort} for "${resolvedModel}"`,
    )
  } else if (reasoningUnsupportedModels.has(resolvedModel)) {
    consola.debug(
      `Thinking: skipped — "${resolvedModel}" does not support reasoning`,
    )
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

import { createResponsesAsChat } from "./create-responses"

/**
 * Models known to require `/v1/responses` (and reject `/chat/completions`
 * with `unsupported_api_for_model`). Learned at runtime — once a model
 * hits the 400, all future requests for it skip the chat-completions
 * attempt and go straight to the Responses API.
 *
 * Cleared on process restart so Copilot routing changes self-heal.
 */
const responsesApiOnlyModels = new Set<string>()

/**
 * Models we know up-front are Responses-API-only on Copilot, so the
 * first request after process start doesn't burn a `/chat/completions`
 * roundtrip just to be told `unsupported_api_for_model`. Conservative
 * — only models we've actually observed reject `/chat/completions`.
 *
 * `responsesApiOnlyModels` (learned at runtime) is still the source of
 * truth: anything not in this hint list, or with a future Copilot
 * routing change, self-heals via the 400 path below.
 */
const RESPONSES_ONLY_MODEL_HINTS: ReadonlyArray<RegExp> = [/^gpt-5\.5(\b|-)/]

function isLikelyResponsesOnly(model: string): boolean {
  return RESPONSES_ONLY_MODEL_HINTS.some((re) => re.test(model))
}

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
) => {
  // Guard: every code path below assumes `messages` is an array
  // (`.some(...)`, `.flatMap(...)`, etc.). If a caller / client hands us
  // a malformed body — e.g. a Responses-API-shape payload that escaped
  // the dispatcher in `routes/chat-completions/handler.ts` — fail fast
  // with a readable 400 instead of crashing with
  // `Cannot read properties of undefined (reading 'some')`.
  if (!Array.isArray(payload.messages)) {
    throw new HTTPError(
      "Invalid request: `messages` must be an array. If you intended to send a Responses API payload, POST to /v1/responses or include a `messages` field.",
      new Response(null, { status: 400, statusText: "Bad Request" }),
    )
  }

  // Apply model routing
  const resolvedModel = modelRouter.resolveModel(payload.model)
  const routedPayload =
    resolvedModel !== payload.model ?
      { ...payload, model: resolvedModel }
    : payload
  if (resolvedModel !== payload.model) {
    consola.debug(`Model routed: ${payload.model} → ${resolvedModel}`)
  }

  // ---------------------------------------------------------------------------
  // Thinking injection: use model capabilities to decide strategy
  // ---------------------------------------------------------------------------
  const thinkingPayload = injectThinking(routedPayload, resolvedModel)
  const wasInjected =
    thinkingPayload.reasoning_effort !== routedPayload.reasoning_effort
    || thinkingPayload.thinking_budget !== routedPayload.thinking_budget

  logThinkingInjection(routedPayload, thinkingPayload, resolvedModel)

  // Short-circuit: if we've already learned this model is Responses-only
  // (e.g. gpt-5.5), skip the failing /chat/completions attempt. Use the
  // thinking-injected payload so Responses-only models still get max effort.
  if (
    responsesApiOnlyModels.has(resolvedModel)
    || isLikelyResponsesOnly(resolvedModel)
  ) {
    consola.debug(
      `Model "${resolvedModel}" is Responses-only — using /v1/responses`,
    )
    responsesApiOnlyModels.add(resolvedModel)
    return createResponsesAsChat(thinkingPayload)
  }

  // Acquire concurrency slot
  const releaseSlot = await modelRouter.acquireSlot(resolvedModel)

  try {
    const result = await dispatchRequest(thinkingPayload)

    // For streaming responses, wrap the generator so the slot is released
    // when the stream ends (not when this function returns).
    if (Symbol.asyncIterator in result) {
      const accountInfo = (
        result as AsyncGenerator & {
          __accountInfo?: StreamAccountInfo
        }
      ).__accountInfo
      const wrapped = wrapGeneratorWithRelease(result, releaseSlot, accountInfo)
      // Propagate accountInfo so handler.ts can determine proxy status
      ;(
        wrapped as AsyncGenerator & {
          __accountInfo?: StreamAccountInfo
        }
      ).__accountInfo = accountInfo
      return wrapped
    }

    // Non-streaming: release immediately
    releaseSlot()
    return result
  } catch (error) {
    // Responses-API-only models: cache + retry via /v1/responses.
    const responsesRetry = handle400UnsupportedApiError(
      error,
      { resolvedModel, routedPayload },
      releaseSlot,
    )
    if (responsesRetry !== undefined) return responsesRetry

    const maxTokensRetry = handle400MaxTokensError(
      error,
      { resolvedModel, routedPayload: thinkingPayload },
      releaseSlot,
    )
    if (maxTokensRetry !== undefined) return maxTokensRetry

    const retryResult = handle400ReasoningError(
      error,
      { resolvedModel, thinkingPayload, routedPayload, wasInjected },
      releaseSlot,
    )
    if (retryResult !== undefined) return retryResult

    releaseSlot()
    throw error
  }
}

/**
 * Handle Copilot's `unsupported_api_for_model` 400 — the model only
 * accepts /v1/responses, not /chat/completions (e.g. gpt-5.5). Mark the
 * model so future requests skip the failing attempt, then retry via the
 * Responses API translator.
 */
function handle400UnsupportedApiError(
  error: unknown,
  ctx: { resolvedModel: string; routedPayload: ChatCompletionsPayload },
  releaseSlot: () => void,
): Promise<AsyncGenerator | ChatCompletionResponse> | undefined {
  if (!(error instanceof HTTPError) || error.response.status !== 400)
    return undefined
  const errMsg = error.message
  if (
    !errMsg.includes("unsupported_api_for_model")
    && !errMsg.includes("not accessible via the /chat/completions endpoint")
  )
    return undefined

  responsesApiOnlyModels.add(ctx.resolvedModel)
  consola.debug(
    `Model "${ctx.resolvedModel}" requires /v1/responses — switching for future requests`,
  )

  return (async () => {
    try {
      const result = await createResponsesAsChat(ctx.routedPayload)
      if (Symbol.asyncIterator in result) {
        const accountInfo = (
          result as AsyncGenerator & { __accountInfo?: StreamAccountInfo }
        ).__accountInfo
        const wrapped = wrapGeneratorWithRelease(
          result as AsyncGenerator,
          releaseSlot,
          accountInfo,
        )
        ;(
          wrapped as AsyncGenerator & { __accountInfo?: StreamAccountInfo }
        ).__accountInfo = accountInfo
        return wrapped
      }
      releaseSlot()
      return result
    } catch (retryError) {
      releaseSlot()
      throw retryError
    }
  })()
}

/**
 * Handle 400 errors caused by `max_tokens` being rejected — o-series and
 * GPT-5.x require `max_completion_tokens` instead.  Learns at runtime:
 * adds the model to `maxCompletionTokensModels` and retries once with the
 * field renamed so all future requests skip the 400 entirely.
 */
function handle400MaxTokensError(
  error: unknown,
  ctx: {
    resolvedModel: string
    routedPayload: ChatCompletionsPayload
  },
  releaseSlot: () => void,
): Promise<AsyncGenerator | ChatCompletionResponse> | undefined {
  if (!(error instanceof HTTPError) || error.response.status !== 400)
    return undefined
  // Copilot error message contains both field names when rejecting max_tokens
  const errMsg = error.message
  if (
    !errMsg.includes("max_tokens")
    || !errMsg.includes("max_completion_tokens")
  )
    return undefined

  maxCompletionTokensModels.add(ctx.resolvedModel)
  consola.debug(
    `Model "${ctx.resolvedModel}" requires max_completion_tokens — switching for future requests`,
  )

  if (
    ctx.routedPayload.max_tokens === null
    || ctx.routedPayload.max_tokens === undefined
  )
    return retryWithModifiedPayload(ctx.routedPayload, releaseSlot)

  const { max_tokens, ...rest } = ctx.routedPayload
  return retryWithModifiedPayload(
    { ...rest, max_completion_tokens: max_tokens } as ChatCompletionsPayload,
    releaseSlot,
  )
}

/**
 * Handle 400 reasoning_effort errors in the outer createChatCompletions catch.
 * Returns a Promise (retry result) if handled, or undefined to re-throw.
 */
function handle400ReasoningError(
  error: unknown,
  ctx: {
    resolvedModel: string
    thinkingPayload: ChatCompletionsPayload
    routedPayload: ChatCompletionsPayload
    wasInjected: boolean
  },
  releaseSlot: () => void,
): Promise<AsyncGenerator | ChatCompletionResponse> | undefined {
  if (!(error instanceof HTTPError) || error.response.status !== 400)
    return undefined
  const errMsg = error.message

  // Case 2: Model rejects the specific value (e.g. "high" not supported, only "medium")
  if (
    errMsg.includes("supported values")
    || (errMsg.includes("is not supported by model")
      && errMsg.includes("reasoning_effort"))
  ) {
    const currentEffort = ctx.thinkingPayload.reasoning_effort
    if (
      currentEffort
      && currentEffort !== "medium"
      && currentEffort !== "low"
    ) {
      reasoningEffortCap.set(ctx.resolvedModel, "medium")
      consola.debug(
        `Model "${ctx.resolvedModel}" rejected reasoning_effort="${currentEffort}" — downgrading to "medium"`,
      )
      return retryWithModifiedPayload(
        { ...ctx.routedPayload, reasoning_effort: "medium" as const },
        releaseSlot,
      )
    }
  }

  // Case 1: Model doesn't support reasoning_effort at all
  if (
    ctx.wasInjected
    && (errMsg.includes("Unrecognized request argument")
      || errMsg.includes("does not support reasoning")
      || errMsg.includes("invalid_reasoning_effort"))
  ) {
    reasoningUnsupportedModels.add(ctx.resolvedModel)
    consola.debug(
      `Model "${ctx.resolvedModel}" does not support reasoning_effort — disabled for future requests`,
    )
    return retryWithModifiedPayload(ctx.routedPayload, releaseSlot)
  }

  // Case 3: Model rejects reasoning_effort when tools are present
  // e.g. gpt-5.4: "Function tools with reasoning_effort are not supported"
  if (
    errMsg.includes("Function tools")
    && errMsg.includes("reasoning_effort")
  ) {
    reasoningWithToolsUnsupported.add(ctx.resolvedModel)
    consola.debug(
      `Model "${ctx.resolvedModel}" does not support tools + reasoning_effort — stripped for future requests`,
    )
    const stripped = { ...ctx.routedPayload }
    delete stripped.reasoning_effort
    delete stripped.thinking_budget
    return retryWithModifiedPayload(stripped, releaseSlot)
  }

  return undefined
}

/**
 * Retry a request after modifying the payload (e.g. stripping or
 * downgrading reasoning_effort).
 * Handles slot release for both streaming and non-streaming responses.
 */
async function retryWithModifiedPayload(
  payload: ChatCompletionsPayload,
  releaseSlot: () => void,
) {
  try {
    const result = await dispatchRequest(payload)
    if (Symbol.asyncIterator in result) {
      const accountInfo = (
        result as AsyncGenerator & {
          __accountInfo?: StreamAccountInfo
        }
      ).__accountInfo
      const wrapped = wrapGeneratorWithRelease(result, releaseSlot, accountInfo)
      // Propagate accountInfo so handler.ts can determine proxy status
      ;(
        wrapped as AsyncGenerator & {
          __accountInfo?: StreamAccountInfo
        }
      ).__accountInfo = accountInfo
      return wrapped
    }
    releaseSlot()
    return result
  } catch (retryError) {
    releaseSlot()
    throw retryError
  }
}

/**
 * Dispatch request to either single-account or multi-account path.
 */
function dispatchRequest(payload: ChatCompletionsPayload) {
  return state.multiAccountEnabled && accountManager.hasAccounts() ?
      createWithMultiAccount(payload)
    : createWithSingleAccount(payload)
}

// ---------------------------------------------------------------------------
// Single-account path (original behaviour, unchanged)
// ---------------------------------------------------------------------------

async function createWithSingleAccount(payload: ChatCompletionsPayload) {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const enableVision = payload.messages.some(
    (msg) =>
      typeof msg.content !== "string"
      && msg.content?.some((part) => part.type === "image_url"),
  )

  // Agent/user check for X-Initiator header
  // Determine if any message is from an agent ("assistant" or "tool")
  const isAgentCall = payload.messages.some((msg) =>
    ["assistant", "tool"].includes(msg.role),
  )

  // Build headers fresh each call (token may be refreshed between attempts)
  const buildHeaders = (): Record<string, string> => ({
    ...copilotHeaders(state, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
  })

  consola.debug("Sending request to Copilot:", {
    model: payload.model,
    endpoint: `${copilotBaseUrl(state)}/chat/completions`,
  })

  const url = `${copilotBaseUrl(state)}/chat/completions`

  // Request usage stats in the final stream chunk
  const body =
    payload.stream ?
      {
        ...normalizeMaxTokens(payload),
        stream_options: { include_usage: true },
      }
    : normalizeMaxTokens(payload)

  const bodyString = JSON.stringify(body)

  // Fetch with timeout + exponential back-off retries
  let response = await fetchWithRetry(url, () => ({
    method: "POST",
    headers: buildHeaders(),
    body: bodyString,
  }))

  // On 401 (token expired), refresh the Copilot token and retry once
  if (response.status === 401) {
    consola.warn("Copilot token expired, refreshing and retrying...")
    try {
      await refreshCopilotToken()
      response = await fetchWithTimeout(url, {
        method: "POST",
        headers: buildHeaders(),
        body: bodyString,
      })
    } catch (refreshError) {
      consola.warn(`Failed to refresh token: ${rootCause(refreshError)}`)
      consola.debug("Failed to refresh token:", refreshError)
      // Fall through to the error handling below
    }
  }

  if (!response.ok) {
    const errorBody = await response.text()

    if (response.status === 400) {
      // reasoning_effort / thinking 相关的 400 是预期内的(会被自动降级重试),
      // 静默到 debug 避免误导用户。其他 400 保留 warn。
      const isExpectedReasoningError =
        errorBody.includes("reasoning_effort")
        || errorBody.includes("invalid_reasoning_effort")
        || errorBody.includes("does not support reasoning")
      const isModelNotSupported = errorBody.includes("model_not_supported")
      const isUnsupportedApiForModel =
        errorBody.includes("unsupported_api_for_model")
        || errorBody.includes(
          "not accessible via the /chat/completions endpoint",
        )
      const isMaxTokensError =
        errorBody.includes("max_tokens")
        && errorBody.includes("max_completion_tokens")
      if (
        isExpectedReasoningError
        || isModelNotSupported
        || isUnsupportedApiForModel
        || isMaxTokensError
      ) {
        consola.debug(`400 (auto-handled): ${errorBody}`)
      } else {
        consola.warn(`400: ${errorBody}`)
      }
    } else {
      consola.error("Failed to create chat completions", {
        status: response.status,
        statusText: response.statusText,
        body: errorBody,
      })
    }

    throw new HTTPError(
      `Failed to create chat completions: ${response.status} ${errorBody}`,
      response,
    )
  }

  if (payload.stream) {
    const gen = events(response) as AsyncGenerator & {
      __accountInfo?: StreamAccountInfo
    }
    gen.__accountInfo = { apiBaseUrl: copilotBaseUrl(state) }
    return gen
  }

  return (await response.json()) as ChatCompletionResponse
}

// ---------------------------------------------------------------------------
// Multi-account path (failover across accounts)
// ---------------------------------------------------------------------------
//
// Generic rotation/breaker/jitter logic lives in `~/lib/account-rotation.ts`.
// This module only owns the Chat-Completions–specific bits:
//   - the transport (doFetch)
//   - the 400 retry hooks (downgrade reasoning_effort, strip when tools)
//
// ---------------------------------------------------------------------------

/** Try to retry a 400 with downgraded reasoning_effort on the same account. */
async function tryDowngradeReasoningEffort(
  errMsg: string,
  ctx: {
    payload: ChatCompletionsPayload
    tokenSource: TokenSource
    accountId: string
  },
): Promise<AsyncGenerator | ChatCompletionResponse | null> {
  const isEffortRejection =
    errMsg.includes("supported values")
    || (errMsg.includes("is not supported by model")
      && errMsg.includes("reasoning_effort"))
  if (!isEffortRejection) return null

  const currentEffort = ctx.payload.reasoning_effort
  if (!currentEffort || currentEffort === "medium" || currentEffort === "low")
    return null

  reasoningEffortCap.set(ctx.payload.model, "medium")
  const downgraded = {
    ...ctx.payload,
    reasoning_effort: "medium" as const,
  }
  try {
    return await doFetch(downgraded, ctx.tokenSource, ctx.accountId)
  } catch {
    return null
  }
}

/** Strip reasoning params and retry when tools + reasoning_effort conflict. */
async function tryStripReasoningForTools(
  errMsg: string,
  ctx: {
    payload: ChatCompletionsPayload
    tokenSource: TokenSource
    accountId: string
  },
): Promise<AsyncGenerator | ChatCompletionResponse | null> {
  if (
    !errMsg.includes("Function tools")
    || !errMsg.includes("reasoning_effort")
  )
    return null

  reasoningWithToolsUnsupported.add(ctx.payload.model)
  consola.debug(
    `Model "${ctx.payload.model}" does not support tools + reasoning_effort — stripped for future requests`,
  )
  const stripped = { ...ctx.payload }
  delete stripped.reasoning_effort
  delete stripped.thinking_budget
  try {
    return await doFetch(stripped, ctx.tokenSource, ctx.accountId)
  } catch {
    return null
  }
}

async function createWithMultiAccount(payload: ChatCompletionsPayload) {
  return runWithAccountRotation<
    ChatCompletionsPayload,
    AsyncGenerator | ChatCompletionResponse
  >({
    label: "chat",
    payload,
    transport: (p, tokenSource, accountId) =>
      doFetch(p, tokenSource, accountId),
    on400: async (error, ctx, account) => {
      const downgraded = await tryDowngradeReasoningEffort(error.message, {
        payload: ctx.payload,
        tokenSource: ctx.tokenSource,
        accountId: account.id,
      })
      if (downgraded !== null) return downgraded
      return tryStripReasoningForTools(error.message, {
        payload: ctx.payload,
        tokenSource: ctx.tokenSource,
        accountId: account.id,
      })
    },
  })
}

// ---------------------------------------------------------------------------
// Shared fetch helper (used by multi-account path)
// ---------------------------------------------------------------------------

/**
 * Execute the actual HTTP request to the Copilot chat/completions endpoint.
 *
 * This is intentionally a thin wrapper so that `createWithMultiAccount` can
 * call it with different `TokenSource` objects while keeping all the header
 * construction / retry / error‐surfacing logic in one place.
 */
async function doFetch(
  payload: ChatCompletionsPayload,
  source: TokenSource,
  accountId?: string,
): Promise<AsyncGenerator | ChatCompletionResponse> {
  const enableVision = payload.messages.some(
    (msg) =>
      typeof msg.content !== "string"
      && msg.content?.some((part) => part.type === "image_url"),
  )

  const isAgentCall = payload.messages.some((msg) =>
    ["assistant", "tool"].includes(msg.role),
  )

  const buildHeaders = (): Record<string, string> => ({
    ...copilotHeaders(source, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
  })

  const url = `${copilotBaseUrl(source)}/chat/completions`

  consola.debug("Sending request to Copilot (multi-account):", {
    model: payload.model,
    endpoint: url,
  })

  const body =
    payload.stream ?
      {
        ...normalizeMaxTokens(payload),
        stream_options: { include_usage: true },
      }
    : normalizeMaxTokens(payload)

  const bodyString = JSON.stringify(body)

  // Fetch with timeout + exponential back-off retries
  const response = await fetchWithRetry(
    url,
    () => ({
      method: "POST",
      headers: buildHeaders(),
      body: bodyString,
    }),
    { accountId, accountProxy: source.proxy },
  )

  if (!response.ok) {
    const errorBody = await response.text()

    if (response.status === 400) {
      // reasoning_effort / thinking 相关的 400 是预期内的(会被自动降级重试),
      // 静默到 debug 避免误导用户。其他 400 保留 warn。
      const isExpectedReasoningError =
        errorBody.includes("reasoning_effort")
        || errorBody.includes("invalid_reasoning_effort")
        || errorBody.includes("does not support reasoning")
      const isModelNotSupported = errorBody.includes("model_not_supported")
      const isUnsupportedApiForModel =
        errorBody.includes("unsupported_api_for_model")
        || errorBody.includes(
          "not accessible via the /chat/completions endpoint",
        )
      const isMaxTokensError =
        errorBody.includes("max_tokens")
        && errorBody.includes("max_completion_tokens")
      if (
        isExpectedReasoningError
        || isModelNotSupported
        || isUnsupportedApiForModel
        || isMaxTokensError
      ) {
        consola.debug(`400 (auto-handled): ${errorBody}`)
      } else {
        consola.warn(`400: ${errorBody}`)
      }
    } else {
      consola.error("Failed to create chat completions", {
        status: response.status,
        statusText: response.statusText,
        body: errorBody,
      })
    }

    throw new HTTPError(
      `Failed to create chat completions: ${response.status} ${errorBody}`,
      response,
    )
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ChatCompletionResponse
}

// ===========================================================================
// Types (unchanged)
// ===========================================================================

// Streaming types

export interface ChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<Choice>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
    completion_tokens_details?: {
      accepted_prediction_tokens: number
      rejected_prediction_tokens: number
    }
  }
}

interface Delta {
  content?: string | null
  reasoning_content?: string | null
  reasoning_text?: string | null
  role?: "user" | "assistant" | "system" | "tool"
  tool_calls?: Array<{
    index: number
    id?: string
    type?: "function"
    function?: {
      name?: string
      arguments?: string
    }
  }>
}

interface Choice {
  index: number
  delta: Delta
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  logprobs: object | null
}

// Non-streaming types

export interface ChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<ChoiceNonStreaming>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
  }
}

interface ResponseMessage {
  role: "assistant"
  content: string | null
  reasoning_content?: string | null
  reasoning_text?: string | null
  tool_calls?: Array<ToolCall>
}

interface ChoiceNonStreaming {
  index: number
  message: ResponseMessage
  logprobs: object | null
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter"
}

// Payload types

export interface ChatCompletionsPayload {
  messages: Array<Message>
  model: string
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  max_completion_tokens?: number | null // required by o-series and GPT-5.x instead of max_tokens
  stop?: string | Array<string> | null
  n?: number | null
  stream?: boolean | null

  frequency_penalty?: number | null
  presence_penalty?: number | null
  logit_bias?: Record<string, number> | null
  logprobs?: boolean | null
  response_format?: { type: "json_object" } | null
  seed?: number | null
  tools?: Array<Tool> | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | null
  user?: string | null

  // OpenAI reasoning_effort parameter — triggers Copilot thinking mode
  reasoning_effort?: "low" | "medium" | "high" | "xhigh" | "max" | null

  // Copilot thinking budget — number of tokens allocated for thinking
  thinking_budget?: number | null
}

export interface Tool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool" | "developer"
  content: string | Array<ContentPart> | null

  name?: string
  tool_calls?: Array<ToolCall>
  tool_call_id?: string
}

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ContentPart = TextPart | ImagePart

export interface TextPart {
  type: "text"
  text: string
}

export interface ImagePart {
  type: "image_url"
  image_url: {
    url: string
    detail?: "low" | "high" | "auto"
  }
}
