/**
 * Decide whether an Anthropic /v1/messages request should go through the
 * native Copilot `/v1/messages` endpoint (passthrough) or be translated to
 * Copilot `/chat/completions` (existing translation layer).
 *
 * Decision is based on the model's `supported_endpoints` capability that
 * Copilot's `/models` endpoint advertises. We never translate the other way
 * (e.g. an OpenAI client cannot reach a model that only advertises
 * anthropic-messages) — that lives in chat-completions translation today.
 *
 * The result is cached per model id to avoid scanning the model list on
 * every request.
 */

import { state } from "~/lib/state"
import { findModel } from "~/lib/utils"

export type AnthropicRoute = "native-anthropic" | "translate-openai"

/**
 * Heuristic fallback when the model has no `supported_endpoints` field
 * (e.g. older Copilot deployments or a stripped models list). We only
 * use this when the wire-level capability is missing — never to override
 * an explicitly-advertised capability.
 *
 * Anthropic-published Claude models all natively support /v1/messages on
 * the Copilot backend at the time of writing. Non-Claude models do not.
 */
function looksLikeClaudeModel(model: string): boolean {
  return /^claude-/i.test(model)
}

/** Per-process cache of the routing decision keyed by model id. */
const routeCache = new Map<string, AnthropicRoute>()

/** Wipe the cache (call after `/models` is refreshed). */
export function clearRouteCache(): void {
  routeCache.clear()
}

/**
 * Resolve the upstream route for an Anthropic /v1/messages payload.
 *
 * Order of precedence:
 *   1. User force-disabled native passthrough — always translate.
 *   2. Model advertises `anthropic-messages` in supported_endpoints → native.
 *   3. Model advertises supported_endpoints WITHOUT anthropic-messages → translate.
 *   4. Capability missing → fall back to name heuristic (claude-* → native).
 */
export function resolveAnthropicRoute(model: string): AnthropicRoute {
  if (state.disableAnthropicPassthrough) return "translate-openai"

  const cached = routeCache.get(model)
  if (cached) return cached

  const decision = decideRoute(model)
  routeCache.set(model, decision)
  return decision
}

function decideRoute(model: string): AnthropicRoute {
  const modelInfo = findModel(model)

  const endpoints = modelInfo?.supported_endpoints
  if (Array.isArray(endpoints) && endpoints.length > 0) {
    return endpoints.includes("anthropic-messages") ? "native-anthropic" : (
        "translate-openai"
      )
  }

  // Capability missing — fall back to model-name heuristic.
  return looksLikeClaudeModel(model) ? "native-anthropic" : "translate-openai"
}
