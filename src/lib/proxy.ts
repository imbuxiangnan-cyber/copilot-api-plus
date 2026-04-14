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
