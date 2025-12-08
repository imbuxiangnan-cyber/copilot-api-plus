/**
 * OpenCode Zen Chat Completions Proxy
 *
 * Proxies chat completion requests to OpenCode Zen API.
 */

import consola from "consola"
import { state } from "~/lib/state"

export interface ZenChatCompletionRequest {
  model: string
  messages: Array<{
    role: string
    content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
  }>
  temperature?: number
  max_tokens?: number
  stream?: boolean
  [key: string]: unknown
}

export interface ZenChatCompletionResponse {
  id: string
  object: string
  created: number
  model: string
  choices: Array<{
    index: number
    message: {
      role: string
      content: string
    }
    finish_reason: string
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

/**
 * Create chat completions via OpenCode Zen
 */
export async function createZenChatCompletions(
  request: ZenChatCompletionRequest,
  signal?: AbortSignal,
): Promise<Response> {
  const apiKey = state.zenApiKey

  if (!apiKey) {
    throw new Error("Zen API key not configured")
  }

  consola.debug(`Zen chat completions request for model: ${request.model}`)

  const response = await fetch("https://opencode.ai/zen/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(request),
    signal,
  })

  if (!response.ok) {
    const errorText = await response.text()
    consola.error(`Zen API error: ${response.status} ${errorText}`)
    throw new Error(`Zen API error: ${response.status} ${errorText}`)
  }

  return response
}
