/**
 * Stable exit codes returned by `pioc`. Every command failure maps to exactly one of these so
 * scripts driving the CLI can branch on exit status instead of parsing message text.
 */
export const EXIT_SUCCESS = 0;
/** An expected validation, drift, or unresolved-capability failure surfaced by a command. */
export const EXIT_DOMAIN_FAILURE = 1;
/** A bug: a command threw something other than a `PiocCliError`. Never expected in normal use. */
export const EXIT_INTERNAL_ERROR = 2;
/** A required external package or binary (a target generator, `tsc`, `opencode2`) was unavailable. */
export const EXIT_ENVIRONMENT_FAILURE = 3;
/** The CLI was invoked with an argument citty itself could not parse or route. */
export const EXIT_USAGE_ERROR = 64;

/**
 * A stable, user-facing CLI failure. `run functions` throw this instead of a bare `Error` so the
 * top-level dispatcher can print one line of diagnostic text and exit with a documented code
 * instead of letting a stack trace reach the terminal.
 */
export class PiocCliError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly details: readonly string[];

  constructor(code: string, message: string, exitCode: number, details: readonly string[] = []) {
    super(message);
    this.name = "PiocCliError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

/** Wraps a `{ code, message }`-shaped core failure into a stable domain-failure CLI error. */
export function fromCoreFailure(error: { readonly code: string; readonly message: string }): PiocCliError {
  return new PiocCliError(error.code, error.message, EXIT_DOMAIN_FAILURE);
}
