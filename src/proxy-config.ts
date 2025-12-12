/**
 * Proxy configuration command
 * Allows users to configure, enable, disable, and view proxy settings
 */

/* eslint-disable max-lines-per-function */
/* eslint-disable complexity */

import * as p from "@clack/prompts"
import { defineCommand } from "citty"
import consola from "consola"

import {
  clearProxyConfig,
  getProxyConfig,
  saveProxyConfig,
  type ProxyConfig,
} from "./lib/config"
import { ensurePaths } from "./lib/paths"

export const proxy = defineCommand({
  meta: {
    name: "proxy",
    description: "Configure proxy settings (persistent)",
  },
  args: {
    set: {
      type: "boolean",
      default: false,
      description: "Set proxy configuration interactively",
    },
    enable: {
      type: "boolean",
      default: false,
      description: "Enable saved proxy configuration",
    },
    disable: {
      type: "boolean",
      default: false,
      description: "Disable proxy (keep settings)",
    },
    clear: {
      type: "boolean",
      default: false,
      description: "Clear all proxy settings",
    },
    show: {
      type: "boolean",
      default: false,
      description: "Show current proxy configuration",
    },
    "http-proxy": {
      type: "string",
      description: "HTTP proxy URL (e.g., http://proxy:8080)",
    },
    "https-proxy": {
      type: "string",
      description: "HTTPS proxy URL (e.g., http://proxy:8080)",
    },
    "no-proxy": {
      type: "string",
      description: "Comma-separated list of hosts to bypass proxy",
    },
  },
  async run({ args }) {
    await ensurePaths()

    // Show current configuration
    if (
      args.show
      || (!args.set
        && !args.enable
        && !args.disable
        && !args.clear
        && !args["http-proxy"]
        && !args["https-proxy"])
    ) {
      const config = await getProxyConfig()
      if (!config) {
        consola.info("No proxy configuration saved.")
        consola.info("")
        consola.info("To configure proxy, use one of:")
        consola.info(
          "  copilot-api-plus proxy --set                    # Interactive setup",
        )
        consola.info(
          "  copilot-api-plus proxy --http-proxy http://proxy:8080  # Direct set",
        )
        return
      }

      consola.info("Current proxy configuration:")
      consola.info(`  Status: ${config.enabled ? "✅ Enabled" : "❌ Disabled"}`)
      if (config.httpProxy) {
        consola.info(`  HTTP_PROXY: ${config.httpProxy}`)
      }
      if (config.httpsProxy) {
        consola.info(`  HTTPS_PROXY: ${config.httpsProxy}`)
      }
      if (config.noProxy) {
        consola.info(`  NO_PROXY: ${config.noProxy}`)
      }
      return
    }

    // Clear proxy settings
    if (args.clear) {
      await clearProxyConfig()
      consola.success("Proxy configuration cleared.")
      return
    }

    // Enable proxy
    if (args.enable) {
      const config = await getProxyConfig()
      if (!config) {
        consola.error(
          "No proxy configuration saved. Use --set to configure first.",
        )
        return
      }
      config.enabled = true
      await saveProxyConfig(config)
      consola.success("Proxy enabled. It will be used on next server start.")
      return
    }

    // Disable proxy
    if (args.disable) {
      const config = await getProxyConfig()
      if (!config) {
        consola.info("No proxy configuration to disable.")
        return
      }
      config.enabled = false
      await saveProxyConfig(config)
      consola.success("Proxy disabled. Settings are preserved.")
      return
    }

    // Direct set via command line args
    if (args["http-proxy"] || args["https-proxy"]) {
      const newConfig: ProxyConfig = {
        enabled: true,
        httpProxy: args["http-proxy"],
        httpsProxy: args["https-proxy"] || args["http-proxy"], // Use HTTP proxy for HTTPS if not specified
        noProxy: args["no-proxy"],
      }
      await saveProxyConfig(newConfig)
      consola.success("Proxy configuration saved and enabled.")
      consola.info(`  HTTP_PROXY: ${newConfig.httpProxy || "(not set)"}`)
      consola.info(`  HTTPS_PROXY: ${newConfig.httpsProxy || "(not set)"}`)
      if (newConfig.noProxy) {
        consola.info(`  NO_PROXY: ${newConfig.noProxy}`)
      }
      return
    }

    // Interactive setup
    if (args.set) {
      p.intro("Proxy Configuration")

      const existingConfig = await getProxyConfig()

      const httpProxy = await p.text({
        message: "HTTP Proxy URL",
        placeholder: "http://proxy:8080",
        initialValue: existingConfig?.httpProxy || "",
      })

      if (p.isCancel(httpProxy)) {
        p.cancel("Configuration cancelled.")
        return
      }

      const httpsProxy = await p.text({
        message: "HTTPS Proxy URL (leave empty to use HTTP proxy)",
        placeholder: "http://proxy:8080",
        initialValue: existingConfig?.httpsProxy || "",
      })

      if (p.isCancel(httpsProxy)) {
        p.cancel("Configuration cancelled.")
        return
      }

      const noProxy = await p.text({
        message: "No Proxy (comma-separated hosts to bypass)",
        placeholder: "localhost,127.0.0.1,.local",
        initialValue: existingConfig?.noProxy || "",
      })

      if (p.isCancel(noProxy)) {
        p.cancel("Configuration cancelled.")
        return
      }

      const enable = await p.confirm({
        message: "Enable proxy now?",
        initialValue: true,
      })

      if (p.isCancel(enable)) {
        p.cancel("Configuration cancelled.")
        return
      }

      const newConfig: ProxyConfig = {
        enabled: enable,
        httpProxy: httpProxy || undefined,
        httpsProxy: httpsProxy || httpProxy || undefined,
        noProxy: noProxy || undefined,
      }

      await saveProxyConfig(newConfig)

      p.outro(`Proxy configuration saved${enable ? " and enabled" : ""}.`)
    }
  },
})
