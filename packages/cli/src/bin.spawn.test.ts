import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTempDirectory, removeTempDirectory, writeFixturePiPackage } from "./test-support.js";

const execFileAsync = promisify(execFile);
const packageRoot = join(import.meta.dirname, "..");
const binPath = join(packageRoot, "dist", "bin", "pioc.js");

/**
 * Exercises the actual published entry point (`bin.pioc` in package.json, built by `tsc`), not
 * just the `runPiocCli` function every other test in this package calls directly. Every other
 * suite proves command *behavior*; this proves the *packaging* — the shebang, the built `dist/`
 * layout, and that `node dist/bin/pioc.js` really is what a `pioc`-invoking user gets — actually
 * works. Building here (rather than assuming a prior `pnpm build`) keeps `pnpm test` runnable
 * on a clean checkout at the cost of one build per test run.
 */
async function runBuiltCli(args: readonly string[]): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [binPath, ...args]);
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { readonly code?: number; readonly stdout?: string; readonly stderr?: string };
    return { exitCode: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

const cleanupDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(cleanupDirectories.splice(0).map(removeTempDirectory));
});

describe("pioc bin (built, spawned)", () => {
  beforeAll(async () => {
    await execFileAsync(process.execPath, [join(packageRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], {
      cwd: packageRoot,
    });
  }, 120_000);

  it("prints usage and exits 0 for --help", async () => {
    const { exitCode, stdout } = await runBuiltCli(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("pioc");
  });

  it("runs a real analyze end to end as a separate process and exits 0", async () => {
    const source = await createTempDirectory("pioc-bin-analyze-source-");
    const out = await createTempDirectory("pioc-bin-analyze-out-");
    cleanupDirectories.push(source, out);
    await writeFixturePiPackage(source);

    const { exitCode, stdout } = await runBuiltCli(["analyze", source, "--out", out]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Analyzed "fixture"');
  });

  it("exits nonzero with no stack trace for an unknown subcommand", async () => {
    const { exitCode, stderr } = await runBuiltCli(["not-a-real-command"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("pioc:");
    expect(stderr).not.toMatch(/\n\s+at /u);
  });
});
