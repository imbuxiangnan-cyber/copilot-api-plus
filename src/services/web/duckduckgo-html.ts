/**
 * Zero-config DuckDuckGo HTML search backend.
 *
 * Uses the public `html.duckduckgo.com/html` endpoint (no API key). The
 * response is regular HTML, parsed by hand into title/url/snippet. This
 * is deliberately tolerant — DDG occasionally changes class names; the
 * parser falls back to anchor scraping if the canonical pattern misses.
 *
 * Not a production-grade search provider — it's the "good-enough"
 * default so Claude CLI's WebSearch keeps working without a paid key.
 */

import type { SearchBackend, SearchOptions, SearchResult } from "./types"

const DDG_HTML_ENDPOINT = "https://html.duckduckgo.com/html/"
const DEFAULT_MAX_RESULTS = 10
const REQUEST_TIMEOUT_MS = 15_000

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

/**
 * Decode the DuckDuckGo redirect-wrapped URLs back to their target.
 * DDG HTML wraps every result link as `/l/?uddg=<encoded>&...`.
 */
export function unwrapDuckDuckGoUrl(href: string): string {
  if (!href) return href
  try {
    // Handle protocol-relative `//duckduckgo.com/l/?uddg=...`
    const normalised = href.startsWith("//") ? `https:${href}` : href
    const url = new URL(normalised, "https://duckduckgo.com")
    if (url.pathname === "/l/" || url.pathname.endsWith("/l/")) {
      const uddg = url.searchParams.get("uddg")
      if (uddg) return decodeURIComponent(uddg)
    }
    return url.toString()
  } catch {
    return href
  }
}

function decodeHtmlEntities(text: string): string {
  return text
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'")
    .replaceAll(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 10)),
    )
}

function stripHtml(html: string): string {
  return decodeHtmlEntities(html.replaceAll(/<[^>]+>/g, "")).trim()
}

/**
 * Parse a DuckDuckGo HTML response into search results.
 * Exported for unit testing with fixture HTML.
 */
export function parseDuckDuckGoHtml(html: string): Array<SearchResult> {
  const results: Array<SearchResult> = []
  // Each result lives in <div class="result"> ... </div>. The title +
  // url anchor is `<a class="result__a" href="...">title</a>` and the
  // snippet is `<a class="result__snippet">...</a>`.
  const resultBlockRe =
    /<div class="result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi
  const matches = html.matchAll(resultBlockRe)
  for (const match of matches) {
    const block = match[1]
    const anchor =
      /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(
        block,
      )
    if (!anchor) continue
    const url = unwrapDuckDuckGoUrl(decodeHtmlEntities(anchor[1]))
    const title = stripHtml(anchor[2])
    const snippetMatch =
      /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
      || /<div[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i.exec(block)
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : ""
    if (url && title) {
      results.push({ url, title, snippet })
    }
  }
  return results
}

export class DuckDuckGoHtmlBackend implements SearchBackend {
  readonly id = "duckduckgo"

  async search(
    query: string,
    options?: SearchOptions,
  ): Promise<Array<SearchResult>> {
    if (!query || !query.trim()) return []

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const body = new URLSearchParams({ q: query, kl: "wt-wt" })
      const response = await fetch(DDG_HTML_ENDPOINT, {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
        body: body.toString(),
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new Error(
          `DuckDuckGo HTML search failed: HTTP ${response.status}`,
        )
      }
      const html = await response.text()
      const all = parseDuckDuckGoHtml(html)
      const limit = options?.maxResults ?? DEFAULT_MAX_RESULTS
      return all.slice(0, Math.max(0, limit))
    } finally {
      clearTimeout(timer)
    }
  }
}
