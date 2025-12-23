import consola from "consola"
import { Hono } from "hono"

import { state } from "~/lib/state"
import { getAntigravityUsage } from "~/services/antigravity/get-models"
import { getCopilotUsage } from "~/services/github/get-copilot-usage"

export const usageRoute = new Hono()

usageRoute.get("/", async (c) => {
  try {
    // Handle different modes
    if (state.antigravityMode) {
      const usage = await getAntigravityUsage()
      return c.json(usage)
    }

    if (state.zenMode) {
      // Zen doesn't have a public usage API
      return c.json({
        error: "Usage statistics not available for Zen mode",
        message: "Please check your usage at https://console.opencode.ai",
        mode: "zen",
      }, 200)
    }

    // Default: Copilot mode
    const usage = await getCopilotUsage()
    return c.json(usage)
  } catch (error) {
    consola.error("Error fetching usage:", error)

    // Return mode-specific error messages
    if (state.antigravityMode) {
      return c.json({ error: "Failed to fetch Antigravity usage" }, 500)
    }
    if (state.zenMode) {
      return c.json({ error: "Failed to fetch Zen usage" }, 500)
    }
    return c.json({ error: "Failed to fetch Copilot usage" }, 500)
  }
})
