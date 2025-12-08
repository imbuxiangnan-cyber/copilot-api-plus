import type { ModelsResponse } from "~/services/copilot/get-models"
import type { ZenModelsResponse } from "~/services/zen/get-models"

export interface State {
  githubToken?: string
  copilotToken?: string

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

  // OpenCode Zen support
  zenApiKey?: string
  zenModels?: ZenModelsResponse
  zenMode?: boolean  // When true, proxy to Zen instead of Copilot
}

export const state: State = {
  accountType: "individual",
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
  zenMode: false,
}
