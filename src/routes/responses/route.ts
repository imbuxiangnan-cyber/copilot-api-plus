/**
 * Native OpenAI Responses API endpoint (`/responses` and `/v1/responses`).
 *
 * Clients that natively speak the Responses API can POST here and get
 * the raw upstream Responses-shape result back (or raw SSE for streaming).
 * Unlike the Chat Completions passthrough at `/chat/completions`, this
 * endpoint does NOT translate the response into Chat Completions format —
 * the body the client sent and the body the client receives are both
 * Responses-shape.
 *
 * Multi-account rotation, model routing, vision/initiator headers, and
 * max_output_tokens clamping behavior mirror the passthrough.
 */

import { Hono } from "hono"
import { streamSSE, type SSEMessage } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { forwardError } from "~/lib/error"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  createNativeResponses,
  type LooseResponsesPayload,
} from "~/services/copilot/create-native-responses"

export const responsesRoutes = new Hono()

responsesRoutes.post("/", async (c) => {
  const controller = new AbortController()
  const signal = AbortSignal.any([c.req.raw.signal, controller.signal])
  try {
    signal.throwIfAborted()
    await checkRateLimit(state)

    const body = await c.req.json<LooseResponsesPayload>()
    signal.throwIfAborted()
    if (state.manualApprove) await awaitApproval()

    const result = await createNativeResponses(body, { signal })

    if (result.__isStream) {
      const sse = result.stream
      return streamSSE(c, async (stream) => {
        stream.onAbort(() => controller.abort(new Error("Client disconnected")))
        try {
          for await (const chunk of sse) {
            await stream.writeSSE(chunk as SSEMessage)
          }
        } catch (error) {
          if (!signal.aborted) throw error
        }
      })
    }

    return c.json(result.json)
  } catch (error) {
    return await forwardError(c, error)
  }
})
