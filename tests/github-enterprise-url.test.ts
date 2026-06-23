import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { githubApiBaseUrl, githubBaseUrl } from "~/lib/api-config"
import { state } from "~/lib/state"
import { accountRoutes } from "~/routes/admin/accounts"
import { getCopilotToken } from "~/services/github/get-copilot-token"
import { getCopilotUsage } from "~/services/github/get-copilot-usage"
import { getDeviceCode } from "~/services/github/get-device-code"
import { getGitHubRateLimit } from "~/services/github/get-rate-limit"
import { getGitHubUser } from "~/services/github/get-user"
import { pollAccessToken } from "~/services/github/poll-access-token"

const originalFetch = globalThis.fetch
const originalEnv = {
  GITHUB_BASE_URL: process.env.GITHUB_BASE_URL,
  COPILOT_API_GITHUB_BASE_URL: process.env.COPILOT_API_GITHUB_BASE_URL,
  GITHUB_API_BASE_URL: process.env.GITHUB_API_BASE_URL,
  COPILOT_API_GITHUB_API_BASE_URL: process.env.COPILOT_API_GITHUB_API_BASE_URL,
}

function restoreEnv(): void {
  if (originalEnv.GITHUB_BASE_URL === undefined) {
    delete process.env.GITHUB_BASE_URL
  } else {
    process.env.GITHUB_BASE_URL = originalEnv.GITHUB_BASE_URL
  }

  if (originalEnv.COPILOT_API_GITHUB_BASE_URL === undefined) {
    delete process.env.COPILOT_API_GITHUB_BASE_URL
  } else {
    process.env.COPILOT_API_GITHUB_BASE_URL =
      originalEnv.COPILOT_API_GITHUB_BASE_URL
  }

  if (originalEnv.GITHUB_API_BASE_URL === undefined) {
    delete process.env.GITHUB_API_BASE_URL
  } else {
    process.env.GITHUB_API_BASE_URL = originalEnv.GITHUB_API_BASE_URL
  }

  if (originalEnv.COPILOT_API_GITHUB_API_BASE_URL === undefined) {
    delete process.env.COPILOT_API_GITHUB_API_BASE_URL
  } else {
    process.env.COPILOT_API_GITHUB_API_BASE_URL =
      originalEnv.COPILOT_API_GITHUB_API_BASE_URL
  }
}

function resetGitHubConfig(): void {
  state.githubBaseUrl = undefined
  state.githubApiBaseUrl = undefined
  state.githubToken = undefined
  delete process.env.GITHUB_BASE_URL
  delete process.env.COPILOT_API_GITHUB_BASE_URL
  delete process.env.GITHUB_API_BASE_URL
  delete process.env.COPILOT_API_GITHUB_API_BASE_URL
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  })
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return input.url
}

function quota() {
  return {
    entitlement: 100,
    overage_count: 0,
    overage_permitted: false,
    percent_remaining: 100,
    quota_id: "quota",
    quota_remaining: 100,
    remaining: 100,
    unlimited: false,
  }
}

describe("GitHub Enterprise URL configuration", () => {
  beforeEach(() => {
    resetGitHubConfig()
    globalThis.fetch = originalFetch
  })

  afterEach(() => {
    resetGitHubConfig()
    restoreEnv()
    globalThis.fetch = originalFetch
  })

  test("preserves public GitHub defaults", () => {
    expect(githubBaseUrl()).toBe("https://github.com")
    expect(githubApiBaseUrl()).toBe("https://api.github.com")
  })

  test("normalizes runtime GitHub Enterprise web URL and derives API URL", () => {
    state.githubBaseUrl = " https://xxx.ghe.com/ "

    expect(githubBaseUrl()).toBe("https://xxx.ghe.com")
    expect(githubApiBaseUrl()).toBe("https://xxx.ghe.com/api/v3")
  })

  test("uses explicit runtime API URL before derived API URL", () => {
    state.githubBaseUrl = "https://xxx.ghe.com"
    state.githubApiBaseUrl = "https://api.internal.example/github/"

    expect(githubApiBaseUrl()).toBe("https://api.internal.example/github")
  })

  test("uses environment overrides when runtime state is unset", () => {
    process.env.COPILOT_API_GITHUB_BASE_URL = "https://env.ghe.com/"
    process.env.COPILOT_API_GITHUB_API_BASE_URL =
      "https://env.ghe.com/custom-api/"

    expect(githubBaseUrl()).toBe("https://env.ghe.com")
    expect(githubApiBaseUrl()).toBe("https://env.ghe.com/custom-api")
  })

  test("posts device-code requests to the configured web base URL", async () => {
    state.githubBaseUrl = "https://xxx.ghe.com/"
    const urls: Array<string> = []
    globalThis.fetch = ((input) => {
      urls.push(requestUrl(input))
      return Promise.resolve(
        jsonResponse({
          device_code: "device",
          user_code: "user",
          verification_uri: "https://xxx.ghe.com/login/device",
          expires_in: 900,
          interval: 5,
        }),
      )
    }) as typeof fetch

    await getDeviceCode()

    expect(urls).toEqual(["https://xxx.ghe.com/login/device/code"])
  })

  test("pollAccessToken posts token polling requests to the configured web base URL", async () => {
    state.githubBaseUrl = "https://xxx.ghe.com"
    const urls: Array<string> = []
    globalThis.fetch = ((input) => {
      urls.push(requestUrl(input))
      return Promise.resolve(
        jsonResponse({
          access_token: "gho_token",
          token_type: "bearer",
          scope: "read:user",
        }),
      )
    }) as typeof fetch

    const token = await pollAccessToken({
      device_code: "device",
      user_code: "user",
      verification_uri: "https://xxx.ghe.com/login/device",
      expires_in: 900,
      interval: 5,
    })

    expect(token).toBe("gho_token")
    expect(urls).toEqual(["https://xxx.ghe.com/login/oauth/access_token"])
  })

  test("admin auth polling uses the same configured web base URL", async () => {
    state.githubBaseUrl = "https://admin.ghe.com"
    const urls: Array<string> = []
    globalThis.fetch = ((input) => {
      urls.push(requestUrl(input))
      return Promise.resolve(jsonResponse({ error: "authorization_pending" }))
    }) as typeof fetch

    const response = await accountRoutes.request("http://localhost/auth/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: "device" }),
    })
    const body = (await response.json()) as { status: string }

    expect(body.status).toBe("pending")
    expect(urls).toEqual(["https://admin.ghe.com/login/oauth/access_token"])
  })

  test("GitHub REST helpers use the configured API base URL", async () => {
    state.githubApiBaseUrl = "https://xxx.ghe.com/api/v3"
    state.githubToken = "gho_state"
    const urls: Array<string> = []
    globalThis.fetch = ((input) => {
      const url = requestUrl(input)
      urls.push(url)
      if (url.endsWith("/user")) {
        return Promise.resolve(jsonResponse({ login: "octocat" }))
      }
      if (url.endsWith("/rate_limit")) {
        return Promise.resolve(
          jsonResponse({
            resources: {
              core: { limit: 5000, remaining: 4999, used: 1, reset: 1 },
            },
          }),
        )
      }
      if (url.endsWith("/copilot_internal/v2/token")) {
        return Promise.resolve(
          jsonResponse({ token: "copilot", expires_at: 1, refresh_in: 1 }),
        )
      }
      if (url.endsWith("/copilot_internal/user")) {
        return Promise.resolve(
          jsonResponse({
            access_type_sku: "business",
            analytics_tracking_id: "tracking",
            assigned_date: "2026-01-01",
            can_signup_for_limited: false,
            chat_enabled: true,
            copilot_plan: "business",
            organization_login_list: [],
            organization_list: [],
            quota_reset_date: "2026-01-02",
            quota_snapshots: {
              chat: quota(),
              completions: quota(),
              premium_interactions: quota(),
            },
          }),
        )
      }
      return Promise.resolve(jsonResponse({}, { status: 404 }))
    }) as typeof fetch

    await getGitHubUser()
    await getGitHubRateLimit()
    await getCopilotToken()
    await getCopilotUsage()

    expect(urls).toEqual([
      "https://xxx.ghe.com/api/v3/user",
      "https://xxx.ghe.com/api/v3/rate_limit",
      "https://xxx.ghe.com/api/v3/copilot_internal/v2/token",
      "https://xxx.ghe.com/api/v3/copilot_internal/user",
    ])
  })
})
