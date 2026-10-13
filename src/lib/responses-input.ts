function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasImageBlock(content: unknown): boolean {
  return (
    Array.isArray(content)
    && content.some((part) => isRecord(part) && part.type === "input_image")
  )
}

/** Inspect actual message/tool-output content blocks, never serialized strings. */
export function responsesHasVisionInput(input: unknown): boolean {
  if (!Array.isArray(input)) return false
  return input.some((item) => {
    if (!isRecord(item)) return false
    if (item.type === "message" || item.type === undefined) {
      return hasImageBlock(item.content)
    }
    if (
      item.type === "function_call_output"
      || item.type === "custom_tool_call_output"
    ) {
      return hasImageBlock(item.output)
    }
    return false
  })
}
