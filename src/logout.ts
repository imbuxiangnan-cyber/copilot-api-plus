#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"

import { ensurePaths, PATHS } from "./lib/paths"
import { clearGithubToken } from "./lib/token"

export async function runLogout(): Promise<void> {
  await ensurePaths()
  await clearGithubToken()
  consola.success("Logged out successfully")
  consola.info(`Token file location: ${PATHS.GITHUB_TOKEN_PATH}`)
}

export const logout = defineCommand({
  meta: {
    name: "logout",
    description: "Clear stored GitHub token and logout",
  },
  run() {
    return runLogout()
  },
})
