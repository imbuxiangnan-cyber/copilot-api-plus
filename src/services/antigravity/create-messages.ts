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

import { antigravityQueue } from "../../lib/request-queue"
import { sleep } from "../../lib/utils"
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
  getCurrentProjectId,
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

// Antigravity API endpoints with fallback support
// Note: Claude models also use the same generateContent endpoint, not rawPredict
// The API accepts Claude model names but uses Gemini-style format
const ANTIGRAVITY_ENDPOINTS = [
  "daily-cloudcode-pa.sandbox.googleapis.com", // Daily (Sandbox) - Primary
  "cloudcode-pa.googleapis.com", // Production - Fallback
] as const

// Current endpoint index for fallback rotation
let currentEndpointIndex = 0

function getStreamUrl(host: string): string {
  return `https://${host}/v1internal:streamGenerateContent?alt=sse`
}

function getNoStreamUrl(host: string): string {
  return `https://${host}/v1internal:generateContent`
}

function getCurrentHost(): string {
  return ANTIGRAVITY_ENDPOINTS[currentEndpointIndex]
}

function rotateEndpoint(): void {
  const oldIndex = currentEndpointIndex
  currentEndpointIndex =
    (currentEndpointIndex + 1) % ANTIGRAVITY_ENDPOINTS.length
  consola.info(
    `Rotating endpoint: ${ANTIGRAVITY_ENDPOINTS[oldIndex]} → ${ANTIGRAVITY_ENDPOINTS[currentEndpointIndex]}`,
  )
}

const ANTIGRAVITY_USER_AGENT = "antigravity/1.11.3 windows/amd64"

// Rate limit tracking per model family
interface RateLimitInfo {
  lastLimitTime: number
  consecutiveErrors: number
}

const rateLimitTracker: Record<string, RateLimitInfo> = {}

function getModelFamily(model: string): string {
  if (model.includes("claude")) return "claude"
  if (model.includes("gemini")) return "gemini"
  return "other"
}

function trackRateLimit(model: string): void {
  const family = getModelFamily(model)
  if (!rateLimitTracker[family]) {
    rateLimitTracker[family] = { lastLimitTime: 0, consecutiveErrors: 0 }
  }
  rateLimitTracker[family].lastLimitTime = Date.now()
  rateLimitTracker[family].consecutiveErrors++
}

function clearRateLimitTracker(model: string): void {
  const family = getModelFamily(model)
  if (rateLimitTracker[family]) {
    rateLimitTracker[family].consecutiveErrors = 0
  }
}

function getBackoffDelay(model: string, baseDelay: number): number {
  const family = getModelFamily(model)
  const info = rateLimitTracker[family]
  if (!info) return baseDelay

  // Exponential backoff: base * 2^(consecutive-1), max 30s
  const multiplier = Math.min(Math.pow(2, info.consecutiveErrors - 1), 60)
  return Math.min(baseDelay * multiplier, 30000)
}

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
  system?:
    | string
    | Array<{ type: string; text?: string; cache_control?: unknown }>
  max_tokens: number
  stream?: boolean
  temperature?: number
  top_p?: number
  top_k?: number
  tools?: Array<unknown>
}

interface AntigravityContent {
  role: string
  parts: Array<unknown> | { text: string }
}

interface ConvertedMessages {
  contents: Array<AntigravityContent>
  systemInstruction?: { parts: Array<{ text: string }> }
}

/**
 * Extract text from system content (can be string or array)
 */
function extractSystemText(
  system:
    | string
    | Array<{ type: string; text?: string; cache_control?: unknown }>,
): string {
  if (typeof system === "string") {
    return system
  }
  // Extract text from array of content blocks
  return system
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text)
    .join("\n\n")
}

/**
 * Convert Anthropic messages to Antigravity format
 */
function convertMessages(
  messages: Array<AnthropicMessage>,
  system?:
    | string
    | Array<{ type: string; text?: string; cache_control?: unknown }>,
): ConvertedMessages {
  const contents: Array<AntigravityContent> = []
  let systemInstruction: { parts: Array<{ text: string }> } | undefined

  if (system) {
    const systemText = extractSystemText(system)
    if (systemText) {
      // Antigravity format: parts is an array of Part objects with text field
      systemInstruction = { parts: [{ text: systemText }] }
    }
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
      name: string
      description?: string
      input_schema?: unknown
    }
    functionDeclarations.push({
      name: t.name,
      description: t.description || "",
      parameters: cleanJsonSchema(t.input_schema) || {},
    })
  }

  // Return as a single object with all function declarations
  return [{ functionDeclarations }]
}

/**
 * Build Antigravity request body
 * The Antigravity API expects a specific nested structure with request object
 */
function buildGeminiRequest(
  request: AnthropicMessageRequest,
  projectId?: string | null,
): Record<string, unknown> {
  const { contents, systemInstruction } = convertMessages(
    request.messages,
    request.system,
  )
  const tools = convertTools(request.tools)

  // Build the inner request object
  const innerRequest: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: request.temperature ?? 1,
      topP: request.top_p ?? 0.85,
      topK: request.top_k ?? 50,
      maxOutputTokens: request.max_tokens ?? 8096,
    },
  }

  if (systemInstruction) innerRequest.systemInstruction = systemInstruction
  if (tools) innerRequest.tools = tools

  if (isThinkingModel(request.model)) {
    innerRequest.generationConfig = {
      ...(innerRequest.generationConfig as Record<string, unknown>),
      thinkingConfig: { includeThoughts: true },
    }
  }

  // Wrap in the Antigravity request structure
  const result: Record<string, unknown> = {
    model: request.model,
    userAgent: "antigravity",
    requestId: `agent-${crypto.randomUUID()}`,
    request: innerRequest,
  }

  // Add project ID if available (required by some endpoints)
  if (projectId) {
    result.project = projectId
  }

  return result
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
 * Note: Both Gemini and Claude models use the same endpoint and Gemini-style format
 *
 * Features:
 * - Endpoint fallback (daily → prod)
 * - Per-model-family rate limit tracking
 * - Exponential backoff for consecutive errors
 * - Smart retry for short delays (≤5s on same endpoint)
 */
const MAX_RETRIES = 5
const MAX_ENDPOINT_RETRIES = 2 // Try each endpoint up to 2 times before switching

async function executeAntigravityRequest(
  request: AnthropicMessageRequest,
): Promise<Response> {
  // Get project ID for the request
  const projectId = await getCurrentProjectId()
  const body = buildGeminiRequest(request, projectId)
  let endpointRetries = 0

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const host = getCurrentHost()
    const endpoint = request.stream ? getStreamUrl(host) : getNoStreamUrl(host)

    const accessToken = await getValidAccessToken()

    if (!accessToken) {
      return createErrorResponse(
        "authentication_error",
        "No valid Antigravity access token available.",
        401,
      )
    }

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Host: host,
          "User-Agent": ANTIGRAVITY_USER_AGENT,
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "Accept-Encoding": "gzip",
        },
        body: JSON.stringify(body),
      })

      if (response.ok) {
        // Success - clear rate limit tracker for this model family
        clearRateLimitTracker(request.model)
        return request.stream ?
            transformStreamResponse(response, request.model)
          : await transformNonStreamResponse(response, request.model)
      }

      const errorResult = await handleApiError(response, request.model)

      if (errorResult.shouldRetry && attempt < MAX_RETRIES) {
        // Track rate limit for exponential backoff
        trackRateLimit(request.model)

        // Calculate delay with backoff
        const backoffDelay = getBackoffDelay(
          request.model,
          errorResult.retryDelayMs,
        )

        // If delay is short (≤5s), retry on same endpoint
        // Otherwise, try switching endpoint
        if (backoffDelay <= 5000 || endpointRetries >= MAX_ENDPOINT_RETRIES) {
          consola.info(
            `Rate limited, retrying in ${backoffDelay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
          )
          await sleep(backoffDelay)
        } else {
          // Try switching endpoint
          rotateEndpoint()
          endpointRetries++
          consola.info(
            `Switching endpoint, retrying in ${errorResult.retryDelayMs}ms`,
          )
          await sleep(errorResult.retryDelayMs)
        }
        continue
      }

      return errorResult.response
    } catch (error) {
      consola.error("Antigravity request error:", error)
      if (attempt < MAX_RETRIES) {
        // On network error, try switching endpoint
        if (endpointRetries < MAX_ENDPOINT_RETRIES) {
          rotateEndpoint()
          endpointRetries++
        }
        await sleep(500)
        continue
      }
      return createErrorResponse(
        "api_error",
        `Request failed: ${String(error)}`,
        500,
      )
    }
  }

  return createErrorResponse("api_error", "Max retries exceeded", 429)
}

export async function createAntigravityMessages(
  request: AnthropicMessageRequest,
): Promise<Response> {
  return antigravityQueue.enqueue(() => executeAntigravityRequest(request))
}

interface ApiErrorResult {
  shouldRetry: boolean
  retryDelayMs: number
  response: Response
}

/**
 * Parse retry delay from error response
 * Supports multiple formats:
 * - RetryInfo.retryDelay: "3.5s"
 * - quotaResetDelay: "3000ms" or "3s"
 * - message: "Your quota will reset after 3s"
 */
function parseRetryDelay(errorText: string): number {
  try {
    const errorData = JSON.parse(errorText) as {
      error?: {
        message?: string
        details?: Array<{
          "@type"?: string
          retryDelay?: string
          quotaResetDelay?: string
        }>
      }
    }

    // Check details array first
    const details = errorData.error?.details ?? []
    for (const detail of details) {
      // Check RetryInfo first
      if (detail["@type"]?.includes("RetryInfo") && detail.retryDelay) {
        const match = /(\d+(?:\.\d+)?)s/.exec(detail.retryDelay)
        if (match) return Math.ceil(Number.parseFloat(match[1]) * 1000)
      }
      // Check quotaResetDelay
      if (detail.quotaResetDelay) {
        const match = /(\d+(?:\.\d+)?)(?:ms|s)/.exec(detail.quotaResetDelay)
        if (match) {
          const value = Number.parseFloat(match[1])
          return detail.quotaResetDelay.includes("ms") ?
              Math.ceil(value)
            : Math.ceil(value * 1000)
        }
      }
    }

    // Check message for "Your quota will reset after Xs" pattern
    const message = errorData.error?.message ?? ""
    const resetMatch = /quota will reset after (\d+(?:\.\d+)?)s/i.exec(message)
    if (resetMatch) {
      return Math.ceil(Number.parseFloat(resetMatch[1]) * 1000)
    }
  } catch {
    // Ignore parse errors
  }
  return 500 // Default 500ms retry delay
}

/**
 * Handle API error response
 */
async function handleApiError(
  response: Response,
  _model?: string,
): Promise<ApiErrorResult> {
  const errorText = await response.text()
  consola.error(`Antigravity error: ${response.status} ${errorText}`)

  if (response.status === 403) {
    await disableCurrentAccount()
  }

  // Handle rate limit errors with retry
  if (response.status === 429 || response.status === 503) {
    await rotateAccount()
    const retryDelayMs = parseRetryDelay(errorText)
    return {
      shouldRetry: true,
      retryDelayMs,
      response: createErrorResponse(
        "api_error",
        `Antigravity API error: ${response.status}`,
        response.status,
      ),
    }
  }

  return {
    shouldRetry: false,
    retryDelayMs: 0,
    response: createErrorResponse(
      "api_error",
      `Antigravity API error: ${response.status}`,
      response.status,
    ),
  }
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
 * Process candidate parts and handle finish
 */
function processCandidate(
  candidate: { finishReason?: string; content?: { parts?: Array<unknown> } },
  state: StreamState,
  emit: (event: StreamEvent) => void,
): boolean {
  const parts = (candidate?.content?.parts ?? []) as Array<{
    text?: string
    thought?: boolean
    functionCall?: { name: string; args: unknown }
  }>

  for (const part of parts) {
    processPart(part, state, emit)
  }

  if (candidate?.finishReason === "STOP") {
    handleFinish(state, emit)
    return true
  }
  return false
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
  let finished = false

  while (!finished) {
    const { done, value } = await reader.read()
    if (done) break

    const lines = processChunk(decoder.decode(value, { stream: true }), state)

    for (const line of lines) {
      if (finished) break

      const data = parseSSELine(line)
      if (!data) continue

      const { candidates, usage } = extractFromData(data)
      if (usage) {
        state.inputTokens = usage.promptTokenCount ?? state.inputTokens
        state.outputTokens = usage.candidatesTokenCount ?? state.outputTokens
      }

      if (candidates[0] && processCandidate(candidates[0], state, emit)) {
        finished = true
        break
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
  interface AntigravityResponseData {
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

  interface NonStreamData {
    response?: AntigravityResponseData
    candidates?: AntigravityResponseData["candidates"]
    usageMetadata?: AntigravityResponseData["usageMetadata"]
  }

  const rawData = (await response.json()) as NonStreamData

  // Handle nested response structure (Antigravity wraps response in a "response" object)
  const data = rawData.response ?? rawData
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
