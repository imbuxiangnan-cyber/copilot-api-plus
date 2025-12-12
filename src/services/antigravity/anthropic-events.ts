/**
 * Anthropic SSE Event Builder
 *
 * Builds Anthropic-compatible SSE events for streaming responses.
 * Extracted for better code organization and reusability.
 */

const encoder = new TextEncoder()

/**
 * Create message_start event
 */
export function createMessageStart(
  messageId: string,
  model: string,
): Uint8Array {
  const event = {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
    },
  }
  return encoder.encode(
    `event: message_start\ndata: ${JSON.stringify(event)}\n\n`,
  )
}

/**
 * Create message_stop event
 */
export function createMessageStop(): Uint8Array {
  const event = { type: "message_stop" }
  return encoder.encode(
    `event: message_stop\ndata: ${JSON.stringify(event)}\n\n`,
  )
}

/**
 * Create content_block_start event for thinking
 */
export function createThinkingBlockStart(index: number): Uint8Array {
  const event = {
    type: "content_block_start",
    index,
    content_block: {
      type: "thinking",
      thinking: "",
    },
  }
  return encoder.encode(
    `event: content_block_start\ndata: ${JSON.stringify(event)}\n\n`,
  )
}

/**
 * Create content_block_delta event for thinking
 */
export function createThinkingDelta(index: number, text: string): Uint8Array {
  const event = {
    type: "content_block_delta",
    index,
    delta: {
      type: "thinking_delta",
      thinking: text,
    },
  }
  return encoder.encode(
    `event: content_block_delta\ndata: ${JSON.stringify(event)}\n\n`,
  )
}

/**
 * Create content_block_start event for text
 */
export function createTextBlockStart(index: number): Uint8Array {
  const event = {
    type: "content_block_start",
    index,
    content_block: {
      type: "text",
      text: "",
    },
  }
  return encoder.encode(
    `event: content_block_start\ndata: ${JSON.stringify(event)}\n\n`,
  )
}

/**
 * Create content_block_delta event for text
 */
export function createTextDelta(index: number, text: string): Uint8Array {
  const event = {
    type: "content_block_delta",
    index,
    delta: {
      type: "text_delta",
      text,
    },
  }
  return encoder.encode(
    `event: content_block_delta\ndata: ${JSON.stringify(event)}\n\n`,
  )
}

/**
 * Create content_block_stop event
 */
export function createBlockStop(index: number): Uint8Array {
  const event = {
    type: "content_block_stop",
    index,
  }
  return encoder.encode(
    `event: content_block_stop\ndata: ${JSON.stringify(event)}\n\n`,
  )
}

/**
 * Create content_block_start event for tool_use
 */
export function createToolBlockStart(
  index: number,
  toolId: string,
  name: string,
): Uint8Array {
  const event = {
    type: "content_block_start",
    index,
    content_block: {
      type: "tool_use",
      id: toolId,
      name,
      input: {},
    },
  }
  return encoder.encode(
    `event: content_block_start\ndata: ${JSON.stringify(event)}\n\n`,
  )
}

/**
 * Create content_block_delta event for tool input
 */
export function createToolDelta(index: number, args: unknown): Uint8Array {
  const event = {
    type: "content_block_delta",
    index,
    delta: {
      type: "input_json_delta",
      partial_json: JSON.stringify(args),
    },
  }
  return encoder.encode(
    `event: content_block_delta\ndata: ${JSON.stringify(event)}\n\n`,
  )
}

/**
 * Create message_delta event with stop reason and usage
 */
export function createMessageDelta(
  stopReason: string,
  outputTokens: number,
): Uint8Array {
  const event = {
    type: "message_delta",
    delta: {
      stop_reason: stopReason,
      stop_sequence: null,
    },
    usage: {
      output_tokens: outputTokens,
    },
  }
  return encoder.encode(
    `event: message_delta\ndata: ${JSON.stringify(event)}\n\n`,
  )
}

/**
 * Generate a unique message ID
 */
export function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

/**
 * Generate a unique tool ID
 */
export function generateToolId(): string {
  return `toolu_${Date.now()}`
}
