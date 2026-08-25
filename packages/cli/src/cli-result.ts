import type { CoreResult } from "@pi-oc2/core";

/** Re-exports the compiler's tagged result type so CLI modules share one result contract. */
export type { CoreResult } from "@pi-oc2/core";

/** Creates a tagged CLI success value, matching the compiler's expected-outcome convention. */
export function cliSuccess<T>(value: T): CoreResult<T, never> {
  return { ok: true, value };
}

/** Creates a tagged CLI failure value, matching the compiler's expected-outcome convention. */
export function cliFailure<E>(error: E): CoreResult<never, E> {
  return { ok: false, error };
}
