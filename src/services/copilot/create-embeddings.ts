import { accountManager } from "~/lib/account-manager"
import {
  copilotHeaders,
  copilotBaseUrl,
  type TokenSource,
} from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export const createEmbeddings = async (payload: EmbeddingRequest) => {
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

  if (!source.copilotToken) throw new Error("Copilot token not found")

  const response = await fetch(`${copilotBaseUrl(source)}/embeddings`, {
    method: "POST",
    headers: copilotHeaders(source),
    body: JSON.stringify(payload),
  })

  if (!response.ok) throw new HTTPError("Failed to create embeddings", response)

  return (await response.json()) as EmbeddingResponse
}

export interface EmbeddingRequest {
  input: string | Array<string>
  model: string
}

export interface Embedding {
  object: string
  embedding: Array<number>
  index: number
}

export interface EmbeddingResponse {
  object: string
  data: Array<Embedding>
  model: string
  usage: {
    prompt_tokens: number
    total_tokens: number
  }
}
