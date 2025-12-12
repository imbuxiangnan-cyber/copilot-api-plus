/**
 * Google Antigravity Messages API
 *
 * Converts Anthropic Messages API format to Antigravity format.
 * This enables Claude Code to use Antigravity as backend.
 *
 * Based on: https://github.com/liuw1535/antigravity2api-nodejs
 */

/* eslint-disable max-params */
/* eslint-disable @typescript-eslint/no-unnecessary-condition */
/* eslint-disable default-case */

import consola from "consola"

import {
  createBlockStop,
  createMessageDelta,
  createMessageStart,
  createMessageStop,
  createTextBlockStart,
  createTextDelta,
  createThinkingBlockStart,
  createThinkingDelta,
  createToolBlockStart,
  createToolDelta,
  generateMessageId,
  generateToolId,
} from "./anthropic-events"
import {
  disableCurrentAccount,
  getValidAccessToken,
  rotateAccount,
} from "./auth"
import { isThinkingModel } from "./get-models"
import {
  createStreamState,
  extractFromData,
  handleFinish,
  parseSSELine,
  processChunk,
  processPart,
  type StreamEvent,
  type StreamState,
} from "./stream-parser"

// Antigravity API endpoints
const ANTIGRAVITY_API_HOST = "daily-cloudcode-pa.sandbox.googleapis.com"
const ANTIGRAVITY_STREAM_URL = `https://${ANTIGRAVITY_API_HOST}/v1internal:streamGenerateContent?alt=sse`
const ANTIGRAVITY_NO_STREAM_URL = `https://${ANTIGRAVITY_API_HOST}/v1internal:generateContent`
const ANTIGRAVITY_USER_AGENT = "antigravity/1.11.3 windows/amd64"

export interface AnthropicMessage {
  role: "user" | "assistant"
  content:
    | string
    | Array<{
        type: string
        text?: string
        source?: { type: string; media_type: string; data: string }
      }>
}

export interface AnthropicMessageRequest {
  model: string
  messages: Array<AnthropicMessage>
  system?: string
  max_tokens: number
  stream?: boolean
  temperature?: number
  top_p?: number
  top_k?: number
  tools?: Array<unknown>
}

interface AntigravityContent {
  role: string
  parts: Array<unknown>
}

interface ConvertedMessages {
  contents: Array<AntigravityContent>
  systemInstruction?: AntigravityContent
}

/**
 * Convert Anthropic messages to Antigravity format
 */
function convertMessages(
  messages: Array<AnthropicMessage>,
  system?: string,
): ConvertedMessages {
  const contents: Array<AntigravityContent> = []
  let systemInstruction: AntigravityContent | undefined

  if (system) {
    systemInstruction = { role: "user", parts: [{ text: system }] }
  }

  for (const message of messages) {
    const role = message.role === "assistant" ? "model" : "user"
    const parts = buildParts(message.content)
    if (parts.length > 0) {
      contents.push({ role, parts })
    }
  }

  return { contents, systemInstruction }
}

/**
 * Build parts array from message content
 */
function buildParts(content: AnthropicMessage["content"]): Array<unknown> {
  if (typeof content === "string") {
    return [{ text: content }]
  }

  const parts: Array<unknown> = []
  for (const block of content) {
    if (block.type === "text" && block.text) {
      parts.push({ text: block.text })
    } else if (block.type === "image" && block.source) {
      parts.push({
        inlineData: {
          mimeType: block.source.media_type,
          data: block.source.data,
        },
      })
    }
  }
  return parts
}

/**
 * Convert tools to Antigravity format
 */
function convertTools(tools?: Array<unknown>): Array<unknown> | undefined {
  if (!tools || tools.length === 0) return undefined

  return tools.map((tool) => {
    const t = tool as {
      name: string
      description?: string
      input_schema?: unknown
    }
    return {
      functionDeclarations: [
        {
          name: t.name,
          description: t.description || "",
          parameters: t.input_schema || {},
        },
      ],
    }
  })
}

/**
 * Build Antigravity request body
 */
function buildAntigravityRequest(
  request: AnthropicMessageRequest,
): Record<string, unknown> {
  const { contents, systemInstruction } = convertMessages(
    request.messages,
    request.system,
  )
  const tools = convertTools(request.tools)

  const body: Record<string, unknown> = {
    model: request.model,
    contents,
    generationConfig: {
      temperature: request.temperature ?? 1,
      topP: request.top_p ?? 0.85,
      topK: request.top_k ?? 50,
      maxOutputTokens: request.max_tokens ?? 8096,
    },
  }

  if (systemInstruction) body.systemInstruction = systemInstruction
  if (tools) body.tools = tools

  if (isThinkingModel(request.model)) {
    body.generationConfig = {
      ...(body.generationConfig as Record<string, unknown>),
      thinkingConfig: { includeThoughts: true },
    }
  }

  return body
}

/**
 * Create error response
 */
function createErrorResponse(
  type: string,
  message: string,
  status: number,
): Response {
  return new Response(
    JSON.stringify({ type: "error", error: { type, message } }),
    { status, headers: { "Content-Type": "application/json" } },
  )
}

/**
 * Create Anthropic-compatible message response using Antigravity
 */
export async function createAntigravityMessages(
  request: AnthropicMessageRequest,
): Promise<Response> {
  const accessToken = await getValidAccessToken()

  if (!accessToken) {
    return createErrorResponse(
      "authentication_error",
      "No valid Antigravity access token available. Please run login first.",
      401,
    )
  }

  const endpoint =
    request.stream ? ANTIGRAVITY_STREAM_URL : ANTIGRAVITY_NO_STREAM_URL
  const body = buildAntigravityRequest(request)

  consola.debug(
    `Antigravity messages request to ${endpoint} with model ${request.model}`,
  )

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Host: ANTIGRAVITY_API_HOST,
        "User-Agent": ANTIGRAVITY_USER_AGENT,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Accept-Encoding": "gzip",
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      return await handleApiError(response)
    }

    return request.stream ?
        transformStreamResponse(response, request.model)
      : await transformNonStreamResponse(response, request.model)
  } catch (error) {
    consola.error("Antigravity messages request error:", error)
    return createErrorResponse(
      "api_error",
      `Request failed: ${String(error)}`,
      500,
    )
  }
}

/**
 * Handle API error response
 */
async function handleApiError(response: Response): Promise<Response> {
  const errorText = await response.text()
  consola.error(`Antigravity error: ${response.status} ${errorText}`)

  if (response.status === 403) {
    await disableCurrentAccount()
  }
  if (response.status === 429 || response.status === 503) {
    await rotateAccount()
  }

  return createErrorResponse(
    "api_error",
    `Antigravity API error: ${response.status}`,
    response.status,
  )
}

/**
 * Emit SSE event to controller based on stream event type
 */
function emitSSEEvent(
  event: StreamEvent,
  controller: ReadableStreamDefaultController<Uint8Array>,
  state: StreamState,
): void {
  switch (event.type) {
    case "thinking_start": {
      controller.enqueue(createThinkingBlockStart(event.index))
      break
    }
    case "thinking_delta": {
      controller.enqueue(createThinkingDelta(event.index, event.text))
      break
    }
    case "thinking_stop": {
      controller.enqueue(createBlockStop(event.index))
      break
    }
    case "text_start": {
      controller.enqueue(createTextBlockStart(event.index))
      break
    }
    case "text_delta": {
      controller.enqueue(createTextDelta(event.index, event.text))
      break
    }
    case "text_stop": {
      controller.enqueue(createBlockStop(event.index))
      break
    }
    case "tool_use": {
      emitToolUseEvents(event, controller)
      break
    }
    case "usage": {
      state.inputTokens = event.inputTokens
      state.outputTokens = event.outputTokens
      break
    }
    case "finish": {
      controller.enqueue(
        createMessageDelta(event.stopReason, state.outputTokens),
      )
      break
    }
    // No default needed - all cases are handled by the StreamEvent union type
  }
}

/**
 * Emit tool use events
 */
function emitToolUseEvents(
  event: { type: "tool_use"; index: number; name: string; args: unknown },
  controller: ReadableStreamDefaultController<Uint8Array>,
): void {
  const toolId = generateToolId()
  controller.enqueue(createToolBlockStart(event.index, toolId, event.name))
  controller.enqueue(createToolDelta(event.index, event.args))
  controller.enqueue(createBlockStop(event.index))
}

/**
 * Transform Antigravity stream response to Anthropic format
 */
function transformStreamResponse(response: Response, model: string): Response {
  const reader = response.body?.getReader()
  if (!reader) {
    return new Response("No response body", { status: 500 })
  }

  const decoder = new TextDecoder()
  const messageId = generateMessageId()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const state = createStreamState()
      controller.enqueue(createMessageStart(messageId, model))

      try {
        await processStream(
          reader as ReadableStreamDefaultReader<Uint8Array>,
          decoder,
          state,
          controller,
        )
        controller.enqueue(createMessageStop())
        controller.close()
      } catch (error) {
        consola.error("Stream transform error:", error)
        controller.error(error)
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  })
}

/**
 * Process the stream and emit events
 */
async function processStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  state: StreamState,
  controller: ReadableStreamDefaultController<Uint8Array>,
): Promise<void> {
  const emit = (event: StreamEvent) => emitSSEEvent(event, controller, state)

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    const chunk = decoder.decode(value, { stream: true })
    const lines = processChunk(chunk, state)

    for (const line of lines) {
      const data = parseSSELine(line)
      if (!data) continue

      const { candidates, usage } = extractFromData(data)
      if (usage) {
        state.inputTokens = usage.promptTokenCount ?? state.inputTokens
        state.outputTokens = usage.candidatesTokenCount ?? state.outputTokens
      }

      const candidate = candidates[0]
      const parts = candidate?.content?.parts ?? []

      for (const part of parts) {
        processPart(part, state, emit)
      }

      if (candidate?.finishReason === "STOP") {
        handleFinish(state, emit)
      }
    }
  }
}

/**
 * Transform Antigravity non-stream response to Anthropic format
 */
async function transformNonStreamResponse(
  response: Response,
  model: string,
): Promise<Response> {
  interface NonStreamData {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string
          thought?: boolean
          functionCall?: { name: string; args: unknown }
        }>
      }
      finishReason?: string
    }>
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
  }

  const data = (await response.json()) as NonStreamData
  const candidate = data.candidates?.[0]
  const parts = candidate?.content?.parts ?? []
  const content = buildNonStreamContent(parts)

  const anthropicResponse = {
    id: generateMessageId(),
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: data.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    },
  }

  return new Response(JSON.stringify(anthropicResponse), {
    headers: { "Content-Type": "application/json" },
  })
}

/**
 * Build content array for non-stream response
 */
function buildNonStreamContent(
  parts: Array<{
    text?: string
    thought?: boolean
    functionCall?: { name: string; args: unknown }
  }>,
): Array<unknown> {
  const content: Array<unknown> = []

  for (const part of parts) {
    if (part.thought && part.text) {
      content.push({ type: "thinking", thinking: part.text })
    } else if (part.text) {
      content.push({ type: "text", text: part.text })
    }

    if (part.functionCall) {
      content.push({
        type: "tool_use",
        id: generateToolId(),
        name: part.functionCall.name,
        input: part.functionCall.args,
      })
    }
  }

  return content
}
