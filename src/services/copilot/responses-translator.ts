/**
 * Translation layer between OpenAI Chat Completions API and OpenAI
 * Responses API (`/v1/responses`).
 *
 * Some Copilot-served models (gpt-5.5, ...) are *only* exposed through
 * the Responses API and return `unsupported_api_for_model` on
 * `/chat/completions`. This module lets us accept Chat Completions
 * requests from clients while talking Responses API upstream.
 */

import { randomUUID } from "node:crypto"

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ContentPart,
  Message,
  Tool,
  ToolCall,
} from "./create-chat-completions"

// ---------------------------------------------------------------------------
// Responses API request types (the subset we care about)
// ---------------------------------------------------------------------------

interface ResponsesInputTextContent {
  type: "input_text"
  text: string
}
interface ResponsesInputImageContent {
  type: "input_image"
  image_url: string
  detail?: "low" | "high" | "auto"
}
interface ResponsesOutputTextContent {
  type: "output_text"
  text: string
  annotations?: Array<unknown>
}
type ResponsesContent =
  | ResponsesInputTextContent
  | ResponsesInputImageContent
  | ResponsesOutputTextContent

interface ResponsesMessageItem {
  type: "message"
  role: "user" | "assistant" | "system" | "developer"
  content: Array<ResponsesContent>
}

interface ResponsesFunctionCallItem {
  type: "function_call"
  call_id: string
  name: string
  arguments: string
}

interface ResponsesFunctionCallOutputItem {
  type: "function_call_output"
  call_id: string
  output: string
}

type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem

interface ResponsesFunctionTool {
  type: "function"
  name: string
  description?: string
  parameters: Record<string, unknown>
  strict?: boolean
}

export interface ResponsesPayload {
  model: string
  input: Array<ResponsesInputItem>
  instructions?: string
  tools?: Array<ResponsesFunctionTool>
  tool_choice?:
    | "auto"
    | "none"
    | "required"
    | { type: "function"; name: string }
  reasoning?: { effort: "minimal" | "low" | "medium" | "high" | "xhigh" }
  max_output_tokens?: number
  temperature?: number
  top_p?: number
  parallel_tool_calls?: boolean
  stream?: boolean
  store?: boolean
  // Copilot may surface usage in the completed event by default; explicit opt-in here is harmless.
}

// ---------------------------------------------------------------------------
// Responses API response types (subset)
// ---------------------------------------------------------------------------

interface ResponsesUsage {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
  output_tokens_details?: { reasoning_tokens?: number }
}

interface ResponsesMessageOutput {
  type: "message"
  id?: string
  role: "assistant"
  status?: string
  content: Array<{ type: "output_text"; text: string; annotations?: unknown }>
}

interface ResponsesFunctionCallOutput {
  type: "function_call"
  id?: string
  call_id: string
  name: string
  arguments: string
  status?: string
}

interface ResponsesReasoningOutput {
  type: "reasoning"
  id?: string
  summary?: Array<{ type: "summary_text"; text: string }>
}

type ResponsesOutputItem =
  | ResponsesMessageOutput
  | ResponsesFunctionCallOutput
  | ResponsesReasoningOutput

export interface ResponsesResponse {
  id: string
  object: "response"
  created_at?: number
  status?: string
  model: string
  output: Array<ResponsesOutputItem>
  usage?: ResponsesUsage
  error?: { code?: string; message?: string } | null
}

// ---------------------------------------------------------------------------
// Chat → Responses request translation
// ---------------------------------------------------------------------------

function partsToInputContent(
  parts: Array<ContentPart>,
  role: Message["role"],
): Array<ResponsesContent> {
  return parts.map((part) => {
    if (part.type === "text") {
      // Assistant text echoed in history must be output_text; everything else
      // (user / system / developer text) is input_text.
      return role === "assistant" ?
          { type: "output_text", text: part.text }
        : { type: "input_text", text: part.text }
    }
    return {
      type: "input_image",
      image_url: part.image_url.url,
      detail: part.image_url.detail,
    }
  })
}

function stringToInputContent(
  text: string,
  role: Message["role"],
): Array<ResponsesContent> {
  return role === "assistant" ?
      [{ type: "output_text", text }]
    : [{ type: "input_text", text }]
}

function messageContent(message: Message): Array<ResponsesContent> {
  if (message.content === null) return []
  if (typeof message.content === "string") {
    return stringToInputContent(message.content, message.role)
  }
  return partsToInputContent(message.content, message.role)
}

function translateAssistantWithToolCalls(
  message: Message,
): Array<ResponsesInputItem> {
  const items: Array<ResponsesInputItem> = []
  const content = messageContent(message)
  if (content.length > 0) {
    items.push({ type: "message", role: "assistant", content })
  }
  for (const call of message.tool_calls ?? []) {
    items.push({
      type: "function_call",
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    })
  }
  return items
}

function translateMessage(message: Message): Array<ResponsesInputItem> {
  if (message.role === "tool") {
    const text =
      typeof message.content === "string" ?
        message.content
      : messageContent(message)
          .map((c) =>
            c.type === "input_text" || c.type === "output_text" ? c.text : "",
          )
          .join("")
    return [
      {
        type: "function_call_output",
        call_id: message.tool_call_id ?? "",
        output: text,
      },
    ]
  }

  if (message.role === "assistant" && message.tool_calls?.length) {
    return translateAssistantWithToolCalls(message)
  }

  // All remaining roles (user / assistant / system / developer) map 1:1.
  return [
    {
      type: "message",
      role: message.role,
      content: messageContent(message),
    },
  ]
}

function translateTool(tool: Tool): ResponsesFunctionTool {
  return {
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }
}

function translateToolChoice(
  choice: ChatCompletionsPayload["tool_choice"],
): ResponsesPayload["tool_choice"] {
  if (!choice) return undefined
  if (typeof choice === "string") return choice
  return { type: "function", name: choice.function.name }
}

function translateReasoning(
  effort: ChatCompletionsPayload["reasoning_effort"],
): ResponsesPayload["reasoning"] {
  if (!effort) return undefined
  // "max" is a Copilot alias — Responses API expects literal levels.
  if (effort === "max") return { effort: "high" }
  return { effort }
}

export function chatToResponsesPayload(
  payload: ChatCompletionsPayload,
): ResponsesPayload {
  // Extract leading system messages into `instructions`. Mid-conversation
  // system messages stay inline as developer-role items.
  let instructions: string | undefined
  const remainingMessages: Array<Message> = []
  let sawNonSystem = false
  for (const msg of payload.messages) {
    if (msg.role === "system" && !sawNonSystem) {
      const text =
        typeof msg.content === "string" ?
          msg.content
        : messageContent(msg)
            .map((c) =>
              c.type === "input_text" || c.type === "output_text" ? c.text : "",
            )
            .join("\n")
      instructions = instructions ? `${instructions}\n\n${text}` : text
      continue
    }
    sawNonSystem = true
    remainingMessages.push(msg)
  }

  const input = remainingMessages.flatMap((m) => translateMessage(m))

  const rawMaxOutput =
    payload.max_completion_tokens ?? payload.max_tokens ?? undefined
  // Copilot `/v1/responses` rejects max_output_tokens < 16. Clamp small
  // values (e.g. token-counting pings that pass max_tokens=1) up to the
  // minimum so the upstream doesn't 400.
  const maxOutput =
    typeof rawMaxOutput === "number" && rawMaxOutput > 0 ?
      Math.max(rawMaxOutput, 16)
    : undefined

  return {
    model: payload.model,
    input,
    instructions,
    tools: payload.tools?.map((t) => translateTool(t)),
    tool_choice: translateToolChoice(payload.tool_choice),
    reasoning: translateReasoning(payload.reasoning_effort),
    max_output_tokens: maxOutput,
    temperature: payload.temperature ?? undefined,
    top_p: payload.top_p ?? undefined,
    parallel_tool_calls: undefined,
    stream: payload.stream ?? undefined,
  }
}

// ---------------------------------------------------------------------------
// Responses → Chat response translation (non-streaming)
// ---------------------------------------------------------------------------

function mapUsage(
  usage: ResponsesUsage | undefined,
): ChatCompletionResponse["usage"] {
  if (!usage) return undefined
  return {
    prompt_tokens: usage.input_tokens ?? 0,
    completion_tokens: usage.output_tokens ?? 0,
    total_tokens:
      usage.total_tokens
      ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    ...(usage.input_tokens_details?.cached_tokens !== undefined && {
      prompt_tokens_details: {
        cached_tokens: usage.input_tokens_details.cached_tokens,
      },
    }),
  }
}

function extractAssistantText(output: Array<ResponsesOutputItem>): string {
  let text = ""
  for (const item of output) {
    if (item.type !== "message") continue
    for (const part of item.content) {
      text += part.text
    }
  }
  return text
}

function extractToolCalls(output: Array<ResponsesOutputItem>): Array<ToolCall> {
  const calls: Array<ToolCall> = []
  for (const item of output) {
    if (item.type === "function_call") {
      calls.push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments },
      })
    }
  }
  return calls
}

export function responsesToChatResponse(
  resp: ResponsesResponse,
  requestedModel: string,
): ChatCompletionResponse {
  const text = extractAssistantText(resp.output)
  const toolCalls = extractToolCalls(resp.output)
  const finishReason: "stop" | "tool_calls" =
    toolCalls.length > 0 ? "tool_calls" : "stop"
  return {
    id: resp.id,
    object: "chat.completion",
    created: resp.created_at ?? Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || null,
          ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
        },
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
    usage: mapUsage(resp.usage),
  }
}

// ---------------------------------------------------------------------------
// Responses → Chat streaming translation
// ---------------------------------------------------------------------------

interface ResponsesStreamEvent {
  type: string
  // Event-specific fields — discriminated below at runtime.
  output_index?: number
  item?: ResponsesOutputItem
  item_id?: string
  delta?: string
  arguments?: string
  text?: string
  response?: ResponsesResponse
  code?: string
  message?: string
}

interface SSEMessage {
  data?: string
  event?: string
}

interface StreamState {
  responseId: string
  created: number
  requestedModel: string
  roleEmitted: boolean
  hasToolCalls: boolean
  toolIndexById: Map<string, number>
  nextToolIndex: number
}

function makeChunk(
  s: StreamState,
  choice: ChatCompletionChunk["choices"][number],
): SSEMessage {
  return {
    data: JSON.stringify({
      id: s.responseId,
      object: "chat.completion.chunk",
      created: s.created,
      model: s.requestedModel,
      choices: [choice],
    } satisfies ChatCompletionChunk),
  }
}

function ensureRoleChunk(s: StreamState): SSEMessage | null {
  if (s.roleEmitted) return null
  s.roleEmitted = true
  return makeChunk(s, {
    index: 0,
    delta: { role: "assistant", content: "" },
    finish_reason: null,
    logprobs: null,
  })
}

function getToolIndex(s: StreamState, key: string): number {
  let idx = s.toolIndexById.get(key)
  if (idx === undefined) {
    idx = s.nextToolIndex++
    s.toolIndexById.set(key, idx)
  }
  return idx
}

function* handleTextDelta(
  s: StreamState,
  delta: string,
): Generator<SSEMessage> {
  const roleChunk = ensureRoleChunk(s)
  if (roleChunk) yield roleChunk
  yield makeChunk(s, {
    index: 0,
    delta: { content: delta },
    finish_reason: null,
    logprobs: null,
  })
}

function* handleFunctionCallAdded(
  s: StreamState,
  item: ResponsesFunctionCallOutput,
): Generator<SSEMessage> {
  s.hasToolCalls = true
  const key = item.call_id || item.id || ""
  const idx = getToolIndex(s, key)
  const roleChunk = ensureRoleChunk(s)
  if (roleChunk) yield roleChunk
  yield makeChunk(s, {
    index: 0,
    delta: {
      tool_calls: [
        {
          index: idx,
          id: item.call_id,
          type: "function",
          function: { name: item.name, arguments: "" },
        },
      ],
    },
    finish_reason: null,
    logprobs: null,
  })
}

function* handleArgumentsDelta(
  s: StreamState,
  itemId: string,
  delta: string,
): Generator<SSEMessage> {
  const idx = getToolIndex(s, itemId)
  yield makeChunk(s, {
    index: 0,
    delta: {
      tool_calls: [{ index: idx, function: { arguments: delta } }],
    },
    finish_reason: null,
    logprobs: null,
  })
}

function buildUsageChunk(
  s: StreamState,
  usage: ChatCompletionResponse["usage"],
): SSEMessage | null {
  if (!usage) return null
  const chunk: ChatCompletionChunk = {
    id: s.responseId,
    object: "chat.completion.chunk",
    created: s.created,
    model: s.requestedModel,
    choices: [],
    usage: {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
      ...(usage.prompt_tokens_details && {
        prompt_tokens_details: usage.prompt_tokens_details,
      }),
    },
  }
  return { data: JSON.stringify(chunk) }
}

function* handleCompleted(
  s: StreamState,
  response: ResponsesResponse,
): Generator<SSEMessage> {
  const finishReason: "stop" | "tool_calls" =
    s.hasToolCalls ? "tool_calls" : "stop"
  yield makeChunk(s, {
    index: 0,
    delta: {},
    finish_reason: finishReason,
    logprobs: null,
  })
  const usageChunk = buildUsageChunk(s, mapUsage(response.usage))
  if (usageChunk) yield usageChunk
  yield { data: "[DONE]" }
}

function parseEvent(data: string): ResponsesStreamEvent | null {
  try {
    return JSON.parse(data) as ResponsesStreamEvent
  } catch {
    return null
  }
}

function handleTerminalEvent(event: ResponsesStreamEvent): never {
  const message =
    event.message ?? event.response?.error?.message ?? "Responses API error"
  throw new Error(message)
}

/**
 * Dispatch a single Responses-API event to the right handler.
 * Returns generator of chunks and a boolean (true = stream complete).
 */
function* dispatchEvent(
  s: StreamState,
  event: ResponsesStreamEvent,
): Generator<SSEMessage, boolean> {
  switch (event.type) {
    case "response.output_text.delta": {
      if (event.delta) yield* handleTextDelta(s, event.delta)
      return false
    }
    case "response.output_item.added": {
      if (event.item?.type === "function_call") {
        yield* handleFunctionCallAdded(s, event.item)
      }
      return false
    }
    case "response.function_call_arguments.delta": {
      if (event.delta !== undefined) {
        yield* handleArgumentsDelta(s, event.item_id ?? "", event.delta)
      }
      return false
    }
    case "response.completed": {
      if (event.response) {
        yield* handleCompleted(s, event.response)
        return true
      }
      return false
    }
    case "response.failed":
    case "response.error": {
      handleTerminalEvent(event)
    }
    // eslint-disable-next-line no-fallthrough
    default: {
      return false
    }
  }
}

/**
 * Translate a Responses-API SSE stream into Chat Completions SSE messages.
 *
 * Yields `{ data: <stringified chat-completion-chunk> }` objects so the
 * route handler can feed them straight into `stream.writeSSE()` — same
 * shape as the existing `events()` output for `/chat/completions`.
 */
export async function* responsesStreamToChatChunks(
  source: AsyncGenerator<SSEMessage>,
  requestedModel: string,
): AsyncGenerator<SSEMessage> {
  const s: StreamState = {
    responseId: `chatcmpl-${randomUUID().replaceAll("-", "")}`,
    created: Math.floor(Date.now() / 1000),
    requestedModel,
    roleEmitted: false,
    hasToolCalls: false,
    toolIndexById: new Map(),
    nextToolIndex: 0,
  }

  for await (const sse of source) {
    if (!sse.data || sse.data === "[DONE]") continue
    const event = parseEvent(sse.data)
    if (!event) continue
    const done = yield* dispatchEvent(s, event)
    if (done) return
  }
}
