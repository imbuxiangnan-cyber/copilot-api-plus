import type { Context } from "hono"

import consola from "consola"

import { getTokenCount } from "~/lib/tokenizer"
import { findModel } from "~/lib/utils"

import { type AnthropicMessagesPayload } from "./anthropic-types"
import { translateModelName, translateToOpenAI } from "./non-stream-translation"

/**
 * Handles token counting for Anthropic messages.
 *
 * Uses multi-strategy model matching:
 * 1. findModel(translatedName) — translated Copilot name with format variants
 * 2. findModel(originalName) — original Anthropic name with format variants
 */
export async function handleCountTokens(c: Context) {
  try {
    const anthropicBeta = c.req.header("anthropic-beta")

    const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()

    const openAIPayload = translateToOpenAI(anthropicPayload)

    // Multi-strategy model matching:
    // Try translated name first (most likely to match Copilot model IDs),
    // then fall back to original Anthropic name with format variants
    const translatedModelName = translateModelName(anthropicPayload.model)
    const selectedModel =
      findModel(translatedModelName) ?? findModel(anthropicPayload.model)

    if (!selectedModel) {
      consola.warn(
        `Model not found for "${anthropicPayload.model}" (translated: "${translatedModelName}"), returning default token count`,
      )
      return c.json({
        input_tokens: 1,
      })
    }

    const tokenCount = await getTokenCount(openAIPayload, selectedModel)

    if (anthropicPayload.tools && anthropicPayload.tools.length > 0) {
      let mcpToolExist = false
      if (anthropicBeta?.startsWith("claude-code")) {
        mcpToolExist = anthropicPayload.tools.some((tool) =>
          tool.name.startsWith("mcp__"),
        )
      }
      if (!mcpToolExist) {
        if (anthropicPayload.model.startsWith("claude")) {
          // https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview#pricing
          tokenCount.input = tokenCount.input + 346
        } else if (anthropicPayload.model.startsWith("grok")) {
          tokenCount.input = tokenCount.input + 480
        }
      }
    }

    let finalTokenCount = tokenCount.input + tokenCount.output
    if (anthropicPayload.model.startsWith("claude")) {
      finalTokenCount = Math.round(finalTokenCount * 1.15)
    } else if (anthropicPayload.model.startsWith("grok")) {
      finalTokenCount = Math.round(finalTokenCount * 1.03)
    }

    consola.info("Token count:", finalTokenCount)

    return c.json({
      input_tokens: finalTokenCount,
    })
  } catch (error) {
    consola.error("Error counting tokens:", error)
    return c.json({
      input_tokens: 1,
    })
  }
}
