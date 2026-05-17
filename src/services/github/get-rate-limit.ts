import { GITHUB_API_BASE_URL, standardHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

/**
 * GET /rate_limit — returns GitHub REST API rate-limit snapshots for the
 * authenticated user. Calling this endpoint does NOT count against the
 * user's quota (per the GitHub docs).
 *
 * @param githubToken Optional explicit token. Falls back to `state.githubToken`.
 */
export async function getGitHubRateLimit(
  githubToken?: string,
): Promise<GithubRateLimitResponse> {
  const token = githubToken ?? state.githubToken
  const response = await fetch(`${GITHUB_API_BASE_URL}/rate_limit`, {
    headers: {
      authorization: `token ${token}`,
      ...standardHeaders(),
    },
  })

  if (!response.ok) {
    throw new HTTPError("Failed to get GitHub rate_limit", response)
  }

  return (await response.json()) as GithubRateLimitResponse
}

/** Per-resource quota block returned by GitHub. */
export interface GithubRateLimitResource {
  limit: number
  remaining: number
  used: number
  /** Unix seconds. */
  reset: number
}

/** Trimmed shape — only fields we actually use. */
export interface GithubRateLimitResponse {
  resources: Record<string, GithubRateLimitResource> & {
    core: GithubRateLimitResource
  }
  rate?: GithubRateLimitResource
}
