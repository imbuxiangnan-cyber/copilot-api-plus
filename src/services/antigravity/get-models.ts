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

export interface AntigravityQuotaInfo {
  remainingFraction: number
  resetTime: string
}

export interface AntigravityModel {
  id: string
  object: string
  created: number
  owned_by: string
  quotaInfo?: AntigravityQuotaInfo
}

export interface AntigravityModelsResponse {
  object: string
  data: Array<AntigravityModel>
}

/**
 * Fallback Antigravity models when API is unavailable
 * Updated based on actual API response (December 2024)
 */
const FALLBACK_MODELS: Array<AntigravityModel> = [
  // Gemini models
  {
    id: "gemini-2.5-pro",
    object: "model",
    created: 1700000000,
    owned_by: "google",
  },
  {
    id: "gemini-2.5-flash",
    object: "model",
    created: 1700000000,
    owned_by: "google",
  },
  {
    id: "gemini-2.5-flash-lite",
    object: "model",
    created: 1700000000,
    owned_by: "google",
  },
  {
    id: "gemini-2.5-flash-thinking",
    object: "model",
    created: 1700000000,
    owned_by: "google",
  },
  {
    id: "gemini-3-pro-low",
    object: "model",
    created: 1700000000,
    owned_by: "google",
  },
  {
    id: "gemini-3-pro-high",
    object: "model",
    created: 1700000000,
    owned_by: "google",
  },
  {
    id: "gemini-3-pro-image",
    object: "model",
    created: 1700000000,
    owned_by: "google",
  },
  {
    id: "gemini-3-flash",
    object: "model",
    created: 1700000000,
    owned_by: "google",
  },

  // Claude models (via Antigravity)
  {
    id: "claude-sonnet-4-5",
    object: "model",
    created: 1700000000,
    owned_by: "anthropic",
  },
  {
    id: "claude-sonnet-4-5-thinking",
    object: "model",
    created: 1700000000,
    owned_by: "anthropic",
  },
  {
    id: "claude-opus-4-5-thinking",
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

    // API returns models as object (dictionary), not array
    // Format: { "models": { "model-id": { "quotaInfo": {...}, ... }, ... } }
    const data = (await response.json()) as {
      models?: Record<string, {
        displayName?: string
        maxTokens?: number
        quotaInfo?: {
          remainingFraction?: number
          resetTime?: string
        }
      }>
    }

    if (!data.models || typeof data.models !== "object") {
      consola.warn("No models object in response")
      return null
    }

    // Convert object to array format
    const modelEntries = Object.entries(data.models)
    consola.debug(`Antigravity API returned ${modelEntries.length} models`)

    // Filter to only include Gemini and Claude models (skip internal models like chat_20706)
    const models: Array<AntigravityModel> = modelEntries
      .filter(([modelId, info]) => {
        // Only include gemini, learnlm, and claude models
        const isPublicModel = modelId.startsWith("gemini") ||
                              modelId.startsWith("learnlm") ||
                              modelId.startsWith("claude")
        // Filter out models with no remaining quota
        const remaining = info.quotaInfo?.remainingFraction ?? 1
        return isPublicModel && remaining > 0
      })
      .map(([modelId, info]) => {
        const isGoogle = modelId.startsWith("gemini") || modelId.startsWith("learnlm")

        return {
          id: modelId,
          object: "model",
          created: 1700000000,
          owned_by: isGoogle ? "google" : "anthropic",
          quotaInfo: info.quotaInfo ? {
            remainingFraction: info.quotaInfo.remainingFraction ?? 1,
            resetTime: info.quotaInfo.resetTime ?? "",
          } : undefined,
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
 * Antigravity usage response format (compatible with Copilot usage viewer)
 */
export interface AntigravityUsageResponse {
  copilot_plan: string
  quota_reset_date: string
  quota_snapshots: {
    models: Record<string, {
      remaining_fraction: number
      reset_time: string
      percent_remaining: number
    }>
  }
}

/**
 * Get Antigravity usage/quota information
 */
export async function getAntigravityUsage(): Promise<AntigravityUsageResponse> {
  // Force refresh models to get latest quota
  cachedModels = null
  cacheTimestamp = 0

  const modelsResponse = await getAntigravityModels()

  // Find earliest reset time
  let earliestResetTime = ""
  const modelsQuota: Record<string, {
    remaining_fraction: number
    reset_time: string
    percent_remaining: number
  }> = {}

  let modelsWithQuota = 0
  for (const model of modelsResponse.data) {
    if (model.quotaInfo) {
      modelsWithQuota++
      const resetTime = model.quotaInfo.resetTime
      if (!earliestResetTime || (resetTime && resetTime < earliestResetTime)) {
        earliestResetTime = resetTime
      }

      modelsQuota[model.id] = {
        remaining_fraction: model.quotaInfo.remainingFraction,
        reset_time: model.quotaInfo.resetTime,
        percent_remaining: Math.round(model.quotaInfo.remainingFraction * 100),
      }
    }
  }

  consola.debug(`Antigravity usage: ${modelsWithQuota}/${modelsResponse.data.length} models have quota info`)

  return {
    copilot_plan: "antigravity",
    quota_reset_date: earliestResetTime,
    quota_snapshots: {
      models: modelsQuota,
    },
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
