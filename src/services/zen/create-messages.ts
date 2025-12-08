/**
 * OpenCode Zen Messages Proxy
 *
 * Proxies Anthropic-format message requests to OpenCode Zen API.
 */

import consola from "consola"
import { state } from "~/lib/state"

export interface ZenMessageRequest {
  model: string
  messages: Array<{
    role: string
    content: string | Array<{ type: string; text?: string; source?: unknown }>
  }>
  max_tokens: number
  temperature?: number
  stream?: boolean
  system?: string | Array<{ type: string; text: string }>
  [key: string]: unknown
}

/**
 * Create messages via OpenCode Zen (Anthropic format)
 */
export async function createZenMessages(
  request: ZenMessageRequest,
  signal?: AbortSignal,
): Promise<Response> {
  const apiKey = state.zenApiKey

  if (!apiKey) {
    throw new Error("Zen API key not configured")
  }

  consola.debug(`Zen messages request for model: ${request.model}`)

  const response = await fetch("https://opencode.ai/zen/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(request),
    signal,
  })

  if (!response.ok) {
    const errorText = await response.text()
    consola.error(`Zen Messages API error: ${response.status} ${errorText}`)
    throw new Error(`Zen Messages API error: ${response.status} ${errorText}`)
  }

  return response
}
