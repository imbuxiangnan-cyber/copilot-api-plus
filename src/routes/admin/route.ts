import { Hono } from "hono"

import { accountRoutes } from "./accounts"
import { modelAdminRoutes } from "./models"
import { statsRoute } from "./stats"

export const adminRoutes = new Hono()

adminRoutes.route("/accounts", accountRoutes)
adminRoutes.route("/models", modelAdminRoutes)
adminRoutes.route("/stats", statsRoute)
