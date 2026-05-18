/**
 * Regression: Copilot `/v1/responses` rejects `max_output_tokens < 16`
 * ("Expected a value >= 16, but got 1 instead."). Token-counting pings
 * from Anthropic clients send max_tokens=1, which got forwarded as
 * max_output_tokens=1 and triggered 400s.
 *
 * Both translation paths must clamp:
 *  - chatToResponsesPayload (Anthropic → Chat → Responses translation)
 *  - the passthrough body builder (Cursor-style Responses payload)
 */

import { describe, test, expect } from "bun:test"

import { chatToResponsesPayload } from "~/services/copilot/responses-translator"

describe("chatToResponsesPayload max_output_tokens clamp", () => {
  test("clamps max_tokens=1 up to 16", () => {
    const out = chatToResponsesPayload({
      model: "gpt-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
    } as never)
    expect(out.max_output_tokens).toBe(16)
  })

  test("clamps max_completion_tokens=5 up to 16", () => {
    const out = chatToResponsesPayload({
      model: "gpt-5",
      messages: [{ role: "user", content: "hi" }],
      max_completion_tokens: 5,
    } as never)
    expect(out.max_output_tokens).toBe(16)
  })

  test("passes through values >= 16 unchanged", () => {
    const out = chatToResponsesPayload({
      model: "gpt-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 4096,
    } as never)
    expect(out.max_output_tokens).toBe(4096)
  })

  test("omits field when not provided", () => {
    const out = chatToResponsesPayload({
      model: "gpt-5",
      messages: [{ role: "user", content: "hi" }],
    } as never)
    expect(out.max_output_tokens).toBeUndefined()
  })

  test("omits field for non-positive values", () => {
    const out = chatToResponsesPayload({
      model: "gpt-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 0,
    } as never)
    expect(out.max_output_tokens).toBeUndefined()
  })
})
