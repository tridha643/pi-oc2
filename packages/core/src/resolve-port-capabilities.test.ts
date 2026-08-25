import { describe, expect, it } from "vitest";
import type { CapabilityFinding } from "./core-domain.js";
import { parsePortabilityManifest } from "./portability-manifest.js";
import { resolvePortCapabilities } from "./resolve-port-capabilities.js";

const findings: readonly CapabilityFinding[] = [
  {
    id: "skill:review:skills/review/SKILL.md:1:1",
    capability: "skill",
    classification: "direct",
    required: true,
    message: "direct",
    source: { path: "skills/review/SKILL.md", line: 1, column: 1 },
  },
  {
    id: "tool:hello:extensions/hello.ts:2:3",
    capability: "tool",
    classification: "scaffold",
    required: true,
    message: "manual",
    source: { path: "extensions/hello.ts", line: 2, column: 3 },
  },
];

function manifest(resolutions?: unknown): string {
  return JSON.stringify({
    schemaVersion: 1,
    source: { packageName: "fixture", sourceHash: "a".repeat(64) },
    plugin: { id: "fixture" },
    requiredCapabilities: findings.map((finding) => finding.id),
    ...(resolutions === undefined ? {} : { resolutions }),
  });
}

describe("resolvePortCapabilities", () => {
  it("returns unresolved required capabilities as a tagged failure", () => {
    const parsed = parsePortabilityManifest(manifest());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = resolvePortCapabilities(findings, parsed.value);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "UNRESOLVED_REQUIRED_CAPABILITIES",
        message: "Required capabilities remain unresolved: tool:hello:extensions/hello.ts:2:3",
        unresolved: [
          {
            capabilityId: "tool:hello:extensions/hello.ts:2:3",
            reason: "manual-resolution-required",
            classification: "scaffold",
          },
        ],
      },
    });
  });

  it("resolves direct and manual capabilities deterministically", () => {
    const parsed = parsePortabilityManifest(
      manifest({
        "tool:hello:extensions/hello.ts:2:3": { mode: "manual", module: "portable/hello.ts" },
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = resolvePortCapabilities(findings, parsed.value);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.capabilities.map((entry) => entry.resolution)).toEqual(["direct", "manual"]);
    }
  });
});
