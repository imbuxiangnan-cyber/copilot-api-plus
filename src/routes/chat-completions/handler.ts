import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { findModel, isNullish } from "~/lib/utils"
import {
  createChatCompletions,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

/**
 * Set max_tokens from model limits if not already provided in the payload.
 */
function applyMaxTokens(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  if (!isNullish(payload.max_tokens)) {
    return payload
  }

  const selectedModel = findModel(payload.model)
  if (!selectedModel) {
    return payload
  }

  const maxTokens = selectedModel.capabilities.limits.max_output_tokens
  if (maxTokens) {
    consola.debug("Set max_tokens to:", maxTokens)
    return { ...payload, max_tokens: maxTokens }
  }

  return payload
}

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const rawPayload = await c.req.json<ChatCompletionsPayload>()
  consola.debug("Request payload:", JSON.stringify(rawPayload).slice(-400))

  const payload = applyMaxTokens(rawPayload)

  if (state.manualApprove) await awaitApproval()

  const response = await createChatCompletions(payload)

  if (isNonStreaming(response)) {
    // Map reasoning_text to reasoning_content for OpenAI-compatible clients
    const mappedResponse = mapReasoningFields(response)
    consola.debug("Non-streaming response:", JSON.stringify(mappedResponse))
    return c.json(mappedResponse)
  }

  consola.debug("Streaming response")
  return streamSSE(c, async (stream) => {
    try {
      for await (const chunk of response) {
        consola.debug("Streaming chunk:", JSON.stringify(chunk))
        await stream.writeSSE(chunk as SSEMessage)
      }
    } catch (error) {
      const message = (error as Error).message || String(error)
      consola.warn(`SSE stream interrupted: ${message}`)
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

/**
 * Map `reasoning_text` (Copilot-specific) to `reasoning_content` (OpenAI-compatible)
 * so that downstream OpenAI-compatible clients can consume the reasoning output.
 */
function mapReasoningFields(
  response: ChatCompletionResponse,
): ChatCompletionResponse {
  const hasReasoningText = response.choices.some(
    (c) => (c.message as Record<string, unknown>).reasoning_text,
  )
  if (!hasReasoningText) return response

  return {
    ...response,
    choices: response.choices.map((choice) => {
      const msg = choice.message as Record<string, unknown>
      if (!msg.reasoning_text) return choice
      return {
        ...choice,
        message: {
          ...choice.message,
          reasoning_content:
            (msg.reasoning_text as string) || choice.message.reasoning_content,
        },
      }
    }),
  }
}
