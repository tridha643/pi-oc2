import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInitCommand } from "./init-command.js";
import { createTempDirectory, removeTempDirectory } from "./test-support.js";

const cleanupDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(cleanupDirectories.splice(0).map(removeTempDirectory));
});

async function tempDir(prefix: string): Promise<string> {
  const path = await createTempDirectory(prefix);
  cleanupDirectories.push(path);
  return path;
}

describe("runInitCommand", () => {
  it("scaffolds a package, extension, portable executor, skill, and a fully resolved pioc.port.json", async () => {
    const directory = await tempDir("pioc-init-");

    const result = await runInitCommand({ directory });

    expect(result.createdPaths).toEqual(
      ["package.json", join("extensions", "index.ts"), join("portable", "hello.ts"), join("skills", "hello-guide", "SKILL.md"), "pioc.port.json"].sort(),
    );

    const manifestText = await readFile(join(directory, "pioc.port.json"), "utf8");
    const manifest = JSON.parse(manifestText);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.source.packageName).toBe(result.packageName);
    expect(typeof manifest.source.sourceHash).toBe("string");
    expect(manifest.source.sourceHash).toMatch(/^[a-f0-9]{64}$/u);
    // Every required capability must be either direct (no resolution needed) or have an explicit
    // manual/waive resolution — this is what makes `pioc port` runnable immediately after init.
    for (const capabilityId of manifest.requiredCapabilities as readonly string[]) {
      const isDirect = capabilityId.startsWith("extension-factory:") || capabilityId.startsWith("skill:");
      if (!isDirect) {
        expect(manifest.resolutions[capabilityId]).toEqual({ mode: "manual", module: "portable/hello.ts" });
      }
    }
  });

  it("never overwrites an existing file and leaves the directory untouched", async () => {
    const directory = await tempDir("pioc-init-conflict-");
    await writeFile(join(directory, "package.json"), '{"name":"already-here"}');

    await expect(runInitCommand({ directory })).rejects.toMatchObject({ code: "INIT_TARGET_EXISTS", exitCode: 1 });

    // No scaffold files beyond the pre-existing package.json should have been written.
    const preserved = await readFile(join(directory, "package.json"), "utf8");
    expect(preserved).toBe('{"name":"already-here"}');
    await expect(readFile(join(directory, "pioc.port.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(directory, "extensions", "index.ts"), "utf8")).rejects.toThrow();
  });
});
