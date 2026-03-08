import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

export class HTTPError extends Error {
  response: Response

  constructor(message: string, response: Response) {
    super(message)
    this.response = response
  }
}

export async function forwardError(c: Context, error: unknown) {
  if (error instanceof HTTPError) {
    // Try to read error body, but it may already be consumed by the caller
    let errorText: string
    try {
      errorText = await error.response.text()
    } catch {
      // Body already read — fall back to the error message
      errorText = error.message
    }

    // 400 errors: concise log, already detailed upstream
    if (error.response.status === 400) {
      // no extra logging, upstream already printed details
    } else {
      let errorJson: unknown
      try {
        errorJson = JSON.parse(errorText)
      } catch {
        errorJson = errorText
      }
      consola.error("Error occurred:", error)
      consola.error("HTTP error:", errorJson)
    }

    return c.json(
      {
        error: {
          message: errorText,
          type: "error",
        },
      },
      error.response.status as ContentfulStatusCode,
    )
  }

  // Network errors (fetch failed, TLS disconnect, etc.) — concise log
  const message = (error as Error).message || String(error)
  const cause = (error as { cause?: Error }).cause
  if (cause) {
    consola.error(`${message}: ${cause.message}`)
  } else {
    consola.error(message)
  }
  return c.json(
    {
      error: {
        message: (error as Error).message,
        type: "error",
      },
    },
    500,
  )
}
