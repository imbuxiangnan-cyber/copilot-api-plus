/**
 * OpenCode Zen Responses Proxy
 *
 * Proxies OpenAI Responses API requests to OpenCode Zen.
 * Used for GPT-5 series models with stateful, agentic tool-use.
 */

import consola from "consola"

import { state } from "~/lib/state"
import { sleep } from "~/lib/utils"

const MAX_RETRIES = 5
const DEFAULT_RETRY_DELAY = 500

export interface ZenResponsesRequest {
  model: string
  input: string | Array<{ role: string; content: string }>
  instructions?: string
  tools?: Array<unknown>
  temperature?: number
  max_output_tokens?: number
  stream?: boolean
  [key: string]: unknown
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
 * Create responses via OpenCode Zen (OpenAI Responses API format)
 */
export async function createZenResponses(
  request: ZenResponsesRequest,
  signal?: AbortSignal,
): Promise<Response> {
  const apiKey = state.zenApiKey

  if (!apiKey) {
    throw new Error("Zen API key not configured")
  }

  consola.debug(`Zen responses request for model: ${request.model}`)

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch("https://opencode.ai/zen/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(request),
        signal,
      })

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

      consola.error(`Zen Responses API error: ${response.status} ${errorText}`)
      throw new Error(
        `Zen Responses API error: ${response.status} ${errorText}`,
      )
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
