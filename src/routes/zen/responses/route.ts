/**
 * OpenCode Zen Responses Route
 *
 * Proxies OpenAI Responses API requests to Zen.
 * Used for GPT-5 series models.
 */

import consola from "consola"
import { Hono } from "hono"

import { state } from "~/lib/state"
import {
  createZenResponses,
  type ZenResponsesRequest,
} from "~/services/zen/create-responses"

export const zenResponsesRoutes = new Hono()

zenResponsesRoutes.post("/", async (c) => {
  if (!state.zenMode || !state.zenApiKey) {
    return c.json(
      { error: "Zen mode is not enabled. Start with --zen flag." },
      400,
    )
  }

  try {
    const body: ZenResponsesRequest = await c.req.json()
    consola.debug("Zen responses request:", body.model)

    const response = await createZenResponses(body)

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
    consola.error("Zen responses error:", error)
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
