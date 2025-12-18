import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"

import { apiKeyAuthMiddleware } from "./lib/api-key-auth"
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

export const server = new Hono()

server.use(logger())
server.use(cors())
server.use(apiKeyAuthMiddleware)

server.get("/", (c) => c.text("Server running"))

// Dynamic routing based on mode (Zen / Antigravity / Copilot)
server.route(
  "/chat/completions",
  new Hono().all("*", async (c, _next) => {
    if (state.zenMode) {
      return zenCompletionRoutes.fetch(c.req.raw, c.env)
    }
    if (state.antigravityMode) {
      return antigravityChatCompletionsRoute.fetch(c.req.raw, c.env)
    }
    return completionRoutes.fetch(c.req.raw, c.env)
  }),
)

server.route(
  "/models",
  new Hono().all("*", async (c, _next) => {
    if (state.zenMode) {
      return zenModelRoutes.fetch(c.req.raw, c.env)
    }
    if (state.antigravityMode) {
      return antigravityModelsRoute.fetch(c.req.raw, c.env)
    }
    return modelRoutes.fetch(c.req.raw, c.env)
  }),
)

server.route("/embeddings", embeddingRoutes)
server.route("/usage", usageRoute)
server.route("/token", tokenRoute)

// Compatibility with tools that expect v1/ prefix
server.route(
  "/v1/chat/completions",
  new Hono().all("*", async (c, _next) => {
    if (state.zenMode) {
      return zenCompletionRoutes.fetch(c.req.raw, c.env)
    }
    if (state.antigravityMode) {
      return antigravityChatCompletionsRoute.fetch(c.req.raw, c.env)
    }
    return completionRoutes.fetch(c.req.raw, c.env)
  }),
)

server.route(
  "/v1/models",
  new Hono().all("*", async (c, _next) => {
    if (state.zenMode) {
      return zenModelRoutes.fetch(c.req.raw, c.env)
    }
    if (state.antigravityMode) {
      return antigravityModelsRoute.fetch(c.req.raw, c.env)
    }
    return modelRoutes.fetch(c.req.raw, c.env)
  }),
)

server.route("/v1/embeddings", embeddingRoutes)

// Anthropic compatible endpoints
server.route(
  "/v1/messages",
  new Hono().all("*", async (c, _next) => {
    if (state.zenMode) {
      return zenMessageRoutes.fetch(c.req.raw, c.env)
    }
    if (state.antigravityMode) {
      return antigravityMessagesRoute.fetch(c.req.raw, c.env)
    }
    return messageRoutes.fetch(c.req.raw, c.env)
  }),
)

// Dedicated Zen routes (always available)
server.route("/zen/v1/chat/completions", zenCompletionRoutes)
server.route("/zen/v1/models", zenModelRoutes)
server.route("/zen/v1/messages", zenMessageRoutes)

// Dedicated Antigravity routes (always available)
server.route(
  "/antigravity/v1/chat/completions",
  antigravityChatCompletionsRoute,
)
server.route("/antigravity/v1/models", antigravityModelsRoute)
server.route("/antigravity/v1/messages", antigravityMessagesRoute)
