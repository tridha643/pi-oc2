import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzePiPackage } from "@pi-oc2/core";
import { serializeStableJson } from "@pi-oc2/core/serialization";
import { EXIT_ENVIRONMENT_FAILURE } from "./cli-error.js";
import { runPortCommand } from "./port-command.js";
import { createTempDirectory, removeTempDirectory, writeFixtureManifest, writeFixturePiPackage } from "./test-support.js";
import { cliFailure } from "./cli-result.js";

const cleanupDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(cleanupDirectories.splice(0).map(removeTempDirectory));
});

async function tempDir(prefix: string): Promise<string> {
  const path = await createTempDirectory(prefix);
  cleanupDirectories.push(path);
  return path;
}

async function fixtureSourceAndManifest(): Promise<{ readonly source: string; readonly manifestPath: string; readonly portDir: string }> {
  const source = await tempDir("pioc-port-source-");
  await writeFixturePiPackage(source);
  const analysis = await analyzePiPackage(source);
  if (!analysis.ok) {
    throw new Error("fixture package failed to analyze");
  }
  const portDir = await tempDir("pioc-port-out-");
  const manifestPath = await writeFixtureManifest(portDir, analysis.value);
  return { source, manifestPath, portDir };
}

describe("runPortCommand", () => {
  it("generates both real targets under generated/, writes COMPAT.md and pioc.lock.json", async () => {
    const { source, manifestPath, portDir } = await fixtureSourceAndManifest();

    // No generator overrides: this is the real @pi-oc2/target-pi / @pi-oc2/target-opencode2,
    // present in this workspace, not a fake.
    const result = await runPortCommand({ sourcePath: source, manifestPath, outDir: portDir });

    expect(result.packageName).toBe("fixture");
    expect([...result.piWrittenPaths]).toContain("extension.ts");
    // @pi-oc2/target-opencode2 emits the pinned @opencode-ai/plugin `Plugin.define({ id, setup })`
    // contract as one server.ts (never a Hooks-based `{ id, server }` export, never something a
    // consumer loads by resolving a package directory). setup(ctx) registers both the tool
    // (ctx.tool.transform) and the skill (ctx.skill.transform) itself, inline — no separate
    // .opencode/tools or .opencode/skills installation step for a consuming project.
    expect([...result.opencode2WrittenPaths]).toContain("server.ts");
    expect([...result.opencode2WrittenPaths]).toContain("portable/hello.ts");
    expect([...result.opencode2WrittenPaths]).toContain("skills/fixture/SKILL.md");
    expect([...result.opencode2WrittenPaths].some((path) => path.startsWith(".opencode/"))).toBe(false);

    const extension = await readFile(join(portDir, "generated", "pi", "extension.ts"), "utf8");
    expect(extension).toContain('name: "hello"');
    const server = await readFile(join(portDir, "generated", "opencode2", "server.ts"), "utf8");
    expect(server).toContain('from "@opencode-ai/plugin"');
    expect(server).toContain("export default Plugin.define({");
    expect(server).toContain("await ctx.tool.transform((draft) => {");
    expect(server).toContain("await ctx.skill.transform((draft) => {");
    expect(server).toContain('name: "hello"');

    const compat = await readFile(join(portDir, "COMPAT.md"), "utf8");
    expect(compat).toContain("# Compatibility analysis: fixture");

    const lock = JSON.parse(await readFile(join(portDir, "pioc.lock.json"), "utf8"));
    expect(lock.schemaVersion).toBe(1);
    expect(lock.sourceHash).toBe(result.sourceHash);
    // The lock must record portable, non-absolute paths so it survives a checkout to another machine.
    expect(lock.sourcePath.startsWith("/")).toBe(false);
    expect(lock.manifestPath).toBe("pioc.port.json");
  });

  it("rejects a manifest pinned to a stale source hash before touching any generator", async () => {
    const { source, manifestPath, portDir } = await fixtureSourceAndManifest();
    const staleManifest = JSON.parse(await readFile(manifestPath, "utf8"));
    staleManifest.source.sourceHash = "f".repeat(64);
    await writeFile(manifestPath, serializeStableJson(staleManifest));

    let generatorCalled = false;
    const trackingLoader = async () => {
      generatorCalled = true;
      return cliFailure({ code: "TARGET_GENERATOR_UNAVAILABLE" as const, packageName: "unused", message: "should never be reached" });
    };

    await expect(
      runPortCommand({
        sourcePath: source,
        manifestPath,
        outDir: portDir,
        loadPiTargetGenerator: trackingLoader,
        loadOpenCode2TargetGenerator: trackingLoader,
      }),
    ).rejects.toMatchObject({ code: "PORT_SOURCE_HASH_MISMATCH", exitCode: 1 });
    expect(generatorCalled).toBe(false);
  });

  it("rejects unresolved required capabilities before touching any generator", async () => {
    const source = await tempDir("pioc-port-unresolved-source-");
    await writeFixturePiPackage(source);
    const analysis = await analyzePiPackage(source);
    if (!analysis.ok) {
      throw new Error("fixture package failed to analyze");
    }
    const portDir = await tempDir("pioc-port-unresolved-out-");
    // A manifest that requires every finding but never resolves the non-direct "tool" finding.
    const manifestPath = join(portDir, "pioc.port.json");
    await writeFile(
      manifestPath,
      serializeStableJson({
        schemaVersion: 1,
        source: { packageName: analysis.value.packageName, sourceHash: analysis.value.sourceHash },
        plugin: { id: analysis.value.packageName },
        requiredCapabilities: analysis.value.findings.map((finding) => finding.id),
      }),
    );

    let generatorCalled = false;
    const trackingLoader = async () => {
      generatorCalled = true;
      return cliFailure({ code: "TARGET_GENERATOR_UNAVAILABLE" as const, packageName: "unused", message: "should never be reached" });
    };

    const failure = await runPortCommand({
      sourcePath: source,
      manifestPath,
      outDir: portDir,
      loadPiTargetGenerator: trackingLoader,
      loadOpenCode2TargetGenerator: trackingLoader,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "UNRESOLVED_REQUIRED_CAPABILITIES", exitCode: 1 });
    expect((failure as { details: readonly string[] }).details.some((detail) => detail.startsWith("tool:hello:"))).toBe(true);
    expect(generatorCalled).toBe(false);
  });

  it("fails with a stable, environment-tier error when a target generator cannot be loaded", async () => {
    const { source, manifestPath, portDir } = await fixtureSourceAndManifest();

    const failingLoader = async () =>
      cliFailure({
        code: "TARGET_GENERATOR_UNAVAILABLE" as const,
        packageName: "@pi-oc2/target-pi",
        message: "simulated: package failed to load",
      });

    await expect(
      runPortCommand({ sourcePath: source, manifestPath, outDir: portDir, loadPiTargetGenerator: failingLoader }),
    ).rejects.toMatchObject({
      code: "TARGET_GENERATOR_UNAVAILABLE",
      exitCode: EXIT_ENVIRONMENT_FAILURE,
    });
  });
});
