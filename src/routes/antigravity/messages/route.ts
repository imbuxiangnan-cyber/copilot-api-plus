/**
 * Antigravity Messages Route
 *
 * Anthropic-compatible messages endpoint for Antigravity.
 * This enables Claude Code to use Antigravity as backend.
 */

import consola from "consola"
import { Hono } from "hono"

import { state } from "~/lib/state"
import {
  createAntigravityMessages,
  type AnthropicMessageRequest,
} from "~/services/antigravity/create-messages"

export const antigravityMessagesRoute = new Hono()

antigravityMessagesRoute.post("/", async (c) => {
  if (!state.antigravityMode) {
    return c.json(
      {
        error:
          "Antigravity mode is not enabled. Start with --antigravity flag.",
      },
      400,
    )
  }

  try {
    const body: AnthropicMessageRequest = await c.req.json()
    consola.debug("Antigravity message request:", body.model)

    const response = await createAntigravityMessages(body)

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
    consola.error("Antigravity message error:", error)
    return c.json(
      {
        type: "error",
        error: {
          type: "antigravity_error",
          message: error instanceof Error ? error.message : "Unknown error",
        },
      },
      500,
    )
  }
})
