import consola from "consola"
import { getProxyForUrl } from "proxy-from-env"
import { Agent, ProxyAgent, setGlobalDispatcher, type Dispatcher } from "undici"

// Module-level references so that `resetConnections` can swap them out.
// Initialised by `initProxyFromEnv`; the dispatcher closure captures the
// *variables* (not their values), so replacing them is enough.
const agentOptions = {
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connect: { timeout: 15_000 },
}
let direct: Agent | undefined
let proxies = new Map<string, ProxyAgent>()

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
