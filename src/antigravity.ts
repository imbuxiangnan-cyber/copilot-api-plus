#!/usr/bin/env node

import "dotenv/config"
import { defineCommand } from "citty"
import consola from "consola"

import { applyProxyConfig } from "./lib/config"
import { ensurePaths } from "./lib/paths"
import { initProxyFromEnv } from "./lib/proxy"

/**
 * Add a new Antigravity account via OAuth
 */
async function addAccount(): Promise<void> {
  const { setupAntigravity, loadAntigravityAuth } = await import(
    "~/services/antigravity/auth"
  )

  const existingAuth = await loadAntigravityAuth()
  if (existingAuth && existingAuth.accounts.length > 0) {
    const enabledCount = existingAuth.accounts.filter((a) => a.enable).length
    consola.info(
      `Found ${existingAuth.accounts.length} existing accounts (${enabledCount} enabled)`,
    )
  }

  await setupAntigravity()
}

/**
 * List all Antigravity accounts
 */
async function listAccounts(): Promise<void> {
  const { loadAntigravityAuth } = await import("~/services/antigravity/auth")

  const auth = await loadAntigravityAuth()

  if (!auth || auth.accounts.length === 0) {
    consola.info("No Antigravity accounts configured")
    return
  }

  consola.info(`\nAntigravity Accounts (${auth.accounts.length} total):`)
  consola.info("=".repeat(50))

  for (let i = 0; i < auth.accounts.length; i++) {
    const account = auth.accounts[i]
    const isCurrent = i === auth.currentIndex
    const status = account.enable ? "enabled" : "disabled"
    const marker = isCurrent ? "→ " : "  "
    const projectId = account.project_id || "unknown"

    consola.info(
      `${marker}[${i}] Project: ${projectId} | Status: ${status}${isCurrent ? " (current)" : ""}`,
    )
  }
}

/**
 * Remove an Antigravity account by index
 */
async function removeAccount(index: number): Promise<void> {
  const { loadAntigravityAuth, saveAntigravityAuth } = await import(
    "~/services/antigravity/auth"
  )

  const auth = await loadAntigravityAuth()

  if (!auth || auth.accounts.length === 0) {
    consola.error("No Antigravity accounts configured")
    return
  }

  if (index < 0 || index >= auth.accounts.length) {
    consola.error(
      `Invalid index. Must be between 0 and ${auth.accounts.length - 1}`,
    )
    return
  }

  const removed = auth.accounts.splice(index, 1)[0]

  // Adjust current index if needed
  if (auth.currentIndex >= auth.accounts.length) {
    auth.currentIndex = Math.max(0, auth.accounts.length - 1)
  }

  await saveAntigravityAuth(auth)
  consola.success(
    `Removed account ${index} (Project: ${removed.project_id || "unknown"})`,
  )
}

/**
 * Clear all Antigravity accounts
 */
async function clearAccounts(): Promise<void> {
  const { clearAntigravityAuth } = await import("~/services/antigravity/auth")

  const confirm = await consola.prompt(
    "Are you sure you want to remove all Antigravity accounts?",
    { type: "confirm", initial: false },
  )

  if (confirm) {
    await clearAntigravityAuth()
  }
}

export const antigravity = defineCommand({
  meta: {
    name: "antigravity",
    description: "Manage Google Antigravity accounts",
  },
  subCommands: {
    add: defineCommand({
      meta: {
        name: "add",
        description: "Add a new Antigravity account via OAuth",
      },
      async run() {
        await ensurePaths()
        const savedProxyApplied = await applyProxyConfig()
        if (savedProxyApplied) {
          initProxyFromEnv()
        }
        await addAccount()
      },
    }),
    list: defineCommand({
      meta: {
        name: "list",
        description: "List all Antigravity accounts",
      },
      async run() {
        await ensurePaths()
        await listAccounts()
      },
    }),
    remove: defineCommand({
      meta: {
        name: "remove",
        description: "Remove an Antigravity account by index",
      },
      args: {
        index: {
          type: "positional",
          description: "Account index to remove (use 'list' to see indexes)",
          required: true,
        },
      },
      async run({ args }) {
        await ensurePaths()
        const indexStr = String(args.index)
        const index = Number.parseInt(indexStr, 10)
        if (Number.isNaN(index)) {
          consola.error("Index must be a number")
          return
        }
        await removeAccount(index)
      },
    }),
    clear: defineCommand({
      meta: {
        name: "clear",
        description: "Remove all Antigravity accounts",
      },
      async run() {
        await ensurePaths()
        await clearAccounts()
      },
    }),
  },
})
