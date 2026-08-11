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

  /**
   * When true, requests that don't specify a `thinking` field will get a
   * model-compatible thinking setting injected automatically.
   *
   * Adaptive-thinking models receive `{ type: "adaptive" }` plus the highest
   * allowed `output_config.effort` advertised by Copilot `/models`. Legacy
   * thinking models receive `{ type: "enabled" }` with `max_thinking_budget`.
   * If billing or quota is token-based, lowering or disabling auto-injection
   * may save quota.
   *
   * Default: true (preserve existing v1.3.x quality-first behavior).
   */
  maxThinking: boolean

  // GitHub Enterprise base URL overrides
  githubBaseUrl?: string
  githubApiBaseUrl?: string

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
  maxThinking: true,
}
