/**
 * Strip `<system-reminder>` blocks from client-supplied messages before
 * they are forwarded to the upstream model.
 *
 * Rationale: Claude Code injects `<system-reminder>` tags into user
 * messages (safety reminders, TodoWrite nudges, hook context, plan-file
 * notices, etc.). The upstream here is GitHub Copilot, which does not
 * participate in Claude Code's internal workflow — these reminders are
 * either harmful (safety reminders cause false-positive refusals on
 * legitimate user code) or irrelevant (TodoWrite / Plan mode mean
 * nothing to Copilot). We strip them all.
 *
 * Design notes:
 *   - Only `type: "text"` blocks are scanned. `tool_use`, `tool_result`,
 *     `image`, `thinking`, `document` blocks pass through untouched.
 *   - Blocks whose text becomes empty after stripping are **filtered
 *     out** (Anthropic API rejects empty text blocks with
 *     `text content blocks cannot be empty`).
 *   - Excess blank lines from removed reminders are collapsed:
 *     `\n{3,}` → `\n\n` (paragraph structure preserved).
 *   - Zero-allocation fast path: if no reminder is present anywhere in
 *     a text / content / message / payload, the original reference is
 *     returned unchanged.
 *   - Four layers of API are exported for ergonomic testing:
 *     `stripText`, `stripContent`, `stripMessage`, `stripSystemReminders`.
 */

import type {
  AnthropicAssistantContentBlock,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicUserContentBlock,
} from "./anthropic-types"

/** Matches `<system-reminder>…</system-reminder>` non-greedy, across lines. */
const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g

/** Cheap sentinel that lets callers skip the regex scan. */
const REMINDER_OPEN_TAG = "<system-reminder>"

/**
 * Strip every `<system-reminder>` block from a plain string.
 *
 * Collapses runs of 3+ newlines left behind by the removal into a
 * single blank line, then trims leading/trailing whitespace. Returns
 * the same reference if no reminder was present (zero allocation).
 */
export function stripText(s: string): string {
  if (!s.includes(REMINDER_OPEN_TAG)) return s
  return s
    .replaceAll(REMINDER_RE, "")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim()
}

type AnyContentBlock =
  | AnthropicUserContentBlock
  | AnthropicAssistantContentBlock

/**
 * Strip reminders from a block array. Non-text blocks pass through.
 * Text blocks that become empty after stripping are filtered out.
 * Returns the same reference if nothing changed.
 */
export function stripBlocks<B extends AnyContentBlock>(
  content: ReadonlyArray<B>,
): ReadonlyArray<B> {
  // Fast path: no text block contains a reminder → return as-is.
  const hasReminder = content.some(
    (b) => b.type === "text" && b.text.includes(REMINDER_OPEN_TAG),
  )
  if (!hasReminder) return content

  const out: Array<B> = []
  for (const b of content) {
    if (b.type !== "text") {
      out.push(b)
      continue
    }
    const t = stripText(b.text)
    if (t.length === 0) continue // drop empty-after-strip blocks
    out.push(t === b.text ? b : ({ ...b, text: t } as B))
  }
  return out
}

/**
 * Strip reminders from a message `content` field (string OR block array).
 * Returns the same reference if nothing changed.
 */
export function stripContent(
  content: string | ReadonlyArray<AnyContentBlock>,
): string | ReadonlyArray<AnyContentBlock> {
  if (typeof content === "string") return stripText(content)
  return stripBlocks(content)
}

/**
 * Strip reminders from a single message. Returns the same reference
 * if nothing changed.
 */
export function stripMessage(message: AnthropicMessage): AnthropicMessage {
  if (typeof message.content === "string") {
    const next = stripText(message.content)
    if (next === message.content) return message
    return { ...message, content: next } as AnthropicMessage
  }
  const next = stripBlocks(message.content as ReadonlyArray<AnyContentBlock>)
  if (next === message.content) return message
  return { ...message, content: next } as AnthropicMessage
}

/**
 * Return a shallow-cloned payload with `<system-reminder>` blocks
 * removed from every message's text content. The input payload is
 * NOT mutated; if no reminders are present anywhere, the original
 * payload reference is returned unchanged (no allocation).
 */
export function stripSystemReminders(
  payload: AnthropicMessagesPayload,
): AnthropicMessagesPayload {
  let changed = false
  const newMessages = payload.messages.map((m) => {
    const next = stripMessage(m)
    if (next !== m) changed = true
    return next
  })
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!changed) return payload
  return { ...payload, messages: newMessages }
}
