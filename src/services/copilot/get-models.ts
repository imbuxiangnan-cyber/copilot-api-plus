import { accountManager } from "~/lib/account-manager"
import {
  copilotBaseUrl,
  copilotHeaders,
  type TokenSource,
} from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export const getModels = async () => {
  // In multi-account mode, use the active account's token
  let source: TokenSource = state
  if (state.multiAccountEnabled && accountManager.hasAccounts()) {
    const account = accountManager.getActiveAccount()
    if (account?.copilotToken) {
      source = {
        copilotToken: account.copilotToken,
        copilotApiEndpoint: account.copilotApiEndpoint,
        accountType: account.accountType,
        githubToken: account.githubToken,
        vsCodeVersion: state.vsCodeVersion,
      }
    }
  }

  const url = `${copilotBaseUrl(source)}/models`

  const response = await fetch(url, {
    headers: copilotHeaders(source),
  })

  if (!response.ok) throw new HTTPError("Failed to get models", response)

  const data = (await response.json()) as ModelsResponse

  return data
}

export interface ModelsResponse {
  data: Array<Model>
  object: string
}

interface ModelLimits {
  max_context_window_tokens?: number
  max_output_tokens?: number
  max_prompt_tokens?: number
  max_inputs?: number
}

interface ModelSupports {
  tool_calls?: boolean
  parallel_tool_calls?: boolean
  dimensions?: boolean
  // Thinking/reasoning capabilities
  max_thinking_budget?: number
  min_thinking_budget?: number
  adaptive_thinking?: boolean
}

interface ModelCapabilities {
  family: string
  limits: ModelLimits
  object: string
  supports: ModelSupports
  tokenizer: string
  type: string
}

export interface Model {
  capabilities: ModelCapabilities
  id: string
  model_picker_enabled: boolean
  name: string
  object: string
  preview: boolean
  vendor: string
  version: string
  policy?: {
    state: string
    terms: string
  }
  billing?: {
    is_premium: boolean
    multiplier: number
    restricted_to?: Array<string>
  }
  /**
   * Optional list of native upstream endpoints this model supports.
   * GitHub Copilot's `/models` response advertises this for some models
   * (e.g. Claude family typically includes "anthropic-messages") so we
   * can route directly to the native API instead of translating.
   */
  supported_endpoints?: Array<string>
}
