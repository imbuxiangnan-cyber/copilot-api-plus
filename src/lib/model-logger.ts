/**
 * Custom logger middleware that displays model name before timestamp
 */

import type { Context, MiddlewareHandler, Next } from "hono"

/**
 * Global token usage store for passing usage info from handlers to logger.
 * Handlers call setTokenUsage() when usage is available,
 * logger reads and clears it after await next().
 *
 * For streaming responses, usage arrives after next() returns.
 * In that case the handler calls signalStreamDone() when the stream ends,
 * and the logger waits for it with a timeout.
 */
let pendingTokenUsage: TokenUsage | undefined

// eslint-disable-next-line @typescript-eslint/no-invalid-void-type
let streamDoneResolve: ((value: void) => void) | undefined

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

export function setTokenUsage(usage: TokenUsage): void {
  pendingTokenUsage = usage
}

/**
 * Notify the logger that a streaming response has finished sending.
 * Must be called at the end of streamSSE callbacks.
 */
export function signalStreamDone(): void {
  streamDoneResolve?.()
}

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
 * Format token usage for log output
 */
export function formatTokenUsage(usage: TokenUsage): string {
  const parts = [`in:${usage.inputTokens}`, `out:${usage.outputTokens}`]
  if (usage.cacheReadTokens) {
    parts.push(`cache_read:${usage.cacheReadTokens}`)
  }
  if (usage.cacheCreationTokens) {
    parts.push(`cache_create:${usage.cacheCreationTokens}`)
  }
  return parts.join(" ")
}

/**
 * Extract model name from request body
 */
async function extractModel(c: Context): Promise<string | undefined> {
  try {
    // Clone the request to avoid consuming the body
    const clonedReq = c.req.raw.clone()
    const body = (await clonedReq.json()) as { model?: string }
    return body.model
  } catch {
    return undefined
  }
}

/**
 * Custom logger middleware that shows model name before timestamp
 *
 * Output format:
 * [model] HH:mm:ss <-- METHOD /path
 * [model] HH:mm:ss --> METHOD /path STATUS DURATION [in:N out:N]
 */
export function modelLogger(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const method = c.req.method
    const path = c.req.path
    const queryString =
      c.req.raw.url.includes("?") ? `?${c.req.raw.url.split("?")[1]}` : ""
    const fullPath = `${path}${queryString}`

    // Extract model for POST requests with JSON body
    let model: string | undefined
    if (method === "POST" && c.req.header("content-type")?.includes("json")) {
      model = await extractModel(c)
    }

    const modelPrefix = model ? `[${model}] ` : ""
    const startTime = getTime()

    // Clear any stale state before handling
    pendingTokenUsage = undefined
    const localStreamDone = new Promise<void>((resolve) => {
      streamDoneResolve = resolve
    })

    // Log incoming request
    console.log(`${modelPrefix}${startTime} <-- ${method} ${fullPath}`)

    const start = Date.now()
    await next()

    // For streaming responses, usage arrives after next() returns.
    // Wait for signalStreamDone() with a generous timeout.
    const isStreaming = c.res.headers
      .get("content-type")
      ?.includes("text/event-stream")
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (isStreaming && !pendingTokenUsage) {
      const timeout = new Promise<void>((resolve) =>
        setTimeout(resolve, 120_000),
      )
      await Promise.race([localStreamDone, timeout])
    }

    const duration = Date.now() - start
    const endTime = getTime()

    // Read and clear token usage
    const usage = pendingTokenUsage
    pendingTokenUsage = undefined
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const usageSuffix = usage ? ` [${formatTokenUsage(usage)}]` : ""

    // Log outgoing response
    console.log(
      `${modelPrefix}${endTime} --> ${method} ${fullPath} ${c.res.status} ${formatDuration(duration)}${usageSuffix}`,
    )
  }
}
