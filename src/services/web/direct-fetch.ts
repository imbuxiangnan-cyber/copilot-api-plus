/**
 * Zero-config WebFetch backend — direct `fetch(url)` with safety rails.
 *
 * Rejects:
 *   - non-http(s) URLs
 *   - localhost / loopback / private-RFC1918 / link-local hostnames
 *   - hostnames that resolve to literal private IPs in the URL
 *
 * The intent is to stop the model from probing internal infrastructure
 * (cloud metadata services, intranet, etc.) through the proxy. This is
 * a defense-in-depth check, not a substitute for proper egress control.
 */

import type { FetchOptions, FetchResult } from "./types"

const DEFAULT_MAX_BYTES = 512 * 1024
const DEFAULT_TIMEOUT_MS = 15_000

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

/** Block common private/loopback/link-local addresses. */
const PRIVATE_HOST_PATTERNS: ReadonlyArray<RegExp> = [
  /^localhost$/i,
  /^127(?:\.\d{1,3}){3}$/,
  /^0\.0\.0\.0$/,
  /^10(?:\.\d{1,3}){3}$/,
  /^192\.168(?:\.\d{1,3}){2}$/,
  /^172\.(1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/,
  /^169\.254(?:\.\d{1,3}){2}$/,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
  /^\[?::ffff:127\./i,
]

export function isPrivateHost(host: string): boolean {
  const clean = host.replaceAll(/^\[|\]$/g, "").toLowerCase()
  return PRIVATE_HOST_PATTERNS.some((re) => re.test(clean))
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
      try {
        await reader.cancel()
      } catch {
        // ignore
      }
      break
    }
    chunks.push(value)
  }
  return { buffer: concat(chunks), truncated }
}

export async function directFetch(
  rawUrl: string,
  options?: FetchOptions,
): Promise<FetchResult> {
  const validation = validateFetchUrl(rawUrl)
  if (!validation.ok) {
    throw new Error(`WebFetch refused: ${validation.reason}`)
  }
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(rawUrl, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: controller.signal,
    })

    const contentType =
      response.headers.get("content-type")?.toLowerCase() ?? undefined

    const { buffer, truncated } = await readBodyWithLimit(response, maxBytes)
    // eslint-disable-next-line unicorn/text-encoding-identifier-case
    const raw = new TextDecoder("utf-8", { fatal: false }).decode(buffer)
    const isHtml =
      contentType?.includes("text/html")
      || /^\s*<!doctype html|^\s*<html/i.test(raw)
    const text = isHtml ? extractTextFromHtml(raw) : raw

    return {
      url: response.url || rawUrl,
      status: response.status,
      contentType,
      text,
      truncated,
    }
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
