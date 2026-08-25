import { basename, join, resolve } from "node:path";
import { analyzePiPackage } from "@pi-oc2/core";
import type { PortabilityManifest } from "@pi-oc2/core/manifest";
import { serializeStableJson } from "@pi-oc2/core/serialization";
import { EXIT_DOMAIN_FAILURE, PiocCliError, fromCoreFailure } from "./cli-error.js";
import { pathExists, writeTextFile } from "./fs-utils.js";
import { INIT_EXTENSION_SOURCE, INIT_PORTABLE_EXECUTOR_SOURCE, INIT_SKILL_SOURCE, initPackageJson } from "./init-templates.js";

export interface InitCommandInput {
  readonly directory: string;
}

export interface InitCommandResult {
  readonly packageName: string;
  readonly directory: string;
  readonly createdPaths: readonly string[];
}

interface ScaffoldFile {
  readonly relativePath: string;
  readonly content: string;
}

/**
 * Runs `pioc init`: scaffolds a minimal new dual-host plugin — a Pi package manifest, a source
 * extension, a manual portable executor, an example skill, and a resolved `pioc.port.json` — ready
 * to run `pioc port` against immediately. Refuses to overwrite any file it would create; a
 * directory an author has already started customizing should never lose work silently.
 */
export async function runInitCommand(input: InitCommandInput): Promise<InitCommandResult> {
  const directory = resolve(input.directory);
  const packageName = basename(directory);

  const scaffoldFiles: readonly ScaffoldFile[] = [
    { relativePath: "package.json", content: initPackageJson(packageName) },
    { relativePath: join("extensions", "index.ts"), content: INIT_EXTENSION_SOURCE },
    { relativePath: join("portable", "hello.ts"), content: INIT_PORTABLE_EXECUTOR_SOURCE },
    { relativePath: join("skills", "hello-guide", "SKILL.md"), content: INIT_SKILL_SOURCE },
  ];

  const conflicts: string[] = [];
  for (const file of [...scaffoldFiles, { relativePath: "pioc.port.json", content: "" }]) {
    if (await pathExists(join(directory, file.relativePath))) {
      conflicts.push(file.relativePath);
    }
  }
  if (conflicts.length > 0) {
    throw new PiocCliError(
      "INIT_TARGET_EXISTS",
      `"pioc init" would overwrite ${conflicts.length} existing file(s) in ${directory}; nothing was written.`,
      EXIT_DOMAIN_FAILURE,
      conflicts,
    );
  }

  for (const file of scaffoldFiles) {
    await writeTextFile(join(directory, file.relativePath), file.content);
  }

  const analysis = await analyzePiPackage(directory);
  if (!analysis.ok) {
    throw fromCoreFailure(analysis.error);
  }

  const manifest: PortabilityManifest = {
    schemaVersion: 1,
    source: { packageName: analysis.value.packageName, sourceHash: analysis.value.sourceHash },
    plugin: { id: packageName, name: packageName },
    requiredCapabilities: analysis.value.findings.map((finding) => finding.id),
    resolutions: Object.fromEntries(
      analysis.value.findings
        .filter((finding) => finding.classification !== "direct")
        .map((finding) => [finding.id, { mode: "manual" as const, module: "portable/hello.ts" }]),
    ),
  };
  const manifestPath = join(directory, "pioc.port.json");
  await writeTextFile(manifestPath, serializeStableJson(manifest));

  return {
    packageName: analysis.value.packageName,
    directory,
    createdPaths: [...scaffoldFiles.map((file) => file.relativePath), "pioc.port.json"].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  };
}
