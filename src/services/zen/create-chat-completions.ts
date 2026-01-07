/**
 * OpenCode Zen Chat Completions Proxy
 *
 * Proxies chat completion requests to OpenCode Zen API.
 */

import consola from "consola"

import { state } from "~/lib/state"
import { sleep } from "~/lib/utils"

const MAX_RETRIES = 5
const DEFAULT_RETRY_DELAY = 500

export interface ZenChatCompletionRequest {
  model: string
  messages: Array<{
    role: string
    content:
      | string
      | Array<{ type: string; text?: string; image_url?: { url: string } }>
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
 * Parse retry delay from error response
 */
function parseRetryDelay(response: Response, errorText: string): number {
  const retryAfter = response.headers.get("Retry-After")
  if (retryAfter) {
    const seconds = Number.parseInt(retryAfter, 10)
    if (!Number.isNaN(seconds)) return seconds * 1000
  }

  try {
    const errorData = JSON.parse(errorText) as {
      error?: { retry_after?: number }
    }
    if (errorData.error?.retry_after) {
      return errorData.error.retry_after * 1000
    }
  } catch {
    // Ignore parse errors
  }

  return DEFAULT_RETRY_DELAY
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

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(
        "https://opencode.ai/zen/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(request),
          signal,
        },
      )

      if (response.ok) {
        return response
      }

      const errorText = await response.text()

      if (
        (response.status === 429 || response.status >= 500)
        && attempt < MAX_RETRIES
      ) {
        const retryDelay = parseRetryDelay(response, errorText)
        consola.info(
          `Zen rate limited (${response.status}), retrying in ${retryDelay}ms...`,
        )
        await sleep(retryDelay)
        continue
      }

      consola.error(`Zen API error: ${response.status} ${errorText}`)
      throw new Error(`Zen API error: ${response.status} ${errorText}`)
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error
      }
      if (attempt < MAX_RETRIES) {
        consola.warn(`Zen request failed, retrying... (${attempt + 1})`)
        await sleep(DEFAULT_RETRY_DELAY)
        continue
      }
      throw error
    }
  }

  throw new Error("Max retries exceeded")
}
