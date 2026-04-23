/**
 * Strip noisy `<system-reminder>` blocks from client-supplied messages
 * before they are forwarded to the upstream model.
 *
 * Claude Code injects a variety of reminders (malware-analysis refusals,
 * todo-list nudges, hook-output annotations, etc.) into user turns.
 * Most of these are meant for the local CLI layer, not the upstream
 * model, and passing them through costs tokens and sometimes causes
 * the upstream model to refuse legitimate requests on the user's own
 * codebase.
 *
 * This is a pure, allocation-minimal text filter — it does not touch
 * tool-use / tool-result / image blocks, and leaves any message whose
 * content does not contain a reminder block exactly as-is.
 */

import type {
  AnthropicAssistantContentBlock,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicUserContentBlock,
} from "./anthropic-types"

// Match `<system-reminder>...</system-reminder>`, non-greedy across lines.
const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g

function stripFromText(text: string): string {
  if (!text.includes("<system-reminder>")) return text
  return text
    .replaceAll(REMINDER_RE, "")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim()
}

function stripFromBlock<
  B extends AnthropicUserContentBlock | AnthropicAssistantContentBlock,
>(block: B): B {
  if (block.type !== "text") return block
  const text: string = block.text
  const stripped = stripFromText(text)
  if (stripped === text) return block
  return { ...block, text: stripped } as B
}

function stripFromMessage(message: AnthropicMessage): AnthropicMessage {
  if (typeof message.content === "string") {
    const stripped = stripFromText(message.content)
    if (stripped === message.content) return message
    return { ...message, content: stripped } as AnthropicMessage
  }

  let changed = false
  const newBlocks = message.content.map((block) => {
    const next = stripFromBlock(block)
    if (next !== block) changed = true
    return next
  })
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!changed) return message
  return {
    ...message,
    content: newBlocks,
  } as AnthropicMessage
}

/**
 * Return a shallow-cloned payload with `<system-reminder>` blocks removed
 * from every message's text content.  The input payload is NOT mutated.
 * If no reminders are present anywhere, the original payload is returned
 * unchanged (no allocation).
 */
export function stripSystemReminders(
  payload: AnthropicMessagesPayload,
): AnthropicMessagesPayload {
  let changed = false
  const newMessages = payload.messages.map((m) => {
    const next = stripFromMessage(m)
    if (next !== m) changed = true
    return next
  })
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!changed) return payload
  return { ...payload, messages: newMessages }
}
