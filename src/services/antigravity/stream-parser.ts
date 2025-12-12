/**
 * Antigravity Stream Parser
 *
 * Parses SSE stream responses from Antigravity API and emits events.
 * Extracted for better code organization and reduced complexity.
 */

/** Parsed part from Antigravity response */
export interface AntigravityPart {
  text?: string
  thought?: boolean
  functionCall?: {
    name: string
    args: unknown
  }
}

/** Parsed candidate from Antigravity response */
export interface AntigravityCandidate {
  content?: {
    parts?: Array<AntigravityPart>
  }
  finishReason?: string
}

/** Usage metadata from Antigravity response */
export interface AntigravityUsage {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
}

/** Parsed Antigravity SSE data */
export interface AntigravityData {
  response?: {
    candidates?: Array<AntigravityCandidate>
    usageMetadata?: AntigravityUsage
  }
  candidates?: Array<AntigravityCandidate>
  usageMetadata?: AntigravityUsage
}

/** Stream state for tracking parsing progress */
export interface StreamState {
  buffer: string
  inputTokens: number
  outputTokens: number
  contentBlockIndex: number
  thinkingBlockStarted: boolean
  textBlockStarted: boolean
}

/** Events emitted during stream parsing */
export type StreamEvent =
  | { type: "thinking_start"; index: number }
  | { type: "thinking_delta"; index: number; text: string }
  | { type: "thinking_stop"; index: number }
  | { type: "text_start"; index: number }
  | { type: "text_delta"; index: number; text: string }
  | { type: "text_stop"; index: number }
  | { type: "tool_use"; index: number; name: string; args: unknown }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "finish"; stopReason: string }

/**
 * Create initial stream state
 */
export function createStreamState(): StreamState {
  return {
    buffer: "",
    inputTokens: 0,
    outputTokens: 0,
    contentBlockIndex: 0,
    thinkingBlockStarted: false,
    textBlockStarted: false,
  }
}

/**
 * Parse a single SSE line and return the JSON data if valid
 */
export function parseSSELine(line: string): AntigravityData | null {
  if (!line.startsWith("data: ")) {
    return null
  }

  const data = line.slice(6).trim()
  if (data === "[DONE]" || data === "") {
    return null
  }

  try {
    return JSON.parse(data) as AntigravityData
  } catch {
    return null
  }
}

/**
 * Extract candidates and usage from parsed data
 */
export function extractFromData(data: AntigravityData): {
  candidates: Array<AntigravityCandidate>
  usage: AntigravityUsage | undefined
} {
  const candidates = data.response?.candidates || data.candidates || []
  const usage = data.response?.usageMetadata || data.usageMetadata
  return { candidates, usage }
}

/**
 * Process a single part and emit events
 */
export function processPart(
  part: AntigravityPart,
  state: StreamState,
  emit: (event: StreamEvent) => void,
): void {
  // Handle thinking content
  if (part.thought && part.text) {
    processThinkingPart(part.text, state, emit)
    return
  }

  // Handle regular text content
  if (part.text && !part.thought) {
    processTextPart(part.text, state, emit)
    return
  }

  // Handle function calls
  if (part.functionCall) {
    processToolPart(part.functionCall, state, emit)
  }
}

/**
 * Process thinking content
 */
function processThinkingPart(
  text: string,
  state: StreamState,
  emit: (event: StreamEvent) => void,
): void {
  if (!state.thinkingBlockStarted) {
    emit({ type: "thinking_start", index: state.contentBlockIndex })
    state.thinkingBlockStarted = true
  }
  emit({ type: "thinking_delta", index: state.contentBlockIndex, text })
}

/**
 * Process text content
 */
function processTextPart(
  text: string,
  state: StreamState,
  emit: (event: StreamEvent) => void,
): void {
  // Close thinking block if open
  if (state.thinkingBlockStarted && !state.textBlockStarted) {
    emit({ type: "thinking_stop", index: state.contentBlockIndex })
    state.contentBlockIndex++
    state.thinkingBlockStarted = false
  }

  // Start text block if not started
  if (!state.textBlockStarted) {
    emit({ type: "text_start", index: state.contentBlockIndex })
    state.textBlockStarted = true
  }

  emit({ type: "text_delta", index: state.contentBlockIndex, text })
}

/**
 * Process tool/function call
 */
function processToolPart(
  functionCall: { name: string; args: unknown },
  state: StreamState,
  emit: (event: StreamEvent) => void,
): void {
  // Close previous block if open
  if (state.textBlockStarted) {
    emit({ type: "text_stop", index: state.contentBlockIndex })
    state.contentBlockIndex++
    state.textBlockStarted = false
  } else if (state.thinkingBlockStarted) {
    emit({ type: "thinking_stop", index: state.contentBlockIndex })
    state.contentBlockIndex++
    state.thinkingBlockStarted = false
  }

  emit({
    type: "tool_use",
    index: state.contentBlockIndex,
    name: functionCall.name,
    args: functionCall.args,
  })
  state.contentBlockIndex++
}

/**
 * Handle finish reason and close open blocks
 */
export function handleFinish(
  state: StreamState,
  emit: (event: StreamEvent) => void,
): void {
  if (state.textBlockStarted) {
    emit({ type: "text_stop", index: state.contentBlockIndex })
    state.textBlockStarted = false
  } else if (state.thinkingBlockStarted) {
    emit({ type: "thinking_stop", index: state.contentBlockIndex })
    state.thinkingBlockStarted = false
  }

  emit({
    type: "usage",
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
  })
  emit({ type: "finish", stopReason: "end_turn" })
}

/**
 * Process chunk and update buffer, returning complete lines
 */
export function processChunk(chunk: string, state: StreamState): Array<string> {
  state.buffer += chunk
  const lines = state.buffer.split("\n")
  state.buffer = lines.pop() || ""
  return lines
}
