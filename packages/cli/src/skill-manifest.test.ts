import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzePiPackage } from "@pi-oc2/core";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("pi-oc2's own Pi package manifest", () => {
  it("exposes the port-pi-extension-to-opencode2 skill and parses without executing any source", async () => {
    // pi-oc2 is a Pi package in its own right (package.json's "pi" field), distributing its
    // porting skill through the same mechanism a ported plugin's skills go through. This proves
    // the skill's frontmatter is well-formed and that packages/cli's own manifest is valid,
    // using the exact static analyzer this skill tells authors to trust.
    const result = await analyzePiPackage(packageRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.skills.map((skill) => skill.name)).toContain("port-pi-extension-to-opencode2");
    const skill = result.value.skills.find((entry) => entry.name === "port-pi-extension-to-opencode2");
    expect(skill?.description).toContain("pioc");
  });
});
