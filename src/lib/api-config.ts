import { randomUUID } from "node:crypto"

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
  }

  if (vision) headers["copilot-vision-request"] = "true"

  return headers
}

export const GITHUB_API_BASE_URL = "https://api.github.com"
export const githubHeaders = (source: TokenSource) => ({
  ...standardHeaders(),
  authorization: `token ${source.githubToken}`,
  "editor-version": `vscode/${source.vsCodeVersion}`,
  "editor-plugin-version": EDITOR_PLUGIN_VERSION,
  "user-agent": USER_AGENT,
  "x-github-api-version": API_VERSION,
  "x-vscode-user-agent-library-version": "electron-fetch",
})

export const GITHUB_BASE_URL = "https://github.com"
export const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"
export const GITHUB_APP_SCOPES = ["read:user"].join(" ")
