import { Hono } from "hono"
import { cors } from "hono/cors"

import { apiKeyAuthMiddleware } from "./lib/api-key-auth"
import { modelLogger } from "./lib/model-logger"
import { requestInspector } from "./lib/request-inspector"
import { adminRoutes } from "./routes/admin/route"
import { completionRoutes } from "./routes/chat-completions/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import { responsesRoutes } from "./routes/responses/route"
import { tokenRoute } from "./routes/token/route"
import { usageRoute } from "./routes/usage/route"

export const server = new Hono()

server.use(modelLogger())
server.use(cors())
server.use(apiKeyAuthMiddleware)
server.use(requestInspector())

server.get("/", (c) => c.text("Server running"))

// Chat completions
server.route("/chat/completions", completionRoutes)

// Models
server.route("/models", modelRoutes)

server.route("/embeddings", embeddingRoutes)
server.route("/usage", usageRoute)
server.route("/token", tokenRoute)
server.route("/responses", responsesRoutes)

// Compatibility with tools that expect v1/ prefix
server.route("/v1/chat/completions", completionRoutes)
server.route("/v1/models", modelRoutes)
server.route("/v1/embeddings", embeddingRoutes)
server.route("/v1/responses", responsesRoutes)

// Anthropic compatible endpoints
server.route("/v1/messages", messageRoutes)

// Admin API (Usage Viewer UI)
server.route("/api", adminRoutes)
