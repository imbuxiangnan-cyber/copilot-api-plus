/**
 * OpenCode Zen Authentication
 *
 * Handles API key authentication for OpenCode Zen.
 * API keys are created at https://opencode.ai/zen
 */

import consola from "consola"
import { PATHS, ensurePaths } from "~/lib/paths"

export interface ZenAuth {
  apiKey: string
}

const ZEN_AUTH_FILENAME = "zen-auth.json"

/**
 * Get the path to the Zen auth file
 */
export function getZenAuthPath(): string {
  return `${PATHS.DATA_DIR}/${ZEN_AUTH_FILENAME}`
}

/**
 * Save Zen API key to file
 */
export async function saveZenAuth(auth: ZenAuth): Promise<void> {
  await ensurePaths()
  const authPath = getZenAuthPath()
  await Bun.write(authPath, JSON.stringify(auth, null, 2))
  consola.success("Zen API key saved to", authPath)
}

/**
 * Load Zen API key from file
 */
export async function loadZenAuth(): Promise<ZenAuth | null> {
  try {
    const authPath = getZenAuthPath()
    const file = Bun.file(authPath)

    if (!(await file.exists())) {
      return null
    }

    const content = await file.text()
    return JSON.parse(content) as ZenAuth
  } catch {
    return null
  }
}

/**
 * Clear Zen API key
 */
export async function clearZenAuth(): Promise<void> {
  try {
    const authPath = getZenAuthPath()
    const fs = await import("node:fs/promises")
    await fs.unlink(authPath)
    consola.success("Zen API key cleared")
  } catch {
    // File might not exist, ignore
  }
}

/**
 * Setup Zen API key interactively
 */
export async function setupZenApiKey(force = false): Promise<string> {
  const existingAuth = await loadZenAuth()

  if (existingAuth && !force) {
    consola.info("Using existing Zen API key")
    return existingAuth.apiKey
  }

  consola.info("OpenCode Zen gives you access to all the best coding models")
  consola.info("Get your API key at: https://opencode.ai/zen")
  consola.info("")

  const apiKey = await consola.prompt("Enter your OpenCode Zen API key:", {
    type: "text",
  })

  if (!apiKey || typeof apiKey !== "string") {
    throw new Error("API key is required")
  }

  // Validate the API key by fetching models
  try {
    const response = await fetch("https://opencode.ai/zen/v1/models", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    })

    if (!response.ok) {
      throw new Error(`Invalid API key: ${response.status} ${response.statusText}`)
    }

    consola.success("API key validated successfully")
  } catch (error) {
    consola.error("Failed to validate API key:", error)
    throw error
  }

  await saveZenAuth({ apiKey })
  return apiKey
}
