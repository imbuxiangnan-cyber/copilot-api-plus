import { Hono } from "hono"

import { clearRequests, getRecentRequests } from "~/lib/request-inspector"

export const requestAdminRoutes = new Hono()

requestAdminRoutes.get("/", (c) => {
  return c.json({ requests: getRecentRequests() })
})

requestAdminRoutes.delete("/", (c) => {
  clearRequests()
  return c.json({ success: true })
})
