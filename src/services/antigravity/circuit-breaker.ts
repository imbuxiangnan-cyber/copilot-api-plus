import consola from "consola"

const FAILURE_THRESHOLD = 3
const RESET_TIMEOUT_MS = 30_000
const HALF_OPEN_SUCCESS_THRESHOLD = 2

export const CircuitState = {
  CLOSED: "CLOSED",
  OPEN: "OPEN",
  HALF_OPEN: "HALF_OPEN",
} as const

export type CircuitState = (typeof CircuitState)[keyof typeof CircuitState]

interface CircuitBreakerState {
  state: CircuitState
  failureCount: number
  successCount: number
  lastFailureTime: number
}

const breakers = new Map<string, CircuitBreakerState>()

function getOrCreate(family: string): CircuitBreakerState {
  const existing = breakers.get(family)
  if (existing) return existing
  const fresh: CircuitBreakerState = {
    state: CircuitState.CLOSED,
    failureCount: 0,
    successCount: 0,
    lastFailureTime: 0,
  }
  breakers.set(family, fresh)
  return fresh
}

export function getModelFamily(model: string): string {
  if (model.includes("claude")) return "claude"
  if (model.includes("gemini")) return "gemini"
  return "other"
}

export function canExecute(family: string): boolean {
  const breaker = getOrCreate(family)

  switch (breaker.state) {
    case CircuitState.CLOSED: {
      return true
    }
    case CircuitState.OPEN: {
      if (Date.now() - breaker.lastFailureTime >= RESET_TIMEOUT_MS) {
        consola.info(`[circuit-breaker] ${family}: OPEN -> HALF_OPEN`)
        breaker.state = CircuitState.HALF_OPEN
        breaker.successCount = 0
        return true
      }
      return false
    }
    case CircuitState.HALF_OPEN: {
      return true
    }
    default: {
      return true
    }
  }
}

export function recordSuccess(family: string): void {
  const breaker = getOrCreate(family)

  switch (breaker.state) {
    case CircuitState.HALF_OPEN: {
      breaker.successCount++
      if (breaker.successCount >= HALF_OPEN_SUCCESS_THRESHOLD) {
        consola.info(`[circuit-breaker] ${family}: HALF_OPEN -> CLOSED`)
        breaker.state = CircuitState.CLOSED
        breaker.failureCount = 0
        breaker.successCount = 0
      }
      break
    }
    case CircuitState.CLOSED: {
      breaker.failureCount = 0
      break
    }
    default: {
      break
    }
  }
}

export function recordFailure(family: string): void {
  const breaker = getOrCreate(family)
  breaker.failureCount++
  breaker.lastFailureTime = Date.now()

  switch (breaker.state) {
    case CircuitState.CLOSED: {
      if (breaker.failureCount >= FAILURE_THRESHOLD) {
        consola.info(`[circuit-breaker] ${family}: CLOSED -> OPEN`)
        breaker.state = CircuitState.OPEN
      }
      break
    }
    case CircuitState.HALF_OPEN: {
      consola.info(`[circuit-breaker] ${family}: HALF_OPEN -> OPEN`)
      breaker.state = CircuitState.OPEN
      break
    }
    default: {
      break
    }
  }
}

export function getBackoffDelay(family: string, baseDelay: number): number {
  const breaker = breakers.get(family)
  if (!breaker || breaker.failureCount === 0) return baseDelay
  const delay = baseDelay * Math.pow(2, breaker.failureCount - 1)
  return Math.min(delay, 30_000)
}

export function getCircuitState(family: string): CircuitState {
  return getOrCreate(family).state
}

export function parseRetryDelay(errorText: string): number {
  try {
    const errorData = JSON.parse(errorText) as {
      error?: {
        message?: string
        details?: Array<{
          "@type"?: string
          retryDelay?: string
          quotaResetDelay?: string
        }>
      }
    }

    const details = errorData.error?.details ?? []
    for (const detail of details) {
      if (detail["@type"]?.includes("RetryInfo") && detail.retryDelay) {
        const match = /(\d+(?:\.\d+)?)s/.exec(detail.retryDelay)
        if (match) return Math.ceil(Number.parseFloat(match[1]) * 1000)
      }
      if (detail.quotaResetDelay) {
        const match = /(\d+(?:\.\d+)?)(?:ms|s)/.exec(detail.quotaResetDelay)
        if (match) {
          const value = Number.parseFloat(match[1])
          return detail.quotaResetDelay.includes("ms") ?
              Math.ceil(value)
            : Math.ceil(value * 1000)
        }
      }
    }

    const message = errorData.error?.message ?? ""
    const resetMatch = /quota will reset after (\d+(?:\.\d+)?)s/i.exec(message)
    if (resetMatch) {
      return Math.ceil(Number.parseFloat(resetMatch[1]) * 1000)
    }
  } catch {
    // Ignore parse errors
  }
  return 500
}
