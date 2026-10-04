import consola from "consola"
import { Hono, type Context } from "hono"

import { saveModelMappingConfig } from "~/lib/config"
import { modelRouter } from "~/lib/model-router"
import { state } from "~/lib/state"
import { rootCause } from "~/lib/utils"

export const modelAdminRoutes = new Hono()

function isConfigObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function readConfigField(
  c: Context,
  field: string,
): Promise<Record<string, unknown> | Response> {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400)
  }
  if (!isConfigObject(body) || !isConfigObject(body[field])) {
    return c.json({ error: `${field} object is required` }, 400)
  }
  return body[field]
}

// ---------------------------------------------------------------------------
// GET /available — List all models from Copilot
// ---------------------------------------------------------------------------

modelAdminRoutes.get("/available", (c) => {
  try {
    const models = state.models?.data ?? []
    return c.json(models)
  } catch (error) {
    consola.warn(`Error fetching available models: ${rootCause(error)}`)
    consola.debug("Error fetching available models:", error)
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
    consola.warn(`Error fetching model mapping: ${rootCause(error)}`)
    consola.debug("Error fetching model mapping:", error)
    return c.json({ error: "Failed to fetch model mapping" }, 500)
  }
})

// ---------------------------------------------------------------------------
// PUT /mapping — Update model mapping
// ---------------------------------------------------------------------------

modelAdminRoutes.put("/mapping", async (c) => {
  const mapping = await readConfigField(c, "mapping")
  if (mapping instanceof Response) return mapping

  try {
    // Validate that all mapping values are non-empty strings
    for (const [key, value] of Object.entries(mapping)) {
      if (typeof value !== "string" || value.trim() === "") {
        return c.json(
          {
            error: `Invalid mapping value for "${key}": must be a non-empty string`,
          },
          400,
        )
      }
    }

    const validatedMapping = mapping as Record<string, string>
    await saveModelMappingConfig({ mapping: validatedMapping }, () => {
      modelRouter.updateMapping(validatedMapping)
    })

    return c.json(modelRouter.getConfig())
  } catch (error) {
    consola.warn(`Error updating model mapping: ${rootCause(error)}`)
    consola.debug("Error updating model mapping:", error)
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
    consola.warn(`Error fetching concurrency config: ${rootCause(error)}`)
    consola.debug("Error fetching concurrency config:", error)
    return c.json({ error: "Failed to fetch concurrency config" }, 500)
  }
})

// ---------------------------------------------------------------------------
// PUT /concurrency — Update concurrency config
// ---------------------------------------------------------------------------

modelAdminRoutes.put("/concurrency", async (c) => {
  const concurrency = await readConfigField(c, "concurrency")
  if (concurrency instanceof Response) return concurrency

  try {
    // Validate that all concurrency values are positive integers
    for (const [key, value] of Object.entries(concurrency)) {
      if (typeof value !== "number" || value < 1 || !Number.isInteger(value)) {
        return c.json(
          {
            error: `Invalid concurrency value for "${key}": must be a positive integer`,
          },
          400,
        )
      }
    }

    const validatedConcurrency = concurrency as Record<string, number>
    await saveModelMappingConfig({ concurrency: validatedConcurrency }, () => {
      modelRouter.updateConcurrency(validatedConcurrency)
    })

    return c.json({ concurrency: modelRouter.getConfig().concurrency })
  } catch (error) {
    consola.warn(`Error updating concurrency config: ${rootCause(error)}`)
    consola.debug("Error updating concurrency config:", error)
    return c.json({ error: "Failed to update concurrency config" }, 500)
  }
})
