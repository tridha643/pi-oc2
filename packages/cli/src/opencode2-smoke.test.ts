import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runOpenCode2ConfigDiscoverySmoke } from "./opencode2-smoke.js";
import { OPENCODE2_HOST_VERSION } from "./target-profile.js";
import { createTempDirectory, removeTempDirectory } from "./test-support.js";

const cleanupDirectories: string[] = [];
const originalPath = process.env.PATH;
const originalOpenCode2Bin = process.env.PIOC_OPENCODE2_BIN;
afterEach(async () => {
  process.env.PATH = originalPath;
  if (originalOpenCode2Bin === undefined) {
    delete process.env.PIOC_OPENCODE2_BIN;
  } else {
    process.env.PIOC_OPENCODE2_BIN = originalOpenCode2Bin;
  }
  await Promise.all(cleanupDirectories.splice(0).map(removeTempDirectory));
});

/**
 * This package's own `devDependencies` pin `@opencode-ai/cli@0.0.0-dev-18204` (see package.json)
 * specifically so these tests have a real, exact-pinned `opencode2` binary to run the smoke check's
 * "passed" path against — not a hand-rolled fake. Resolved relative to this module's own file so it
 * works regardless of the test runner's cwd.
 */
function realExactPinnedOpenCode2Binary(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ".bin", "opencode2");
}

describe("runOpenCode2ConfigDiscoverySmoke", () => {
  it("skips cleanly when no opencode2 binary is found at all", async () => {
    const directory = await createTempDirectory("pioc-opencode2-smoke-");
    cleanupDirectories.push(directory);
    process.env.PATH = "";
    delete process.env.PIOC_OPENCODE2_BIN;

    const result = await runOpenCode2ConfigDiscoverySmoke(directory);

    expect(result.status).toBe("skipped");
    if (result.status === "skipped") {
      expect(result.reason).toContain("was not found on PATH");
    }
  });

  it("skips with a precise version reason when the ambient PATH opencode2 is not the exact pinned dev-18204 build", async () => {
    const directory = await createTempDirectory("pioc-opencode2-smoke-ambient-");
    cleanupDirectories.push(directory);
    delete process.env.PIOC_OPENCODE2_BIN;

    const result = await runOpenCode2ConfigDiscoverySmoke(directory);

    // This asserts against whatever opencode2 build happens to be on PATH in the environment
    // running these tests, not a fixture — this repo's dev environment has a global
    // opencode2 v0.0.0-beta-18155 install, which is exactly the "older ambient build" case: never
    // treated as good enough to report a false "passed" for the pinned dev-18204 contract.
    expect(result.status).toBe("skipped");
    if (result.status === "skipped") {
      // Precise: names both the version it actually found and the one it required, not just "wrong version".
      expect(result.reason).toContain("0.0.0-beta-18155");
      expect(result.reason).toContain(OPENCODE2_HOST_VERSION);
    }
  });

  it("PIOC_OPENCODE2_BIN overrides which binary is inspected and run", async () => {
    const directory = await createTempDirectory("pioc-opencode2-smoke-override-");
    cleanupDirectories.push(directory);
    process.env.PIOC_OPENCODE2_BIN = realExactPinnedOpenCode2Binary();

    const result = await runOpenCode2ConfigDiscoverySmoke(directory);

    // The pinned binary itself is real; `directory` has no server.ts, but debug config only echoes
    // back what a project's opencode.jsonc actually declares, so an absent plugin file still
    // discovers cleanly rather than failing.
    expect(result.status).toBe("passed");
  });

  it("directly discovers a synthetic target's server.ts plugin against the real exact pinned binary", async () => {
    // Not a real generated/opencode2 target — just enough of the real @pi-oc2/target-opencode2
    // shape this module reads (a server.ts file) to prove the direct-file-URL-plugin discovery
    // logic on its own, faster and more directly than going through pioc port -> pioc verify.
    const targetRoot = await createTempDirectory("pioc-opencode2-smoke-target-");
    cleanupDirectories.push(targetRoot);
    await writeFile(join(targetRoot, "server.ts"), "export {};\n");
    process.env.PIOC_OPENCODE2_BIN = realExactPinnedOpenCode2Binary();

    const result = await runOpenCode2ConfigDiscoverySmoke(targetRoot);

    expect(result).toMatchObject({ status: "passed" });
  });

  it("discovers the plugin the same way whether or not the port registers any skills", async () => {
    // @pi-oc2/target-opencode2's server.ts registers skills itself, inline, via
    // ctx.skill.transform((draft) => draft.add({...})) inside Plugin.define's setup() — there is no
    // separate skills file, directory, or config entry for a consuming project to wire up.
    // debug config never runs setup() (it only lists configuration sources), so the only thing this
    // no-model check can prove either way is that opencode2 loads server.ts as a plugin at all —
    // which it must do identically regardless of what setup() goes on to register.
    const targetRoot = await createTempDirectory("pioc-opencode2-smoke-skills-inline-");
    cleanupDirectories.push(targetRoot);
    await writeFile(
      join(targetRoot, "server.ts"),
      'import { Plugin, Skill } from "@opencode-ai/plugin";\n' +
        "export default Plugin.define({\n" +
        '  id: "example",\n' +
        "  async setup(ctx) {\n" +
        "    await ctx.skill.transform((draft) => {\n" +
        '      draft.add({ id: Skill.ID.make("example:hello"), name: Skill.Name.make("hello"), content: "# Hello\\n" });\n' +
        "    });\n" +
        "  },\n" +
        "});\n",
    );
    process.env.PIOC_OPENCODE2_BIN = realExactPinnedOpenCode2Binary();

    const result = await runOpenCode2ConfigDiscoverySmoke(targetRoot);

    expect(result).toMatchObject({ status: "passed" });
  });
});
