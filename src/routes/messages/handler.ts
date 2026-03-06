import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { truncateMessages } from "~/lib/context-compression"
import { setTokenUsage } from "~/lib/model-logger"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { findModel } from "~/lib/utils"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { translateChunkToAnthropicEvents } from "./stream-translation"

/**
 * Auto-truncate OpenAI payload if prompt tokens exceed model limit.
 *
 * Uses multi-strategy exact matching via findModel() to handle
 * mismatches between Anthropic and Copilot model naming conventions.
 */
async function autoTruncatePayload(
  payload: ChatCompletionsPayload,
): Promise<ChatCompletionsPayload> {
  const selectedModel = findModel(payload.model)

  if (!selectedModel) {
    consola.warn(
      "No model selected for Anthropic endpoint, skipping auto-truncation",
    )
    return payload
  }

  try {
    return await truncateMessages(payload, selectedModel)
  } catch (error) {
    consola.warn("Failed to auto-truncate context:", error)
    return payload
  }
}

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  const rawOpenAIPayload = translateToOpenAI(anthropicPayload)

  // Auto-truncate if prompt tokens exceed model limit
  const openAIPayload = await autoTruncatePayload(rawOpenAIPayload)

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createChatCompletions(openAIPayload)

  if (isNonStreaming(response)) {
    const anthropicResponse = translateToAnthropic(response)
    setTokenUsage({
      inputTokens: anthropicResponse.usage.input_tokens,
      outputTokens: anthropicResponse.usage.output_tokens,
      cacheReadTokens: anthropicResponse.usage.cache_read_input_tokens,
      cacheCreationTokens: anthropicResponse.usage.cache_creation_input_tokens,
    })
    return c.json(anthropicResponse)
  }

  return streamSSE(c, async (stream) => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }

    for await (const rawEvent of response) {
      if (rawEvent.data === "[DONE]") {
        break
      }

      if (!rawEvent.data) {
        continue
      }

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      const events = translateChunkToAnthropicEvents(chunk, streamState)

      // Record token usage from the final chunk (which contains usage stats)
      if (chunk.usage) {
        setTokenUsage({
          inputTokens:
            chunk.usage.prompt_tokens
            - (chunk.usage.prompt_tokens_details?.cached_tokens ?? 0),
          outputTokens: chunk.usage.completion_tokens,
          cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens,
        })
        consola.info(
          `Token usage: in:${chunk.usage.prompt_tokens - (chunk.usage.prompt_tokens_details?.cached_tokens ?? 0)}`
            + ` out:${chunk.usage.completion_tokens}`
            + (chunk.usage.prompt_tokens_details?.cached_tokens ?
              ` cache_read:${chunk.usage.prompt_tokens_details.cached_tokens}`
            : ""),
        )
      }

      for (const event of events) {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
