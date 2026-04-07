import consola from "consola"
import { Hono } from "hono"

import { state } from "~/lib/state"
import { rootCause } from "~/lib/utils"

export const tokenRoute = new Hono()

tokenRoute.get("/", (c) => {
  try {
    return c.json({
      token: state.copilotToken,
    })
  } catch (error) {
    consola.warn(`Error fetching token: ${rootCause(error)}`)
    consola.debug("Error fetching token:", error)
    return c.json({ error: "Failed to fetch token", token: null }, 500)
  }
})
