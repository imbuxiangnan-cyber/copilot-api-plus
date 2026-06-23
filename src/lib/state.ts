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
   * When true, requests that don't specify a `thinking` field will get the
   * model's maximum thinking budget injected automatically (adaptive for
   * adaptive-thinking models, otherwise `enabled` with `max_thinking_budget`).
   *
   * Trade-off:
   *   - Pre-2026-06-01 Copilot billing is per-request (token count doesn't
   *     change cost), so leaving this on is "free quality".
   *   - Post-2026-06-01 billing switches to per-token, at which point
   *     auto-injection burns tokens. Users on token billing should turn this
   *     off (or upgrade to a release that flips the default).
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
