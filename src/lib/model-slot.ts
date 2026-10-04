import { modelRouter } from "~/lib/model-router"

/** Keep one model slot until the JSON result or stream has finished. */
// eslint-disable-next-line max-params -- Keep existing callers compatible while adding optional cancellation.
export async function runWithModelSlot<TResult>(
  resolvedModel: string,
  request: () => Promise<TResult>,
  getStream: (result: TResult) => AsyncGenerator | undefined,
  signal?: AbortSignal,
): Promise<TResult> {
  const releaseSlot = await modelRouter.acquireSlot(resolvedModel, signal)
  let released = false
  const release = () => {
    if (released) return
    released = true
    releaseSlot()
  }

  try {
    signal?.throwIfAborted()
    const result = await request()
    const stream = getStream(result)
    if (stream) releaseWhenStreamEnds(stream, release, signal)
    else release()
    signal?.throwIfAborted()
    return result
  } catch (error) {
    release()
    throw error
  }
}

/** Attach an idempotent release to a generator without replacing its identity. */
export function releaseWhenStreamEnds<T, TReturn, TNext>(
  stream: AsyncGenerator<T, TReturn, TNext>,
  releaseSlot: () => void,
  signal?: AbortSignal,
): void {
  let released = false
  const release = () => {
    if (released) return
    released = true
    signal?.removeEventListener("abort", onAbort)
    releaseSlot()
  }
  const next = stream.next.bind(stream)
  const returnStream = stream.return.bind(stream)
  const throwStream = stream.throw.bind(stream)
  const onAbort = () => {
    release()
    // Close the original iterator so its keepalive/finally cleanup still runs.
    // The request reports signal.reason; closing an already failed stream may
    // reject too, and must not produce a second unhandled rejection.
    void returnStream(undefined as TReturn).catch(() => {})
  }

  const advance = async (
    operation: () => Promise<IteratorResult<T, TReturn>>,
  ) => {
    try {
      const result = await operation()
      if (result.done) release()
      return result
    } catch (error) {
      release()
      throw error
    }
  }
  // Wrap the methods directly so return() before the first next() releases
  // the slot too; an unstarted async generator never enters its finally block.
  // Keeping the same generator also preserves its account metadata.
  stream.next = (...args) =>
    advance(async () => {
      signal?.throwIfAborted()
      const result = await next(...args)
      signal?.throwIfAborted()
      return result
    })
  stream.return = (value) => advance(() => returnStream(value))
  stream.throw = (error: unknown) => advance(() => throwStream(error))
  if (signal?.aborted) onAbort()
  else signal?.addEventListener("abort", onAbort, { once: true })
}
