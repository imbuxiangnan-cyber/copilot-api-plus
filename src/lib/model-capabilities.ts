import type { Model } from "~/services/copilot/get-models"

type HttpEndpoint = "chat-completions" | "responses" | "anthropic-messages"

/** Normalize catalog HTTP paths without treating WebSocket metadata as HTTP. */
function normalizeHttpEndpoint(endpoint: string): HttpEndpoint | undefined {
  const path = endpoint.trim().toLowerCase()
  if (/^wss?:/.test(path)) return undefined
  const normalized = path.replaceAll(/^\/+|\/+$/g, "").replace(/^v1\//, "")
  switch (normalized) {
    case "chat/completions":
    case "chat-completions": {
      return "chat-completions"
    }
    case "responses": {
      return "responses"
    }
    case "messages":
    case "anthropic-messages": {
      return "anthropic-messages"
    }
    default: {
      return undefined
    }
  }
}

export function modelSupportsHttpEndpoint(
  model: Pick<Model, "supported_endpoints"> | undefined,
  endpoint: HttpEndpoint,
): boolean {
  return (
    model?.supported_endpoints?.some(
      (value) => normalizeHttpEndpoint(value) === endpoint,
    ) ?? false
  )
}
