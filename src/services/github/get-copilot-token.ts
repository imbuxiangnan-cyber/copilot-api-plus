import consola from "consola"

import { githubApiBaseUrl, githubHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

/**
 * Fetch a short-lived Copilot JWT from the GitHub API.
 *
 * @param githubToken  Optional explicit GitHub PAT.  When provided the request
 *                     uses this token instead of `state.githubToken` and does
 *                     **not** mutate global state (so multi-account callers
 *                     stay side-effect-free).
 */
export const getCopilotToken = async (githubToken?: string) => {
  const tokenToUse = githubToken ?? state.githubToken
  const isExplicitToken = githubToken !== undefined

  const url = `${githubApiBaseUrl()}/copilot_internal/v2/token`
  const fetchOptions: RequestInit = {
    headers: githubHeaders({
      ...state,
      githubToken: tokenToUse,
    }),
  }

  // Retry on transient network errors (TLS disconnect, connection timeout, etc.)
  const maxRetries = 2
  let lastError: unknown
  let response: Response | undefined

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      response = await fetch(url, fetchOptions)
      break
    } catch (error: unknown) {
      lastError = error
      if (attempt < maxRetries) {
        const delay = 1000 * (attempt + 1)
        consola.warn(
          `Token fetch error on attempt ${attempt + 1}/${maxRetries + 1}, retrying in ${delay}ms:`,
          error instanceof Error ? error.message : error,
        )
        await new Promise((r) => setTimeout(r, delay))
      }
    }
  }

  if (!response) {
    throw lastError
  }

  if (!response.ok) throw new HTTPError("Failed to get Copilot token", response)

  const data = (await response.json()) as GetCopilotTokenResponse

  // Only write to global state when using the default token (single-account mode).
  // When an explicit githubToken is provided (multi-account), the caller is
  // responsible for storing the endpoint on its own Account object.
  if (!isExplicitToken && data.endpoints?.api) {
    // eslint-disable-next-line require-atomic-updates
    state.copilotApiEndpoint = data.endpoints.api
  }

  return data
}

// Full interface matching Zed's implementation
interface GetCopilotTokenResponse {
  expires_at: number
  refresh_in: number
  token: string
  endpoints?: {
    api: string
    "origin-tracker"?: string
    proxy?: string
    telemetry?: string
  }
  annotations_enabled?: boolean
  chat_enabled?: boolean
  chat_jetbrains_enabled?: boolean
  code_quote_enabled?: boolean
  codesearch?: boolean
  copilot_ide_agent_chat_gpt4_small_prompt?: boolean
  copilotignore_enabled?: boolean
  individual?: boolean
  sku?: string
  tracking_id?: string
  limited_user_quotas?: unknown // Premium request quotas
}
