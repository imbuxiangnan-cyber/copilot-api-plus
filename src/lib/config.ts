/**
 * Configuration file management
 * Handles persistent configuration storage for proxy settings and other options
 */

import consola from "consola"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import { PATHS } from "./paths"

const CONFIG_FILENAME = "config.json"
let configWriteQueue: Promise<void> = Promise.resolve()

export interface ProxyConfig {
  enabled: boolean
  httpProxy?: string
  httpsProxy?: string
  noProxy?: string
}

export interface ModelMappingConfig {
  mapping?: Record<string, string>
  concurrency?: Record<string, number>
}

/**
 * Reserved search backend selector. Default `"duckduckgo"` (zero-config).
 * `bing` / `brave` / `searxng` are accepted for forward-compat; without
 * provider keys wired up they currently fall back to DuckDuckGo. Used
 * only by the WebSearch/WebFetch fallback when Copilot rejects the
 * Anthropic server-side web tools.
 */
export type SearchBackendId = "bing" | "brave" | "duckduckgo" | "searxng"

export interface AppConfig {
  proxy?: ProxyConfig
  modelMapping?: ModelMappingConfig
  search_backend?: SearchBackendId
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
    // eslint-disable-next-line unicorn/prefer-json-parse-buffer
    const content = await fs.readFile(configPath, "utf8")
    const config: unknown = JSON.parse(content)
    if (
      typeof config !== "object"
      || config === null
      || Array.isArray(config)
    ) {
      throw new TypeError("Configuration must be a JSON object")
    }
    return config as AppConfig
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {}
    }
    throw error
  }
}

/** Keep every read-modify-write transaction in this process ordered. */
function queueConfigWrite(operation: () => Promise<void>): Promise<void> {
  const pending = configWriteQueue.then(operation)
  // Let later transactions run after a failure, while returning it to its caller.
  configWriteQueue = pending.catch(() => {})
  return pending
}

async function writeConfigAtomically(config: AppConfig): Promise<void> {
  const configPath = getConfigPath()
  const temporaryPath = `${configPath}.${randomUUID()}.tmp`
  const content = JSON.stringify(config, null, 2)
  try {
    await fs.writeFile(temporaryPath, content, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    })
    await fs.rename(temporaryPath, configPath)
  } catch (error) {
    try {
      await fs.unlink(temporaryPath)
    } catch (cleanupError) {
      if (
        !(cleanupError instanceof Error)
        || !("code" in cleanupError)
        || cleanupError.code !== "ENOENT"
      ) {
        consola.warn("Failed to remove temporary configuration:", cleanupError)
      }
    }
    throw error
  }
  consola.debug(`Configuration saved to ${configPath}`)
}

function updateConfig(
  update: (config: AppConfig) => void,
  onSaved?: () => void,
): Promise<void> {
  return queueConfigWrite(async () => {
    const config = await loadConfig()
    update(config)
    await writeConfigAtomically(config)
    onSaved?.()
  })
}

/**
 * Replace the complete configuration, ordered with all other config writes.
 */
export async function saveConfig(config: AppConfig): Promise<void> {
  await queueConfigWrite(() => writeConfigAtomically(config))
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
  await updateConfig((config) => {
    config.proxy = proxyConfig
  })
}

/**
 * Clear proxy configuration
 */
export async function clearProxyConfig(): Promise<void> {
  await updateConfig((config) => {
    delete config.proxy
  })
}

/**
 * Get model mapping configuration
 */
export async function getModelMappingConfig(): Promise<
  ModelMappingConfig | undefined
> {
  const config = await loadConfig()
  return config.modelMapping
}

/**
 * Merge model configuration fields and apply runtime changes only after saving.
 * The optional synchronous callback runs before the next write transaction.
 */
export async function saveModelMappingConfig(
  modelMapping: ModelMappingConfig,
  onSaved?: () => void,
): Promise<void> {
  await updateConfig((config) => {
    config.modelMapping = { ...config.modelMapping, ...modelMapping }
  }, onSaved)
}

/**
 * Get configured search backend id (or undefined for default DDG).
 */
export async function getSearchBackendId(): Promise<
  SearchBackendId | undefined
> {
  const config = await loadConfig()
  return config.search_backend
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
