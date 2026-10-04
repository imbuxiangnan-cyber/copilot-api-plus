import {
  getAccountDispatcher,
  resetAccountConnections,
  resetConnections,
} from "~/lib/proxy"

const FETCH_TIMEOUT_MS = 120_000

interface FetchOptions {
  accountId?: string
  accountProxy?: string
  externalSignal?: AbortSignal
}

class UpstreamTimeoutError extends Error {}

/** Bound the wait for headers while retaining caller cancellation for the body. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  {
    timeoutMs = FETCH_TIMEOUT_MS,
    accountId,
    accountProxy,
    externalSignal,
  }: FetchOptions & { timeoutMs?: number } = {},
): Promise<Response> {
  const timeout = new AbortController()
  const signals = [timeout.signal]
  if (init.signal) signals.push(init.signal)
  if (externalSignal) signals.push(externalSignal)
  const signal = AbortSignal.any(signals)
  signal.throwIfAborted()
  const timer = setTimeout(() => {
    timeout.abort(
      new UpstreamTimeoutError(`Request timed out after ${timeoutMs}ms`),
    )
  }, timeoutMs)

  try {
    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      ...init,
      signal,
    }
    if (accountId) {
      ;(fetchOptions as { dispatcher?: unknown }).dispatcher =
        getAccountDispatcher(accountId, accountProxy)
    }
    const response = await fetch(url, fetchOptions)
    signal.throwIfAborted()
    return response
  } catch (error) {
    signal.throwIfAborted()
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** One attempt; reset broken pools only for network failures, never cancellation. */
export async function fetchWithRetry(
  url: string,
  buildInit: () => RequestInit,
  options: FetchOptions = {},
): Promise<Response> {
  options.externalSignal?.throwIfAborted()
  const init = buildInit()
  const callerSignals: Array<AbortSignal> = []
  if (init.signal) callerSignals.push(init.signal)
  if (options.externalSignal) callerSignals.push(options.externalSignal)
  const callerSignal = AbortSignal.any(callerSignals)
  callerSignal.throwIfAborted()
  try {
    return await fetchWithTimeout(url, init, options)
  } catch (error) {
    callerSignal.throwIfAborted()
    if (!(error instanceof UpstreamTimeoutError)) {
      if (options.accountId) resetAccountConnections(options.accountId)
      else resetConnections()
    }
    throw error
  }
}
