/**
 * Model Router - Model mapping and per-model concurrency control
 *
 * Provides flexible model name mapping (requested → actual) and
 * per-model concurrency limits using a semaphore pattern.
 */

import consola from "consola"

export interface ModelMappingConfig {
  /** Map from requested model name → actual model name sent to Copilot. Special key "*" is the default/fallback. */
  mapping: Record<string, string>
  /** Per-model max concurrent requests. Special key "default" is the fallback. */
  concurrency: Record<string, number>
}

const DEFAULT_CONFIG: ModelMappingConfig = {
  mapping: {},
  concurrency: {
    default: 10,
  },
}

const DEFAULT_MAX_CONCURRENCY = 10

export class ModelRouter {
  private config: ModelMappingConfig
  private queues: Map<string, { active: number; waiters: Array<() => void> }> =
    new Map()

  constructor(config?: ModelMappingConfig) {
    this.config =
      config ?
        { ...config }
      : { ...DEFAULT_CONFIG, mapping: {}, concurrency: { default: 10 } }
  }

  /**
   * Resolve a requested model name to the actual model name.
   *
   * Resolution order:
   * 1. Exact match in config.mapping
   * 2. Wildcard "*" in config.mapping
   * 3. Passthrough (return requestedModel as-is)
   */
  resolveModel(requestedModel: string): string {
    // 1. Exact match
    if (requestedModel in this.config.mapping) {
      const resolved = this.config.mapping[requestedModel]
      consola.debug(`Model mapping: "${requestedModel}" → "${resolved}"`)
      return resolved
    }

    // 2. Wildcard fallback
    if ("*" in this.config.mapping) {
      const resolved = this.config.mapping["*"]
      consola.debug(
        `Model mapping (wildcard): "${requestedModel}" → "${resolved}"`,
      )
      return resolved
    }

    // 3. Passthrough
    return requestedModel
  }

  /**
   * Acquire a concurrency slot for the given model.
   *
   * The caller should pass the **already-resolved** model name (i.e. the
   * value returned by `resolveModel()`).  This method does NOT re-resolve
   * the name so that concurrency limits are keyed by the actual model sent
   * to the backend, not the user-facing alias.
   *
   * Returns a release function that must be called when the request completes.
   * If the concurrency limit is reached, the returned promise will wait until
   * a slot becomes available.
   */
  async acquireSlot(resolvedModel: string): Promise<() => void> {
    const maxConcurrency =
      (this.config.concurrency as Partial<Record<string, number>>)[
        resolvedModel
      ]
      ?? (this.config.concurrency as Partial<Record<string, number>>)["default"]
      ?? DEFAULT_MAX_CONCURRENCY

    let queue = this.queues.get(resolvedModel)
    if (!queue) {
      queue = { active: 0, waiters: [] }
      this.queues.set(resolvedModel, queue)
    }

    if (queue.active < maxConcurrency) {
      queue.active++
      consola.debug(
        `Slot acquired for "${resolvedModel}": ${queue.active}/${maxConcurrency} active`,
      )
      return () => this.releaseSlot(resolvedModel)
    }

    // Wait for a slot to open
    const currentQueue = queue
    consola.debug(
      `Concurrency limit reached for "${resolvedModel}" (${maxConcurrency}), queuing request`,
    )
    return new Promise<() => void>((resolve) => {
      currentQueue.waiters.push(() => {
        currentQueue.active++
        consola.debug(
          `Queued slot acquired for "${resolvedModel}": ${currentQueue.active}/${maxConcurrency} active`,
        )
        resolve(() => this.releaseSlot(resolvedModel))
      })
    })
  }

  private releaseSlot(model: string): void {
    const queue = this.queues.get(model)
    if (!queue) return

    queue.active--

    if (queue.waiters.length > 0) {
      const next = queue.waiters.shift()
      if (next) next()
    }

    consola.debug(
      `Slot released for "${model}": ${queue.active} active, ${queue.waiters.length} queued`,
    )
  }

  /**
   * Get current concurrency stats for all tracked models.
   */
  getStats(): Record<
    string,
    { active: number; queued: number; maxConcurrency: number }
  > {
    const stats: Record<
      string,
      { active: number; queued: number; maxConcurrency: number }
    > = {}

    for (const [model, queue] of this.queues) {
      const maxConcurrency =
        this.config.concurrency[model] ?? DEFAULT_MAX_CONCURRENCY

      stats[model] = {
        active: queue.active,
        queued: queue.waiters.length,
        maxConcurrency,
      }
    }

    return stats
  }

  /**
   * Update the model name mapping configuration.
   */
  updateMapping(mapping: Record<string, string>): void {
    this.config.mapping = { ...mapping }
    consola.info("Model mapping updated:", Object.keys(mapping).length, "rules")
  }

  /**
   * Update the per-model concurrency configuration.
   */
  updateConcurrency(concurrency: Record<string, number>): void {
    this.config.concurrency = { ...concurrency }
    consola.info(
      "Model concurrency updated:",
      Object.keys(concurrency).length,
      "rules",
    )
  }

  /**
   * Get the current configuration (returns a copy).
   */
  getConfig(): ModelMappingConfig {
    return {
      mapping: { ...this.config.mapping },
      concurrency: { ...this.config.concurrency },
    }
  }
}

export const modelRouter = new ModelRouter()
