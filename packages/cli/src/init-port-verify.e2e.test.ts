import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { analyzePiPackage } from "@pi-oc2/core";
import { runInitCommand } from "./init-command.js";
import { runPortCommand } from "./port-command.js";
import { runVerifyCommand } from "./verify-command.js";
import { createTempDirectory, removeTempDirectory, writeFixtureManifest, writeFixturePiPackage } from "./test-support.js";

const cleanupDirectories: string[] = [];
const originalOpenCode2Bin = process.env.PIOC_OPENCODE2_BIN;
afterEach(async () => {
  if (originalOpenCode2Bin === undefined) {
    delete process.env.PIOC_OPENCODE2_BIN;
  } else {
    process.env.PIOC_OPENCODE2_BIN = originalOpenCode2Bin;
  }
  await Promise.all(cleanupDirectories.splice(0).map(removeTempDirectory));
});

/** This package's own devDependencies pin @opencode-ai/cli@0.0.0-dev-18204 — see opencode2-smoke.test.ts. */
function realExactPinnedOpenCode2Binary(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ".bin", "opencode2");
}

describe("pioc init -> port -> verify (in-place, source === --out)", () => {
  it("scaffolds a runnable dual-host plugin that ports and verifies against the real target generators", async () => {
    const directory = await createTempDirectory("pioc-e2e-");
    cleanupDirectories.push(directory);

    const initResult = await runInitCommand({ directory });
    expect(initResult.createdPaths).toContain("pioc.port.json");

    // The canonical "new plugin" workflow: pioc.port.json and portable/ already live in
    // `directory` (init put them there), so <source>, portRoot, and --out are the same directory —
    // this is what regressed toPortableRelativePath's empty-string-vs-"." handling in fs-utils.ts.
    const portResult = await runPortCommand({
      sourcePath: directory,
      manifestPath: join(directory, "pioc.port.json"),
      outDir: directory,
    });
    expect(portResult.piWrittenPaths).toContain("extension.ts");
    expect(portResult.opencode2WrittenPaths).toContain("server.ts");

    const verifyResult = await runVerifyCommand({ portDir: directory, skipOpenCode2Smoke: true });
    expect(verifyResult.piTypecheck).toBe("passed");
    expect(verifyResult.opencode2Typecheck).toBe("passed");
  }, 30_000);
});

describe("pioc port -> verify across three distinct directories", () => {
  it("ports and verifies when <source>, the manifest's port root, and --out are three separate directories", async () => {
    // @pi-oc2/target-pi and @pi-oc2/target-opencode2 now copy each resolved portable module into
    // their own generated output rather than importing it from outside --out (see port-command.ts's
    // module doc), so none of these three roles need to share a directory. This is the regression
    // test for that: it was previously a hard requirement that portRoot === outputRoot.
    const sourceDir = await createTempDirectory("pioc-e2e-source-");
    const portRootDir = await createTempDirectory("pioc-e2e-portroot-");
    const outDir = await createTempDirectory("pioc-e2e-out-");
    cleanupDirectories.push(sourceDir, portRootDir, outDir);

    await writeFixturePiPackage(sourceDir);
    const analysis = await analyzePiPackage(sourceDir);
    if (!analysis.ok) {
      throw new Error("fixture package failed to analyze");
    }
    const manifestPath = await writeFixtureManifest(portRootDir, analysis.value);

    const portResult = await runPortCommand({ sourcePath: sourceDir, manifestPath, outDir });
    expect(portResult.piWrittenPaths).toContain("extension.ts");
    // The portable executor is copied into the generated output itself, not left as a dangling
    // reference back into portRootDir.
    expect(portResult.piWrittenPaths.some((path) => path.startsWith("portable/"))).toBe(true);
    expect(portResult.opencode2WrittenPaths.some((path) => path.startsWith("portable/"))).toBe(true);
    // The tool and skill are both registered inline inside server.ts's own Plugin.define setup()
    // (ctx.tool.transform / ctx.skill.transform) — never a Hooks-based export, never a separate
    // .opencode/tools or .opencode/skills installation step.
    expect(portResult.opencode2WrittenPaths).toContain("skills/fixture/SKILL.md");
    expect(portResult.opencode2WrittenPaths.some((path) => path.startsWith(".opencode/"))).toBe(false);

    // The lock records portRootDir/sourceDir purely as paths relative to outDir; nothing here
    // assumes any of the three directories is an ancestor or descendant of another.
    //
    // The ambient opencode2 on PATH in this dev environment is v0.0.0-beta-18155 — not the exact
    // pinned dev-18204 build the smoke check requires — so without an override it would (correctly)
    // report "skipped", not "passed". Point PIOC_OPENCODE2_BIN at this package's own real, exact
    // pinned devDependency binary so this end-to-end run exercises the actual "passed" path, not
    // just the isolated opencode2-smoke.test.ts unit tests.
    process.env.PIOC_OPENCODE2_BIN = realExactPinnedOpenCode2Binary();
    const verifyResult = await runVerifyCommand({ portDir: outDir });
    expect(verifyResult.piTypecheck).toBe("passed");
    expect(verifyResult.opencode2Typecheck).toBe("passed");
    // Proves the strengthened smoke check actually discovers server.ts as a direct file:// plugin
    // (and any file-based .opencode/ this port still has), not just that some command exited zero.
    // (A "failed" status would already have thrown out of runVerifyCommand above — asserting
    // "passed" specifically, not just "did not throw", rules out a silent "skipped".)
    expect(verifyResult.opencode2Smoke).toMatchObject({ status: "passed" });
  }, 30_000);
});
