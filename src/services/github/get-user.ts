import { GITHUB_API_BASE_URL, standardHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

/**
 * Fetch the GitHub user profile.
 *
 * @param githubToken  Optional explicit token.  When omitted, falls back to
 *                     the global `state.githubToken`.  Prefer passing a token
 *                     explicitly to avoid race conditions in multi-account mode.
 */
export async function getGitHubUser(githubToken?: string) {
  const token = githubToken ?? state.githubToken
  const response = await fetch(`${GITHUB_API_BASE_URL}/user`, {
    headers: {
      authorization: `token ${token}`,
      ...standardHeaders(),
    },
  })

  if (!response.ok) throw new HTTPError("Failed to get GitHub user", response)

  return (await response.json()) as GithubUserResponse
}

// Trimmed for the sake of simplicity
interface GithubUserResponse {
  login: string
}
