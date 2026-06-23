import { githubApiBaseUrl, githubHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

/**
 * Fetch the authenticated user's Copilot usage / quota snapshot.
 *
 * @param githubToken  Optional explicit GitHub PAT.  When provided the request
 *                     uses this token instead of `state.githubToken`, allowing
 *                     multi-account callers to query any account without
 *                     touching global state.
 */
export const getCopilotUsage = async (
  githubToken?: string,
): Promise<CopilotUsageResponse> => {
  const response = await fetch(`${githubApiBaseUrl()}/copilot_internal/user`, {
    headers: githubHeaders({
      ...state,
      githubToken: githubToken ?? state.githubToken,
    }),
  })

  if (!response.ok) {
    throw new HTTPError("Failed to get Copilot usage", response)
  }

  return (await response.json()) as CopilotUsageResponse
}

export interface QuotaDetail {
  entitlement: number
  overage_count: number
  overage_permitted: boolean
  percent_remaining: number
  quota_id: string
  quota_remaining: number
  remaining: number
  unlimited: boolean
}

interface QuotaSnapshots {
  chat: QuotaDetail
  completions: QuotaDetail
  premium_interactions: QuotaDetail
}

interface CopilotUsageResponse {
  access_type_sku: string
  analytics_tracking_id: string
  assigned_date: string
  can_signup_for_limited: boolean
  chat_enabled: boolean
  copilot_plan: string
  organization_login_list: Array<unknown>
  organization_list: Array<unknown>
  quota_reset_date: string
  quota_snapshots: QuotaSnapshots
}
