#!/usr/bin/env node

// Load environment variables from .env file
import "dotenv/config"
/* eslint-disable require-atomic-updates */
import { defineCommand } from "citty"
import clipboard from "clipboardy"
import consola from "consola"
import { serve, type ServerHandler } from "srvx"
import invariant from "tiny-invariant"

import { accountManager } from "./lib/account-manager"
import {
  applyProxyConfig,
  getModelMappingConfig,
  getSearchBackendId,
} from "./lib/config"
import { modelRouter } from "./lib/model-router"
import { ensurePaths } from "./lib/paths"
import { initProxyFromEnv } from "./lib/proxy"
import { generateEnvScript } from "./lib/shell"
import { state } from "./lib/state"
import {
  setupCopilotToken,
  setupGitHubToken,
  stopCopilotTokenRefresh,
} from "./lib/token"
import { cacheModels, cacheVSCodeVersion, rootCause } from "./lib/utils"
import { server } from "./server"
import { setSearchBackend } from "./services/web"

interface RunServerOptions {
  port: number
  verbose: boolean
  accountType: string
  manual: boolean
  rateLimit?: number
  rateLimitWait: boolean
  githubToken?: string
  claudeCode: boolean
  showToken: boolean
  proxyEnv: boolean
  apiKeys?: Array<string>
  disableAnthropicPassthrough: boolean
  maxThinking: boolean
  githubBaseUrl?: string
  githubApiBaseUrl?: string
}

/**
 * Initialize multi-account mode: load accounts from disk, optionally migrate
 * the legacy single-account, and start background token/usage refresh.
 */
async function initMultiAccount(): Promise<void> {
  try {
    await accountManager.loadAccounts()

    if (accountManager.hasAccounts()) {
      // Multi-account mode: accounts.json exists with accounts
      state.multiAccountEnabled = true
      consola.info(
        `Multi-account mode enabled with ${accountManager.accountCount} account(s)`,
      )

      // Stop single-account token refresh — multi-account has its own
      stopCopilotTokenRefresh()

      // Start background token/usage refresh
      await accountManager.startBackgroundRefresh()
    } else if (state.githubToken && !accountManager.accountsFileExisted) {
      // accounts.json didn't exist at all — first run, migrate legacy single account.
      // If the file existed but was empty, the user intentionally removed all accounts.
      try {
        const account = await accountManager.migrateFromLegacy(
          state.githubToken,
          state.accountType,
        )
        state.multiAccountEnabled = true
        consola.info(
          `Migrated current account (${account.githubLogin ?? account.label}) to multi-account mode`,
        )

        // Stop single-account token refresh — multi-account has its own
        stopCopilotTokenRefresh()

        await accountManager.startBackgroundRefresh()
      } catch (migrationError) {
        consola.warn(
          "Could not migrate to multi-account, staying in single-account mode:",
          migrationError,
        )
      }
    }
  } catch (error) {
    consola.debug("Multi-account init skipped:", error)
    // Non-fatal — single account mode continues to work
  }
}

/**
 * Load model mapping and concurrency configuration from the config file and
 * apply it to the model router.
 */
async function initModelRouting(): Promise<void> {
  try {
    const modelMappingConfig = await getModelMappingConfig()
    if (modelMappingConfig) {
      if (modelMappingConfig.mapping) {
        modelRouter.updateMapping(modelMappingConfig.mapping)
        consola.info(
          `Model mapping loaded: ${Object.keys(modelMappingConfig.mapping).length} rule(s)`,
        )
      }
      if (modelMappingConfig.concurrency) {
        modelRouter.updateConcurrency(modelMappingConfig.concurrency)
        consola.info(
          `Model concurrency loaded: ${Object.keys(modelMappingConfig.concurrency).length} rule(s)`,
        )
      }
    }
  } catch (error) {
    consola.debug("Model routing config not loaded:", error)
  }
}

/**
 * Apply search backend selection from saved config. Zero-config default
 * is DuckDuckGo HTML; other ids are accepted but currently fall back.
 */
async function initSearchBackend(): Promise<void> {
  try {
    const backendId = await getSearchBackendId()
    setSearchBackend(backendId)
    if (backendId && backendId !== "duckduckgo") {
      consola.info(
        `Search backend "${backendId}" requested; using DuckDuckGo HTML (other backends not yet implemented)`,
      )
    }
  } catch (error) {
    consola.debug("Search backend config not loaded:", error)
  }
}

/**
 * Interactively select models and generate a Claude Code environment script.
 */
async function setupClaudeCodeEnv(serverUrl: string): Promise<void> {
  const modelList = state.models?.data
  invariant(modelList, "Models should be loaded by now")

  const selectedModel = await consola.prompt(
    "Select a model to use with Claude Code",
    {
      type: "select",
      options: modelList.map((model) => model.id),
    },
  )

  if (typeof selectedModel === "symbol") {
    consola.info("Model selection cancelled")
    return
  }

  const selectedSmallModel = await consola.prompt(
    "Select a small model to use with Claude Code",
    {
      type: "select",
      options: modelList.map((model) => model.id),
    },
  )

  if (typeof selectedSmallModel === "symbol") {
    consola.info("Model selection cancelled")
    return
  }

  // Save selections to state for API access
  state.selectedModel = selectedModel
  state.selectedSmallModel = selectedSmallModel

  const command = generateEnvScript(
    {
      ANTHROPIC_BASE_URL: serverUrl,
      ANTHROPIC_AUTH_TOKEN: state.apiKeys?.[0] ?? "dummy",
      ANTHROPIC_MODEL: selectedModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: selectedModel,
      ANTHROPIC_DEFAULT_OPUS_MODEL: selectedModel,
      ANTHROPIC_REASONING_MODEL: selectedModel,
      ANTHROPIC_SMALL_FAST_MODEL: selectedSmallModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: selectedSmallModel,
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
    "claude",
  )

  try {
    clipboard.writeSync(command)
    consola.success("Copied Claude Code command to clipboard!")
  } catch {
    consola.warn(
      "Failed to copy to clipboard. Here is the Claude Code command:",
    )
    consola.log(command)
  }
}
async function validateGitHubToken(token: string): Promise<void> {
  state.githubToken = token
  consola.info("Using provided GitHub token")
  try {
    const { getGitHubUser } = await import("~/services/github/get-user")
    const user = await getGitHubUser()
    consola.info(`Logged in as ${user.login}`)
  } catch (error) {
    consola.error("Provided GitHub token is invalid")
    throw error
  }
}

/**
 * Apply the --max-thinking CLI flag to runtime state and log when disabled.
 * Extracted to keep `runServer` under the eslint complexity ceiling.
 */
function applyMaxThinkingOption(enabled: boolean): void {
  state.maxThinking = enabled
  if (!enabled) {
    consola.info(
      "Max thinking auto-injection DISABLED — clients must specify `thinking` explicitly to enable extended thinking",
    )
  }
}

/**
 * Start and configure the Copilot API server according to the provided options.
 *
 * @param options - Server startup options:
 *   - port: Port number to listen on
 *   - verbose: Enable verbose logging
 *   - accountType: Account plan to use ("individual", "business", "enterprise")
 *   - manual: Require manual approval for requests
 *   - rateLimit: Seconds to wait between requests (optional)
 *   - rateLimitWait: Wait instead of erroring when rate limit is hit
 *   - githubToken: GitHub token to use (optional; if omitted a token setup prompt may run)
 *   - claudeCode: Generate a Claude Code environment launch command
 *   - showToken: Expose GitHub/Copilot tokens in responses for debugging
 *   - proxyEnv: Initialize proxy settings from environment variables
 *   - apiKeys: Optional list of API keys to enable API key authentication
 */
export async function runServer(options: RunServerOptions): Promise<void> {
  // Apply saved proxy configuration first (if any)
  const savedProxyApplied = await applyProxyConfig()

  // Then apply --proxy-env if specified (overrides saved config)
  if (options.proxyEnv) {
    initProxyFromEnv()
  } else if (savedProxyApplied) {
    // If saved proxy was applied, initialize the proxy dispatcher
    initProxyFromEnv()
  }

  if (options.verbose) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  state.accountType = options.accountType
  if (options.accountType !== "individual") {
    consola.info(`Using ${options.accountType} plan GitHub account`)
  }

  state.manualApprove = options.manual
  state.rateLimitSeconds = options.rateLimit
  state.rateLimitWait = options.rateLimitWait
  state.showToken = options.showToken
  state.apiKeys = options.apiKeys
  state.disableAnthropicPassthrough = options.disableAnthropicPassthrough
  state.githubBaseUrl = options.githubBaseUrl
  state.githubApiBaseUrl = options.githubApiBaseUrl

  if (options.disableAnthropicPassthrough) {
    consola.info(
      "Native Anthropic passthrough DISABLED — all /v1/messages requests will translate via /chat/completions",
    )
  }

  applyMaxThinkingOption(options.maxThinking)

  if (state.apiKeys && state.apiKeys.length > 0) {
    consola.info(
      `API key authentication enabled with ${state.apiKeys.length} key(s)`,
    )
  }

  await ensurePaths()

  // Standard Copilot mode
  await cacheVSCodeVersion()

  try {
    await (options.githubToken ?
      validateGitHubToken(options.githubToken)
    : setupGitHubToken())
  } catch (error) {
    // Network errors during token validation shouldn't prevent startup
    // The token might still be valid, and we'll find out on first API call
    consola.error(`GitHub authentication failed: ${rootCause(error)}`)
    consola.info(
      "The server will start, but requests may fail until connectivity is restored",
    )
  }

  try {
    await setupCopilotToken()
  } catch (error) {
    // If getting Copilot token fails with 401, the GitHub token might be invalid
    const { HTTPError } = await import("~/lib/error")
    if (error instanceof HTTPError && error.response.status === 401) {
      consola.error(
        "Failed to get Copilot token - GitHub token may be invalid or Copilot access revoked",
      )
      const { clearGithubToken } = await import("~/lib/token")
      await clearGithubToken()
      consola.info("Please restart to re-authenticate")
    }
    throw error
  }

  await cacheModels()

  // Initialize multi-account mode
  await initMultiAccount()

  // Initialize model routing from config
  await initModelRouting()

  // Apply search backend selection (default duckduckgo, zero-config)
  await initSearchBackend()

  consola.info(
    `Available models: \n${state.models?.data.map((model) => `- ${model.id}`).join("\n")}`,
  )

  const serverUrl = `http://localhost:${options.port}`

  if (options.claudeCode) {
    await setupClaudeCodeEnv(serverUrl)
  }

  const multiAccountInfo =
    state.multiAccountEnabled ?
      `\n👥 Multi-account: ${accountManager.activeAccountCount}/${accountManager.accountCount} active`
    : ""

  consola.box(
    `🌐 Usage Viewer: https://imbuxiangnan-cyber.github.io/copilot-api-plus?endpoint=${serverUrl}/usage${multiAccountInfo}`,
  )

  serve({
    fetch: server.fetch as ServerHandler,
    port: options.port,
  })
}

export const start = defineCommand({
  meta: {
    name: "start",
    description: "Start the Copilot API server",
  },
  args: {
    port: {
      alias: "p",
      type: "string",
      default: "4141",
      description: "Port to listen on",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "account-type": {
      alias: "a",
      type: "string",
      default: "individual",
      description: "Account type to use (individual, business, enterprise)",
    },
    manual: {
      type: "boolean",
      default: false,
      description: "Enable manual request approval",
    },
    "rate-limit": {
      alias: "r",
      type: "string",
      description: "Rate limit in seconds between requests",
    },
    wait: {
      alias: "w",
      type: "boolean",
      default: false,
      description:
        "Wait instead of error when rate limit is hit. Has no effect if rate limit is not set",
    },
    "github-token": {
      alias: "g",
      type: "string",
      description:
        "Provide GitHub token directly (must be generated using the `auth` subcommand)",
    },
    "github-base-url": {
      type: "string",
      description: "GitHub web base URL (for GitHub Enterprise device login)",
    },
    "github-api-base-url": {
      type: "string",
      description: "GitHub API base URL (for GitHub Enterprise REST API)",
    },
    "claude-code": {
      alias: "c",
      type: "boolean",
      default: false,
      description:
        "Generate a command to launch Claude Code with Copilot API config",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show GitHub and Copilot tokens on fetch and refresh",
    },
    "proxy-env": {
      type: "boolean",
      default: false,
      description: "Initialize proxy from environment variables",
    },
    "api-key": {
      type: "string",
      description: "API keys for authentication",
    },
    "disable-anthropic-passthrough": {
      type: "boolean",
      default: false,
      description:
        "Force translate all /v1/messages requests via /chat/completions (disable native Copilot Anthropic endpoint)",
    },
    "max-thinking": {
      type: "boolean",
      default: true,
      description:
        "Auto-inject the model's maximum thinking budget when the client doesn't specify one. Default: true. Disable with --no-max-thinking to save tokens (recommended once Copilot switches to per-token billing).",
    },
  },
  run({ args }) {
    const rateLimitRaw = args["rate-limit"]
    const rateLimit =
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      rateLimitRaw === undefined ? undefined : Number.parseInt(rateLimitRaw, 10)

    // Handle multiple API keys - citty may pass a string or array
    const apiKeyRaw = args["api-key"]
    let apiKeys: Array<string> | undefined
    if (apiKeyRaw) {
      apiKeys = Array.isArray(apiKeyRaw) ? apiKeyRaw : [apiKeyRaw]
    }

    return runServer({
      port: Number.parseInt(args.port, 10),
      verbose: args.verbose,
      accountType: args["account-type"],
      manual: args.manual,
      rateLimit,
      rateLimitWait: args.wait,
      githubToken: args["github-token"],
      claudeCode: args["claude-code"],
      showToken: args["show-token"],
      proxyEnv: args["proxy-env"],
      apiKeys,
      disableAnthropicPassthrough: args["disable-anthropic-passthrough"],
      maxThinking: args["max-thinking"],
      githubBaseUrl: args["github-base-url"],
      githubApiBaseUrl: args["github-api-base-url"],
    })
  },
})
