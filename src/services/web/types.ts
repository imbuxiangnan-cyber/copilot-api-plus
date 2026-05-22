/**
 * Shared types for the proxy-side WebSearch / WebFetch backends.
 *
 * Zero-config defaults: DuckDuckGo HTML for search, direct `fetch(url)` for
 * fetch. Other backends (bing/brave/searxng) are reserved for users who
 * supply their own API keys via the `search_backend` config field.
 */

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export interface SearchOptions {
  /** Optional max results cap. Backend may return fewer. */
  maxResults?: number
}

export interface SearchBackend {
  readonly id: string
  search(query: string, options?: SearchOptions): Promise<Array<SearchResult>>
}

export interface FetchResult {
  url: string
  status: number
  contentType?: string
  text: string
  truncated: boolean
}

export interface FetchOptions {
  /** Maximum response bytes to read. Default ~512 KiB. */
  maxBytes?: number
  /** Whole-request timeout (ms). Default 15s. */
  timeoutMs?: number
}
