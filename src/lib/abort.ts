/** Wait without keeping a cancelled request in a retry delay. */
export function abortableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- AbortSignal permits arbitrary reasons, which must be preserved.
  if (signal?.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Preserve the caller's cancellation reason.
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}
