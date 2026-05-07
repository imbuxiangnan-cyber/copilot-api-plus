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
// GET /config — Export-ready config + runtime toggles
// ---------------------------------------------------------------------------

adminRoutes.get("/config", (c) => {
  return c.json({
    selectedModel: state.selectedModel,
    selectedSmallModel: state.selectedSmallModel,
    apiKey: state.apiKeys?.[0] ?? "dummy",
    maxThinking: state.maxThinking,
  })
})

// ---------------------------------------------------------------------------
// PUT /config — Update mutable runtime toggles
//
// Currently supports:
//   - maxThinking: boolean — auto-inject model max thinking budget when the
//     client doesn't specify a `thinking` field.
//
// Other fields (selectedModel, apiKey, etc.) are intentionally read-only here;
// they belong to startup config and shouldn't flip at runtime.
// ---------------------------------------------------------------------------

adminRoutes.put("/config", async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400)
  }

  if (typeof body !== "object" || body === null) {
    return c.json({ error: "Body must be a JSON object" }, 400)
  }

  const patch = body as Record<string, unknown>
  const updated: Record<string, unknown> = {}

  if ("maxThinking" in patch) {
    if (typeof patch.maxThinking !== "boolean") {
      return c.json({ error: "maxThinking must be a boolean" }, 400)
    }
    state.maxThinking = patch.maxThinking
    updated.maxThinking = patch.maxThinking
  }

  return c.json({ ok: true, updated })
})
