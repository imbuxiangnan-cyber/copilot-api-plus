/**
 * Search backend registry. DuckDuckGo HTML is the zero-config default;
 * other backends are reserved (bing/brave/searxng) and currently fall
 * back to DDG when selected without an implementation/key — keeping
 * the field forward-compatible without forcing users to configure keys.
 */

import type { SearchBackend } from "./types"

import { DuckDuckGoHtmlBackend } from "./duckduckgo-html"

export type SearchBackendId = "bing" | "brave" | "duckduckgo" | "searxng"

let activeBackend: SearchBackend = new DuckDuckGoHtmlBackend()

export function setSearchBackend(_id: SearchBackendId | undefined): void {
  // For now only DuckDuckGo is wired in; other ids are accepted but
  // silently fall back to DDG. This keeps config forward-compatible.
  // Future backends (bing/brave/searxng) should branch on `_id` here.
  activeBackend = new DuckDuckGoHtmlBackend()
}

export function getSearchBackend(): SearchBackend {
  return activeBackend
}

export { directFetch } from "./direct-fetch"
export type { FetchResult, SearchResult } from "./types"
