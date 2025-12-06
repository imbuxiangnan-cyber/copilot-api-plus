import consola from "consola"

import {
  GITHUB_BASE_URL,
  GITHUB_CLIENT_ID,
  standardHeaders,
} from "~/lib/api-config"
import { sleep } from "~/lib/utils"

import type { DeviceCodeResponse } from "./get-device-code"

export async function pollAccessToken(
  deviceCode: DeviceCodeResponse,
): Promise<string> {
  // Interval is in seconds, we need to multiply by 1000 to get milliseconds
  // I'm also adding another second, just to be safe
  const sleepDuration = (deviceCode.interval + 1) * 1000
  consola.debug(`Polling access token with interval of ${sleepDuration}ms`)

  // Calculate expiration time - device code expires after expires_in seconds
  const expirationTime = Date.now() + deviceCode.expires_in * 1000

  while (Date.now() < expirationTime) {
    const response = await fetch(
      `${GITHUB_BASE_URL}/login/oauth/access_token`,
      {
        method: "POST",
        headers: standardHeaders(),
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          device_code: deviceCode.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      },
    )

    if (!response.ok) {
      await sleep(sleepDuration)
      consola.error("Failed to poll access token:", await response.text())

      continue
    }

    const json = (await response.json()) as AccessTokenResponse | AccessTokenErrorResponse
    consola.debug("Polling access token response:", json)

    if ("access_token" in json && json.access_token) {
      return json.access_token
    }
    
    // Handle specific error cases
    if ("error" in json) {
      if (json.error === "authorization_pending") {
        // User hasn't authorized yet, continue polling
        await sleep(sleepDuration)
        continue
      } else if (json.error === "slow_down") {
        // We're polling too fast, increase interval
        await sleep(sleepDuration * 2)
        continue
      } else if (json.error === "expired_token") {
        throw new Error("Device code expired. Please try again.")
      } else if (json.error === "access_denied") {
        throw new Error("Authorization was denied by the user.")
      } else {
        throw new Error(`Authentication failed: ${json.error_description || json.error}`)
      }
    }
    
    await sleep(sleepDuration)
  }

  throw new Error("Device code expired. Please try again.")
}

interface AccessTokenResponse {
  access_token: string
  token_type: string
  scope: string
}

interface AccessTokenErrorResponse {
  error: string
  error_description?: string
  error_uri?: string
}
