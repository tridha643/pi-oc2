import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { analyzePiPackage } from "@pi-oc2/core";
import { resolvePortCapabilities, type ResolvedPortCapabilities } from "@pi-oc2/core/capabilities";
import { parsePortabilityManifest } from "@pi-oc2/core/manifest";
import { serializeCompatibilityMarkdown } from "@pi-oc2/core/serialization";
import { EXIT_DOMAIN_FAILURE, EXIT_ENVIRONMENT_FAILURE, PiocCliError, fromCoreFailure } from "./cli-error.js";
import { ensureDirectory, toPortableRelativePath, writeTextFile } from "./fs-utils.js";
import { readGeneratorVersion } from "./generator-version.js";
import { serializePortLockFile, type PortLockFile } from "./port-lock.js";
import { stagePortResources } from "./stage-port-resources.js";
import { loadOpenCode2TargetGenerator, loadPiTargetGenerator } from "./target-generators.js";
import { COMBINED_TARGET_PROFILE, OPENCODE2_TARGET_PROFILE } from "./target-profile.js";

export interface PortCommandInput {
  readonly sourcePath: string;
  readonly manifestPath: string;
  readonly outDir: string;
  /** Test seam: overrides the default dynamic-import loaders for the two native target generators. */
  readonly loadPiTargetGenerator?: typeof loadPiTargetGenerator;
  readonly loadOpenCode2TargetGenerator?: typeof loadOpenCode2TargetGenerator;
}

export interface PortCommandResult {
  readonly packageName: string;
  readonly sourceHash: string;
  readonly resolvedCapabilities: ResolvedPortCapabilities;
  readonly piWrittenPaths: readonly string[];
  readonly opencode2WrittenPaths: readonly string[];
  readonly compatMarkdownPath: string;
  readonly lockPath: string;
}

/**
 * Runs `pioc port`: validates that `--manifest` still matches `<source>`'s current bytes, resolves
 * every required capability against explicit manual or waived resolutions, then generates both
 * native targets — via `@pi-oc2/target-pi`'s `generatePiTarget` and
 * `@pi-oc2/target-opencode2`'s `generateOpenCode2Target`, each writing its own
 * `<out>/generated/<target>` directory — and writes `COMPAT.md` and `pioc.lock.json` into `--out`.
 *
 * `<source>`, the port root (`dirname(--manifest)`, where `pioc.port.json` and `portable/` live),
 * and `--out` may be three distinct directories — both generators copy each resolved portable
 * module into their own generated output rather than importing it from outside `--out`.
 *
 * `@pi-oc2/target-pi` and `@pi-oc2/target-opencode2` are separate workspace packages this CLI
 * does not own; see `target-generators.ts` for how a broken or missing install becomes a clean
 * `TARGET_GENERATOR_UNAVAILABLE` failure instead of a crash.
 */
export async function runPortCommand(input: PortCommandInput): Promise<PortCommandResult> {
  const sourcePath = resolve(input.sourcePath);
  const manifestPath = resolve(input.manifestPath);
  const outDir = resolve(input.outDir);

  let manifestText: string;
  try {
    manifestText = await readFile(manifestPath, "utf8");
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new PiocCliError("PORT_MANIFEST_NOT_FOUND", `Cannot read --manifest file: ${manifestPath}: ${cause}`, EXIT_DOMAIN_FAILURE);
  }

  const manifest = parsePortabilityManifest(manifestText);
  if (!manifest.ok) {
    throw fromCoreFailure(manifest.error);
  }

  const analysis = await analyzePiPackage(sourcePath);
  if (!analysis.ok) {
    throw fromCoreFailure(analysis.error);
  }

  if (manifest.value.source.sourceHash !== analysis.value.sourceHash) {
    throw new PiocCliError(
      "PORT_SOURCE_HASH_MISMATCH",
      `pioc.port.json was pinned to a different source: manifest has ${manifest.value.source.sourceHash}, ` +
        `<source> now hashes to ${analysis.value.sourceHash}. Re-run "pioc analyze" and update the manifest's ` +
        `source.sourceHash after reviewing what changed.`,
      EXIT_DOMAIN_FAILURE,
    );
  }
  if (manifest.value.source.packageName !== analysis.value.packageName) {
    throw new PiocCliError(
      "PORT_SOURCE_PACKAGE_NAME_MISMATCH",
      `pioc.port.json names package "${manifest.value.source.packageName}", but <source> is "${analysis.value.packageName}".`,
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

  await ensureDirectory(outDir);
  // @pi-oc2/target-pi and @pi-oc2/target-opencode2 both copy each resolved portable module
  // byte-for-byte into generated/<target>/portable/... and emit a local import to that copy, so
  // outputRoot no longer needs to equal portRoot — <source>, the port root (dirname(--manifest):
  // where pioc.port.json and portable/ live), and --out are free to be three distinct directories.
  // portable/ overrides and any resourceMappings-declared source paths still resolve against the
  // port root, not against --out.
  const portRoot = dirname(manifestPath);
  await stagePortResources(sourcePath, portRoot, analysis.value);
  const sharedGenerationInput = {
    analysis: analysis.value,
    manifest: manifest.value,
    resolvedCapabilities: resolvedCapabilities.value,
    portRoot,
    outputRoot: outDir,
  };

  const loadPi = input.loadPiTargetGenerator ?? loadPiTargetGenerator;
  const loadedPiGenerator = await loadPi();
  if (!loadedPiGenerator.ok) {
    throw new PiocCliError(loadedPiGenerator.error.code, loadedPiGenerator.error.message, EXIT_ENVIRONMENT_FAILURE);
  }
  const piResult = await loadedPiGenerator.value(sharedGenerationInput);
  if (!piResult.ok) {
    throw new PiocCliError(piResult.error.code, `Generating the pi target failed: ${piResult.error.message}`, EXIT_DOMAIN_FAILURE);
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
      `Generating the opencode2 target failed: ${opencode2Result.error.message}`,
      EXIT_DOMAIN_FAILURE,
    );
  }
  // Defensive: @pi-oc2/target-opencode2 is a sibling package pioc does not own. Its returned
  // targetProfile is typechecked against that package's own literal type, so a real drift between
  // the two profile strings is a compile-time error there, not just a runtime one here — this
  // string-widened comparison still fails closed at runtime for whichever side is stale.
  const reportedOpenCode2TargetProfile: string = opencode2Result.value.targetProfile;
  if (reportedOpenCode2TargetProfile !== OPENCODE2_TARGET_PROFILE) {
    throw new PiocCliError(
      "TARGET_GENERATOR_PROFILE_MISMATCH",
      `@pi-oc2/target-opencode2 reported target profile "${reportedOpenCode2TargetProfile}", but pioc is built ` +
        `against "${OPENCODE2_TARGET_PROFILE}". Update target-profile.ts to match the installed generator.`,
      EXIT_ENVIRONMENT_FAILURE,
    );
  }

  const compatMarkdownPath = join(outDir, "COMPAT.md");
  await writeTextFile(compatMarkdownPath, serializeCompatibilityMarkdown(analysis.value));

  const lock: PortLockFile = {
    schemaVersion: 1,
    generatorVersion: readGeneratorVersion(),
    sourceHash: analysis.value.sourceHash,
    targetProfile: COMBINED_TARGET_PROFILE,
    sourcePath: toPortableRelativePath(outDir, sourcePath),
    manifestPath: toPortableRelativePath(outDir, manifestPath),
  };
  const lockPath = join(outDir, "pioc.lock.json");
  await writeTextFile(lockPath, serializePortLockFile(lock));

  return {
    packageName: analysis.value.packageName,
    sourceHash: analysis.value.sourceHash,
    resolvedCapabilities: resolvedCapabilities.value,
    piWrittenPaths: piResult.value.files,
    opencode2WrittenPaths: opencode2Result.value.files,
    compatMarkdownPath,
    lockPath,
  };
}
