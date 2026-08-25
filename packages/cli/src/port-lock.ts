import { serializeStableJson } from "@pi-oc2/core/serialization";
import { cliFailure, cliSuccess, type CoreResult } from "./cli-result.js";

/**
 * `pioc.lock.json`'s on-disk shape. A structural superset of `@pi-oc2/core`'s `PiocLock`
 * (`schemaVersion`, `generatorVersion`, `sourceHash`, `targetProfile`): `@pi-oc2/core` has no
 * `port-lock.ts` module yet (see `docs/adr/0001-compile-native-targets.md`'s call stack, which
 * marks it `[NEW]`), and this package may only write within `packages/cli`, so lock reading and
 * writing lives here instead. `sourcePath` and `manifestPath` are always paths relative to the
 * directory the lock itself is written into (`--out`) — never absolute — so the lock stays
 * reproducible across machines and checkouts, matching `docs/design.md`'s determinism rule that
 * absolute paths never enter generated output. `--out`, `<source>`, and `dirname(manifestPath)`
 * (the port root — where `pioc.port.json` and `portable/` live) may all be different directories;
 * `manifestPath` may therefore be a path that climbs back out of `--out` (e.g. `../port/pioc.port.json`),
 * which `path.relative`/`path.resolve` handle the same as any other relative path.
 */
export interface PortLockFile {
  readonly schemaVersion: 1;
  readonly generatorVersion: string;
  readonly sourceHash: string;
  readonly targetProfile: string;
  readonly sourcePath: string;
  readonly manifestPath: string;
}

export interface PortLockFailure {
  readonly code: "PORT_LOCK_INVALID_JSON" | "PORT_LOCK_INVALID";
  readonly message: string;
}

/** Serializes a port lock through the same stable JSON contract as every other compiler artifact. */
export function serializePortLockFile(lock: PortLockFile): string {
  return serializeStableJson(lock);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses and structurally validates `pioc.lock.json` without throwing on malformed input. */
export function parsePortLockFile(sourceText: string): CoreResult<PortLockFile, PortLockFailure> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceText);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return cliFailure({ code: "PORT_LOCK_INVALID_JSON", message: `pioc.lock.json is invalid JSON: ${cause}` });
  }

  if (!isUnknownRecord(parsed)) {
    return cliFailure({ code: "PORT_LOCK_INVALID", message: "pioc.lock.json must contain a JSON object." });
  }
  if (parsed.schemaVersion !== 1) {
    return cliFailure({ code: "PORT_LOCK_INVALID", message: "pioc.lock.json schemaVersion must be 1." });
  }

  const { generatorVersion, sourceHash, targetProfile, sourcePath, manifestPath } = parsed;
  const fields = { generatorVersion, sourceHash, targetProfile, sourcePath, manifestPath };
  for (const [field, value] of Object.entries(fields)) {
    if (!isNonEmptyString(value)) {
      return cliFailure({ code: "PORT_LOCK_INVALID", message: `pioc.lock.json field "${field}" must be a non-empty string.` });
    }
  }
  if (
    !isNonEmptyString(generatorVersion) ||
    !isNonEmptyString(sourceHash) ||
    !isNonEmptyString(targetProfile) ||
    !isNonEmptyString(sourcePath) ||
    !isNonEmptyString(manifestPath)
  ) {
    return cliFailure({ code: "PORT_LOCK_INVALID", message: "pioc.lock.json contains an invalid string field." });
  }

  return cliSuccess({
    schemaVersion: 1,
    generatorVersion,
    sourceHash,
    targetProfile,
    sourcePath,
    manifestPath,
  });
}
