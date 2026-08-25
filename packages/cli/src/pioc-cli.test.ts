import { afterEach, describe, expect, it, vi } from "vitest";
import { runPiocCli } from "./pioc-cli.js";
import { createTempDirectory, removeTempDirectory, writeFixturePiPackage } from "./test-support.js";

const cleanupDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(cleanupDirectories.splice(0).map(removeTempDirectory));
});

async function tempDir(prefix: string): Promise<string> {
  const path = await createTempDirectory(prefix);
  cleanupDirectories.push(path);
  return path;
}

/** Captures stdout/stderr writes made during `fn()` without letting them reach the real terminal. */
async function captureOutput(fn: () => Promise<{ readonly exitCode: number }>): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const { exitCode } = await fn();
    const stdout = stdoutSpy.mock.calls.map((call) => String(call[0])).join("") + consoleLogSpy.mock.calls.map((call) => `${String(call[0])}\n`).join("");
    const stderr = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    return { exitCode, stdout, stderr };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    consoleLogSpy.mockRestore();
  }
}

describe("runPiocCli", () => {
  it("prints usage and exits 0 for no arguments", async () => {
    const { exitCode, stdout } = await captureOutput(() => runPiocCli([]));
    expect(exitCode).toBe(0);
    expect(stdout).toContain("pioc");
  });

  it("prints the CLI's own version and exits 0 for --version", async () => {
    const { exitCode, stdout } = await captureOutput(() => runPiocCli(["--version"]));
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/u);
  });

  it("exits 64 with a stable, stack-trace-free message for an unknown subcommand", async () => {
    const { exitCode, stderr } = await captureOutput(() => runPiocCli(["not-a-real-command"]));
    expect(exitCode).toBe(64);
    expect(stderr).toContain("pioc:");
    expect(stderr).not.toMatch(/\n\s+at /u);
  });

  it("exits 64 with a stable message when a required flag is missing", async () => {
    const { exitCode, stderr } = await captureOutput(() => runPiocCli(["analyze", "/tmp/does-not-matter"]));
    expect(exitCode).toBe(64);
    expect(stderr).toContain("pioc:");
    expect(stderr).not.toMatch(/\n\s+at /u);
  });

  it("runs a real `analyze` end to end through the CLI dispatcher and exits 0", async () => {
    const source = await tempDir("pioc-cli-analyze-source-");
    await writeFixturePiPackage(source);
    const out = await tempDir("pioc-cli-analyze-out-");

    const { exitCode, stdout } = await captureOutput(() => runPiocCli(["analyze", source, "--out", out]));

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Analyzed "fixture"');
  });

  it("exits 1 with a stack-trace-free message for a real domain failure (source is not a Pi package)", async () => {
    const source = await tempDir("pioc-cli-analyze-bad-source-");
    const out = await tempDir("pioc-cli-analyze-bad-out-");

    const { exitCode, stderr } = await captureOutput(() => runPiocCli(["analyze", source, "--out", out]));

    expect(exitCode).toBe(1);
    expect(stderr).toContain("pioc: SOURCE_NOT_PI_PACKAGE:");
    expect(stderr).not.toMatch(/\n\s+at /u);
  });
});
