import consola from "consola"

import type {
  ChatCompletionsPayload,
  Message,
} from "~/services/copilot/create-chat-completions"
import type { Model } from "~/services/copilot/get-models"

import { getTokenCount } from "./tokenizer"

/**
 * Get the maximum prompt token limit for a model.
 * Prefers max_prompt_tokens, falls back to max_context_window_tokens minus max_output_tokens.
 */
const getMaxPromptTokens = (model: Model): number | undefined => {
  const limits = model.capabilities.limits
  if (limits.max_prompt_tokens) {
    return limits.max_prompt_tokens
  }
  if (limits.max_context_window_tokens) {
    // Reserve space for output tokens
    const outputReserve = limits.max_output_tokens ?? 4096
    return limits.max_context_window_tokens - outputReserve
  }
  return undefined
}

/**
 * Check if a message is a tool-related message (tool call or tool result).
 * Tool messages must be kept together with their paired assistant message.
 */
const isToolMessage = (message: Message): boolean => {
  return message.role === "tool"
}

/**
 * Check if an assistant message contains tool calls.
 */
const hasToolCalls = (message: Message): boolean => {
  return (
    message.role === "assistant"
    && Array.isArray(message.tool_calls)
    && message.tool_calls.length > 0
  )
}

/**
 * Group messages into logical units that must be kept together.
 * Tool call sequences (assistant with tool_calls -> tool results) form a single group.
 * System/developer messages are kept as individual groups.
 * Other messages are individual groups.
 */
interface MessageGroup {
  messages: Array<Message>
  isSystem: boolean
  isRecent: boolean
}

const groupMessages = (messages: Array<Message>): Array<MessageGroup> => {
  const groups: Array<MessageGroup> = []
  let i = 0

  while (i < messages.length) {
    const message = messages[i]

    // System/developer messages are always their own group
    if (message.role === "system" || message.role === "developer") {
      groups.push({ messages: [message], isSystem: true, isRecent: false })
      i++
      continue
    }

    // Assistant message with tool calls — group with following tool results
    if (hasToolCalls(message)) {
      const group: Array<Message> = [message]
      let j = i + 1
      while (j < messages.length && isToolMessage(messages[j])) {
        group.push(messages[j])
        j++
      }
      groups.push({ messages: group, isSystem: false, isRecent: false })
      i = j
      continue
    }

    // Regular message
    groups.push({ messages: [message], isSystem: false, isRecent: false })
    i++
  }

  return groups
}

/**
 * Create a truncation notice message to inform the model that earlier context was removed.
 */
const createTruncationNotice = (): Message => ({
  role: "user",
  content:
    "[Note: Earlier conversation history was automatically truncated to fit within the model's context window. The most recent messages have been preserved.]",
})

/**
 * Intelligently truncate messages to fit within the model's token limit.
 *
 * Strategy:
 * 1. Always preserve system/developer messages (they contain critical instructions)
 * 2. Always preserve the most recent messages (they contain the current task context)
 * 3. Remove middle conversation messages, oldest first
 * 4. Insert a truncation notice where messages were removed
 * 5. Keep tool call/result pairs together (never split them)
 *
 * Safety margin: keeps 5% below the limit to account for token counting inaccuracies.
 */
export const truncateMessages = async (
  payload: ChatCompletionsPayload,
  model: Model,
): Promise<ChatCompletionsPayload> => {
  const maxPromptTokens = getMaxPromptTokens(model)
  if (!maxPromptTokens) {
    consola.debug("No token limit found for model, skipping truncation")
    return payload
  }

  // Check current token count
  const tokenCount = await getTokenCount(payload, model)
  // Apply 5% safety margin
  const safeLimit = Math.floor(maxPromptTokens * 0.95)

  if (tokenCount.input <= safeLimit) {
    return payload
  }

  console.log(
    `Context too long (${tokenCount.input}/${maxPromptTokens} tokens), truncating...`,
  )

  const groups = groupMessages(payload.messages)

  // Separate system groups from conversation groups
  const systemGroups = groups.filter((g) => g.isSystem)
  const conversationGroups = groups.filter((g) => !g.isSystem)

  if (conversationGroups.length === 0) {
    consola.warn("No conversation messages to truncate, only system messages")
    return payload
  }

  // Binary search approach: find the minimum number of recent conversation groups
  // that, combined with system messages + truncation notice, fit within the limit.
  // We start by trying to keep all conversation groups, then progressively remove from the front.

  let truncatedPayload = payload
  let dropCount = 0
  const maxDrop = Math.max(0, conversationGroups.length - 1) // Keep at least the last group

  // Start by dropping oldest groups one at a time
  while (dropCount <= maxDrop) {
    const keptConversationGroups = conversationGroups.slice(dropCount)
    const truncationNotice = dropCount > 0 ? [createTruncationNotice()] : []

    const newMessages = [
      ...systemGroups.flatMap((g) => g.messages),
      ...truncationNotice,
      ...keptConversationGroups.flatMap((g) => g.messages),
    ]

    truncatedPayload = { ...payload, messages: newMessages }

    const newTokenCount = await getTokenCount(truncatedPayload, model)
    if (newTokenCount.input <= safeLimit) {
      if (dropCount > 0) {
        const droppedMessages = conversationGroups
          .slice(0, dropCount)
          .reduce((sum, g) => sum + g.messages.length, 0)
        console.log(
          `Truncated ${droppedMessages} msgs. Tokens: ${tokenCount.input} -> ${newTokenCount.input}`,
        )
      }
      return truncatedPayload
    }

    dropCount++
  }

  // If we still exceed after dropping all but the last conversation group,
  // return what we have — at least we tried our best
  const finalTokenCount = await getTokenCount(truncatedPayload, model)
  consola.warn(
    `Could not reduce tokens below limit even after maximum truncation. `
      + `Current: ${finalTokenCount.input}, limit: ${maxPromptTokens}. `
      + `System messages or the last message may be too large.`,
  )

  return truncatedPayload
}
