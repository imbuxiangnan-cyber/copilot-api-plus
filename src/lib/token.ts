import consola from "consola"
import fs from "node:fs/promises"

import { PATHS } from "~/lib/paths"
import { getCopilotToken } from "~/services/github/get-copilot-token"
import { getDeviceCode } from "~/services/github/get-device-code"
import { getGitHubUser } from "~/services/github/get-user"
import { pollAccessToken } from "~/services/github/poll-access-token"

import { HTTPError } from "./error"
import { state } from "./state"

const readGithubToken = () => fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")

const writeGithubToken = (token: string) =>
  fs.writeFile(PATHS.GITHUB_TOKEN_PATH, token)

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

export const setupCopilotToken = async () => {
  const { token, refresh_in } = await getCopilotToken()
  state.copilotToken = token

  // Display the Copilot token to the screen
  consola.debug("GitHub Copilot Token fetched successfully!")
  if (state.showToken) {
    consola.info("Copilot token:", token)
  }

  const refreshInterval = (refresh_in - 60) * 1000
  setInterval(async () => {
    consola.debug("Refreshing Copilot token")
    try {
      const { token } = await getCopilotToken()
      state.copilotToken = token
      consola.debug("Copilot token refreshed")
      if (state.showToken) {
        consola.info("Refreshed Copilot token:", token)
      }
    } catch (error) {
      consola.error("Failed to refresh Copilot token:", error)
      
      // If we get a 401, the GitHub token might be invalid
      // Log the error but don't crash - the next API request will fail
      // and the user can restart with valid credentials
      if (error instanceof HTTPError && error.response.status === 401) {
        consola.warn("GitHub token may have been revoked. Please restart and re-authenticate.")
        state.copilotToken = undefined
      }
      // Don't throw here - it would cause an unhandled rejection in setInterval
    }
  }, refreshInterval)
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
          consola.warn("Stored GitHub token is invalid or expired, clearing and re-authenticating...")
          await clearGithubToken()
          // Fall through to perform fresh authentication
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

    consola.error("Failed to get GitHub token:", error)
    throw error
  }
}

async function logUser() {
  const user = await getGitHubUser()
  consola.info(`Logged in as ${user.login}`)
}
