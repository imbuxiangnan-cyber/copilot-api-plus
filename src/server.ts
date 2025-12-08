import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"

import { apiKeyAuthMiddleware } from "./lib/api-key-auth"
import { completionRoutes } from "./routes/chat-completions/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import { tokenRoute } from "./routes/token/route"
import { usageRoute } from "./routes/usage/route"
import { zenCompletionRoutes } from "./routes/zen/chat-completions/route"
import { zenMessageRoutes } from "./routes/zen/messages/route"
import { zenModelRoutes } from "./routes/zen/models/route"
import { state } from "./lib/state"

export const server = new Hono()

server.use(logger())
server.use(cors())
server.use(apiKeyAuthMiddleware)

server.get("/", (c) => c.text("Server running"))

// Dynamic routing based on Zen mode
// When Zen mode is enabled, route to Zen; otherwise route to Copilot
server.route("/chat/completions", new Hono().all("/*", async (c, next) => {
  if (state.zenMode) {
    return zenCompletionRoutes.fetch(c.req.raw, c.env)
  }
  return completionRoutes.fetch(c.req.raw, c.env)
}))

server.route("/models", new Hono().all("/*", async (c, next) => {
  if (state.zenMode) {
    return zenModelRoutes.fetch(c.req.raw, c.env)
  }
  return modelRoutes.fetch(c.req.raw, c.env)
}))

server.route("/embeddings", embeddingRoutes)
server.route("/usage", usageRoute)
server.route("/token", tokenRoute)

// Compatibility with tools that expect v1/ prefix
server.route("/v1/chat/completions", new Hono().all("/*", async (c, next) => {
  if (state.zenMode) {
    return zenCompletionRoutes.fetch(c.req.raw, c.env)
  }
  return completionRoutes.fetch(c.req.raw, c.env)
}))

server.route("/v1/models", new Hono().all("/*", async (c, next) => {
  if (state.zenMode) {
    return zenModelRoutes.fetch(c.req.raw, c.env)
  }
  return modelRoutes.fetch(c.req.raw, c.env)
}))

server.route("/v1/embeddings", embeddingRoutes)

// Anthropic compatible endpoints
// When Zen mode is enabled, route to Zen messages API
server.route("/v1/messages", new Hono().all("/*", async (c, next) => {
  if (state.zenMode) {
    return zenMessageRoutes.fetch(c.req.raw, c.env)
  }
  return messageRoutes.fetch(c.req.raw, c.env)
}))

// Dedicated Zen routes (always available)
server.route("/zen/v1/chat/completions", zenCompletionRoutes)
server.route("/zen/v1/models", zenModelRoutes)
server.route("/zen/v1/messages", zenMessageRoutes)
