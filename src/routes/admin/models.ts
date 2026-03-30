import consola from "consola"
import { Hono } from "hono"

import { saveModelMappingConfig } from "~/lib/config"
import { modelRouter } from "~/lib/model-router"
import { state } from "~/lib/state"

export const modelAdminRoutes = new Hono()

// ---------------------------------------------------------------------------
// GET /available — List all models from Copilot
// ---------------------------------------------------------------------------

modelAdminRoutes.get("/available", (c) => {
  try {
    return c.json({ models: state.models ?? [] })
  } catch (error) {
    consola.error("Error fetching available models:", error)
    return c.json({ error: "Failed to fetch available models" }, 500)
  }
})

// ---------------------------------------------------------------------------
// GET /mapping — Get current model mapping config
// ---------------------------------------------------------------------------

modelAdminRoutes.get("/mapping", (c) => {
  try {
    return c.json(modelRouter.getConfig())
  } catch (error) {
    consola.error("Error fetching model mapping:", error)
    return c.json({ error: "Failed to fetch model mapping" }, 500)
  }
})

// ---------------------------------------------------------------------------
// PUT /mapping — Update model mapping
// ---------------------------------------------------------------------------

modelAdminRoutes.put("/mapping", async (c) => {
  try {
    const body = await c.req.json<{ mapping?: Record<string, string> }>()

    if (!body.mapping || typeof body.mapping !== "object") {
      return c.json({ error: "mapping object is required" }, 400)
    }

    // Validate that all mapping values are non-empty strings
    for (const [key, value] of Object.entries(body.mapping)) {
      if (typeof value !== "string" || value.trim() === "") {
        return c.json(
          {
            error: `Invalid mapping value for "${key}": must be a non-empty string`,
          },
          400,
        )
      }
    }

    modelRouter.updateMapping(body.mapping)
    await saveModelMappingConfig(modelRouter.getConfig())

    return c.json(modelRouter.getConfig())
  } catch (error) {
    consola.error("Error updating model mapping:", error)
    return c.json({ error: "Failed to update model mapping" }, 500)
  }
})

// ---------------------------------------------------------------------------
// GET /concurrency — Get concurrency config
// ---------------------------------------------------------------------------

modelAdminRoutes.get("/concurrency", (c) => {
  try {
    return c.json({ concurrency: modelRouter.getConfig().concurrency })
  } catch (error) {
    consola.error("Error fetching concurrency config:", error)
    return c.json({ error: "Failed to fetch concurrency config" }, 500)
  }
})

// ---------------------------------------------------------------------------
// PUT /concurrency — Update concurrency config
// ---------------------------------------------------------------------------

modelAdminRoutes.put("/concurrency", async (c) => {
  try {
    const body = await c.req.json<{ concurrency?: Record<string, number> }>()

    if (!body.concurrency || typeof body.concurrency !== "object") {
      return c.json({ error: "concurrency object is required" }, 400)
    }

    // Validate that all concurrency values are positive integers
    for (const [key, value] of Object.entries(body.concurrency)) {
      if (typeof value !== "number" || value < 1 || !Number.isInteger(value)) {
        return c.json(
          {
            error: `Invalid concurrency value for "${key}": must be a positive integer`,
          },
          400,
        )
      }
    }

    modelRouter.updateConcurrency(body.concurrency)
    await saveModelMappingConfig(modelRouter.getConfig())

    return c.json({ concurrency: modelRouter.getConfig().concurrency })
  } catch (error) {
    consola.error("Error updating concurrency config:", error)
    return c.json({ error: "Failed to update concurrency config" }, 500)
  }
})
