import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cachedVersion: string | undefined;

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads this CLI's own `version` field so generated headers and `pioc.lock.json` can record which
 * `pioc` build produced them. Resolves relative to this module's own file so it works unchanged
 * whether `pioc` is running from `src/` under a test runner or from the built `dist/` output,
 * since `package.json` sits exactly one directory above both.
 */
export function readGeneratorVersion(): string {
  if (cachedVersion !== undefined) {
    return cachedVersion;
  }
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = join(moduleDirectory, "..", "package.json");
  const packageJson: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (!isUnknownRecord(packageJson) || typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error(`pioc package.json is missing a version field: ${packageJsonPath}`);
  }
  cachedVersion = packageJson.version;
  return cachedVersion;
}
