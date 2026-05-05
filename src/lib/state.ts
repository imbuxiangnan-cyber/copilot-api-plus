import type { ModelsResponse } from "~/services/copilot/get-models"

export interface State {
  githubToken?: string
  copilotToken?: string
  copilotApiEndpoint?: string // API endpoint returned by token response

  accountType: string
  models?: ModelsResponse
  vsCodeVersion?: string

  manualApprove: boolean
  rateLimitWait: boolean
  showToken: boolean

  // Rate limiting configuration
  rateLimitSeconds?: number
  lastRequestTimestamp?: number

  // API key authentication
  apiKeys?: Array<string>

  // Multi-account mode
  multiAccountEnabled: boolean

  /**
   * When true, Anthropic /v1/messages requests are NEVER routed through the
   * native Copilot /v1/messages endpoint — the legacy translation layer
   * (Anthropic → OpenAI chat-completions → Anthropic) is used instead.
   * Default: false (native passthrough enabled by capability).
   */
  disableAnthropicPassthrough: boolean

  // Selected models (from --claude-code setup)
  selectedModel?: string
  selectedSmallModel?: string
}

export const state: State = {
  accountType: "individual",
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
  multiAccountEnabled: false,
  disableAnthropicPassthrough: false,
}
