/**
 * Antigravity Chat Completions Route
 *
 * OpenAI-compatible chat completions endpoint for Antigravity.
 */

import { Hono } from "hono"

import {
  createAntigravityChatCompletion,
  type ChatCompletionRequest,
} from "~/services/antigravity/create-chat-completions"

const app = new Hono()

app.post("/", async (c) => {
  const body = await c.req.json<ChatCompletionRequest>()

  const response = await createAntigravityChatCompletion(
    body,
    c.req.raw.headers,
  )

  // Copy response headers
  const headers = new Headers(response.headers)

  if (body.stream) {
    return new Response(response.body, {
      status: response.status,
      headers,
    })
  }

  return new Response(await response.text(), {
    status: response.status,
    headers,
  })
})

export const antigravityChatCompletionsRoute = app
