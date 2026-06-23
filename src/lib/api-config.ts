import { randomUUID } from "node:crypto"

import { state } from "~/lib/state"

export const standardHeaders = () => ({
  "content-type": "application/json",
  accept: "application/json",
})

const COPILOT_VERSION = "0.38.2"
const EDITOR_PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`
const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`

// Updated to match latest Zed implementation - 2025-10-01 returns Claude models
const API_VERSION = "2025-10-01"

/**
 * Common interface for anything that can supply Copilot/GitHub credentials.
 *
 * Both `State` and `Account` satisfy this interface, so all header/URL
 * helpers can accept either without an explicit overload.
 */
export interface TokenSource {
  copilotToken?: string
  copilotApiEndpoint?: string
  accountType: string
  githubToken?: string
  vsCodeVersion?: string
  machineId?: string
  sessionId?: string
  proxy?: string
}

// Re-export constants used by other modules for building headers manually
export { API_VERSION, EDITOR_PLUGIN_VERSION, USER_AGENT }

// Use the API endpoint from token response if available, otherwise fall back to default
export const copilotBaseUrl = (source: TokenSource) => {
  if (source.copilotApiEndpoint) {
    return source.copilotApiEndpoint
  }
  return source.accountType === "individual" ?
      "https://api.githubcopilot.com"
    : `https://api.${source.accountType}.githubcopilot.com`
}
export const copilotHeaders = (
  source: TokenSource,
  vision: boolean = false,
) => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${source.copilotToken}`,
    "content-type": standardHeaders()["content-type"],
    "copilot-integration-id": "vscode-chat",
    "editor-version": `vscode/${source.vsCodeVersion}`,
    "editor-plugin-version": EDITOR_PLUGIN_VERSION,
    "user-agent": USER_AGENT,
    "openai-intent": "conversation-agent",
    "x-interaction-type": "conversation-agent",
    "x-agent-task-id": randomUUID(),
    "x-github-api-version": API_VERSION,
    "x-request-id": randomUUID(),
    "x-vscode-user-agent-library-version": "electron-fetch",
    // Anti-correlation: per-account device identifiers
    ...(source.machineId && { "vscode-machineid": source.machineId }),
    ...(source.sessionId && { "vscode-sessionid": source.sessionId }),
  }

  if (vision) headers["copilot-vision-request"] = "true"

  return headers
}

const PUBLIC_GITHUB_BASE_URL = "https://github.com"
const PUBLIC_GITHUB_API_BASE_URL = "https://api.github.com"

function normalizeBaseUrl(url: string | undefined): string | undefined {
  const trimmed = url?.trim()
  if (!trimmed) return undefined
  return trimmed.replace(/\/+$/, "")
}

function envValue(...names: Array<string>): string | undefined {
  for (const name of names) {
    const value = normalizeBaseUrl(process.env[name])
    if (value) return value
  }
  return undefined
}

export function githubBaseUrl(): string {
  return (
    normalizeBaseUrl(state.githubBaseUrl)
    ?? envValue("GITHUB_BASE_URL", "COPILOT_API_GITHUB_BASE_URL")
    ?? PUBLIC_GITHUB_BASE_URL
  )
}

export function githubApiBaseUrl(): string {
  const explicitApiUrl =
    normalizeBaseUrl(state.githubApiBaseUrl)
    ?? envValue("GITHUB_API_BASE_URL", "COPILOT_API_GITHUB_API_BASE_URL")

  if (explicitApiUrl) return explicitApiUrl

  const baseUrl = githubBaseUrl()
  return baseUrl === PUBLIC_GITHUB_BASE_URL ?
      PUBLIC_GITHUB_API_BASE_URL
    : `${baseUrl}/api/v3`
}

export const GITHUB_API_BASE_URL = PUBLIC_GITHUB_API_BASE_URL
export const githubHeaders = (source: TokenSource) => ({
  ...standardHeaders(),
  authorization: `token ${source.githubToken}`,
  "editor-version": `vscode/${source.vsCodeVersion}`,
  "editor-plugin-version": EDITOR_PLUGIN_VERSION,
  "user-agent": USER_AGENT,
  "x-github-api-version": API_VERSION,
  "x-vscode-user-agent-library-version": "electron-fetch",
})

export const GITHUB_BASE_URL = PUBLIC_GITHUB_BASE_URL
export const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"
export const GITHUB_APP_SCOPES = ["read:user"].join(" ")
