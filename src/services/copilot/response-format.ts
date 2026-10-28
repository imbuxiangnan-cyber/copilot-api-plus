/** Output format shapes shared by Chat and Responses request translation. */
export type ChatResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | {
      type: "json_schema"
      json_schema: {
        name: string
        description?: string
        schema: Record<string, unknown>
        strict?: boolean | null
      }
    }

export type ResponsesTextFormat =
  | { type: "text" }
  | { type: "json_object" }
  | ({ type: "json_schema" } & Extract<
      ChatResponseFormat,
      { type: "json_schema" }
    >["json_schema"])

export function translateResponseFormat(
  format: ChatResponseFormat | null | undefined,
): { format: ResponsesTextFormat } | undefined {
  if (!format) return undefined
  if (format.type === "json_schema") {
    return { format: { ...format.json_schema, type: "json_schema" } }
  }
  return { format: { type: format.type } }
}
