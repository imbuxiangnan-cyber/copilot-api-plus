/**
 * Google Antigravity Chat Completions
 *
 * Proxy chat completion requests to Google Antigravity API.
 * Based on: https://github.com/liuw1535/antigravity2api-nodejs
 */

/* eslint-disable max-params */
/* eslint-disable @typescript-eslint/no-unnecessary-condition */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents */
/* eslint-disable @typescript-eslint/no-unsafe-argument */

import consola from "consola"

import {
  disableCurrentAccount,
  getValidAccessToken,
  rotateAccount,
} from "./auth"
import { isThinkingModel } from "./get-models"
import {
  createStreamState,
  extractFromData,
  parseSSELine,
  processChunk,
  type AntigravityPart,
  type StreamState,
} from "./stream-parser"

// Antigravity API endpoints
const ANTIGRAVITY_API_HOST = "daily-cloudcode-pa.sandbox.googleapis.com"
const ANTIGRAVITY_STREAM_URL = `https://${ANTIGRAVITY_API_HOST}/v1internal:streamGenerateContent?alt=sse`
const ANTIGRAVITY_NO_STREAM_URL = `https://${ANTIGRAVITY_API_HOST}/v1internal:generateContent`
const ANTIGRAVITY_USER_AGENT = "antigravity/1.11.3 windows/amd64"

export interface ChatMessage {
  role: "system" | "user" | "assistant"
  content:
    | string
    | Array<{ type: string; text?: string; image_url?: { url: string } }>
}

export interface ChatCompletionRequest {
  model: string
  messages: Array<ChatMessage>
  stream?: boolean
  temperature?: number
  max_tokens?: number
  top_p?: number
  top_k?: number
  tools?: Array<unknown>
}

interface ConvertedContent {
  contents: Array<unknown>
  systemInstruction?: unknown
}

/**
 * Convert OpenAI format messages to Antigravity format
 */
function convertMessages(messages: Array<ChatMessage>): ConvertedContent {
  const contents: Array<unknown> = []
  let systemInstruction: unknown

  for (const message of messages) {
    if (message.role === "system") {
      systemInstruction = buildSystemInstruction(message.content)
      continue
    }

    const role = message.role === "assistant" ? "model" : "user"
    const parts = buildMessageParts(message.content)
    contents.push({ role, parts })
  }

  return { contents, systemInstruction }
}

/**
 * Build system instruction from content
 */
function buildSystemInstruction(content: ChatMessage["content"]): {
  role: string
  parts: Array<unknown>
} {
  const text =
    typeof content === "string" ? content : (
      content.map((c) => c.text || "").join("")
    )
  return { role: "user", parts: [{ text }] }
}

/**
 * Build message parts from content
 */
function buildMessageParts(content: ChatMessage["content"]): Array<unknown> {
  if (typeof content === "string") {
    return [{ text: content }]
  }

  const parts: Array<unknown> = []
  for (const part of content) {
    if (part.type === "text") {
      parts.push({ text: part.text })
    } else if (part.type === "image_url" && part.image_url?.url) {
      const imageData = parseBase64Image(part.image_url.url)
      if (imageData) parts.push({ inlineData: imageData })
    }
  }
  return parts
}

/**
 * Parse base64 image URL
 */
function parseBase64Image(
  url: string,
): { mimeType: string; data: string } | null {
  if (!url.startsWith("data:")) return null
  const match = url.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return null
  return { mimeType: match[1], data: match[2] }
}

/**
 * Convert tools to Antigravity format
 */
function convertTools(tools?: Array<unknown>): Array<unknown> | undefined {
  if (!tools || tools.length === 0) return undefined

  return tools.map((tool) => {
    const t = tool as {
      type: string
      function?: { name: string; description?: string; parameters?: unknown }
    }
    if (t.type === "function" && t.function) {
      return {
        functionDeclarations: [
          {
            name: t.function.name,
            description: t.function.description || "",
            parameters: t.function.parameters || {},
          },
        ],
      }
    }
    return tool
  })
}

/**
 * Build Antigravity request body
 */
function buildRequestBody(
  request: ChatCompletionRequest,
): Record<string, unknown> {
  const { contents, systemInstruction } = convertMessages(request.messages)
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
  message: string,
  type: string,
  status: number,
  details?: string,
): Response {
  const error: Record<string, unknown> = { message, type }
  if (details) error.details = details
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/**
 * Create chat completion with Antigravity
 */
export async function createAntigravityChatCompletion(
  request: ChatCompletionRequest,
): Promise<Response> {
  const accessToken = await getValidAccessToken()

  if (!accessToken) {
    return createErrorResponse(
      "No valid Antigravity access token available. Please run login first.",
      "auth_error",
      401,
    )
  }

  const endpoint =
    request.stream ? ANTIGRAVITY_STREAM_URL : ANTIGRAVITY_NO_STREAM_URL
  const body = buildRequestBody(request)

  consola.debug(
    `Antigravity request to ${endpoint} with model ${request.model}`,
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
    consola.error("Antigravity request error:", error)
    return createErrorResponse(
      `Request failed: ${String(error)}`,
      "request_error",
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

  if (response.status === 403) await disableCurrentAccount()
  if (response.status === 429 || response.status === 503) await rotateAccount()

  return createErrorResponse(
    `Antigravity API error: ${response.status}`,
    "api_error",
    response.status,
    errorText,
  )
}

/**
 * Generate request ID
 */
function generateRequestId(): string {
  return `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/**
 * Transform Antigravity stream response to OpenAI format
 */
function transformStreamResponse(response: Response, model: string): Response {
  const reader = response.body?.getReader()
  if (!reader) return new Response("No response body", { status: 500 })

  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const requestId = generateRequestId()

  const stream = new ReadableStream({
    async start(controller) {
      const state = createStreamState()

      try {
        await processOpenAIStream(
          reader as ReadableStreamDefaultReader<Uint8Array>,
          decoder,
          state,
          controller,
          encoder,
          requestId,
          model,
        )
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
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
 * Process stream and emit OpenAI format chunks
 */
async function processOpenAIStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  state: StreamState,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  requestId: string,
  model: string,
): Promise<void> {
  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    const chunk = decoder.decode(value, { stream: true })
    const lines = processChunk(chunk, state)

    for (const line of lines) {
      const data = parseSSELine(line)
      if (!data) continue

      const { candidates } = extractFromData(data)
      const candidate = candidates[0]
      const parts = candidate?.content?.parts ?? []

      for (const part of parts) {
        const chunkData = buildOpenAIChunk(
          part,
          requestId,
          model,
          candidate?.finishReason,
        )
        if (chunkData) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(chunkData)}\n\n`),
          )
        }
      }
    }
  }
}

/**
 * Build OpenAI format chunk from part
 */
function buildOpenAIChunk(
  part: AntigravityPart,
  requestId: string,
  model: string,
  finishReason?: string,
): unknown | null {
  const baseChunk = {
    id: requestId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
  }

  // Handle thinking content
  if (part.thought && part.text) {
    return {
      ...baseChunk,
      choices: [
        {
          index: 0,
          delta: { reasoning_content: part.text },
          finish_reason: null,
        },
      ],
    }
  }

  // Handle regular text
  if (part.text && !part.thought) {
    return {
      ...baseChunk,
      choices: [
        {
          index: 0,
          delta: { content: part.text },
          finish_reason: finishReason === "STOP" ? "stop" : null,
        },
      ],
    }
  }

  // Handle function calls
  if (part.functionCall) {
    return {
      ...baseChunk,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: `call_${Date.now()}`,
                type: "function",
                function: {
                  name: part.functionCall.name,
                  arguments: JSON.stringify(part.functionCall.args),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }
  }

  return null
}

/**
 * Transform Antigravity non-stream response to OpenAI format
 */
async function transformNonStreamResponse(
  response: Response,
  model: string,
): Promise<Response> {
  interface NonStreamData {
    candidates?: Array<{
      content?: { parts?: Array<AntigravityPart> }
      finishReason?: string
    }>
    usageMetadata?: {
      promptTokenCount?: number
      candidatesTokenCount?: number
      totalTokenCount?: number
    }
  }

  const data = (await response.json()) as NonStreamData
  const candidate = data.candidates?.[0]
  const parts = candidate?.content?.parts ?? []
  const { content, reasoningContent, toolCalls } =
    extractNonStreamContent(parts)

  const message: Record<string, unknown> = {
    role: "assistant",
    content: content || null,
  }
  if (reasoningContent) message.reasoning_content = reasoningContent
  if (toolCalls.length > 0) message.tool_calls = toolCalls

  const openaiResponse = {
    id: generateRequestId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: "stop" }],
    usage: {
      prompt_tokens: data.usageMetadata?.promptTokenCount ?? 0,
      completion_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      total_tokens: data.usageMetadata?.totalTokenCount ?? 0,
    },
  }

  return new Response(JSON.stringify(openaiResponse), {
    headers: { "Content-Type": "application/json" },
  })
}

/**
 * Extract content from non-stream response parts
 */
function extractNonStreamContent(parts: Array<AntigravityPart>): {
  content: string
  reasoningContent: string
  toolCalls: Array<unknown>
} {
  let content = ""
  let reasoningContent = ""
  const toolCalls: Array<unknown> = []

  for (const part of parts) {
    if (part.thought && part.text) {
      reasoningContent += part.text
    } else if (part.text) {
      content += part.text
    }

    if (part.functionCall) {
      toolCalls.push({
        id: `call_${Date.now()}`,
        type: "function",
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args),
        },
      })
    }
  }

  return { content, reasoningContent, toolCalls }
}
