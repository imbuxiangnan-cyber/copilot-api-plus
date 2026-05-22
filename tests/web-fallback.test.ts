import { describe, expect, test } from "bun:test"

import {
  extractNonWebTools,
  extractWebTools,
  hasProxyWebTools,
  isAnthropicWebFetchTool,
  isAnthropicWebSearchTool,
} from "~/lib/anthropic-web-tools"
import { validateFetchUrl } from "~/services/web/direct-fetch"
import {
  parseDuckDuckGoHtml,
  unwrapDuckDuckGoUrl,
} from "~/services/web/duckduckgo-html"

describe("anthropic-web-tools detection", () => {
  test("detects web_search server tool by type", () => {
    expect(
      isAnthropicWebSearchTool({
        type: "web_search_20250305",
        name: "web_search",
      }),
    ).toBe(true)
    expect(isAnthropicWebSearchTool({ name: "web_search" })).toBe(true)
    expect(isAnthropicWebSearchTool({ name: "my_tool" })).toBe(false)
  })

  test("detects web_fetch server tool", () => {
    expect(isAnthropicWebFetchTool({ type: "web_fetch_20250910" })).toBe(true)
    expect(isAnthropicWebFetchTool({ name: "web_fetch" })).toBe(true)
    expect(isAnthropicWebFetchTool({ type: "custom" })).toBe(false)
  })

  test("partitions web vs non-web tools", () => {
    const payload = {
      model: "x",
      messages: [],
      max_tokens: 1,
      tools: [
        { type: "web_search_20250305", name: "web_search" },
        { name: "custom", input_schema: {} },
        { type: "web_fetch_20250910" },
      ],
    } as never
    expect(hasProxyWebTools(payload)).toBe(true)
    expect(extractWebTools(payload)).toHaveLength(2)
    expect(extractNonWebTools(payload)).toHaveLength(1)
  })
})

describe("duckduckgo html parser", () => {
  test("unwraps DDG redirect urls", () => {
    const wrapped =
      "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=abc"
    expect(unwrapDuckDuckGoUrl(wrapped)).toBe("https://example.com/page")
    expect(unwrapDuckDuckGoUrl("https://plain.example.com")).toBe(
      "https://plain.example.com/",
    )
  })

  test("parses result blocks", () => {
    const html = `
      <div class="result results_links">
        <h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.test%2F1">First &amp; Best</a></h2>
        <a class="result__snippet">Hello <b>world</b></a>
      </div></div>
      <div class="result results_links">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fb.test%2F2">Second</a>
        <a class="result__snippet">Snippet two</a>
      </div></div>
    `
    const out = parseDuckDuckGoHtml(html)
    expect(out.length).toBeGreaterThanOrEqual(2)
    expect(out[0].url).toBe("https://a.test/1")
    expect(out[0].title).toBe("First & Best")
    expect(out[1].url).toBe("https://b.test/2")
  })
})

describe("direct-fetch url validation", () => {
  test("rejects non-http(s) schemes", () => {
    expect(validateFetchUrl("file:///etc/passwd").ok).toBe(false)
    expect(validateFetchUrl("javascript:alert(1)").ok).toBe(false)
  })

  test("rejects private hosts", () => {
    expect(validateFetchUrl("http://127.0.0.1/").ok).toBe(false)
    expect(validateFetchUrl("http://10.0.0.1/").ok).toBe(false)
    expect(validateFetchUrl("http://192.168.1.1/").ok).toBe(false)
    expect(validateFetchUrl("http://localhost/").ok).toBe(false)
  })

  test("accepts public https url", () => {
    expect(validateFetchUrl("https://example.com/page").ok).toBe(true)
  })
})
