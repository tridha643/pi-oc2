import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { analyzePiPackage } from "@pi-oc2/core";
import { resolvePortCapabilities } from "@pi-oc2/core/capabilities";
import { parsePortabilityManifest } from "@pi-oc2/core/manifest";
import { EXIT_DOMAIN_FAILURE, EXIT_ENVIRONMENT_FAILURE, PiocCliError, fromCoreFailure } from "./cli-error.js";
import { compareDirectoriesByteExact } from "./fs-utils.js";
import { runOpenCode2ConfigDiscoverySmoke, type OpenCode2SmokeResult } from "./opencode2-smoke.js";
import { parsePortLockFile } from "./port-lock.js";
import { stagePortResources } from "./stage-port-resources.js";
import { loadOpenCode2TargetGenerator, loadPiTargetGenerator } from "./target-generators.js";
import { COMBINED_TARGET_PROFILE } from "./target-profile.js";
import { prepareGeneratedPackageTypecheck, typecheckGeneratedPackage } from "./typecheck-target.js";

export interface VerifyCommandInput {
  readonly portDir: string;
  readonly loadPiTargetGenerator?: typeof loadPiTargetGenerator;
  readonly loadOpenCode2TargetGenerator?: typeof loadOpenCode2TargetGenerator;
  /** Test seam: skips the optional opencode2 discovery smoke regardless of PATH contents. */
  readonly skipOpenCode2Smoke?: boolean;
}

export interface VerifyCommandResult {
  readonly packageName: string;
  readonly sourceHash: string;
  readonly piTypecheck: "passed";
  readonly opencode2Typecheck: "passed";
  readonly opencode2Smoke: OpenCode2SmokeResult;
}

const MAX_REPORTED_DETAILS = 20;

function generatedTargetDirectory(portDir: string, target: "pi" | "opencode2"): string {
  return join(portDir, "generated", target);
}

/**
 * Runs `pioc verify`: rejects a port whose recorded lock, source, or resolved capabilities have
 * drifted, regenerates both targets into a temporary directory and byte-compares them against what
 * is checked into `<port>/generated`, typechecks that regenerated copy against the same peer
 * dependencies the real hosts use, and — only when the `opencode2` binary is on `PATH` — runs a
 * no-model config-discovery smoke check against the regenerated `opencode2` package. Every step
 * fails closed: an unreachable target generator is reported the same way as detected drift, never
 * silently skipped.
 *
 * `<port>` (this function's `portDir` argument) is only ever the `--out` directory `pioc port`
 * wrote `generated/`, `COMPAT.md`, and `pioc.lock.json` into. The port root — the directory holding
 * `pioc.port.json` and `portable/` — is read back from `pioc.lock.json`'s `manifestPath` and may be
 * a third, distinct directory from both `portDir` and `<source>`; regeneration always resolves
 * `portRoot` from there, never assumes it equals `portDir`.
 */
export async function runVerifyCommand(input: VerifyCommandInput): Promise<VerifyCommandResult> {
  const portDir = resolve(input.portDir);

  const lockPath = join(portDir, "pioc.lock.json");
  let lockText: string;
  try {
    lockText = await readFile(lockPath, "utf8");
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new PiocCliError("PORT_LOCK_NOT_FOUND", `Cannot read pioc.lock.json in <port>: ${lockPath}: ${cause}`, EXIT_DOMAIN_FAILURE);
  }
  const lock = parsePortLockFile(lockText);
  if (!lock.ok) {
    throw fromCoreFailure(lock.error);
  }

  if (lock.value.targetProfile !== COMBINED_TARGET_PROFILE) {
    throw new PiocCliError(
      "PORT_LOCK_TARGET_PROFILE_DRIFT",
      `pioc.lock.json was generated against target profile "${lock.value.targetProfile}", but this pioc build ` +
        `targets "${COMBINED_TARGET_PROFILE}". Re-run "pioc port" with the current pioc build before verifying.`,
      EXIT_DOMAIN_FAILURE,
    );
  }

  const sourcePath = resolve(portDir, lock.value.sourcePath);
  const manifestPath = resolve(portDir, lock.value.manifestPath);

  let manifestText: string;
  try {
    manifestText = await readFile(manifestPath, "utf8");
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new PiocCliError(
      "PORT_MANIFEST_NOT_FOUND",
      `pioc.lock.json points at a manifest that no longer exists: ${manifestPath}: ${cause}`,
      EXIT_DOMAIN_FAILURE,
    );
  }
  const manifest = parsePortabilityManifest(manifestText);
  if (!manifest.ok) {
    throw fromCoreFailure(manifest.error);
  }

  const analysis = await analyzePiPackage(sourcePath);
  if (!analysis.ok) {
    throw fromCoreFailure(analysis.error);
  }

  if (analysis.value.sourceHash !== lock.value.sourceHash) {
    throw new PiocCliError(
      "PORT_LOCK_SOURCE_DRIFT",
      `<source> has changed since "pioc port" ran: pioc.lock.json recorded ${lock.value.sourceHash}, ` +
        `the source now hashes to ${analysis.value.sourceHash}. Re-run "pioc port" and review the new COMPAT.md.`,
      EXIT_DOMAIN_FAILURE,
    );
  }
  if (manifest.value.source.sourceHash !== lock.value.sourceHash) {
    throw new PiocCliError(
      "PORT_MANIFEST_SOURCE_DRIFT",
      `pioc.port.json's source.sourceHash (${manifest.value.source.sourceHash}) no longer matches ` +
        `pioc.lock.json (${lock.value.sourceHash}). Re-run "pioc port" after resolving the manifest edit.`,
      EXIT_DOMAIN_FAILURE,
    );
  }

  const resolvedCapabilities = resolvePortCapabilities(analysis.value.findings, manifest.value);
  if (!resolvedCapabilities.ok) {
    const details = resolvedCapabilities.error.unresolved.map(
      (entry) => `${entry.capabilityId} (${entry.reason}${entry.classification === undefined ? "" : `, ${entry.classification}`})`,
    );
    throw new PiocCliError(resolvedCapabilities.error.code, resolvedCapabilities.error.message, EXIT_DOMAIN_FAILURE, details);
  }

  // The real port root — where pioc.port.json and portable/ live — not portDir, which only holds
  // generated output. Source is confirmed unchanged (the sourceHash checks above passed), so it's
  // safe to re-sync any resource pioc port staged there straight from source before regenerating —
  // this is what catches someone hand-editing a staged copy (e.g. portRoot/skills/...) without
  // touching the tracked source.
  const portRoot = dirname(manifestPath);
  await stagePortResources(sourcePath, portRoot, analysis.value);

  const temporaryRoot = await mkdtemp(join(tmpdir(), "pioc-verify-"));
  try {
    // @pi-oc2/target-pi and @pi-oc2/target-opencode2 both copy each resolved portable module into
    // their own generated output and import the copy locally, so regenerating into a bare
    // temporaryRoot needs no symlink or synthesized package.json for portable/ to resolve — the
    // generators read portable/ from portRoot (for validation and copying) and write everything
    // the regenerated target needs entirely inside temporaryRoot/generated/<target>.
    const sharedGenerationInput = {
      analysis: analysis.value,
      manifest: manifest.value,
      resolvedCapabilities: resolvedCapabilities.value,
      portRoot,
      outputRoot: temporaryRoot,
    };

    const loadPi = input.loadPiTargetGenerator ?? loadPiTargetGenerator;
    const loadedPiGenerator = await loadPi();
    if (!loadedPiGenerator.ok) {
      throw new PiocCliError(loadedPiGenerator.error.code, loadedPiGenerator.error.message, EXIT_ENVIRONMENT_FAILURE);
    }
    const piResult = await loadedPiGenerator.value(sharedGenerationInput);
    if (!piResult.ok) {
      throw new PiocCliError(
        piResult.error.code,
        `Regenerating the pi target for verification failed: ${piResult.error.message}`,
        EXIT_DOMAIN_FAILURE,
      );
    }

    const loadOpenCode2 = input.loadOpenCode2TargetGenerator ?? loadOpenCode2TargetGenerator;
    const loadedOpenCode2Generator = await loadOpenCode2();
    if (!loadedOpenCode2Generator.ok) {
      throw new PiocCliError(loadedOpenCode2Generator.error.code, loadedOpenCode2Generator.error.message, EXIT_ENVIRONMENT_FAILURE);
    }
    const opencode2Result = await loadedOpenCode2Generator.value(sharedGenerationInput);
    if (!opencode2Result.ok) {
      throw new PiocCliError(
        opencode2Result.error.code,
        `Regenerating the opencode2 target for verification failed: ${opencode2Result.error.message}`,
        EXIT_DOMAIN_FAILURE,
      );
    }

    const piDrift = await compareDirectoriesByteExact(generatedTargetDirectory(portDir, "pi"), piResult.value.targetRoot);
    const opencode2Drift = await compareDirectoriesByteExact(generatedTargetDirectory(portDir, "opencode2"), opencode2Result.value.targetRoot);
    const allDrift = [
      ...piDrift.map((entry) => `generated/pi/${entry.path} (${entry.reason})`),
      ...opencode2Drift.map((entry) => `generated/opencode2/${entry.path} (${entry.reason})`),
    ];
    if (allDrift.length > 0) {
      throw new PiocCliError(
        "PORT_TARGET_BYTES_DRIFT",
        `Regenerating <port> produced different bytes than what is checked in, across ${allDrift.length} path(s). ` +
          `Generated output must be disposable and reproducible; re-run "pioc port" and commit its output verbatim.`,
        EXIT_DOMAIN_FAILURE,
        allDrift.slice(0, MAX_REPORTED_DETAILS),
      );
    }

    for (const [label, directory] of [
      ["pi", piResult.value.targetRoot],
      ["opencode2", opencode2Result.value.targetRoot],
    ] as const) {
      await prepareGeneratedPackageTypecheck(directory);
      const typecheck = await typecheckGeneratedPackage(directory);
      if (typecheck.status === "failed") {
        throw new PiocCliError(
          "VERIFY_TYPECHECK_FAILED",
          `Regenerated ${label} target does not typecheck against its real peer dependencies.`,
          EXIT_DOMAIN_FAILURE,
          typecheck.diagnostics.split("\n").slice(0, MAX_REPORTED_DETAILS),
        );
      }
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  const opencode2Smoke: OpenCode2SmokeResult =
    input.skipOpenCode2Smoke === true
      ? { status: "skipped", reason: "Skipped by caller." }
      : await runOpenCode2ConfigDiscoverySmoke(generatedTargetDirectory(portDir, "opencode2"));
  if (opencode2Smoke.status === "failed") {
    throw new PiocCliError("VERIFY_OPENCODE2_SMOKE_FAILED", opencode2Smoke.reason, EXIT_DOMAIN_FAILURE);
  }

  return {
    packageName: analysis.value.packageName,
    sourceHash: analysis.value.sourceHash,
    piTypecheck: "passed",
    opencode2Typecheck: "passed",
    opencode2Smoke,
  };
}
