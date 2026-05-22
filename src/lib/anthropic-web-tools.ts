/**
 * Detection helpers for Anthropic server-side WebSearch / WebFetch tools,
 * and a classifier for Copilot's "unsupported web tool" 400 response.
 *
 * The proxy never strips these tools from the request — native passthrough
 * is attempted first. Only when Copilot rejects them do we fall back to
 * the in-process proxy implementation (see proxy-web-fallback.ts).
 */

import type {
  AnthropicMessagesPayload,
  AnthropicTool,
} from "~/routes/messages/anthropic-types"

import { HTTPError } from "~/lib/error"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function toolType(tool: unknown): string | undefined {
  if (!isRecord(tool)) return undefined
  return typeof tool.type === "string" ? tool.type : undefined
}

function toolName(tool: unknown): string | undefined {
  if (!isRecord(tool)) return undefined
  return typeof tool.name === "string" ? tool.name : undefined
}

/** True when the tool is an Anthropic server-side web_search_* tool. */
export function isAnthropicWebSearchTool(tool: unknown): boolean {
  const t = toolType(tool)
  if (t && t.startsWith("web_search")) return true
  // Some Anthropic variants emit only `name: "web_search"`.
  const n = toolName(tool)
  return n === "web_search"
}

/** True when the tool is an Anthropic server-side web_fetch_* tool. */
export function isAnthropicWebFetchTool(tool: unknown): boolean {
  const t = toolType(tool)
  if (t && t.startsWith("web_fetch")) return true
  const n = toolName(tool)
  return n === "web_fetch"
}

/** True when payload carries any server-side web tool. */
export function hasProxyWebTools(payload: AnthropicMessagesPayload): boolean {
  const tools = payload.tools
  if (!tools || tools.length === 0) return false
  return tools.some(
    (t) => isAnthropicWebSearchTool(t) || isAnthropicWebFetchTool(t),
  )
}

/** Return only the web server tools from a payload (preserves order). */
export function extractWebTools(
  payload: AnthropicMessagesPayload,
): Array<AnthropicTool> {
  const tools = payload.tools
  if (!tools) return []
  return tools.filter(
    (t) => isAnthropicWebSearchTool(t) || isAnthropicWebFetchTool(t),
  )
}

/** Return non-web tools (custom + non-web server tools). */
export function extractNonWebTools(
  payload: AnthropicMessagesPayload,
): Array<AnthropicTool> {
  const tools = payload.tools
  if (!tools) return []
  return tools.filter(
    (t) => !isAnthropicWebSearchTool(t) && !isAnthropicWebFetchTool(t),
  )
}

const UNSUPPORTED_WEB_TOOL_PATTERNS: ReadonlyArray<RegExp> = [
  /use of the web[\s_-]*search tool is not supported/i,
  /use of the web[\s_-]*fetch tool is not supported/i,
  /web[\s_-]*search.*not supported/i,
  /web[\s_-]*fetch.*not supported/i,
  /tools?\.\d+\.type.*?web_(search|fetch)/i,
]

function messageLooksLikeUnsupportedWebTool(message: string): boolean {
  return UNSUPPORTED_WEB_TOOL_PATTERNS.some((re) => re.test(message))
}

/**
 * Decide whether a native /v1/messages error indicates Copilot rejected
 * WebSearch/WebFetch server-side tools. Only triggers when the original
 * payload actually requested such tools — avoids false positives on
 * generic 400s.
 */
export async function isUnsupportedWebToolError(
  payload: AnthropicMessagesPayload,
  error: unknown,
): Promise<boolean> {
  if (!hasProxyWebTools(payload)) return false
  if (!(error instanceof HTTPError)) return false
  if (error.response.status !== 400 && error.response.status !== 422) {
    return false
  }
  if (messageLooksLikeUnsupportedWebTool(error.message)) return true
  // Fallback: read body if message did not embed it.
  try {
    const body = await error.response.clone().text()
    if (body && messageLooksLikeUnsupportedWebTool(body)) return true
  } catch {
    // body already consumed; rely on message
  }
  return false
}
