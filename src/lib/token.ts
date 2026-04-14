import consola from "consola"
import fs from "node:fs/promises"

import { PATHS } from "~/lib/paths"
import { getCopilotToken } from "~/services/github/get-copilot-token"
import { getDeviceCode } from "~/services/github/get-device-code"
import { getGitHubUser } from "~/services/github/get-user"
import { pollAccessToken } from "~/services/github/poll-access-token"

import { HTTPError } from "./error"
import { state } from "./state"
import { rootCause } from "./utils"

/** Check if an error is a transient network/connection error */
function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const cause = (error as { cause?: { code?: string } }).cause
  const code = cause?.code ?? (error as { code?: string }).code
  return [
    "ECONNREFUSED",
    "ECONNRESET",
    "ENOTFOUND",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
  ].includes(code ?? "")
}

const readGithubToken = () => fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")

const writeGithubToken = (token: string) =>
  fs.writeFile(PATHS.GITHUB_TOKEN_PATH, token, { mode: 0o600 })

/**
 * Clear the stored GitHub token from disk and state.
 * This allows the user to logout or re-authenticate.
 */
export async function clearGithubToken(): Promise<void> {
  state.githubToken = undefined
  state.copilotToken = undefined
  await fs.writeFile(PATHS.GITHUB_TOKEN_PATH, "")
  consola.info("GitHub token cleared")
}

/** Handle to the single-account Copilot token refresh interval. */
let copilotTokenRefreshTimer: ReturnType<typeof setInterval> | undefined

/**
 * Stop the single-account Copilot token refresh interval.
 * Called when multi-account mode is activated to avoid duplicate refreshes.
 */
export function stopCopilotTokenRefresh(): void {
  if (copilotTokenRefreshTimer) {
    clearInterval(copilotTokenRefreshTimer)
    copilotTokenRefreshTimer = undefined
    consola.debug(
      "Single-account Copilot token refresh stopped (multi-account active)",
    )
  }
}

export const setupCopilotToken = async () => {
  const { token, refresh_in } = await getCopilotToken()
  state.copilotToken = token

  // Display the Copilot token to the screen
  consola.debug("GitHub Copilot Token fetched successfully!")
  if (state.showToken) {
    consola.info("Copilot token:", token)
  }

  const refreshInterval = Math.max((refresh_in - 60) * 1000, 60_000)
  copilotTokenRefreshTimer = setInterval(async () => {
    consola.debug("Refreshing Copilot token")
    try {
      await refreshCopilotToken()
    } catch (error) {
      consola.warn(`Failed to refresh Copilot token: ${rootCause(error)}`)
      consola.debug("Failed to refresh Copilot token:", error)

      // If we get a 401, the GitHub token might be invalid
      // Log the error but don't crash - the next API request will fail
      // and the user can restart with valid credentials
      if (error instanceof HTTPError && error.response.status === 401) {
        consola.warn(
          "GitHub token may have been revoked. Please restart and re-authenticate.",
        )
        state.copilotToken = undefined
      }
      // Don't throw here - it would cause an unhandled rejection in setInterval
    }
  }, refreshInterval)
}

/**
 * Refresh the Copilot token on demand (e.g. after a 401 error).
 */
export async function refreshCopilotToken(): Promise<void> {
  const { token } = await getCopilotToken()
  state.copilotToken = token
  consola.debug("Copilot token refreshed")
  if (state.showToken) {
    consola.info("Refreshed Copilot token:", token)
  }
}

interface SetupGitHubTokenOptions {
  force?: boolean
}

/**
 * Perform a fresh GitHub authentication flow.
 * Gets a device code and polls for the access token.
 */
async function performFreshAuthentication(): Promise<void> {
  consola.info("Starting GitHub authentication flow...")
  const response = await getDeviceCode()
  consola.debug("Device code response:", response)

  consola.info(
    `Please enter the code "${response.user_code}" in ${response.verification_uri}`,
  )

  const token = await pollAccessToken(response)
  await writeGithubToken(token)
  state.githubToken = token

  if (state.showToken) {
    consola.info("GitHub token:", token)
  }
  await logUser()
}

export async function setupGitHubToken(
  options?: SetupGitHubTokenOptions,
): Promise<void> {
  try {
    const githubToken = await readGithubToken()

    if (githubToken && !options?.force) {
      state.githubToken = githubToken
      if (state.showToken) {
        consola.info("GitHub token:", githubToken)
      }

      // Validate the token by checking if we can get the user
      try {
        await logUser()
        return
      } catch (error) {
        // Token is invalid or expired, clear it and re-authenticate
        if (error instanceof HTTPError && error.response.status === 401) {
          consola.warn(
            "Stored GitHub token is invalid or expired, clearing and re-authenticating...",
          )
          await clearGithubToken()
          // Fall through to perform fresh authentication
        } else if (isNetworkError(error)) {
          // Network error — token is on disk and might still be valid,
          // we just can't verify right now. Continue without throwing.
          consola.warn(
            `Could not verify GitHub token (network issue): ${rootCause(error)}`,
          )
          consola.debug("Network error during token validation:", error)
          return
        } else {
          throw error
        }
      }
    }

    consola.info("Not logged in, getting new access token")
    await performFreshAuthentication()
  } catch (error) {
    if (error instanceof HTTPError) {
      consola.error("Failed to get GitHub token:", await error.response.json())
      throw error
    }

    consola.warn(`Failed to get GitHub token: ${rootCause(error)}`)
    consola.debug("Failed to get GitHub token:", error)

    // Network errors are non-fatal — the server can still try to start
    // with whatever token is on disk. It will fail on first API call if
    // the token is actually missing/invalid.
    if (isNetworkError(error)) {
      return
    }

    throw error
  }
}

async function logUser() {
  const user = await getGitHubUser()
  consola.info(`Logged in as ${user.login}`)
}
