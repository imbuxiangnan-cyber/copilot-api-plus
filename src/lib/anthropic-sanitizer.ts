/**
 * Surgical sanitization for native Copilot `/v1/messages` passthrough.
 *
 * Unlike the OpenAI-translation path which rewrites the entire payload,
 * the native passthrough strips ONLY the small set of fields that the
 * Copilot backend rejects. Everything else is forwarded as-is.
 *
 * Ported (with simplifications) from jer-y/copilot-proxy.
 */

import consola from "consola"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/routes/messages/anthropic-types"

import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { findModel } from "~/lib/utils"

/** Upstream message that triggers the assistant-thinking-strip retry. */
const INVALID_THINKING_SIGNATURE_PATTERN =
  /invalid [`'"]?signature[`'"]? in [`'"]?thinking[`'"]? block/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Strip fields the Copilot backend rejects.
 *
 * Mutates the payload in place.
 */
export function sanitizeForCopilotBackend(
  payload: AnthropicMessagesPayload,
): void {
  const extended = payload as AnthropicMessagesPayload & {
    context_management?: unknown
    output_config?: { format?: unknown }
  }

  // 1. context_management - unsupported on Copilot backend
  if ("context_management" in extended) {
    consola.debug(
      "Stripping context_management (unsupported by Copilot backend)",
    )
    delete extended.context_management
  }

  // 2. output_config.format flattening for json_schema clients
  sanitizeOutputConfigFormat(extended.output_config?.format)

  // 3. effort - Copilot backend rejects this Anthropic 2026 field with 400
  //    ("effort: Extra inputs are not permitted"). Strip if present;
  //    use thinking.budget_tokens to control thinking depth instead.
  if (payload.effort !== undefined) {
    consola.debug("Stripping effort field (unsupported by Copilot backend)")
    delete payload.effort
  }
}

function sanitizeOutputConfigFormat(format: unknown): void {
  if (!isRecord(format) || format.type !== "json_schema") return

  const nested = isRecord(format.json_schema) ? format.json_schema : undefined
  const hasFlat = isRecord(format.schema)
  const hasNested = isRecord(nested?.schema)

  if (!hasFlat && hasNested) {
    format.schema = nested.schema
  }

  if ("json_schema" in format) {
    consola.debug("Flattening output_config.format.json_schema → format.schema")
    delete format.json_schema
  }
  if ("name" in format) {
    consola.debug("Stripping output_config.format.name (Copilot reject)")
    delete format.name
  }
  if ("strict" in format) {
    consola.debug("Stripping output_config.format.strict (Copilot reject)")
    delete format.strict
  }
}

/**
 * Adaptive thinking has a slightly different shape than enabled thinking;
 * Copilot rejects `budget_tokens_max`. Mutates in place.
 */
export function normalizeAdaptiveThinkingForCopilot(
  payload: AnthropicMessagesPayload,
): void {
  const thinking = payload.thinking as unknown
  if (!isRecord(thinking) || thinking.type !== "adaptive") return

  if ("budget_tokens_max" in thinking) {
    consola.debug(
      "Stripping budget_tokens_max from adaptive thinking (Copilot reject)",
    )
    delete thinking.budget_tokens_max
  }
}

// ---------------------------------------------------------------------------
// Maximum thinking budget injection
// ---------------------------------------------------------------------------

/**
 * Pick the highest reasoning effort the model permits.
 *
 * Copilot's `/v1/messages` mirror caps `output_config.effort` to
 * the per-model `supports.reasoning_effort` whitelist. As of 2026-05:
 *   - Opus 4.7  → ["medium"]              → max we can ask is "medium"
 *   - Sonnet 4.6 → ["low","medium","high"] → "high"
 *
 * Anything outside the list returns 400 "not supported by model X;
 * supported values: [...]". `xhigh` and `max` exist in Anthropic's
 * direct API but Copilot does not surface them on any model today.
 */
const EFFORT_RANK: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
}

export function pickHighestSupportedEffort(
  allowed: ReadonlyArray<string> | undefined,
): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  if (!allowed || allowed.length === 0) return undefined
  let best: string | undefined
  let bestRank = -1
  for (const value of allowed) {
    const rank = EFFORT_RANK[value] ?? -1
    if (rank > bestRank) {
      bestRank = rank
      best = value
    }
  }
  return best as "low" | "medium" | "high" | "xhigh" | "max" | undefined
}

/**
 * If the client did not specify a `thinking` field, inject the maximum
 * thinking depth the model supports — pulled from Copilot's `/models`
 * capabilities. Mutates in place.
 *
 *   - Models with `adaptive_thinking: true` (Claude Opus 4.7,
 *     Sonnet 4.6, etc.) get `{ type: "adaptive" }` plus, when the
 *     model advertises `supports.reasoning_effort`, the highest
 *     value from that whitelist injected as `output_config.effort`.
 *     This is the only Copilot-accepted way to control adaptive
 *     thinking depth — `budget_tokens` on adaptive 400s, and the
 *     top-level `effort` field 400s.
 *   - Other thinking-capable models get
 *     `{ type: "enabled", budget_tokens: max_thinking_budget }`.
 *   - Models without thinking capability are left untouched.
 *
 * Skipped if the client already specified `thinking` (any value) — we
 * always defer to explicit client intent. Also skipped when the runtime
 * `state.maxThinking` kill switch is off.
 */
export function injectMaxThinkingBudget(
  payload: AnthropicMessagesPayload,
): void {
  if (!state.maxThinking) return
  if (payload.thinking !== undefined) return

  const modelInfo = findModel(payload.model)
  const supports = modelInfo?.capabilities.supports
  if (!supports) return

  if (supports.adaptive_thinking === true) {
    payload.thinking = { type: "adaptive" }
    const effort = pickHighestSupportedEffort(supports.reasoning_effort)
    if (effort !== undefined) {
      const outputConfig = (payload.output_config ?? {}) as {
        effort?: string
        format?: unknown
      }
      if (outputConfig.effort === undefined) {
        outputConfig.effort = effort
        payload.output_config =
          outputConfig as AnthropicMessagesPayload["output_config"]
      }
    }
    consola.debug(
      `Injected adaptive thinking + output_config.effort=${effort ?? "<none>"} for ${payload.model} (no client preference)`,
    )
    return
  }

  const maxBudget = supports.max_thinking_budget
  if (!maxBudget || maxBudget <= 0) return

  payload.thinking = { type: "enabled", budget_tokens: maxBudget }
  consola.debug(
    `Injected enabled thinking budget=${maxBudget} for ${payload.model} (no client preference)`,
  )
}

// ---------------------------------------------------------------------------
// Assistant thinking-block stripping (for signature-retry self-heal)
// ---------------------------------------------------------------------------

interface StripResult {
  payload: AnthropicMessagesPayload
  stripped: boolean
  strippedBlocks: number
  droppedAssistantMessages: number
}

/**
 * Remove all `thinking` and `redacted_thinking` blocks from assistant
 * messages, and drop any assistant turns left empty as a result.
 *
 * Pure — returns a new payload, never mutates the input.
 */
export function stripAssistantThinkingBlocks(
  payload: AnthropicMessagesPayload,
): StripResult {
  let strippedBlocks = 0
  let droppedAssistantMessages = 0

  const messages = payload.messages.flatMap((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      return [message]
    }

    const content = message.content.filter((block) => {
      const shouldStrip =
        block.type === "thinking" || block.type === "redacted_thinking"
      if (shouldStrip) strippedBlocks += 1
      return !shouldStrip
    })

    if (content.length === message.content.length) return [message]
    if (content.length === 0) {
      droppedAssistantMessages += 1
      return []
    }
    return [{ ...message, content }]
  })

  if (strippedBlocks === 0) {
    return {
      payload,
      stripped: false,
      strippedBlocks: 0,
      droppedAssistantMessages: 0,
    }
  }

  return {
    payload: { ...payload, messages },
    stripped: true,
    strippedBlocks,
    droppedAssistantMessages,
  }
}

/** Detect the upstream "invalid thinking signature" 400 to trigger retry. */
export async function isInvalidThinkingSignatureError(
  error: unknown,
): Promise<boolean> {
  if (!(error instanceof HTTPError) || error.response.status !== 400) {
    return false
  }

  // First try the error message itself — `throwUpstreamError` embeds the
  // upstream body string into the HTTPError message, and it is the only
  // reliable source because the response body has typically already been
  // consumed by the time we get here (`await response.text()`).
  if (INVALID_THINKING_SIGNATURE_PATTERN.test(error.message)) {
    return true
  }

  // Fallback: try the response body, in case a future code path throws
  // an HTTPError without inlining the body into the message.
  const message = await readUpstreamErrorMessage(error.response)
  return (
    typeof message === "string"
    && INVALID_THINKING_SIGNATURE_PATTERN.test(message)
  )
}

async function readUpstreamErrorMessage(
  response: Response,
): Promise<string | undefined> {
  let text: string
  try {
    text = await response.clone().text()
  } catch {
    return undefined
  }
  if (!text) return undefined
  try {
    return extractErrorMessage(JSON.parse(text)) ?? text
  } catch {
    return text
  }
}

function extractErrorMessage(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  if (typeof payload.message === "string") return payload.message
  const errorField = payload.error
  if (isRecord(errorField) && typeof errorField.message === "string") {
    return errorField.message
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Model override (display the user-requested model name in the response)
// ---------------------------------------------------------------------------

export function overrideAnthropicResponseModel(
  response: AnthropicResponse,
  requestedModel: string,
): AnthropicResponse {
  return { ...response, model: requestedModel }
}

/**
 * Override the `model` field in a `message_start` SSE event payload.
 * Returns the original JSON string if the event is not a message_start
 * or cannot be parsed.
 */
export function overrideMessageStartEventModel(
  rawData: string,
  requestedModel: string,
): string {
  try {
    const parsed = JSON.parse(rawData) as {
      type?: string
      message?: { model?: string }
    }
    if (parsed.type !== "message_start" || !parsed.message) return rawData
    parsed.message.model = requestedModel
    return JSON.stringify(parsed)
  } catch {
    return rawData
  }
}
