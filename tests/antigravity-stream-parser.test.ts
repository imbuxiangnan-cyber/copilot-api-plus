/**
 * Antigravity Stream Parser Tests
 *
 * Tests for the Antigravity stream parsing logic
 */

import { describe, expect, test } from "bun:test"

import {
  createStreamState,
  extractFromData,
  handleFinish,
  parseSSELine,
  processChunk,
  processPart,
  type AntigravityData,
  type StreamEvent,
} from "../src/services/antigravity/stream-parser"

describe("Antigravity Stream Parser", () => {
  describe("createStreamState", () => {
    test("should create initial state with default values", () => {
      const state = createStreamState()

      expect(state.buffer).toBe("")
      expect(state.inputTokens).toBe(0)
      expect(state.outputTokens).toBe(0)
      expect(state.contentBlockIndex).toBe(0)
      expect(state.thinkingBlockStarted).toBe(false)
      expect(state.textBlockStarted).toBe(false)
    })
  })

  describe("parseSSELine", () => {
    test("should parse valid SSE data line", () => {
      const line =
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}}'
      const result = parseSSELine(line)

      expect(result).not.toBeNull()
      expect(result?.response?.candidates?.[0]?.content?.parts?.[0]?.text).toBe(
        "Hello",
      )
    })

    test("should return null for non-data lines", () => {
      expect(parseSSELine("event: message")).toBeNull()
      expect(parseSSELine("")).toBeNull()
      expect(parseSSELine("random text")).toBeNull()
    })

    test("should return null for [DONE] marker", () => {
      expect(parseSSELine("data: [DONE]")).toBeNull()
    })

    test("should return null for empty data", () => {
      expect(parseSSELine("data: ")).toBeNull()
    })

    test("should return null for invalid JSON", () => {
      expect(parseSSELine("data: {invalid json}")).toBeNull()
    })
  })

  describe("extractFromData", () => {
    test("should extract candidates from response wrapper", () => {
      const data: AntigravityData = {
        response: {
          candidates: [{ content: { parts: [{ text: "Hello" }] } }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        },
      }

      const result = extractFromData(data)

      expect(result.candidates).toHaveLength(1)
      expect(result.candidates[0].content?.parts?.[0]?.text).toBe("Hello")
      expect(result.usage?.promptTokenCount).toBe(10)
    })

    test("should extract candidates from direct format", () => {
      const data: AntigravityData = {
        candidates: [{ content: { parts: [{ text: "World" }] } }],
        usageMetadata: { promptTokenCount: 20 },
      }

      const result = extractFromData(data)

      expect(result.candidates).toHaveLength(1)
      expect(result.candidates[0].content?.parts?.[0]?.text).toBe("World")
    })

    test("should return empty array when no candidates", () => {
      const data: AntigravityData = {}
      const result = extractFromData(data)

      expect(result.candidates).toEqual([])
      expect(result.usage).toBeUndefined()
    })
  })

  describe("processChunk", () => {
    test("should split chunk into lines and keep incomplete line in buffer", () => {
      const state = createStreamState()

      const lines = processChunk("line1\nline2\nincomplete", state)

      expect(lines).toEqual(["line1", "line2"])
      expect(state.buffer).toBe("incomplete")
    })

    test("should accumulate buffer across multiple chunks", () => {
      const state = createStreamState()

      processChunk("start", state)
      expect(state.buffer).toBe("start")

      const lines = processChunk("_end\nnew", state)
      expect(lines).toEqual(["start_end"])
      expect(state.buffer).toBe("new")
    })
  })

  describe("processPart", () => {
    test("should emit text events for regular text", () => {
      const state = createStreamState()
      const events: Array<StreamEvent> = []
      const emit = (e: StreamEvent) => events.push(e)

      processPart({ text: "Hello" }, state, emit)

      expect(events).toHaveLength(2)
      expect(events[0]).toEqual({ type: "text_start", index: 0 })
      expect(events[1]).toEqual({ type: "text_delta", index: 0, text: "Hello" })
      expect(state.textBlockStarted).toBe(true)
    })

    test("should emit thinking events for thought content", () => {
      const state = createStreamState()
      const events: Array<StreamEvent> = []
      const emit = (e: StreamEvent) => events.push(e)

      processPart({ text: "Thinking...", thought: true }, state, emit)

      expect(events).toHaveLength(2)
      expect(events[0]).toEqual({ type: "thinking_start", index: 0 })
      expect(events[1]).toEqual({
        type: "thinking_delta",
        index: 0,
        text: "Thinking...",
      })
      expect(state.thinkingBlockStarted).toBe(true)
    })

    test("should emit tool_use event for function calls", () => {
      const state = createStreamState()
      const events: Array<StreamEvent> = []
      const emit = (e: StreamEvent) => events.push(e)

      processPart(
        { functionCall: { name: "get_weather", args: { city: "Tokyo" } } },
        state,
        emit,
      )

      expect(events).toHaveLength(1)
      expect(events[0].type).toBe("tool_use")
      if (events[0].type === "tool_use") {
        expect(events[0].name).toBe("get_weather")
        expect(events[0].args).toEqual({ city: "Tokyo" })
      }
    })

    test("should close thinking block before starting text block", () => {
      const state = createStreamState()
      state.thinkingBlockStarted = true
      const events: Array<StreamEvent> = []
      const emit = (e: StreamEvent) => events.push(e)

      processPart({ text: "Result" }, state, emit)

      expect(events[0]).toEqual({ type: "thinking_stop", index: 0 })
      expect(events[1]).toEqual({ type: "text_start", index: 1 })
      expect(state.contentBlockIndex).toBe(1)
    })
  })

  describe("handleFinish", () => {
    test("should close text block and emit finish events", () => {
      const state = createStreamState()
      state.textBlockStarted = true
      state.inputTokens = 100
      state.outputTokens = 50
      const events: Array<StreamEvent> = []
      const emit = (e: StreamEvent) => events.push(e)

      handleFinish(state, emit)

      expect(events).toHaveLength(3)
      expect(events[0]).toEqual({ type: "text_stop", index: 0 })
      expect(events[1]).toEqual({
        type: "usage",
        inputTokens: 100,
        outputTokens: 50,
      })
      expect(events[2]).toEqual({ type: "finish", stopReason: "end_turn" })
    })

    test("should close thinking block if open", () => {
      const state = createStreamState()
      state.thinkingBlockStarted = true
      const events: Array<StreamEvent> = []
      const emit = (e: StreamEvent) => events.push(e)

      handleFinish(state, emit)

      expect(events[0]).toEqual({ type: "thinking_stop", index: 0 })
    })
  })
})
