import { Hono } from "hono"

import consola from "consola"

import { state } from "~/lib/state"

export const tokenRoute = new Hono()

tokenRoute.get("/", (c) => {
  try {
    return c.json({
      token: state.copilotToken,
    })
  } catch (error) {
    consola.error("Error fetching token:", error)
    return c.json({ error: "Failed to fetch token", token: null }, 500)
  }
})
