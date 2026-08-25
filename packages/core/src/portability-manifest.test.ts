import { describe, expect, it } from "vitest";
import { parsePortabilityManifest } from "./portability-manifest.js";

const sourceHash = "a".repeat(64);

function manifestWithModule(module: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    source: { packageName: "fixture", sourceHash },
    plugin: { id: "fixture" },
    requiredCapabilities: ["tool:fixture"],
    resolutions: {
      "tool:fixture": { mode: "manual", module },
    },
  });
}

describe("parsePortabilityManifest", () => {
  it("parses a relative manual module path", () => {
    const result = parsePortabilityManifest(manifestWithModule("portable/fixture.ts"));

    expect(result.ok).toBe(true);
  });

  it.each(["../outside.ts", "/tmp/outside.ts", "C:\\outside.ts", "\\\\server\\share\\outside.ts"])(
    "rejects a manual module path outside the portable root: %s",
    (module) => {
      const result = parsePortabilityManifest(manifestWithModule(module));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("PORT_MANIFEST_INVALID");
      }
    },
  );
});
