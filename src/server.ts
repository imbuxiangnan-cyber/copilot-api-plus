import type { Context } from "hono"

import { Hono } from "hono"
import { cors } from "hono/cors"

import { apiKeyAuthMiddleware } from "./lib/api-key-auth"
import { modelLogger } from "./lib/model-logger"
import { state } from "./lib/state"
import { antigravityChatCompletionsRoute } from "./routes/antigravity/chat-completions/route"
import { antigravityMessagesRoute } from "./routes/antigravity/messages/route"
import { antigravityModelsRoute } from "./routes/antigravity/models/route"
import { completionRoutes } from "./routes/chat-completions/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import { tokenRoute } from "./routes/token/route"
import { usageRoute } from "./routes/usage/route"
import { zenCompletionRoutes } from "./routes/zen/chat-completions/route"
import { zenMessageRoutes } from "./routes/zen/messages/route"
import { zenModelRoutes } from "./routes/zen/models/route"
import { zenResponsesRoutes } from "./routes/zen/responses/route"

export const server = new Hono()

server.use(modelLogger())
server.use(cors())
server.use(apiKeyAuthMiddleware)

server.get("/", (c) => c.text("Server running"))

// Helper to create a new request with modified path for sub-routing
function createSubRequest(c: Context, basePath: string): Request {
  const url = new URL(c.req.url)
  // Remove the base path prefix to get the sub-path
  const subPath = url.pathname.slice(basePath.length) || "/"
  url.pathname = subPath
  return new Request(url.toString(), c.req.raw)
}

// Dynamic routing based on mode (Zen / Antigravity / Copilot)
// Chat completions
server.all("/chat/completions/*", async (c) => {
  const req = createSubRequest(c, "/chat/completions")
  if (state.zenMode) return zenCompletionRoutes.fetch(req, c.env)
  if (state.antigravityMode)
    return antigravityChatCompletionsRoute.fetch(req, c.env)
  return completionRoutes.fetch(req, c.env)
})
server.all("/chat/completions", async (c) => {
  const req = createSubRequest(c, "/chat/completions")
  if (state.zenMode) return zenCompletionRoutes.fetch(req, c.env)
  if (state.antigravityMode)
    return antigravityChatCompletionsRoute.fetch(req, c.env)
  return completionRoutes.fetch(req, c.env)
})

// Models
server.all("/models/*", async (c) => {
  const req = createSubRequest(c, "/models")
  if (state.zenMode) return zenModelRoutes.fetch(req, c.env)
  if (state.antigravityMode) return antigravityModelsRoute.fetch(req, c.env)
  return modelRoutes.fetch(req, c.env)
})
server.all("/models", async (c) => {
  const req = createSubRequest(c, "/models")
  if (state.zenMode) return zenModelRoutes.fetch(req, c.env)
  if (state.antigravityMode) return antigravityModelsRoute.fetch(req, c.env)
  return modelRoutes.fetch(req, c.env)
})

server.route("/embeddings", embeddingRoutes)
server.route("/usage", usageRoute)
server.route("/token", tokenRoute)

// Compatibility with tools that expect v1/ prefix
server.all("/v1/chat/completions/*", async (c) => {
  const req = createSubRequest(c, "/v1/chat/completions")
  if (state.zenMode) return zenCompletionRoutes.fetch(req, c.env)
  if (state.antigravityMode)
    return antigravityChatCompletionsRoute.fetch(req, c.env)
  return completionRoutes.fetch(req, c.env)
})
server.all("/v1/chat/completions", async (c) => {
  const req = createSubRequest(c, "/v1/chat/completions")
  if (state.zenMode) return zenCompletionRoutes.fetch(req, c.env)
  if (state.antigravityMode)
    return antigravityChatCompletionsRoute.fetch(req, c.env)
  return completionRoutes.fetch(req, c.env)
})

server.all("/v1/models/*", async (c) => {
  const req = createSubRequest(c, "/v1/models")
  if (state.zenMode) return zenModelRoutes.fetch(req, c.env)
  if (state.antigravityMode) return antigravityModelsRoute.fetch(req, c.env)
  return modelRoutes.fetch(req, c.env)
})
server.all("/v1/models", async (c) => {
  const req = createSubRequest(c, "/v1/models")
  if (state.zenMode) return zenModelRoutes.fetch(req, c.env)
  if (state.antigravityMode) return antigravityModelsRoute.fetch(req, c.env)
  return modelRoutes.fetch(req, c.env)
})

server.route("/v1/embeddings", embeddingRoutes)

// Anthropic compatible endpoints
server.all("/v1/messages/*", async (c) => {
  const req = createSubRequest(c, "/v1/messages")
  if (state.zenMode) return zenMessageRoutes.fetch(req, c.env)
  if (state.antigravityMode) return antigravityMessagesRoute.fetch(req, c.env)
  return messageRoutes.fetch(req, c.env)
})
server.all("/v1/messages", async (c) => {
  const req = createSubRequest(c, "/v1/messages")
  if (state.zenMode) return zenMessageRoutes.fetch(req, c.env)
  if (state.antigravityMode) return antigravityMessagesRoute.fetch(req, c.env)
  return messageRoutes.fetch(req, c.env)
})

// OpenAI Responses API (Zen only - for GPT-5 models)
server.all("/v1/responses/*", async (c) => {
  const req = createSubRequest(c, "/v1/responses")
  if (state.zenMode) return zenResponsesRoutes.fetch(req, c.env)
  return c.json({ error: "Responses API requires Zen mode" }, 400)
})
server.all("/v1/responses", async (c) => {
  const req = createSubRequest(c, "/v1/responses")
  if (state.zenMode) return zenResponsesRoutes.fetch(req, c.env)
  return c.json({ error: "Responses API requires Zen mode" }, 400)
})

// Dedicated Zen routes (always available)
server.route("/zen/v1/chat/completions", zenCompletionRoutes)
server.route("/zen/v1/models", zenModelRoutes)
server.route("/zen/v1/messages", zenMessageRoutes)
server.route("/zen/v1/responses", zenResponsesRoutes)

// Dedicated Antigravity routes (always available)
server.route(
  "/antigravity/v1/chat/completions",
  antigravityChatCompletionsRoute,
)
server.route("/antigravity/v1/models", antigravityModelsRoute)
server.route("/antigravity/v1/messages", antigravityMessagesRoute)
