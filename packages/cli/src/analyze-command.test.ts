import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { runAnalyzeCommand } from "./analyze-command.js";
import { PiocCliError } from "./cli-error.js";
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

describe("runAnalyzeCommand", () => {
  it("writes analysis.json and COMPAT.md deterministically across two runs", async () => {
    const source = await tempDir("pioc-analyze-source-");
    await writeFixturePiPackage(source);
    const outA = await tempDir("pioc-analyze-out-a-");
    const outB = await tempDir("pioc-analyze-out-b-");

    const resultA = await runAnalyzeCommand({ sourcePath: source, outDir: outA });
    await runAnalyzeCommand({ sourcePath: source, outDir: outB });

    expect(resultA.packageName).toBe("fixture");
    expect(resultA.resourceCount).toBe(2);
    expect(resultA.findingCount).toBeGreaterThan(0);

    const [jsonA, jsonB] = await Promise.all([readFile(join(outA, "analysis.json"), "utf8"), readFile(join(outB, "analysis.json"), "utf8")]);
    expect(jsonA).toBe(jsonB);
    expect(jsonA.endsWith("\n")).toBe(true);

    const [markdownA, markdownB] = await Promise.all([
      readFile(join(outA, "COMPAT.md"), "utf8"),
      readFile(join(outB, "COMPAT.md"), "utf8"),
    ]);
    expect(markdownA).toBe(markdownB);
    expect(markdownA).toContain("# Compatibility analysis: fixture");
    expect(markdownA).toContain("| Capability | Classification | Symbol | Source | Message |");
  });

  it("rejects a source directory that is neither a Pi package nor a bare skill with a stable error", async () => {
    const source = await tempDir("pioc-analyze-empty-");
    const out = await tempDir("pioc-analyze-out-");

    await expect(runAnalyzeCommand({ sourcePath: source, outDir: out })).rejects.toMatchObject({
      code: "SOURCE_NOT_PI_PACKAGE",
      exitCode: 1,
    });
  });

  it("throws a PiocCliError instance, not a bare Error, on domain failure", async () => {
    const source = await tempDir("pioc-analyze-missing-");
    const out = await tempDir("pioc-analyze-out-");
    try {
      await runAnalyzeCommand({ sourcePath: join(source, "does-not-exist"), outDir: out });
      expect.unreachable("expected runAnalyzeCommand to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PiocCliError);
    }
  });
});
