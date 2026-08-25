import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serializeStableJson } from "@pi-oc2/core/serialization";
import { typecheckGeneratedPackage } from "./typecheck-target.js";
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

async function writeTsconfig(directory: string): Promise<void> {
  await writeFile(
    join(directory, "tsconfig.json"),
    serializeStableJson({
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022", strict: true, skipLibCheck: true },
      include: ["*.ts"],
    }),
  );
}

describe("typecheckGeneratedPackage", () => {
  it("passes a package that actually typechecks under a real tsc invocation", async () => {
    const directory = await tempDir("pioc-typecheck-ok-");
    await writeTsconfig(directory);
    await writeFile(join(directory, "index.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n");

    const result = await typecheckGeneratedPackage(directory);

    expect(result).toEqual({ status: "passed" });
  });

  it("reports a real type error's diagnostics instead of throwing", async () => {
    const directory = await tempDir("pioc-typecheck-fail-");
    await writeTsconfig(directory);
    await writeFile(join(directory, "index.ts"), 'export const value: number = "not a number";\n');

    const result = await typecheckGeneratedPackage(directory);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.diagnostics).toContain("index.ts");
      expect(result.diagnostics.length).toBeGreaterThan(0);
    }
  });
});
