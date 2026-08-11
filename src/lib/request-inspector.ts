import type { Context, MiddlewareHandler, Next } from "hono"

import { AsyncLocalStorage } from "node:async_hooks"

const MAX_REQUESTS = 100
const BODY_PREVIEW_LIMIT = 8 * 1024
const REDACTED = "[redacted]"

const INSPECTED_PATHS = new Set([
  "/chat/completions",
  "/v1/chat/completions",
  "/v1/messages",
  "/v1/messages/count_tokens",
  "/responses",
  "/v1/responses",
  "/embeddings",
  "/v1/embeddings",
])

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "x-api-key",
  "cookie",
  "set-cookie",
])

export type RequestTraceAction = {
  action: string
  detail?: string
}

export type InspectedRequest = {
  id: string
  timestamp: string
  method: string
  path: string
  query: string
  status: number
  durationMs: number
  model?: string
  stream?: boolean
  contentType?: string
  requestBytes: number
  bodyPreview: string
  headers: Record<string, string>
  trace: Array<RequestTraceAction>
}

type RequestBodySummary = {
  model?: string
  stream?: boolean
  bodyPreview: string
  requestBytes: number
}

type TraceContext = {
  actions: Array<RequestTraceAction>
}

const traceStorage = new AsyncLocalStorage<TraceContext>()
const requests: Array<InspectedRequest> = []
let nextRequestId = 1

function isInspectedPath(path: string): boolean {
  if (path === "/api/requests" || path.startsWith("/api/requests/")) {
    return false
  }
  return INSPECTED_PATHS.has(path)
}

function shouldRedactHeader(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    SENSITIVE_HEADER_NAMES.has(lower)
    || lower.includes("token")
    || lower.includes("key")
    || lower.includes("secret")
  )
}

function redactHeaders(headers: Headers): Record<string, string> {
  const redacted: Record<string, string> = {}
  for (const [name, value] of headers.entries()) {
    redacted[name] = shouldRedactHeader(name) ? REDACTED : value
  }
  return redacted
}

function getQuery(url: string): string {
  try {
    return new URL(url).search
  } catch {
    const queryStart = url.indexOf("?")
    return queryStart === -1 ? "" : url.slice(queryStart)
  }
}

function parseBodyMetadata(
  bodyPreview: string,
): Pick<RequestBodySummary, "model" | "stream"> {
  if (!bodyPreview) return {}
  try {
    const body = JSON.parse(bodyPreview) as Record<string, unknown>
    return {
      model: typeof body.model === "string" ? body.model : undefined,
      stream: typeof body.stream === "boolean" ? body.stream : undefined,
    }
  } catch {
    return {}
  }
}

async function readRequestBody(c: Context): Promise<RequestBodySummary> {
  try {
    const text = await c.req.raw.clone().text()
    const metadata = parseBodyMetadata(text)
    return {
      ...metadata,
      bodyPreview: text.slice(0, BODY_PREVIEW_LIMIT),
      requestBytes: new TextEncoder().encode(text).byteLength,
    }
  } catch {
    return { bodyPreview: "", requestBytes: 0 }
  }
}

function addRequest(record: InspectedRequest): void {
  requests.push(record)
  if (requests.length > MAX_REQUESTS) {
    requests.splice(0, requests.length - MAX_REQUESTS)
  }
}

export function getRecentRequests(): Array<InspectedRequest> {
  return [...requests].reverse()
}

export function clearRequests(): void {
  requests.length = 0
}

export function addRequestTrace(action: string, detail?: string): void {
  const context = traceStorage.getStore()
  if (!context) return
  context.actions.push(detail === undefined ? { action } : { action, detail })
}

export function requestInspector(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (!isInspectedPath(c.req.path)) {
      await next()
      return
    }

    const startedAt = performance.now()
    const timestamp = new Date().toISOString()
    const method = c.req.method
    const path = c.req.path
    const query = getQuery(c.req.raw.url)
    const contentType = c.req.header("content-type")
    const headers = redactHeaders(c.req.raw.headers)
    const body = await readRequestBody(c)

    const traceContext: TraceContext = { actions: [] }
    await traceStorage.run(traceContext, next)

    addRequest({
      id: String(nextRequestId++),
      timestamp,
      method,
      path,
      query,
      status: c.res.status,
      durationMs: Math.round(performance.now() - startedAt),
      model: body.model,
      stream: body.stream,
      contentType,
      requestBytes: body.requestBytes,
      bodyPreview: body.bodyPreview,
      headers,
      trace: traceContext.actions,
    })
  }
}
