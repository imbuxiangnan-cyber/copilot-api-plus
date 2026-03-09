/**
 * Google Antigravity Chat Completions
 *
 * Proxy chat completion requests to Google Antigravity API or standard Gemini API.
 * Supports two authentication methods:
 * - API Key: Uses standard Gemini API (generativelanguage.googleapis.com)
 * - OAuth: Uses Antigravity private API (daily-cloudcode-pa.sandbox.googleapis.com)
 *
 * Based on: https://github.com/liuw1535/antigravity2api-nodejs
 */

/* eslint-disable max-params */
/* eslint-disable @typescript-eslint/no-unnecessary-condition */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents */
/* eslint-disable @typescript-eslint/no-unsafe-argument */

import consola from "consola"

import { sleep } from "../../lib/utils"
import { recordAccountFailure, recordAccountSuccess } from "./account-scorer"
import {
  disableCurrentAccount,
  getApiKey,
  getCurrentAccountIndex,
  getValidAccessToken,
  rotateAccount,
} from "./auth"
import { maybeDowngradeModel } from "./background-detection"
import {
  canExecute,
  getBackoffDelay,
  getModelFamily,
  parseRetryDelay,
  recordFailure,
  recordSuccess,
} from "./circuit-breaker"
import { isThinkingModel } from "./get-models"
import {
  createStreamState,
  extractFromData,
  parseSSELine,
  processChunk,
  type AntigravityPart,
  type StreamState,
} from "./stream-parser"

// Antigravity API endpoints (OAuth authentication)
// Note: Claude models also use the same generateContent endpoint, not rawPredict
// The API accepts Claude model names (e.g., claude-sonnet-4-5) but uses Gemini-style format
const ANTIGRAVITY_API_HOST = "daily-cloudcode-pa.sandbox.googleapis.com"
const ANTIGRAVITY_STREAM_URL = `https://${ANTIGRAVITY_API_HOST}/v1internal:streamGenerateContent?alt=sse`
const ANTIGRAVITY_NO_STREAM_URL = `https://${ANTIGRAVITY_API_HOST}/v1internal:generateContent`
const ANTIGRAVITY_USER_AGENT = "antigravity/1.11.3 windows/amd64"

// Standard Gemini API endpoints (API Key authentication)
const GEMINI_API_HOST = "generativelanguage.googleapis.com"
const getGeminiStreamUrl = (model: string, apiKey: string) =>
  `https://${GEMINI_API_HOST}/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`
const getGeminiNoStreamUrl = (model: string, apiKey: string) =>
  `https://${GEMINI_API_HOST}/v1beta/models/${model}:generateContent?key=${apiKey}`

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
  parts: Array<{ text: string }>
} {
  const text =
    typeof content === "string" ? content : (
      content.map((c) => c.text || "").join("")
    )
  // Antigravity format: parts is an array of Part objects with text field
  return { parts: [{ text }] }
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

// Allowlisted fields for Gemini API Schema
const GEMINI_ALLOWED_FIELDS = new Set([
  "type",
  "description",
  "properties",
  "required",
  "items",
  "enum",
  "nullable",
])

/**
 * Convert type value to Gemini format
 * Handles both string and array types (for nullable)
 */
function convertTypeValue(
  value: unknown,
): { type: string; nullable?: boolean } | null {
  if (typeof value === "string") {
    return { type: value.toUpperCase() }
  }
  if (Array.isArray(value)) {
    const nonNullType = value.find(
      (t): t is string => typeof t === "string" && t !== "null",
    )
    if (nonNullType) {
      return { type: nonNullType.toUpperCase(), nullable: true }
    }
  }
  return null
}

/**
 * Clean properties object recursively
 */
function cleanProperties(
  props: Record<string, unknown>,
): Record<string, unknown> {
  const cleanedProps: Record<string, unknown> = {}
  for (const [propKey, propValue] of Object.entries(props)) {
    cleanedProps[propKey] = cleanJsonSchema(propValue)
  }
  return cleanedProps
}

/**
 * Clean and convert JSON schema to Gemini format
 * - Removes unsupported fields like $schema, additionalProperties
 * - Converts type values to uppercase (string -> STRING)
 * - Ensures properties format is correct for Google API
 */
function cleanJsonSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema
  if (Array.isArray(schema)) {
    return schema.map((item) => cleanJsonSchema(item))
  }

  const obj = schema as Record<string, unknown>
  const cleaned: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(obj)) {
    if (!GEMINI_ALLOWED_FIELDS.has(key)) continue

    if (key === "type") {
      const result = convertTypeValue(value)
      if (result) {
        cleaned.type = result.type
        if (result.nullable) cleaned.nullable = true
      }
    } else if (key === "properties" && typeof value === "object" && value) {
      cleaned.properties = cleanProperties(value as Record<string, unknown>)
    } else if (typeof value === "object" && value !== null) {
      cleaned[key] = cleanJsonSchema(value)
    } else {
      cleaned[key] = value
    }
  }

  return cleaned
}

/**
 * Convert tools to Antigravity format
 * All tools should be in a single object with functionDeclarations array
 */
function convertTools(tools?: Array<unknown>): Array<unknown> | undefined {
  if (!tools || tools.length === 0) return undefined

  const functionDeclarations: Array<unknown> = []

  for (const tool of tools) {
    const t = tool as {
      type: string
      function?: { name: string; description?: string; parameters?: unknown }
    }
    if (t.type === "function" && t.function) {
      functionDeclarations.push({
        name: t.function.name,
        description: t.function.description || "",
        parameters: cleanJsonSchema(t.function.parameters) || {},
      })
    }
  }

  if (functionDeclarations.length === 0) return undefined

  // Return as a single object with all function declarations
  return [{ functionDeclarations }]
}

/**
 * Build standard Gemini API request body (for API Key authentication)
 */
function buildStandardGeminiRequestBody(
  request: ChatCompletionRequest,
): Record<string, unknown> {
  const { contents, systemInstruction } = convertMessages(request.messages)
  const tools = convertTools(request.tools)

  const body: Record<string, unknown> = {
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
 * Build Antigravity request body
 * The Antigravity API expects a specific nested structure with request object
 */
function buildAntigravityRequestBody(
  request: ChatCompletionRequest,
): Record<string, unknown> {
  const innerRequest = buildStandardGeminiRequestBody(request)

  // Wrap in the Antigravity request structure
  return {
    model: request.model,
    userAgent: "antigravity",
    requestId: `agent-${crypto.randomUUID()}`,
    request: innerRequest,
  }
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
 * Create chat completion with Antigravity or standard Gemini API
 * Priority: API Key > OAuth
 */
export async function createAntigravityChatCompletion(
  request: ChatCompletionRequest,
  requestHeaders?: Headers,
): Promise<Response> {
  // Background detection: optionally downgrade model for agent requests
  const effectiveModel = maybeDowngradeModel(
    request.model,
    request.messages,
    requestHeaders,
  )
  const effectiveRequest =
    effectiveModel !== request.model ?
      { ...request, model: effectiveModel }
    : request

  // Try API Key authentication first (simplest)
  const apiKey = getApiKey()
  if (apiKey) {
    return await createWithApiKey(effectiveRequest, apiKey)
  }

  // Fall back to OAuth authentication
  const accessToken = await getValidAccessToken()
  if (!accessToken) {
    return createErrorResponse(
      "No valid authentication available. Please set GEMINI_API_KEY environment variable or run OAuth login.",
      "auth_error",
      401,
    )
  }

  return await createWithOAuth(effectiveRequest, accessToken)
}

/**
 * Create chat completion using API Key (standard Gemini API)
 */
async function createWithApiKey(
  request: ChatCompletionRequest,
  apiKey: string,
): Promise<Response> {
  const endpoint =
    request.stream ?
      getGeminiStreamUrl(request.model, apiKey)
    : getGeminiNoStreamUrl(request.model, apiKey)
  const body = buildStandardGeminiRequestBody(request)

  consola.debug(`Gemini API request with model ${request.model}`)

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorResult = await handleApiError(response)
      return errorResult.response
    }

    return request.stream ?
        transformStreamResponse(response, request.model)
      : await transformNonStreamResponse(response, request.model)
  } catch (error) {
    consola.error("Gemini API request error:", error)
    return createErrorResponse(
      `Request failed: ${String(error)}`,
      "request_error",
      500,
    )
  }
}

/**
 * Create chat completion using OAuth (Antigravity private API)
 * Note: Both Gemini and Claude models use the same endpoint and Gemini-style format
 *
 * Features:
 * - Circuit breaker per model family
 * - Retry with exponential backoff on 429/503
 * - Token refresh between attempts
 */
const MAX_RETRIES = 5

async function createWithOAuth(
  request: ChatCompletionRequest,
  _initialAccessToken: string,
): Promise<Response> {
  const endpoint =
    request.stream ? ANTIGRAVITY_STREAM_URL : ANTIGRAVITY_NO_STREAM_URL
  const body = buildAntigravityRequestBody(request)
  const bodyString = JSON.stringify(body)

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const family = getModelFamily(request.model)

    // Circuit breaker check
    if (!canExecute(family)) {
      consola.warn(
        `[circuit-breaker] ${family} circuit OPEN, waiting for reset...`,
      )
      await sleep(1000)
      continue
    }

    // Re-acquire token each attempt (may have been refreshed)
    const accessToken = await getValidAccessToken()
    if (!accessToken) {
      return createErrorResponse(
        "No valid Antigravity access token available.",
        "auth_error",
        401,
      )
    }

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
        body: bodyString,
      })

      if (response.ok) {
        recordSuccess(family)
        const acctIdx = await getCurrentAccountIndex()
        recordAccountSuccess(acctIdx)
        return request.stream ?
            transformStreamResponse(response, request.model)
          : await transformNonStreamResponse(response, request.model)
      }

      const errorResult = await handleApiError(response)

      if (errorResult.shouldRetry && attempt < MAX_RETRIES) {
        recordFailure(family)
        const acctIdx = await getCurrentAccountIndex()
        recordAccountFailure(acctIdx)
        const backoffDelay = getBackoffDelay(family, errorResult.retryDelayMs)
        consola.info(
          `Rate limited, retrying in ${backoffDelay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
        )
        await sleep(backoffDelay)
        continue
      }

      return errorResult.response
    } catch (error) {
      consola.error("Antigravity request error:", error)
      if (attempt < MAX_RETRIES) {
        await sleep(500)
        continue
      }
      return createErrorResponse(
        `Request failed: ${String(error)}`,
        "request_error",
        500,
      )
    }
  }

  return createErrorResponse("Max retries exceeded", "api_error", 429)
}

interface ApiErrorResult {
  shouldRetry: boolean
  retryDelayMs: number
  response: Response
}

/**
 * Handle API error response
 */
async function handleApiError(response: Response): Promise<ApiErrorResult> {
  const errorText = await response.text()
  consola.error(`Antigravity error: ${response.status} ${errorText}`)

  if (response.status === 403) {
    await disableCurrentAccount()
  }

  if (response.status === 429 || response.status === 503) {
    await rotateAccount()
    const retryDelayMs = parseRetryDelay(errorText)
    return {
      shouldRetry: true,
      retryDelayMs,
      response: createErrorResponse(
        `Antigravity API error: ${response.status}`,
        "api_error",
        response.status,
        errorText,
      ),
    }
  }

  return {
    shouldRetry: false,
    retryDelayMs: 0,
    response: createErrorResponse(
      `Antigravity API error: ${response.status}`,
      "api_error",
      response.status,
      errorText,
    ),
  }
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
  interface AntigravityResponseData {
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

  interface NonStreamData {
    response?: AntigravityResponseData
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

  const rawData = (await response.json()) as NonStreamData

  // Handle nested response structure (Antigravity wraps response in a "response" object)
  const data = rawData.response ?? rawData
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
