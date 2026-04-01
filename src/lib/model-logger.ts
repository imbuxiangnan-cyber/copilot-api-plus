/**
 * Custom logger middleware that displays model name + thinking status before timestamp
 */

import type { Context, MiddlewareHandler, Next } from "hono"

/**
 * Get timestamp string in format HH:mm:ss
 */
function getTime(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false })
}

/**
 * Format duration in human readable format
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * Extract model name and thinking status from request body.
 *
 * Thinking is considered active when:
 *  - The client explicitly passes reasoning_effort / thinking_budget / thinking
 *  - OR the backend will auto-inject thinking (default for all supported models)
 *
 * Since the proxy injects thinking for every model except those known to reject
 * it, we always mark thinking=true here. The `create-chat-completions` layer
 * will log the precise injection path separately.
 */
async function extractModelInfo(
  c: Context,
): Promise<{ model?: string; thinking?: boolean }> {
  try {
    // Clone the request to avoid consuming the body
    const clonedReq = c.req.raw.clone()
    const body = (await clonedReq.json()) as {
      model?: string
      // OpenAI-style thinking params
      reasoning_effort?: string
      thinking_budget?: number
      // Anthropic-style thinking params
      thinking?: { type?: string; budget_tokens?: number }
    }
    // Client-explicit thinking check
    const clientThinking =
      Boolean(body.reasoning_effort)
      || Boolean(body.thinking_budget)
      || body.thinking?.type === "enabled"

    // The proxy injects thinking by default, so mark true regardless
    // (the actual injection + fallback is logged in create-chat-completions)
    return { model: body.model, thinking: clientThinking || true }
  } catch {
    return {}
  }
}

/**
 * Custom logger middleware that shows model name + thinking before timestamp
 *
 * Output format:
 * [model thinking] HH:mm:ss <-- METHOD /path
 * [model thinking] HH:mm:ss --> METHOD /path STATUS DURATION
 */
export function modelLogger(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const method = c.req.method
    const path = c.req.path
    const queryString =
      c.req.raw.url.includes("?") ? `?${c.req.raw.url.split("?")[1]}` : ""
    const fullPath = `${path}${queryString}`

    // Extract model and thinking status for POST requests with JSON body
    let model: string | undefined
    let thinking = false
    if (method === "POST" && c.req.header("content-type")?.includes("json")) {
      const info = await extractModelInfo(c)
      model = info.model
      thinking = info.thinking ?? false
    }

    const thinkingTag = thinking ? " thinking" : ""
    const modelPrefix = model ? `[${model}${thinkingTag}] ` : ""
    const startTime = getTime()

    // Log incoming request
    console.log(`${modelPrefix}${startTime} <-- ${method} ${fullPath}`)

    const start = Date.now()
    await next()

    const duration = Date.now() - start
    const endTime = getTime()

    // Log outgoing response
    console.log(
      `${modelPrefix}${endTime} --> ${method} ${fullPath} ${c.res.status} ${formatDuration(duration)}`,
    )
  }
}
