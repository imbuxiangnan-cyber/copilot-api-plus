#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"
import fs from "node:fs/promises"

import { ensurePaths, PATHS } from "./lib/paths"
import { clearGithubToken } from "./lib/token"
import { rootCause } from "./lib/utils"

/**
 * Remove the multi-account store so a subsequent login starts from a clean
 * slate. Without this, `accounts.json` keeps the previous account on disk and
 * the next startup loads it instead of migrating the freshly-logged-in token.
 */
async function clearAccountsFile(): Promise<void> {
  try {
    await fs.rm(PATHS.ACCOUNTS_PATH, { force: true })
    consola.info("Multi-account store cleared")
  } catch (err) {
    consola.warn(`Failed to clear multi-account store: ${rootCause(err)}`)
    consola.debug("Failed to clear multi-account store:", err)
  }
}

export async function runLogout(options: {
  github?: boolean
  all?: boolean
}): Promise<void> {
  await ensurePaths()

  if (options.all || options.github) {
    await clearGithubToken()
    await clearAccountsFile()
    consola.success("Logged out from GitHub Copilot")
    consola.info(`Token file location: ${PATHS.GITHUB_TOKEN_PATH}`)
    consola.info(`Accounts file location: ${PATHS.ACCOUNTS_PATH}`)
    return
  }

  // Default: clear GitHub token AND the multi-account store, otherwise the
  // next login keeps showing the old account in the web admin page.
  await clearGithubToken()
  await clearAccountsFile()
  consola.success("Logged out from GitHub Copilot")
  consola.info(`Token file location: ${PATHS.GITHUB_TOKEN_PATH}`)
  consola.info(`Accounts file location: ${PATHS.ACCOUNTS_PATH}`)
}

export const logout = defineCommand({
  meta: {
    name: "logout",
    description: "Clear stored credentials and logout",
  },
  args: {
    github: {
      alias: "g",
      type: "boolean",
      default: false,
      description: "Clear GitHub Copilot token",
    },
    all: {
      alias: "a",
      type: "boolean",
      default: false,
      description: "Clear all credentials",
    },
  },
  run({ args }) {
    return runLogout({
      github: args.github,
      all: args.all,
    })
  },
})
