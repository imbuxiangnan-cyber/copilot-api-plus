/**
 * Antigravity Background Detection
 *
 * Detects agent/background requests and optionally downgrades
 * expensive models to cheaper alternatives to preserve quota.
 *
 * Detection uses multi-signal scoring — not a single heuristic:
 *  1. Explicit header: X-Request-Type: background (definitive)
 *  2. tool_calls / tool role pattern (strong agent signal)
 *  3. High density of assistant messages (weak signal alone)
 *
 * Controlled by env var: ANTIGRAVITY_BACKGROUND_DOWNGRADE=1
 */

import consola from "consola"

const BACKGROUND_DOWNGRADE_ENABLED =
  process.env.ANTIGRAVITY_BACKGROUND_DOWNGRADE === "1"

/**
 * Score threshold for downgrade (0–1).
 * 0.6 means we need at least one strong signal.
 */
const AGENT_SCORE_THRESHOLD = 0.6

/**
 * Model downgrade mapping: expensive → cheaper
 */
const DOWNGRADE_MAP: Record<string, string> = {
  "claude-sonnet-4-5": "gemini-2.5-flash",
  "claude-sonnet-4-5-thinking": "gemini-2.5-flash-thinking",
  "claude-opus-4-5-thinking": "claude-sonnet-4-5-thinking",
  "gemini-2.5-pro": "gemini-2.5-flash",
  "gemini-3-pro-high": "gemini-3-flash",
  "gemini-3-pro-low": "gemini-3-flash",
}

interface DetectionMessage {
  role: string
  tool_calls?: unknown
  tool_call_id?: string
}

interface DetectionResult {
  isAgent: boolean
  score: number
  signals: Array<string>
}

/**
 * Multi-signal agent detection.
 *
 * Scores the request on a 0–1 scale:
 *  - Explicit header "X-Request-Type: background"  → 1.0 (instant)
 *  - Any message with tool_calls field             → +0.5
 *  - Any message with role "tool"                  → +0.4
 *  - assistant messages ≥ 60% of all messages      → +0.2
 *  - More than 6 total messages                    → +0.1
 *
 * Score ≥ 0.6 → treated as agent/background request.
 */
export function detectAgent(
  messages: Array<DetectionMessage>,
  headers?: { get(name: string): string | null | undefined },
): DetectionResult {
  const signals: Array<string> = []

  // Signal 0: Explicit header (definitive, caller knows best)
  const requestType = headers?.get("x-request-type")
  if (requestType === "background" || requestType === "agent") {
    return { isAgent: true, score: 1.0, signals: ["explicit-header"] }
  }

  let score = 0
  const total = messages.length

  if (total === 0) {
    return { isAgent: false, score: 0, signals: [] }
  }

  // Signal 1: tool_calls present (strong — this is an agentic loop)
  const hasToolCalls = messages.some(
    (m) => m.tool_calls !== undefined && m.tool_calls !== null,
  )
  if (hasToolCalls) {
    score += 0.5
    signals.push("tool_calls")
  }

  // Signal 2: tool role messages (strong — tool result returns)
  const hasToolRole = messages.some((m) => m.role === "tool")
  if (hasToolRole) {
    score += 0.4
    signals.push("tool-role")
  }

  // Signal 3: high assistant density (weak — normal multi-turn also has this)
  const assistantCount = messages.filter((m) => m.role === "assistant").length
  if (total >= 3 && assistantCount / total >= 0.6) {
    score += 0.2
    signals.push("high-assistant-density")
  }

  // Signal 4: long conversation (very weak, only a supplementary hint)
  if (total > 6) {
    score += 0.1
    signals.push("long-conversation")
  }

  return {
    isAgent: score >= AGENT_SCORE_THRESHOLD,
    score: Math.min(score, 1),
    signals,
  }
}

/**
 * Optionally downgrade a model for background/agent requests.
 *
 * Returns the original model if:
 * - ANTIGRAVITY_BACKGROUND_DOWNGRADE is not "1"
 * - The request is not detected as agent/background
 * - No downgrade mapping exists for the model
 */
export function maybeDowngradeModel(
  model: string,
  messages: Array<DetectionMessage>,
  headers?: { get(name: string): string | null | undefined },
): string {
  if (!BACKGROUND_DOWNGRADE_ENABLED) return model

  const result = detectAgent(messages, headers)
  if (!result.isAgent) return model

  const downgraded = DOWNGRADE_MAP[model]
  if (!downgraded) return model

  consola.info(
    `[background-detection] agent detected (score=${result.score.toFixed(2)}, signals=[${result.signals.join(",")}]), downgrading ${model} → ${downgraded}`,
  )
  return downgraded
}
