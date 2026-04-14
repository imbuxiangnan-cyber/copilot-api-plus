import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { resetConnections } from "~/lib/proxy"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import {
  translateChunkToAnthropicEvents,
  translateErrorToAnthropicErrorEvent,
} from "./stream-translation"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()

  // Debug: log key Anthropic request parameters
  consola.debug("Anthropic request:", {
    model: anthropicPayload.model,
    stream: anthropicPayload.stream,
    thinking: anthropicPayload.thinking,
    tool_choice: anthropicPayload.tool_choice,
    tools_count: anthropicPayload.tools ? anthropicPayload.tools.length : 0,
    messages_count: anthropicPayload.messages.length,
    max_tokens: anthropicPayload.max_tokens,
  })

  const openAIPayload = translateToOpenAI(anthropicPayload)

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createChatCompletions(openAIPayload)

  if (isNonStreaming(response)) {
    const anthropicResponse = translateToAnthropic(response)
    return c.json(anthropicResponse)
  }

  return streamSSE(c, async (stream) => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
      thinkingRequested: Boolean(anthropicPayload.thinking),
    }

    try {
      for await (const rawEvent of response) {
        const event = rawEvent as { data?: string }
        if (event.data === "[DONE]") {
          break
        }

        if (!event.data) {
          continue
        }

        let chunk: ChatCompletionChunk
        try {
          chunk = JSON.parse(event.data) as ChatCompletionChunk
        } catch {
          consola.debug("Skipping malformed SSE chunk")
          continue
        }
        const events = translateChunkToAnthropicEvents(chunk, streamState)

        for (const event of events) {
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          })
        }
      }
    } catch (error) {
      const message = (error as Error).message || String(error)
      consola.warn(`SSE stream interrupted: ${message}`)
      resetConnections()
      try {
        const errorEvent = translateErrorToAnthropicErrorEvent()
        await stream.writeSSE({
          event: errorEvent.type,
          data: JSON.stringify(errorEvent),
        })
      } catch {
        // Client already disconnected — nothing we can do
      }
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
