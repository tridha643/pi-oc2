import { defineCommand, runCommand, showUsage } from "citty";
import { runAnalyzeCommand } from "./analyze-command.js";
import { EXIT_INTERNAL_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, PiocCliError } from "./cli-error.js";
import { readGeneratorVersion } from "./generator-version.js";
import { runInitCommand } from "./init-command.js";
import { runPortCommand } from "./port-command.js";
import { runVerifyCommand } from "./verify-command.js";

function printFailure(error: PiocCliError): void {
  process.stderr.write(`pioc: ${error.code}: ${error.message}\n`);
  for (const detail of error.details) {
    process.stderr.write(`  - ${detail}\n`);
  }
}

/** True for citty's internal `CLIError` (missing/invalid arguments, unknown subcommand), which citty does not export. */
function isCittyUsageError(error: unknown): error is Error {
  return error instanceof Error && error.name === "CLIError";
}

const analyzeCommand = defineCommand({
  meta: { name: "analyze", description: "Statically analyze a Pi package or bare SKILL.md directory into analysis.json and COMPAT.md." },
  args: {
    source: { type: "positional", description: "Path to a Pi package root or bare SKILL.md directory.", required: true },
    out: { type: "string", description: "Directory to write analysis.json and COMPAT.md into.", required: true },
  },
  async run({ args }) {
    const result = await runAnalyzeCommand({ sourcePath: String(args.source), outDir: String(args.out) });
    process.stdout.write(
      `Analyzed "${result.packageName}": ${result.resourceCount} resource(s), ${result.findingCount} finding(s).\n` +
        `  source hash: ${result.sourceHash}\n  wrote:       ${result.analysisJsonPath}\n  wrote:       ${result.compatMarkdownPath}\n`,
    );
  },
});

const portCommand = defineCommand({
  meta: { name: "port", description: "Resolve pioc.port.json against <source> and generate native Pi and OpenCode 2 targets." },
  args: {
    source: { type: "positional", description: "Path to the Pi package root or bare SKILL.md directory to port.", required: true },
    manifest: { type: "string", description: "Path to the pioc.port.json portability manifest.", required: true },
    out: { type: "string", description: "Port directory to write pi/, opencode2/, COMPAT.md, and pioc.lock.json into.", required: true },
  },
  async run({ args }) {
    const result = await runPortCommand({
      sourcePath: String(args.source),
      manifestPath: String(args.manifest),
      outDir: String(args.out),
    });
    process.stdout.write(
      `Ported "${result.packageName}": ${result.resolvedCapabilities.capabilities.length} capabilit(y/ies) resolved.\n` +
        `  source hash: ${result.sourceHash}\n` +
        `  pi:          ${result.piWrittenPaths.length} file(s)\n` +
        `  opencode2:   ${result.opencode2WrittenPaths.length} file(s)\n` +
        `  wrote:       ${result.compatMarkdownPath}\n  wrote:       ${result.lockPath}\n`,
    );
  },
});

const verifyCommand = defineCommand({
  meta: { name: "verify", description: "Reject a port with lock, source, or target drift; typecheck and smoke-test its generated targets." },
  args: {
    port: { type: "positional", description: "Port directory previously written by `pioc port`.", required: true },
  },
  async run({ args }) {
    const result = await runVerifyCommand({ portDir: String(args.port) });
    const smokeLine =
      result.opencode2Smoke.status === "passed"
        ? `passed (${result.opencode2Smoke.command})`
        : `skipped (${result.opencode2Smoke.reason})`;
    process.stdout.write(
      `Verified "${result.packageName}" (source hash ${result.sourceHash}):\n` +
        `  pi typecheck:        ${result.piTypecheck}\n  opencode2 typecheck: ${result.opencode2Typecheck}\n` +
        `  opencode2 smoke:     ${smokeLine}\n`,
    );
  },
});

const initCommand = defineCommand({
  meta: { name: "init", description: "Scaffold a minimal new dual-host Pi / OpenCode 2 plugin, without overwriting existing files." },
  args: {
    directory: { type: "positional", description: "Directory to scaffold the example plugin into.", required: true },
  },
  async run({ args }) {
    const result = await runInitCommand({ directory: String(args.directory) });
    process.stdout.write(
      `Initialized "${result.packageName}" in ${result.directory}:\n` +
        result.createdPaths.map((path) => `  wrote: ${path}\n`).join(""),
    );
  },
});

export const rootCommand = defineCommand({
  meta: {
    name: "pioc",
    version: readGeneratorVersion(),
    description: "Statically analyze Pi packages and compile deterministic native Pi and OpenCode 2 plugin ports.",
  },
  subCommands: {
    analyze: analyzeCommand,
    port: portCommand,
    verify: verifyCommand,
    init: initCommand,
  },
});

export interface RunPiocCliOutcome {
  readonly exitCode: number;
}

/**
 * Runs the `pioc` CLI end to end and returns an exit code instead of calling `process.exit`, so
 * both `bin/pioc.ts` and tests can drive it identically. Every expected failure — bad arguments,
 * a rejected port, an unavailable target generator — is printed as one stable `pioc: CODE:
 * message` line (plus optional detail lines) with no stack trace; only a genuine bug in this CLI
 * reaches the generic "internal error" branch.
 */
export async function runPiocCli(rawArgs: readonly string[]): Promise<RunPiocCliOutcome> {
  const args = [...rawArgs];

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    await showUsage(rootCommand);
    return { exitCode: EXIT_SUCCESS };
  }
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    process.stdout.write(`${readGeneratorVersion()}\n`);
    return { exitCode: EXIT_SUCCESS };
  }

  try {
    await runCommand(rootCommand, { rawArgs: args });
    return { exitCode: EXIT_SUCCESS };
  } catch (error) {
    if (error instanceof PiocCliError) {
      printFailure(error);
      return { exitCode: error.exitCode };
    }
    if (isCittyUsageError(error)) {
      process.stderr.write(`pioc: ${error.message}\n`);
      return { exitCode: EXIT_USAGE_ERROR };
    }
    const cause = error instanceof Error ? error.message : String(error);
    process.stderr.write(`pioc: internal error: ${cause}\n`);
    return { exitCode: EXIT_INTERNAL_ERROR };
  }
}
