#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"

import { ensurePaths, PATHS } from "./lib/paths"
import { clearGithubToken } from "./lib/token"
import { clearZenAuth, getZenAuthPath } from "./services/zen/auth"

export async function runLogout(options: { zen?: boolean; all?: boolean }): Promise<void> {
  await ensurePaths()

  if (options.all) {
    // Clear both GitHub and Zen credentials
    await clearGithubToken()
    await clearZenAuth()
    consola.success("Logged out from all services")
    consola.info(`GitHub token: ${PATHS.GITHUB_TOKEN_PATH}`)
    consola.info(`Zen API key: ${getZenAuthPath()}`)
    return
  }

  if (options.zen) {
    // Clear only Zen API key
    await clearZenAuth()
    consola.success("Logged out from OpenCode Zen")
    consola.info(`Zen API key location: ${getZenAuthPath()}`)
    return
  }

  // Default: show interactive prompt
  const choice = await consola.prompt("Which credentials do you want to clear?", {
    type: "select",
    options: [
      "GitHub Copilot token",
      "OpenCode Zen API key",
      "Both (all credentials)",
    ],
  })

  if (choice === "GitHub Copilot token") {
    await clearGithubToken()
    consola.success("Logged out from GitHub Copilot")
    consola.info(`Token file location: ${PATHS.GITHUB_TOKEN_PATH}`)
  } else if (choice === "OpenCode Zen API key") {
    await clearZenAuth()
    consola.success("Logged out from OpenCode Zen")
    consola.info(`Zen API key location: ${getZenAuthPath()}`)
  } else if (choice === "Both (all credentials)") {
    await clearGithubToken()
    await clearZenAuth()
    consola.success("Logged out from all services")
  }
}

export const logout = defineCommand({
  meta: {
    name: "logout",
    description: "Clear stored credentials and logout",
  },
  args: {
    zen: {
      alias: "z",
      type: "boolean",
      default: false,
      description: "Clear only OpenCode Zen API key",
    },
    all: {
      alias: "a",
      type: "boolean",
      default: false,
      description: "Clear all credentials (GitHub and Zen)",
    },
  },
  run({ args }) {
    return runLogout({
      zen: args.zen,
      all: args.all,
    })
  },
})
