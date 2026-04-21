import { Hono } from "hono"

import { accountManager } from "~/lib/account-manager"
import { modelRouter } from "~/lib/model-router"

export const statsRoute = new Hono()

statsRoute.get("/", (c) => {
  return c.json({
    accounts: {
      total: accountManager.accountCount,
      active: accountManager.activeAccountCount,
    },
    models: modelRouter.getStats(),
    uptime: process.uptime(),
  })
})

statsRoute.delete("/", (c) => {
  modelRouter.resetStats()
  return c.json({ success: true })
})
