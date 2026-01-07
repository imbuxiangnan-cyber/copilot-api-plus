/**
 * Request Queue with Concurrency Limit
 *
 * Limits concurrent requests to prevent rate limiting.
 * Allows configurable number of concurrent requests.
 */

type QueuedRequest<T> = {
  execute: () => Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

export class RequestQueue {
  private queue: Array<QueuedRequest<unknown>> = []
  private activeCount = 0
  private maxConcurrent: number
  private minDelayMs: number
  private lastRequestTime = 0

  constructor(maxConcurrent = 2, minDelayMs = 300) {
    this.maxConcurrent = maxConcurrent
    this.minDelayMs = minDelayMs
  }

  async enqueue<T>(execute: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        execute: execute as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      })
      void this.processQueue()
    })
  }

  private async processQueue(): Promise<void> {
    if (this.activeCount >= this.maxConcurrent || this.queue.length === 0) {
      return
    }

    const request = this.queue.shift()
    if (!request) return

    this.activeCount++

    // Ensure minimum delay between requests
    const now = Date.now()
    const elapsed = now - this.lastRequestTime
    if (elapsed < this.minDelayMs) {
      await new Promise((r) => setTimeout(r, this.minDelayMs - elapsed))
    }
    this.lastRequestTime = Date.now()

    try {
      const result = await request.execute()
      request.resolve(result)
    } catch (error) {
      request.reject(error)
    } finally {
      this.activeCount--
      void this.processQueue()
    }
  }
}

// Allow 2 concurrent requests with 500ms minimum gap
export const antigravityQueue = new RequestQueue(2, 500)
