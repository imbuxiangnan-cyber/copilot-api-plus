/** Request-scoped cancellation and an optional model resolved by the caller. */
export interface RequestOptions {
  signal?: AbortSignal
  resolvedModel?: string
}
