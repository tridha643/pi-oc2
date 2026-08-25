import { join, resolve } from "node:path";
import { analyzePiPackage } from "@pi-oc2/core";
import { writeDeterministicAnalysis } from "@pi-oc2/core/serialization";
import { EXIT_DOMAIN_FAILURE, PiocCliError, fromCoreFailure } from "./cli-error.js";
import { writeTextFile } from "./fs-utils.js";

export interface AnalyzeCommandInput {
  readonly sourcePath: string;
  readonly outDir: string;
}

export interface AnalyzeCommandResult {
  readonly packageName: string;
  readonly sourceHash: string;
  readonly resourceCount: number;
  readonly findingCount: number;
  readonly analysisJsonPath: string;
  readonly compatMarkdownPath: string;
}

/**
 * Runs `pioc analyze`: statically analyzes a Pi package or bare-skill directory and writes
 * `analysis.json` (machine-readable) and `COMPAT.md` (human-readable) into `--out`. Never imports
 * or evaluates the source package, per `docs/adr/0001-compile-native-targets.md`'s constraint.
 */
export async function runAnalyzeCommand(input: AnalyzeCommandInput): Promise<AnalyzeCommandResult> {
  const analysis = await analyzePiPackage(input.sourcePath);
  if (!analysis.ok) {
    throw fromCoreFailure(analysis.error);
  }

  const outDir = resolve(input.outDir);
  const artifacts = writeDeterministicAnalysis(analysis.value);
  const analysisJsonPath = join(outDir, "analysis.json");
  const compatMarkdownPath = join(outDir, "COMPAT.md");

  try {
    await writeTextFile(analysisJsonPath, artifacts.json);
    await writeTextFile(compatMarkdownPath, artifacts.markdown);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new PiocCliError("ANALYZE_OUTPUT_UNWRITABLE", `Cannot write analysis output to ${outDir}: ${cause}`, EXIT_DOMAIN_FAILURE);
  }

  return {
    packageName: analysis.value.packageName,
    sourceHash: analysis.value.sourceHash,
    resourceCount: analysis.value.resources.length,
    findingCount: analysis.value.findings.length,
    analysisJsonPath,
    compatMarkdownPath,
  };
}
