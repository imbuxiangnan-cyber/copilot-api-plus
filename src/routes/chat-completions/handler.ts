import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { truncateMessages } from "~/lib/context-compression"
import { setTokenUsage, signalStreamDone } from "~/lib/model-logger"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { findModel, isNullish } from "~/lib/utils"
import {
  createChatCompletions,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

/**
 * Calculate token count, log it, and auto-truncate if needed.
 *
 * Uses multi-strategy exact matching via findModel() to handle
 * mismatches between requested and available model names.
 */
async function processPayloadTokens(
  payload: ChatCompletionsPayload,
): Promise<ChatCompletionsPayload> {
  const selectedModel = findModel(payload.model)

  if (!selectedModel) {
    consola.warn("No model selected, skipping token count calculation")
    return payload
  }

  try {
    const tokenCount = await getTokenCount(payload, selectedModel)
    consola.debug("Current token count:", tokenCount)

    // Auto-truncate if prompt tokens exceed model limit
    const truncated = await truncateMessages(payload, selectedModel)

    // Set max_tokens if not provided
    if (isNullish(truncated.max_tokens)) {
      const withMaxTokens = {
        ...truncated,
        max_tokens: selectedModel.capabilities.limits.max_output_tokens,
      }
      consola.debug(
        "Set max_tokens to:",
        JSON.stringify(withMaxTokens.max_tokens),
      )
      return withMaxTokens
    }

    return truncated
  } catch (error) {
    consola.warn("Failed to calculate token count:", error)
    return payload
  }
}

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const rawPayload = await c.req.json<ChatCompletionsPayload>()
  consola.debug("Request payload:", JSON.stringify(rawPayload).slice(-400))

  const payload = await processPayloadTokens(rawPayload)

  if (state.manualApprove) await awaitApproval()

  const response = await createChatCompletions(payload)

  if (isNonStreaming(response)) {
    consola.debug("Non-streaming response:", JSON.stringify(response))
    if (response.usage) {
      setTokenUsage({
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
        cacheReadTokens: response.usage.prompt_tokens_details?.cached_tokens,
      })
    }
    return c.json(response)
  }

  consola.debug("Streaming response")
  return streamSSE(c, async (stream) => {
    for await (const chunk of response) {
      consola.debug("Streaming chunk:", JSON.stringify(chunk))

      // Extract token usage from stream chunks
      try {
        const sseChunk = chunk as SSEMessage & { data?: string }
        if (sseChunk.data && sseChunk.data !== "[DONE]") {
          const parsed = JSON.parse(sseChunk.data) as {
            usage?: {
              prompt_tokens?: number
              completion_tokens?: number
              prompt_tokens_details?: { cached_tokens?: number }
            }
          }
          if (parsed.usage) {
            const usage = {
              inputTokens: parsed.usage.prompt_tokens ?? 0,
              outputTokens: parsed.usage.completion_tokens ?? 0,
              cacheReadTokens:
                parsed.usage.prompt_tokens_details?.cached_tokens,
            }
            setTokenUsage(usage)
          }
        }
      } catch {
        // Ignore parse errors in usage extraction
      }

      await stream.writeSSE(chunk as SSEMessage)
    }
    signalStreamDone()
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
