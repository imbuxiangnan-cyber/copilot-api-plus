/**
 * OpenCode Zen Models
 *
 * Fetches available models from OpenCode Zen.
 */

import consola from "consola"
import { state } from "~/lib/state"

export interface ZenModel {
  id: string
  object: string
  created: number
  owned_by: string
}

export interface ZenModelsResponse {
  object: string
  data: ZenModel[]
}

/**
 * Fetch available models from OpenCode Zen
 */
export async function getZenModels(): Promise<ZenModelsResponse> {
  const apiKey = state.zenApiKey

  if (!apiKey) {
    throw new Error("Zen API key not configured")
  }

  const response = await fetch("https://opencode.ai/zen/v1/models", {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  })

  if (!response.ok) {
    throw new Error(`Failed to fetch Zen models: ${response.status} ${response.statusText}`)
  }

  const data = (await response.json()) as ZenModelsResponse
  consola.debug(`Fetched ${data.data.length} models from Zen`)

  return data
}

/**
 * Cache Zen models in state
 */
export async function cacheZenModels(): Promise<void> {
  try {
    const models = await getZenModels()
    state.zenModels = models
    consola.info(`Loaded ${models.data.length} Zen models`)
  } catch (error) {
    consola.error("Failed to load Zen models:", error)
    throw error
  }
}
