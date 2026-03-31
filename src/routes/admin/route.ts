import { Hono } from "hono"

import { state } from "~/lib/state"

import { accountRoutes } from "./accounts"
import { modelAdminRoutes } from "./models"
import { statsRoute } from "./stats"

export const adminRoutes = new Hono()

adminRoutes.route("/accounts", accountRoutes)
adminRoutes.route("/models", modelAdminRoutes)
adminRoutes.route("/stats", statsRoute)

// ---------------------------------------------------------------------------
// GET /config — Export-ready config with selected models and API key
// ---------------------------------------------------------------------------

adminRoutes.get("/config", (c) => {
  return c.json({
    selectedModel: state.selectedModel,
    selectedSmallModel: state.selectedSmallModel,
    apiKey: state.apiKeys?.[0] ?? "dummy",
  })
})
