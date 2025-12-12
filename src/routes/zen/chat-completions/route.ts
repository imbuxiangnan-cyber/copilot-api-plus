/**
 * OpenCode Zen Chat Completions Route
 *
 * Proxies OpenAI-format chat completion requests to Zen.
 */

import consola from "consola"
import { Hono } from "hono"

import { state } from "~/lib/state"
import {
  createZenChatCompletions,
  type ZenChatCompletionRequest,
} from "~/services/zen/create-chat-completions"

export const zenCompletionRoutes = new Hono()

zenCompletionRoutes.post("/", async (c) => {
  if (!state.zenMode || !state.zenApiKey) {
    return c.json(
      { error: "Zen mode is not enabled. Start with --zen flag." },
      400,
    )
  }

  try {
    const body: ZenChatCompletionRequest = await c.req.json()
    consola.debug("Zen chat completion request:", body.model)

    const response = await createZenChatCompletions(body)

    // Handle streaming
    if (body.stream) {
      const headers = new Headers()
      headers.set("Content-Type", "text/event-stream")
      headers.set("Cache-Control", "no-cache")
      headers.set("Connection", "keep-alive")

      return new Response(response.body, {
        status: response.status,
        headers,
      })
    }

    // Non-streaming response
    const data = await response.json()
    return c.json(data)
  } catch (error) {
    consola.error("Zen chat completion error:", error)
    return c.json(
      {
        error: {
          message: error instanceof Error ? error.message : "Unknown error",
          type: "zen_error",
        },
      },
      500,
    )
  }
})
