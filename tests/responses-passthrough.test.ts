/**
 * Tests for the Responses-shape detector on /chat/completions.
 *
 * Network calls (`forwardResponsesAsChat`) are NOT exercised here —
 * those need an upstream Copilot endpoint. The detector is the part
 * that controls dispatch and must be precise.
 */

import { describe, test, expect } from "bun:test"

import { isResponsesShape } from "~/routes/chat-completions/responses-passthrough"

describe("isResponsesShape", () => {
  test("detects Cursor-style Responses payload", () => {
    const cursorBody = {
      stream: true,
      user: "abc",
      model: "gpt-5-mini",
      input: [
        { role: "system", content: "You are an AI coding assistant" },
        { role: "user", content: "hello" },
      ],
      reasoning: { effort: "medium" },
      text: { verbosity: "low" },
    }
    expect(isResponsesShape(cursorBody)).toBe(true)
  })

  test("rejects standard Chat Completions payload", () => {
    const chatBody = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    }
    expect(isResponsesShape(chatBody)).toBe(false)
  })

  test("rejects bodies with both messages and input (defers to chat path)", () => {
    const ambiguous = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      input: [{ role: "user", content: "hi" }],
    }
    expect(isResponsesShape(ambiguous)).toBe(false)
  })

  test("rejects payload without a string model", () => {
    expect(isResponsesShape({ input: [{ role: "user", content: "x" }] })).toBe(
      false,
    )
  })

  test("rejects payload where input is not an array", () => {
    expect(isResponsesShape({ model: "gpt-5", input: "hello" })).toBe(false)
    expect(isResponsesShape({ model: "gpt-5", input: { foo: 1 } })).toBe(false)
  })

  test("rejects non-object inputs", () => {
    expect(isResponsesShape(null)).toBe(false)
    expect(isResponsesShape(undefined)).toBe(false)
    expect(isResponsesShape("string")).toBe(false)
    expect(isResponsesShape(42)).toBe(false)
    expect(isResponsesShape([])).toBe(false)
  })
})
