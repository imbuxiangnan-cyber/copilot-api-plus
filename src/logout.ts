#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"

import { ensurePaths, PATHS } from "./lib/paths"
import { clearGithubToken } from "./lib/token"

export async function runLogout(options: {
  github?: boolean
  all?: boolean
}): Promise<void> {
  await ensurePaths()

  if (options.all || options.github) {
    await clearGithubToken()
    consola.success("Logged out from GitHub Copilot")
    consola.info(`Token file location: ${PATHS.GITHUB_TOKEN_PATH}`)
    return
  }

  // Default: clear GitHub token
  await clearGithubToken()
  consola.success("Logged out from GitHub Copilot")
  consola.info(`Token file location: ${PATHS.GITHUB_TOKEN_PATH}`)
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
