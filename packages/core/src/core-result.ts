/** A tagged success value used where a compiler outcome is expected. */
export interface CoreSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

/** A tagged failure value used instead of throwing for expected compiler failures. */
export interface CoreFailure<E> {
  readonly ok: false;
  readonly error: E;
}

/** A tagged compiler result that keeps expected failures in the type system. */
export type CoreResult<T, E> = CoreSuccess<T> | CoreFailure<E>;

/** Creates a tagged compiler success value. */
export function coreSuccess<T>(value: T): CoreSuccess<T> {
  return { ok: true, value };
}

/** Creates a tagged compiler failure value. */
export function coreFailure<E>(error: E): CoreFailure<E> {
  return { ok: false, error };
}
