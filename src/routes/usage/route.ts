import consola from "consola"
import { Hono } from "hono"

import { getCopilotUsage } from "~/services/github/get-copilot-usage"

export const usageRoute = new Hono()

usageRoute.get("/", async (c) => {
  try {
    const usage = await getCopilotUsage()
    return c.json(usage)
  } catch (error) {
    consola.error("Error fetching usage:", error)
    return c.json({ error: "Failed to fetch Copilot usage" }, 500)
  }
})
