/**
 * Zero-config WebFetch backend — direct `fetch(url)` with safety rails.
 *
 * Rejects:
 *   - non-http(s) URLs
 *   - localhost / loopback / private-RFC1918 / link-local hostnames
 *   - private IP literals, including IPv4-mapped IPv6
 *
 * The intent is to stop the model from probing internal infrastructure
 * (cloud metadata services, intranet, etc.) through the proxy. This is
 * a defense-in-depth check, not a substitute for proper egress control:
 * DNS results are not pinned. Every redirect target is checked too.
 */

import type { FetchOptions, FetchResult } from "./types"

const DEFAULT_MAX_BYTES = 512 * 1024
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_REDIRECTS = 20
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

/** Block common private/loopback/link-local addresses. */
const PRIVATE_HOST_PATTERNS: ReadonlyArray<RegExp> = [
  /^(?:.*\.)?localhost$/i,
  /^127(?:\.\d{1,3}){3}$/,
  /^0(?:\.\d{1,3}){3}$/,
  /^10(?:\.\d{1,3}){3}$/,
  /^192\.168(?:\.\d{1,3}){2}$/,
  /^172\.(1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/,
  /^169\.254(?:\.\d{1,3}){2}$/,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2}$/,
]

export function isPrivateHost(host: string): boolean {
  const clean = host.replaceAll(/^\[|\]$|\.$/g, "").toLowerCase()
  if (PRIVATE_HOST_PATTERNS.some((re) => re.test(clean))) return true
  if (!clean.includes(":")) return false

  // URL normalizes IPv4-mapped IPv6 to hex, for example ::ffff:7f00:1.
  let address: string
  try {
    address = new URL(`http://[${clean}]/`).hostname.slice(1, -1)
  } catch {
    return false
  }
  const halves = address.split("::")
  const left = halves[0] ? halves[0].split(":") : []
  const right = halves[1] ? halves[1].split(":") : []
  const groups = [
    ...left,
    ...Array<string>(8 - left.length - right.length).fill("0"),
    ...right,
  ].map((group) => Number.parseInt(group, 16))
  const first = groups[0]
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) return true
  if (groups.slice(0, 7).every((group) => group === 0))
    return groups[7] === 0 || groups[7] === 1
  if (
    groups.slice(0, 5).every((group) => group === 0)
    && groups[5] === 0xffff
  ) {
    return isPrivateHost(
      [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join(
        ".",
      ),
    )
  }
  return false
}

export interface UrlValidation {
  ok: boolean
  reason?: string
}

export function validateFetchUrl(rawUrl: string): UrlValidation {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, reason: "invalid URL" }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `unsupported protocol: ${url.protocol}` }
  }
  if (!url.hostname) {
    return { ok: false, reason: "missing hostname" }
  }
  if (isPrivateHost(url.hostname)) {
    return {
      ok: false,
      reason: `blocked private/loopback host: ${url.hostname}`,
    }
  }
  return { ok: true }
}

function decodeHtmlEntitiesBasic(text: string): string {
  return text
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
}

/** Strip script/style + tags from HTML. Crude but adequate for LLM context. */
export function extractTextFromHtml(html: string): string {
  return decodeHtmlEntitiesBasic(
    html
      .replaceAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replaceAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replaceAll(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replaceAll(/<!--[\s\S]*?-->/g, " ")
      .replaceAll(/<[^>]+>/g, " ")
      .replaceAll(/\s+/g, " "),
  ).trim()
}

interface BodyReadResult {
  buffer: Uint8Array
  truncated: boolean
}

async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
): Promise<BodyReadResult> {
  const reader = response.body?.getReader()
  if (!reader) return { buffer: new Uint8Array(0), truncated: false }

  const chunks: Array<Uint8Array> = []
  let collected = 0
  let truncated = false
  try {
    while (true) {
      const { value, done } = (await reader.read()) as {
        value?: Uint8Array
        done: boolean
      }
      if (done) break
      if (!value) continue
      collected += value.byteLength
      if (collected > maxBytes) {
        truncated = true
        const overflow = collected - maxBytes
        const keep = value.byteLength - overflow
        if (keep > 0) chunks.push(value.subarray(0, keep))
        await reader.cancel().catch(() => {})
        break
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return { buffer: concat(chunks), truncated }
}

/** Validate every redirect target before opening another connection. */
async function fetchWithValidatedRedirects(
  rawUrl: string,
  signal: AbortSignal,
): Promise<{ response: Response; url: string }> {
  let url = new URL(rawUrl)
  for (let redirects = 0; ; redirects++) {
    signal.throwIfAborted()
    const validation = validateFetchUrl(url.toString())
    if (!validation.ok)
      throw new Error(`WebFetch refused: ${validation.reason}`)

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "manual",
      signal,
    })
    const location = response.headers.get("location")
    if (!REDIRECT_STATUSES.has(response.status) || location === null)
      return { response, url: url.toString() }

    try {
      signal.throwIfAborted()
      if (redirects >= MAX_REDIRECTS)
        throw new Error(`WebFetch refused: exceeded ${MAX_REDIRECTS} redirects`)
      url = new URL(location, url)
    } finally {
      // Undici cannot reliably reclaim unread bodies through garbage collection.
      await response.body?.cancel().catch(() => {})
    }
  }
}

export async function directFetch(
  rawUrl: string,
  options: FetchOptions = {},
): Promise<FetchResult> {
  options.signal?.throwIfAborted()
  const validation = validateFetchUrl(rawUrl)
  if (!validation.ok) {
    throw new Error(`WebFetch refused: ${validation.reason}`)
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const controller = new AbortController()
  const signal =
    options.signal ?
      AbortSignal.any([controller.signal, options.signal])
    : controller.signal
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const { response, url } = await fetchWithValidatedRedirects(rawUrl, signal)
    signal.throwIfAborted()

    const contentType =
      response.headers.get("content-type")?.toLowerCase() ?? undefined

    const { buffer, truncated } = await readBodyWithLimit(response, maxBytes)
    signal.throwIfAborted()
    // eslint-disable-next-line unicorn/text-encoding-identifier-case
    const raw = new TextDecoder("utf-8", { fatal: false }).decode(buffer)
    const isHtml =
      contentType?.includes("text/html")
      || /^\s*<!doctype html|^\s*<html/i.test(raw)
    const text = isHtml ? extractTextFromHtml(raw) : raw

    return {
      url: response.url || url,
      status: response.status,
      contentType,
      text,
      truncated,
    }
  } catch (error) {
    signal.throwIfAborted()
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function concat(chunks: Array<Uint8Array>): Uint8Array {
  const total = chunks.reduce((s, c) => s + c.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
