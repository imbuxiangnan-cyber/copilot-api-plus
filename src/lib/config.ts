/**
 * Configuration file management
 * Handles persistent configuration storage for proxy settings and other options
 */

import consola from "consola"
import fs from "node:fs/promises"
import path from "node:path"

import { PATHS } from "./paths"

const CONFIG_FILENAME = "config.json"

export interface ProxyConfig {
  enabled: boolean
  httpProxy?: string
  httpsProxy?: string
  noProxy?: string
}

export interface AppConfig {
  proxy?: ProxyConfig
}

/**
 * Get the path to the config file
 */
export function getConfigPath(): string {
  return path.join(PATHS.DATA_DIR, CONFIG_FILENAME)
}

/**
 * Load configuration from file
 */
export async function loadConfig(): Promise<AppConfig> {
  try {
    const configPath = getConfigPath()
    const content = await fs.readFile(configPath)
    // Buffer can be passed to JSON.parse directly (better performance)
    return JSON.parse(content as unknown as string) as AppConfig
  } catch {
    return {}
  }
}

/**
 * Save configuration to file
 */
export async function saveConfig(config: AppConfig): Promise<void> {
  const configPath = getConfigPath()
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8")
  consola.debug(`Configuration saved to ${configPath}`)
}

/**
 * Get proxy configuration
 */
export async function getProxyConfig(): Promise<ProxyConfig | undefined> {
  const config = await loadConfig()
  return config.proxy
}

/**
 * Save proxy configuration
 */
export async function saveProxyConfig(proxyConfig: ProxyConfig): Promise<void> {
  const config = await loadConfig()
  config.proxy = proxyConfig
  await saveConfig(config)
}

/**
 * Clear proxy configuration
 */
export async function clearProxyConfig(): Promise<void> {
  const config = await loadConfig()
  delete config.proxy
  await saveConfig(config)
}

/**
 * Apply saved proxy configuration to environment variables
 * This should be called at startup to restore proxy settings
 */
export async function applyProxyConfig(): Promise<boolean> {
  const proxyConfig = await getProxyConfig()

  if (!proxyConfig || !proxyConfig.enabled) {
    return false
  }

  if (proxyConfig.httpProxy) {
    process.env.HTTP_PROXY = proxyConfig.httpProxy
    process.env.http_proxy = proxyConfig.httpProxy
  }

  if (proxyConfig.httpsProxy) {
    process.env.HTTPS_PROXY = proxyConfig.httpsProxy
    process.env.https_proxy = proxyConfig.httpsProxy
  }

  if (proxyConfig.noProxy) {
    process.env.NO_PROXY = proxyConfig.noProxy
    process.env.no_proxy = proxyConfig.noProxy
  }

  consola.info("Proxy configuration loaded from saved settings")
  if (proxyConfig.httpProxy) {
    consola.info(`  HTTP_PROXY: ${proxyConfig.httpProxy}`)
  }
  if (proxyConfig.httpsProxy) {
    consola.info(`  HTTPS_PROXY: ${proxyConfig.httpsProxy}`)
  }
  if (proxyConfig.noProxy) {
    consola.info(`  NO_PROXY: ${proxyConfig.noProxy}`)
  }

  return true
}
