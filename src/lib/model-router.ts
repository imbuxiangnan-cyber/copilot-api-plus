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

interface ModelQueue {
  active: number
  waiters: Array<() => void>
}

export class ModelRouter {
  private config: ModelMappingConfig
  private queues: Map<string, ModelQueue> = new Map()
  private requestCounts: Map<string, number> = new Map()

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
   * Returns an idempotent release function to call when the request completes.
   * If the concurrency limit is reached, the returned promise will wait until
   * a slot becomes available.
   */
  acquireSlot(
    resolvedModel: string,
    signal?: AbortSignal,
  ): Promise<() => void> {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- AbortSignal permits arbitrary reasons, which must be preserved.
    if (signal?.aborted) return Promise.reject(signal.reason)
    const queue: ModelQueue = this.queues.get(resolvedModel) ?? {
      active: 0,
      waiters: [],
    }
    this.queues.set(resolvedModel, queue)

    return new Promise<() => void>((resolve, reject) => {
      const onAbort = () => {
        const index = queue.waiters.indexOf(waiter)
        if (index === -1) return
        queue.waiters.splice(index, 1)
        signal?.removeEventListener("abort", onAbort)
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Preserve the caller's cancellation reason.
        reject(signal?.reason)
      }
      const waiter = () => {
        signal?.removeEventListener("abort", onAbort)
        resolve(this.grantSlot(resolvedModel, queue))
      }
      queue.waiters.push(waiter)
      signal?.addEventListener("abort", onAbort, { once: true })
      this.drainQueue(resolvedModel, queue)
    })
  }

  private getMaxConcurrency(model: string): number {
    const concurrency = this.config.concurrency as Partial<
      Record<string, number>
    >
    return concurrency[model] ?? concurrency.default ?? DEFAULT_MAX_CONCURRENCY
  }

  private grantSlot(model: string, queue: ModelQueue): () => void {
    queue.active++
    this.requestCounts.set(model, (this.requestCounts.get(model) ?? 0) + 1)
    consola.debug(
      `Slot acquired for "${model}": ${queue.active}/${this.getMaxConcurrency(model)} active`,
    )

    let released = false
    return () => {
      if (released) return
      released = true
      this.releaseSlot(model)
    }
  }

  private drainQueue(model: string, queue: ModelQueue): void {
    const maxConcurrency = this.getMaxConcurrency(model)
    while (queue.active < maxConcurrency && queue.waiters.length > 0) {
      const next = queue.waiters.shift()
      if (next) next()
    }
  }

  private releaseSlot(model: string): void {
    const queue = this.queues.get(model)
    if (!queue) return

    queue.active--

    this.drainQueue(model, queue)

    consola.debug(
      `Slot released for "${model}": ${queue.active} active, ${queue.waiters.length} queued`,
    )
  }

  /**
   * Get current concurrency stats for all tracked models.
   */
  getStats(): Record<
    string,
    {
      active: number
      queued: number
      maxConcurrency: number
      totalRequests: number
    }
  > {
    const stats: Record<
      string,
      {
        active: number
        queued: number
        maxConcurrency: number
        totalRequests: number
      }
    > = {}

    const allModels = new Set([
      ...this.queues.keys(),
      ...this.requestCounts.keys(),
    ])
    for (const model of allModels) {
      const queue = this.queues.get(model)
      stats[model] = {
        active: queue?.active ?? 0,
        queued: queue?.waiters.length ?? 0,
        maxConcurrency: this.getMaxConcurrency(model),
        totalRequests: this.requestCounts.get(model) ?? 0,
      }
    }

    return stats
  }

  resetStats(): void {
    this.requestCounts.clear()
  }

  /**
   * Update the model name mapping configuration.
   */
  updateMapping(mapping: Record<string, string>): void {
    this.config.mapping = { ...mapping }
    consola.debug(
      "Model mapping updated:",
      Object.keys(mapping).length,
      "rules",
    )
  }

  /**
   * Update the per-model concurrency configuration.
   * Admit queued requests when capacity increases; let active requests finish
   * before admitting more when a limit decreases.
   */
  updateConcurrency(concurrency: Record<string, number>): void {
    this.config.concurrency = { ...concurrency }
    for (const [model, queue] of this.queues) {
      this.drainQueue(model, queue)
    }
    consola.debug(
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
