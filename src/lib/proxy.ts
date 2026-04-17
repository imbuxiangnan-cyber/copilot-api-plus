import consola from "consola"
import { getProxyForUrl } from "proxy-from-env"
import { Agent, ProxyAgent, setGlobalDispatcher, type Dispatcher } from "undici"

// Module-level references so that `resetConnections` can swap them out.
// Initialised by `initProxyFromEnv`; the dispatcher closure captures the
// *variables* (not their values), so replacing them is enough.
const agentOptions = {
  keepAliveTimeout: 300_000,
  keepAliveMaxTimeout: 600_000,
  // Allow HTTP/2 when the target supports it.  Inside a CONNECT tunnel
  // the ALPN negotiation and any h2 frames are encrypted traffic — proxy
  // nodes see it as "data flowing" and won't kill the connection for
  // being idle.
  allowH2: true,
  connect: {
    timeout: 15_000,
    keepAlive: true,
    keepAliveInitialDelay: 15_000,
  },
}
let direct: Agent | undefined
let proxies = new Map<string, ProxyAgent>()
/** Whether a proxy is actually configured and in use. */
let proxyActive = false

// ---------------------------------------------------------------------------
// Proxy-tunnel keepalive: periodic lightweight requests through the proxy
// ---------------------------------------------------------------------------

/**
 * Many proxy nodes (especially third-party VPN/airport services) kill
 * CONNECT tunnels that are idle for ~60 s.  During long model thinking
 * phases the SSE stream carries no data, which looks "idle" to the proxy.
 *
 * This keepalive sends a tiny HEAD request to the Copilot API every 45 s
 * through the same proxy.  The encrypted packets flowing through the
 * CONNECT tunnel reset the proxy's idle timer, keeping the tunnel alive.
 *
 * The keepalive is active ONLY while there are SSE streams in flight
 * (tracked via `streamCount`).  When no streams are active it stops to
 * avoid unnecessary traffic.
 */
let keepaliveTimer: ReturnType<typeof setInterval> | undefined
let streamCount = 0
const KEEPALIVE_INTERVAL_MS = 45_000
const KEEPALIVE_URL = "https://api.individual.githubcopilot.com/"

function startKeepalive(): void {
  if (keepaliveTimer) return
  keepaliveTimer = setInterval(() => {
    // Fire-and-forget: we don't care about the response.
    fetch(KEEPALIVE_URL, { method: "HEAD" }).catch(() => {})
    consola.debug("Proxy keepalive ping sent")
  }, KEEPALIVE_INTERVAL_MS)
  // Don't prevent Node from exiting because of this timer.
  keepaliveTimer.unref()
  consola.debug("Proxy keepalive started (45 s interval)")
}

function stopKeepalive(): void {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer)
    keepaliveTimer = undefined
    consola.debug("Proxy keepalive stopped (no active streams)")
  }
}

/**
 * Call when an SSE stream starts.  Activates the proxy-tunnel keepalive
 * if this is the first active stream and a proxy is configured.
 */
export function notifyStreamStart(): void {
  if (!proxyActive) return
  streamCount++
  if (streamCount === 1) startKeepalive()
}

/**
 * Call when an SSE stream ends (success or error).  Stops the keepalive
 * once no streams are active.
 */
export function notifyStreamEnd(): void {
  if (!proxyActive) return
  streamCount = Math.max(0, streamCount - 1)
  if (streamCount === 0) stopKeepalive()
}

export function initProxyFromEnv(): void {
  if (typeof Bun !== "undefined") return

  try {
    direct = new Agent(agentOptions)
    proxies = new Map<string, ProxyAgent>()

    // We only need a minimal dispatcher that implements `dispatch` at runtime.
    // Typing the object as `Dispatcher` forces TypeScript to require many
    // additional methods. Instead, keep a plain object and cast when passing
    // to `setGlobalDispatcher`.
    const dispatcher = {
      dispatch(
        options: Dispatcher.DispatchOptions,
        handler: Dispatcher.DispatchHandler,
      ) {
        try {
          const origin =
            typeof options.origin === "string" ?
              new URL(options.origin)
            : (options.origin as URL)
          const get = getProxyForUrl as unknown as (
            u: string,
          ) => string | undefined
          const raw = get(origin.toString())
          const proxyUrl = raw && raw.length > 0 ? raw : undefined
          if (!proxyUrl) {
            consola.debug(`HTTP proxy bypass: ${origin.hostname}`)
            return (direct as unknown as Dispatcher).dispatch(options, handler)
          }
          let agent = proxies.get(proxyUrl)
          if (!agent) {
            agent = new ProxyAgent({ uri: proxyUrl, ...agentOptions })
            proxies.set(proxyUrl, agent)
          }
          let label = proxyUrl
          try {
            const u = new URL(proxyUrl)
            label = `${u.protocol}//${u.host}`
          } catch {
            /* noop */
          }
          consola.debug(`HTTP proxy route: ${origin.hostname} via ${label}`)
          return (agent as unknown as Dispatcher).dispatch(options, handler)
        } catch {
          return (direct as unknown as Dispatcher).dispatch(options, handler)
        }
      },
      close() {
        for (const agent of proxies.values()) {
          void (agent as unknown as Dispatcher).close()
        }
        // `direct` is always set before the dispatcher is installed.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        return direct!.close()
      },
      destroy() {
        for (const agent of proxies.values()) {
          void (agent as unknown as Dispatcher).destroy()
        }
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        return direct!.destroy()
      },
    }

    setGlobalDispatcher(dispatcher as unknown as Dispatcher)
    proxyActive = true
    consola.debug("HTTP proxy configured from environment (per-URL)")
  } catch (err) {
    consola.debug("Proxy setup skipped:", err)
  }
}

/**
 * Destroy all pooled connections (direct + proxy agents) and replace them
 * with fresh instances.  The global dispatcher's `dispatch` method captures
 * `direct` and `proxies` by reference, so subsequent requests automatically
 * use the new agents — no need to call `setGlobalDispatcher` again.
 *
 * Call this after a network error to discard stale/half-closed sockets that
 * would otherwise cause every retry to wait ~60 s before timing out.
 *
 * Under the Bun runtime (which doesn't use undici) this is a no-op.
 */
export function resetConnections(): void {
  if (typeof Bun !== "undefined") return
  if (!direct) return

  const oldDirect = direct
  const oldProxies = proxies

  direct = new Agent(agentOptions)
  proxies = new Map<string, ProxyAgent>()

  // Tear down old agents in the background — errors are non-fatal.
  void (oldDirect as unknown as Dispatcher).close().catch(() => {})
  for (const agent of oldProxies.values()) {
    void (agent as unknown as Dispatcher).close().catch(() => {})
  }

  consola.debug("Connection pool reset — stale sockets cleared")
}

// ---------------------------------------------------------------------------
// Per-account connection isolation
// ---------------------------------------------------------------------------

/** Separate connection pools per account to prevent cross-account correlation. */
const accountAgents = new Map<string, Agent>()
const accountProxyAgents = new Map<string, Map<string, ProxyAgent>>()

/**
 * Get or create an isolated undici Agent for a specific account.
 * Each account gets its own connection pool so that GitHub cannot correlate
 * accounts by shared TCP connections or TLS sessions.
 */
export function getAccountDispatcher(
  accountId: string,
  accountProxy?: string,
): {
  dispatch: (
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ) => boolean
} {
  // Return a dispatcher that routes through per-account agents
  return {
    dispatch(
      options: Dispatcher.DispatchOptions,
      handler: Dispatcher.DispatchHandler,
    ) {
      try {
        const origin =
          typeof options.origin === "string" ?
            new URL(options.origin)
          : (options.origin as URL)
        // Account-level proxy takes precedence over environment proxy
        let proxyUrl: string | undefined
        if (accountProxy) {
          proxyUrl = accountProxy
        } else {
          const get = getProxyForUrl as unknown as (
            u: string,
          ) => string | undefined
          const raw = get(origin.toString())
          proxyUrl = raw && raw.length > 0 ? raw : undefined
        }

        if (!proxyUrl) {
          // Direct connection — use per-account agent
          let agent = accountAgents.get(accountId)
          if (!agent) {
            agent = new Agent(agentOptions)
            accountAgents.set(accountId, agent)
          }
          return (agent as unknown as Dispatcher).dispatch(options, handler)
        }

        // Proxy connection — use per-account proxy agent
        let proxyMap = accountProxyAgents.get(accountId)
        if (!proxyMap) {
          proxyMap = new Map<string, ProxyAgent>()
          accountProxyAgents.set(accountId, proxyMap)
        }
        let proxyAgent = proxyMap.get(proxyUrl)
        if (!proxyAgent) {
          proxyAgent = new ProxyAgent({ uri: proxyUrl, ...agentOptions })
          proxyMap.set(proxyUrl, proxyAgent)
        }
        return (proxyAgent as unknown as Dispatcher).dispatch(options, handler)
      } catch {
        // Fallback to per-account direct agent
        let agent = accountAgents.get(accountId)
        if (!agent) {
          agent = new Agent(agentOptions)
          accountAgents.set(accountId, agent)
        }
        return (agent as unknown as Dispatcher).dispatch(options, handler)
      }
    },
  }
}

/**
 * Reset connection pools for a specific account.
 */
export function resetAccountConnections(accountId: string): void {
  const oldAgent = accountAgents.get(accountId)
  if (oldAgent) {
    void (oldAgent as unknown as Dispatcher).close().catch(() => {})
    accountAgents.delete(accountId)
  }
  const oldProxies = accountProxyAgents.get(accountId)
  if (oldProxies) {
    for (const agent of oldProxies.values()) {
      void (agent as unknown as Dispatcher).close().catch(() => {})
    }
    accountProxyAgents.delete(accountId)
  }
}

/**
 * Reset all per-account connection pools.
 */
export function resetAllAccountConnections(): void {
  for (const [id] of accountAgents) {
    resetAccountConnections(id)
  }
}

// ---------------------------------------------------------------------------
// Periodic connection pool recreation
// ---------------------------------------------------------------------------

let connectionRecycleTimer: ReturnType<typeof setInterval> | undefined

/**
 * Start periodic connection pool recreation for all per-account pools.
 * Simulates "VS Code restart" behavior — stale connections are replaced
 * with fresh ones at randomized intervals to avoid timing correlation.
 *
 * @param baseIntervalMs  Base interval (default 4 hours).
 */
export function startConnectionRecycling(
  baseIntervalMs: number = 4 * 60 * 60 * 1000,
): void {
  stopConnectionRecycling()

  connectionRecycleTimer = setInterval(() => {
    // Add ±25% jitter to avoid all accounts recycling at the same time
    const jitter = baseIntervalMs * 0.25 * (Math.random() * 2 - 1)
    setTimeout(
      () => {
        resetAllAccountConnections()
        consola.debug("Per-account connection pools recycled")
      },
      Math.max(0, jitter),
    )
  }, baseIntervalMs)

  // Don't prevent Node from exiting
  connectionRecycleTimer.unref()
  consola.info(
    `Connection pool recycling started (interval: ~${Math.round(baseIntervalMs / 3_600_000)}h)`,
  )
}

/**
 * Stop periodic connection pool recreation.
 */
export function stopConnectionRecycling(): void {
  if (connectionRecycleTimer) {
    clearInterval(connectionRecycleTimer)
    connectionRecycleTimer = undefined
  }
}
