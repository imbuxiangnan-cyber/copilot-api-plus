// Anthropic API Types

export interface AnthropicMessagesPayload {
  model: string
  messages: Array<AnthropicMessage>
  max_tokens: number
  system?: string | Array<AnthropicTextBlock>
  metadata?: {
    user_id?: string
  }
  stop_sequences?: Array<string>
  stream?: boolean
  temperature?: number
  top_p?: number
  top_k?: number
  tools?: Array<AnthropicTool>
  tool_choice?: {
    type: "auto" | "any" | "tool" | "none"
    name?: string
  }
  thinking?: {
    type: "enabled" | "adaptive"
    budget_tokens?: number
  }
  /**
   * Anthropic's 2026 top-level `effort` field is NOT accepted by
   * Copilot's `/v1/messages` mirror — it returns 400 "Extra inputs
   * are not permitted". Kept for type-completeness / client
   * passthrough; `sanitizeForCopilotBackend` strips it before forward.
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max"
  /**
   * Copilot-specific control for adaptive thinking depth. Per-model
   * allowed values come from the model's `supports.reasoning_effort`
   * array in `/models` (Opus 4.8/4.7 = `["medium"]`, Sonnet 4.6 =
   * `["low","medium","high"]`). Sending an unsupported value 400s.
   */
  output_config?: {
    effort?: "low" | "medium" | "high" | "max" | "xhigh"
    format?: unknown
  }
  service_tier?: "auto" | "standard_only"
}

export interface AnthropicTextBlock {
  type: "text"
  text: string
}

export interface AnthropicImageBlock {
  type: "image"
  source: {
    type: "base64"
    media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"
    data: string
  }
}

export interface AnthropicToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  content: string
  is_error?: boolean
}

export interface AnthropicToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}

export interface AnthropicThinkingBlock {
  type: "thinking"
  thinking: string
  signature?: string
}

/**
 * Anthropic also emits `redacted_thinking` blocks containing an opaque,
 * server-encrypted payload when extended-thinking content is redacted.
 * We don't render these — they're stripped before forwarding to Copilot —
 * but they must appear in the type so the sanitizer's discriminator
 * comparison stays valid.
 */
export interface AnthropicRedactedThinkingBlock {
  type: "redacted_thinking"
  data: string
}

export type AnthropicUserContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolResultBlock

export type AnthropicAssistantContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock

export interface AnthropicUserMessage {
  role: "user"
  content: string | Array<AnthropicUserContentBlock>
}

export interface AnthropicAssistantMessage {
  role: "assistant"
  content: string | Array<AnthropicAssistantContentBlock>
}

export type AnthropicMessage = AnthropicUserMessage | AnthropicAssistantMessage

/**
 * Client-defined custom function tool (no `type` field, has `input_schema`).
 * This is the only shape OpenAI chat-completions can natively forward.
 */
export interface AnthropicCustomTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

/**
 * Anthropic server-side tool (e.g. `web_search_20250305`, `web_fetch_*`,
 * `bash_20250124`, `computer_20250124`, `text_editor_20250728`,
 * `code_execution_20250825`). Has a `type` discriminator and arbitrary
 * extra fields. Copilot's `/v1/messages` mirror may reject some of these
 * (notably web_search/web_fetch on Vertex). When that happens, the
 * proxy-web-fallback layer intercepts the rejection and emulates the tool
 * itself via the OpenAI chat-completions tool loop.
 */
export interface AnthropicServerTool {
  type: string
  name?: string
  [key: string]: unknown
}

export type AnthropicTool = AnthropicCustomTool | AnthropicServerTool

export interface AnthropicResponse {
  id: string
  type: "message"
  role: "assistant"
  content: Array<AnthropicAssistantContentBlock>
  model: string
  stop_reason:
    | "end_turn"
    | "max_tokens"
    | "stop_sequence"
    | "tool_use"
    | "pause_turn"
    | "refusal"
    | null
  stop_sequence: string | null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    service_tier?: "standard" | "priority" | "batch"
  }
}

export type AnthropicResponseContentBlock = AnthropicAssistantContentBlock

// Anthropic Stream Event Types
export interface AnthropicMessageStartEvent {
  type: "message_start"
  message: Omit<
    AnthropicResponse,
    "content" | "stop_reason" | "stop_sequence"
  > & {
    content: []
    stop_reason: null
    stop_sequence: null
  }
}

export interface AnthropicContentBlockStartEvent {
  type: "content_block_start"
  index: number
  content_block:
    | { type: "text"; text: string }
    | (Omit<AnthropicToolUseBlock, "input"> & {
        input: Record<string, unknown>
      })
    | { type: "thinking"; thinking: string }
}

export interface AnthropicContentBlockDeltaEvent {
  type: "content_block_delta"
  index: number
  delta:
    | { type: "text_delta"; text: string }
    | { type: "input_json_delta"; partial_json: string }
    | { type: "thinking_delta"; thinking: string }
    | { type: "signature_delta"; signature: string }
}

export interface AnthropicContentBlockStopEvent {
  type: "content_block_stop"
  index: number
}

export interface AnthropicMessageDeltaEvent {
  type: "message_delta"
  delta: {
    stop_reason?: AnthropicResponse["stop_reason"]
    stop_sequence?: string | null
  }
  usage?: {
    input_tokens?: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

export interface AnthropicMessageStopEvent {
  type: "message_stop"
}

export interface AnthropicPingEvent {
  type: "ping"
}

export interface AnthropicErrorEvent {
  type: "error"
  error: {
    type: string
    message: string
  }
}

export type AnthropicStreamEventData =
  | AnthropicMessageStartEvent
  | AnthropicContentBlockStartEvent
  | AnthropicContentBlockDeltaEvent
  | AnthropicContentBlockStopEvent
  | AnthropicMessageDeltaEvent
  | AnthropicMessageStopEvent
  | AnthropicPingEvent
  | AnthropicErrorEvent

// State for streaming translation
export interface AnthropicStreamState {
  messageStartSent: boolean
  contentBlockIndex: number
  contentBlockOpen: boolean
  toolCalls: {
    [openAIToolIndex: number]: {
      id: string
      name: string
      anthropicBlockIndex: number
    }
  }
  // Thinking state
  thinkingBlockOpen: boolean
  thinkingRequested: boolean
}
