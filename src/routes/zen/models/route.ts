/**
 * OpenCode Zen Models Route
 *
 * Returns available models from Zen.
 */

/* eslint-disable require-atomic-updates */

import consola from "consola"
import { Hono } from "hono"

import { state } from "~/lib/state"

export const zenModelRoutes = new Hono()

zenModelRoutes.get("/", async (c) => {
  if (!state.zenMode || !state.zenApiKey) {
    return c.json(
      { error: "Zen mode is not enabled. Start with --zen flag." },
      400,
    )
  }

  try {
    // Return cached models
    if (state.zenModels) {
      return c.json(state.zenModels)
    }

    // Fetch fresh if not cached
    const { getZenModels } = await import("~/services/zen/get-models")
    const models = await getZenModels()
    state.zenModels = models
    return c.json(models)
  } catch (error) {
    consola.error("Zen models error:", error)
    return c.json(
      {
        error: {
          message: error instanceof Error ? error.message : "Unknown error",
          type: "zen_error",
        },
      },
      500,
    )
  }
})
