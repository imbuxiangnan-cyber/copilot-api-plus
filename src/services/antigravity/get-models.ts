/**
 * Google Antigravity Models
 *
 * Provides list of available models from Antigravity.
 * Based on: https://github.com/liuw1535/antigravity2api-nodejs
 */

/* eslint-disable require-atomic-updates */

import consola from "consola"

import { getValidAccessToken } from "./auth"

// Antigravity API endpoints
const ANTIGRAVITY_API_HOST = "daily-cloudcode-pa.sandbox.googleapis.com"
const ANTIGRAVITY_MODELS_URL = `https://${ANTIGRAVITY_API_HOST}/v1internal:fetchAvailableModels`
const ANTIGRAVITY_USER_AGENT = "antigravity/1.11.3 windows/amd64"

export interface AntigravityModel {
  id: string
  object: string
  created: number
  owned_by: string
}

export interface AntigravityModelsResponse {
  object: string
  data: Array<AntigravityModel>
}

/**
 * Fallback Antigravity models when API is unavailable
 * Based on antigravity2api-nodejs model list
 */
const FALLBACK_MODELS: Array<AntigravityModel> = [
  // Gemini models
  {
    id: "gemini-2.5-pro-exp-03-25",
    object: "model",
    created: 1700000000,
    owned_by: "google",
  },
  {
    id: "gemini-2.5-pro-preview-05-06",
    object: "model",
    created: 1700000000,
    owned_by: "google",
  },
  {
    id: "gemini-2.0-flash-exp",
    object: "model",
    created: 1700000000,
    owned_by: "google",
  },
  {
    id: "gemini-2.0-flash-001",
    object: "model",
    created: 1700000000,
    owned_by: "google",
  },
  {
    id: "gemini-2.0-flash-thinking-exp-1219",
    object: "model",
    created: 1700000000,
    owned_by: "google",
  },
  {
    id: "gemini-2.0-flash-thinking-exp",
    object: "model",
    created: 1700000000,
    owned_by: "google",
  },
  {
    id: "gemini-2.0-flash-thinking-exp-01-21",
    object: "model",
    created: 1700000000,
    owned_by: "google",
  },
  {
    id: "gemini-2.0-pro-exp-02-05",
    object: "model",
    created: 1700000000,
    owned_by: "google",
  },
  {
    id: "gemini-1.5-pro",
    object: "model",
    created: 1700000000,
    owned_by: "google",
  },
  {
    id: "gemini-1.5-flash",
    object: "model",
    created: 1700000000,
    owned_by: "google",
  },
  {
    id: "gemini-1.5-flash-8b",
    object: "model",
    created: 1700000000,
    owned_by: "google",
  },
  {
    id: "gemini-exp-1206",
    object: "model",
    created: 1700000000,
    owned_by: "google",
  },
  {
    id: "learnlm-1.5-pro-experimental",
    object: "model",
    created: 1700000000,
    owned_by: "google",
  },

  // Claude models (via Antigravity)
  {
    id: "claude-opus-4-5",
    object: "model",
    created: 1700000000,
    owned_by: "anthropic",
  },
  {
    id: "claude-sonnet-4-5",
    object: "model",
    created: 1700000000,
    owned_by: "anthropic",
  },
  {
    id: "claude-3-5-sonnet-20241022",
    object: "model",
    created: 1700000000,
    owned_by: "anthropic",
  },
  {
    id: "claude-3-5-haiku-20241022",
    object: "model",
    created: 1700000000,
    owned_by: "anthropic",
  },
  {
    id: "claude-3-opus-20240229",
    object: "model",
    created: 1700000000,
    owned_by: "anthropic",
  },
  {
    id: "claude-3-sonnet-20240229",
    object: "model",
    created: 1700000000,
    owned_by: "anthropic",
  },
  {
    id: "claude-3-haiku-20240307",
    object: "model",
    created: 1700000000,
    owned_by: "anthropic",
  },
]

// Cache for fetched models
let cachedModels: Array<AntigravityModel> | null = null
let cacheTimestamp: number = 0
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

/**
 * Fetch models from Antigravity API
 */
async function fetchModelsFromApi(): Promise<Array<AntigravityModel> | null> {
  const accessToken = await getValidAccessToken()

  if (!accessToken) {
    consola.debug("No access token available, using fallback models")
    return null
  }

  try {
    const response = await fetch(ANTIGRAVITY_MODELS_URL, {
      method: "POST",
      headers: {
        Host: ANTIGRAVITY_API_HOST,
        "User-Agent": ANTIGRAVITY_USER_AGENT,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Accept-Encoding": "gzip",
      },
      body: JSON.stringify({}),
    })

    if (!response.ok) {
      consola.warn(`Failed to fetch Antigravity models: ${response.status}`)
      return null
    }

    const data = (await response.json()) as {
      models?: Array<{
        name: string
        quotaInfo?: {
          remainingFraction?: number
          resetTime?: string
        }
      }>
    }

    if (!data.models || !Array.isArray(data.models)) {
      return null
    }

    // Convert to OpenAI format
    const models: Array<AntigravityModel> = data.models
      .filter((m) => {
        // Filter out models with no remaining quota
        const remaining = m.quotaInfo?.remainingFraction ?? 1
        return remaining > 0
      })
      .map((m) => {
        // Extract model ID from name (e.g., "models/gemini-2.0-flash" -> "gemini-2.0-flash")
        const modelId = m.name.replace("models/", "")
        const isGoogle =
          modelId.startsWith("gemini") || modelId.startsWith("learnlm")

        return {
          id: modelId,
          object: "model",
          created: 1700000000,
          owned_by: isGoogle ? "google" : "anthropic",
        }
      })

    consola.debug(`Fetched ${models.length} models from Antigravity API`)
    return models
  } catch (error) {
    consola.warn("Error fetching Antigravity models:", error)
    return null
  }
}

/**
 * Get available Antigravity models
 */
export async function getAntigravityModels(): Promise<AntigravityModelsResponse> {
  // Check cache
  if (cachedModels && Date.now() - cacheTimestamp < CACHE_TTL) {
    consola.debug(`Returning ${cachedModels.length} cached Antigravity models`)
    return {
      object: "list",
      data: cachedModels,
    }
  }

  // Try to fetch from API
  const apiModels = await fetchModelsFromApi()

  if (apiModels && apiModels.length > 0) {
    cachedModels = apiModels
    cacheTimestamp = Date.now()

    return {
      object: "list",
      data: apiModels,
    }
  }

  // Use fallback models
  consola.debug(
    `Returning ${FALLBACK_MODELS.length} fallback Antigravity models`,
  )

  return {
    object: "list",
    data: FALLBACK_MODELS,
  }
}

/**
 * Check if a model is a Claude model
 */
export function isClaudeModel(modelId: string): boolean {
  return modelId.startsWith("claude-")
}

/**
 * Check if a model is a thinking/reasoning model
 */
export function isThinkingModel(modelId: string): boolean {
  return modelId.includes("thinking")
}

/**
 * Check if a model is an image generation model
 */
export function isImageModel(modelId: string): boolean {
  return modelId.includes("image")
}
