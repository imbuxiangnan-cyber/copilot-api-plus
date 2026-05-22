/**
 * Proxy-side WebSearch / WebFetch fallback.
 *
 * Invoked when Copilot's native /v1/messages rejects Anthropic server-side
 * web_search_* / web_fetch_* tools. Strategy:
 *
 *   1. Replace the web server tools in the payload with two private
 *      function tools (`__copilot_proxy_web_search`,
 *      `__copilot_proxy_web_fetch`) and translate the rest of the
 *      payload via the existing Anthropic→OpenAI path.
 *   2. Run a chat-completions tool loop, executing search/fetch calls
 *      ourselves and appending tool results until the model produces a
 *      final response (or we hit the iteration cap).
 *   3. Translate the final OpenAI response back into Anthropic shape via
 *      the existing translateToAnthropic helper.
 *   4. If the original request asked for streaming, synthesize a valid
 *      Anthropic SSE stream from the non-streamed result.
 *
 * This deliberately does not stream token-by-token — the search/fetch
 * loop happens server-side and the final answer is delivered as a
 * synthesized stream. Clients (Claude CLI etc.) see a normal
 * Anthropic-shaped response either way.
 */

import type { Context } from "hono"
import type { SSEStreamingApi } from "hono/streaming"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { overrideAnthropicResponseModel } from "~/lib/anthropic-sanitizer"
import {
  extractNonWebTools,
  isAnthropicWebFetchTool,
  isAnthropicWebSearchTool,
} from "~/lib/anthropic-web-tools"
import {
  createChatCompletions,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  type Message,
  type Tool,
  type ToolCall,
} from "~/services/copilot/create-chat-completions"
import { directFetch, getSearchBackend } from "~/services/web"

import type {
  AnthropicCustomTool,
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "./anthropic-types"

import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"

const PROXY_WEB_SEARCH = "__copilot_proxy_web_search"
const PROXY_WEB_FETCH = "__copilot_proxy_web_fetch"
const MAX_LOOP_ITERATIONS = 6
const MAX_SEARCH_RESULTS = 8

const SEARCH_TOOL: Tool = {
  type: "function",
  function: {
    name: PROXY_WEB_SEARCH,
    description:
      "Search the public web and return a list of {title, url, snippet} results. Use this whenever you would have called the Anthropic web_search tool.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query string.",
        },
        max_results: {
          type: "integer",
          description: "Maximum number of results to return (default 8).",
        },
      },
      required: ["query"],
    },
  },
}

const FETCH_TOOL: Tool = {
  type: "function",
  function: {
    name: PROXY_WEB_FETCH,
    description:
      "Fetch a single HTTP(S) URL and return its text content. Use this whenever you would have called the Anthropic web_fetch tool. Private/loopback hosts are blocked.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Absolute http(s) URL to fetch.",
        },
      },
      required: ["url"],
    },
  },
}

function buildFallbackTools(payload: AnthropicMessagesPayload): Array<Tool> {
  const tools: Array<Tool> = []
  // Custom tools survive — translate them normally.
  const customTools = extractNonWebTools(payload).filter(
    (t) => !("type" in t) || typeof (t as { type?: unknown }).type !== "string",
  ) as Array<AnthropicCustomTool>
  for (const tool of customTools) {
    tools.push({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    })
  }
  // Inject the proxy private tools matching what the original payload requested.
  const wantSearch = payload.tools?.some((t) => isAnthropicWebSearchTool(t))
  const wantFetch = payload.tools?.some((t) => isAnthropicWebFetchTool(t))
  if (wantSearch) tools.push(SEARCH_TOOL)
  if (wantFetch) tools.push(FETCH_TOOL)
  return tools
}

interface ParsedArgs {
  query?: string
  max_results?: number
  url?: string
}

function parseArgs(raw: string): ParsedArgs {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as ParsedArgs
    return parsed
  } catch {
    return {}
  }
}

async function executeToolCall(call: ToolCall): Promise<string> {
  const args = parseArgs(call.function.arguments)
  try {
    if (call.function.name === PROXY_WEB_SEARCH) {
      const query = (args.query ?? "").trim()
      if (!query) {
        return JSON.stringify({ error: "missing query" })
      }
      const backend = getSearchBackend()
      const results = await backend.search(query, {
        maxResults: Math.min(
          args.max_results ?? MAX_SEARCH_RESULTS,
          MAX_SEARCH_RESULTS,
        ),
      })
      return JSON.stringify({ backend: backend.id, query, results })
    }
    if (call.function.name === PROXY_WEB_FETCH) {
      const url = (args.url ?? "").trim()
      if (!url) {
        return JSON.stringify({ error: "missing url" })
      }
      const result = await directFetch(url)
      return JSON.stringify({
        url: result.url,
        status: result.status,
        content_type: result.contentType,
        truncated: result.truncated,
        text: result.text,
      })
    }
  } catch (error) {
    return JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return JSON.stringify({ error: `unknown tool: ${call.function.name}` })
}

function isProxyToolCall(call: ToolCall): boolean {
  return (
    call.function.name === PROXY_WEB_SEARCH
    || call.function.name === PROXY_WEB_FETCH
  )
}

/**
 * Run the chat-completions tool loop until the model returns a final
 * non-proxy-tool response or we hit the iteration cap.
 */
async function runFallbackLoop(
  initialPayload: ChatCompletionsPayload,
): Promise<ChatCompletionResponse> {
  let payload: ChatCompletionsPayload = { ...initialPayload, stream: false }
  let lastResponse: ChatCompletionResponse | undefined

  for (let i = 0; i < MAX_LOOP_ITERATIONS; i++) {
    const result = (await createChatCompletions(
      payload,
    )) as ChatCompletionResponse
    lastResponse = result
    const choice = result.choices[0]
    const toolCalls = choice.message.tool_calls
    const proxyCalls = toolCalls?.filter((c) => isProxyToolCall(c)) ?? []

    if (proxyCalls.length === 0) {
      // Either finished or invoked a non-proxy custom tool — return
      // immediately. Custom tool calls are forwarded to the client.
      return result
    }

    consola.debug(
      `[web-fallback] iteration ${i + 1}: executing ${proxyCalls.length} proxy tool call(s)`,
    )

    const assistantMessage: Message = {
      role: "assistant",
      content: choice.message.content ?? null,
      tool_calls: toolCalls,
    }

    const toolResults: Array<Message> = []
    for (const call of toolCalls ?? []) {
      if (!isProxyToolCall(call)) continue
      const content = await executeToolCall(call)
      toolResults.push({
        role: "tool",
        tool_call_id: call.id,
        content,
      })
    }

    payload = {
      ...payload,
      messages: [...payload.messages, assistantMessage, ...toolResults],
    }
  }

  if (!lastResponse) {
    throw new Error("Fallback loop produced no response")
  }
  consola.warn(
    `[web-fallback] hit max iterations (${MAX_LOOP_ITERATIONS}); returning last response`,
  )
  return lastResponse
}

// ---------------------------------------------------------------------------
// SSE synthesis from a non-streaming Anthropic response
// ---------------------------------------------------------------------------

async function writeSynthesizedStream(
  stream: SSEStreamingApi,
  response: AnthropicResponse,
): Promise<void> {
  const messageStart = {
    type: "message_start",
    message: {
      id: response.id,
      type: "message",
      role: "assistant",
      content: [],
      model: response.model,
      stop_reason: null,
      stop_sequence: null,
      usage: response.usage,
    },
  }
  await stream.writeSSE({
    event: "message_start",
    data: JSON.stringify(messageStart),
  })

  let index = 0
  for (const block of response.content) {
    if (block.type === "text") {
      await stream.writeSSE({
        event: "content_block_start",
        data: JSON.stringify({
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        }),
      })
      await stream.writeSSE({
        event: "content_block_delta",
        data: JSON.stringify({
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: block.text },
        }),
      })
      await stream.writeSSE({
        event: "content_block_stop",
        data: JSON.stringify({ type: "content_block_stop", index }),
      })
      index++
    } else if (block.type === "tool_use") {
      await stream.writeSSE({
        event: "content_block_start",
        data: JSON.stringify({
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: {},
          },
        }),
      })
      await stream.writeSSE({
        event: "content_block_delta",
        data: JSON.stringify({
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(block.input),
          },
        }),
      })
      await stream.writeSSE({
        event: "content_block_stop",
        data: JSON.stringify({ type: "content_block_stop", index }),
      })
      index++
    }
  }

  await stream.writeSSE({
    event: "message_delta",
    data: JSON.stringify({
      type: "message_delta",
      delta: {
        stop_reason: response.stop_reason,
        stop_sequence: response.stop_sequence,
      },
      usage: { output_tokens: response.usage.output_tokens },
    }),
  })
  await stream.writeSSE({
    event: "message_stop",
    data: JSON.stringify({ type: "message_stop" }),
  })
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Run the web fallback for a payload whose web server tools were rejected
 * by Copilot. Returns a Hono Response (JSON or SSE depending on stream flag).
 */
export async function handleWebToolFallback(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
): Promise<Response> {
  consola.warn(
    "[web-fallback] Copilot rejected WebSearch/WebFetch — running proxy-side fallback (DuckDuckGo HTML + direct fetch)",
  )

  const openAiPayload = translateToOpenAI({
    ...anthropicPayload,
    // Strip server tools — they'd be skipped by the translator anyway,
    // and we add our private replacements below.
    tools: extractNonWebTools(anthropicPayload),
    // Drop tool_choice that forces a server tool (e.g. type:"tool" name:"web_search")
    tool_choice:
      (
        anthropicPayload.tool_choice?.type === "tool"
        && (anthropicPayload.tool_choice.name === "web_search"
          || anthropicPayload.tool_choice.name === "web_fetch")
      ) ?
        { type: "auto" }
      : anthropicPayload.tool_choice,
    stream: false,
  })

  const fallbackTools = buildFallbackTools(anthropicPayload)
  const combinedTools = [...(openAiPayload.tools ?? []), ...fallbackTools]
  const loopPayload: ChatCompletionsPayload = {
    ...openAiPayload,
    tools: combinedTools.length > 0 ? combinedTools : null,
    stream: false,
  }

  let final: ChatCompletionResponse
  try {
    final = await runFallbackLoop(loopPayload)
  } catch (error) {
    consola.warn(
      `[web-fallback] loop failed: ${(error as Error).message || String(error)}`,
    )
    throw error
  }

  const anthropicResponse = overrideAnthropicResponseModel(
    translateToAnthropic(final),
    anthropicPayload.model,
  )

  if (!anthropicPayload.stream) {
    return c.json(anthropicResponse)
  }

  return streamSSE(c, async (sse) => {
    try {
      await writeSynthesizedStream(sse, anthropicResponse)
    } catch (error) {
      consola.warn(
        `[web-fallback] failed to write synthesized stream: ${(error as Error).message || String(error)}`,
      )
    }
  })
}
