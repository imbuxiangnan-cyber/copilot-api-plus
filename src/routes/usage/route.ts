import consola from "consola"
import { Hono } from "hono"

import { accountManager } from "~/lib/account-manager"
import { state } from "~/lib/state"
import { rootCause } from "~/lib/utils"
import { getCopilotUsage } from "~/services/github/get-copilot-usage"

export const usageRoute = new Hono()

usageRoute.get("/", async (c) => {
  try {
    // In multi-account mode, use the active account's GitHub token
    if (state.multiAccountEnabled && accountManager.hasAccounts()) {
      const account = accountManager.getActiveAccount()
      if (account) {
        const usage = await getCopilotUsage(account.githubToken)
        return c.json(usage)
      }
    }
    const usage = await getCopilotUsage()
    return c.json(usage)
  } catch (error) {
    consola.warn(`Error fetching usage: ${rootCause(error)}`)
    consola.debug("Error fetching usage:", error)
    return c.json({ error: "Failed to fetch Copilot usage" }, 500)
  }
})
