/**
 * OpenCode Zen Messages Route
 *
 * Proxies Anthropic-format message requests to Zen.
 * This enables Claude Code to use Zen as backend.
 */

import consola from "consola"
import { Hono } from "hono"

import { state } from "~/lib/state"
import {
  createZenMessages,
  type ZenMessageRequest,
} from "~/services/zen/create-messages"

export const zenMessageRoutes = new Hono()

zenMessageRoutes.post("/", async (c) => {
  if (!state.zenMode || !state.zenApiKey) {
    return c.json(
      { error: "Zen mode is not enabled. Start with --zen flag." },
      400,
    )
  }

  try {
    const body: ZenMessageRequest = await c.req.json()
    consola.debug("Zen message request:", body.model)

    const response = await createZenMessages(body)

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
    consola.error("Zen message error:", error)
    return c.json(
      {
        type: "error",
        error: {
          type: "zen_error",
          message: error instanceof Error ? error.message : "Unknown error",
        },
      },
      500,
    )
  }
})
