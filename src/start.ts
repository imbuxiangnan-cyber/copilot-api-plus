#!/usr/bin/env node

import { defineCommand } from "citty"
import clipboard from "clipboardy"
import consola from "consola"
import { serve, type ServerHandler } from "srvx"
import invariant from "tiny-invariant"

import { ensurePaths } from "./lib/paths"
import { initProxyFromEnv } from "./lib/proxy"
import { generateEnvScript } from "./lib/shell"
import { state } from "./lib/state"
import { setupCopilotToken, setupGitHubToken } from "./lib/token"
import { cacheModels, cacheVSCodeVersion } from "./lib/utils"
import { server } from "./server"

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
  zen: boolean
  zenApiKey?: string
}

/**
 * Start and configure the Copilot API server according to the provided options.
 *
 * Configures proxy and logging, initializes global state and credentials, ensures
 * required paths and model data are cached, optionally generates a Claude Code
 * launch command (and attempts to copy it to the clipboard), prints a usage
 * viewer URL, and begins serving HTTP requests on the specified port.
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
 *   - zen: Enable OpenCode Zen mode (proxy to Zen instead of GitHub Copilot)
 *   - zenApiKey: OpenCode Zen API key (optional; if omitted will prompt for setup)
 */
export async function runServer(options: RunServerOptions): Promise<void> {
  if (options.proxyEnv) {
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

  if (state.apiKeys && state.apiKeys.length > 0) {
    consola.info(
      `API key authentication enabled with ${state.apiKeys.length} key(s)`,
    )
  }

  await ensurePaths()

  // Handle Zen mode
  if (options.zen) {
    consola.info("OpenCode Zen mode enabled")
    state.zenMode = true

    // Setup Zen API key
    if (options.zenApiKey) {
      state.zenApiKey = options.zenApiKey
      consola.info("Using provided Zen API key")
    } else {
      const { setupZenApiKey, loadZenAuth } = await import("~/services/zen/auth")
      const existingAuth = await loadZenAuth()

      if (existingAuth) {
        state.zenApiKey = existingAuth.apiKey
        consola.info("Using existing Zen API key")
      } else {
        const apiKey = await setupZenApiKey()
        state.zenApiKey = apiKey
      }
    }

    // Cache Zen models
    const { cacheZenModels } = await import("~/services/zen/get-models")
    await cacheZenModels()

    consola.info(
      `Available Zen models: \n${state.zenModels?.data.map((model) => `- ${model.id}`).join("\n")}`,
    )
  } else {
    // Standard Copilot mode
    await cacheVSCodeVersion()

    if (options.githubToken) {
      state.githubToken = options.githubToken
      consola.info("Using provided GitHub token")
      // Validate the provided token
      try {
        const { getGitHubUser } = await import("~/services/github/get-user")
        const user = await getGitHubUser()
        consola.info(`Logged in as ${user.login}`)
      } catch (error) {
        consola.error("Provided GitHub token is invalid")
        throw error
      }
    } else {
      await setupGitHubToken()
    }

    try {
      await setupCopilotToken()
    } catch (error) {
      // If getting Copilot token fails with 401, the GitHub token might be invalid
      const { HTTPError } = await import("~/lib/error")
      if (error instanceof HTTPError && error.response.status === 401) {
        consola.error("Failed to get Copilot token - GitHub token may be invalid or Copilot access revoked")
        const { clearGithubToken } = await import("~/lib/token")
        await clearGithubToken()
        consola.info("Please restart to re-authenticate")
      }
      throw error
    }
    
    await cacheModels()

    consola.info(
      `Available models: \n${state.models?.data.map((model) => `- ${model.id}`).join("\n")}`,
    )
  }

  const serverUrl = `http://localhost:${options.port}`

  if (options.claudeCode) {
    const models = state.zenMode ? state.zenModels : state.models
    invariant(models, "Models should be loaded by now")

    const selectedModel = await consola.prompt(
      "Select a model to use with Claude Code",
      {
        type: "select",
        options: models.data.map((model) => model.id),
      },
    )

    const selectedSmallModel = await consola.prompt(
      "Select a small model to use with Claude Code",
      {
        type: "select",
        options: models.data.map((model) => model.id),
      },
    )

    const command = generateEnvScript(
      {
        ANTHROPIC_BASE_URL: serverUrl,
        ANTHROPIC_AUTH_TOKEN: "dummy",
        ANTHROPIC_MODEL: selectedModel,
        ANTHROPIC_DEFAULT_SONNET_MODEL: selectedModel,
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

  consola.box(
    `🌐 Usage Viewer: https://imbuxiangnan-cyber.github.io/copilot-api-plus?endpoint=${serverUrl}/usage`,
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
    zen: {
      alias: "z",
      type: "boolean",
      default: false,
      description: "Enable OpenCode Zen mode (proxy to Zen instead of GitHub Copilot)",
    },
    "zen-api-key": {
      type: "string",
      description: "OpenCode Zen API key (get from https://opencode.ai/zen)",
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
      zen: args.zen,
      zenApiKey: args["zen-api-key"],
    })
  },
})