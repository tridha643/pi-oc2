import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzePiPackage } from "./analyze-pi-package.js";
import { writeDeterministicAnalysis } from "./deterministic-artifacts.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixturePackage(): Promise<{ readonly root: string; readonly marker: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-oc2-analysis-"));
  temporaryDirectories.push(root);
  const marker = join(root, "extension-executed.txt");
  await mkdir(join(root, "extensions"));
  await mkdir(join(root, "skills", "fixture"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture" }));
  await writeFile(
    join(root, "extensions", "evil.ts"),
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "executed");
export default function (pi) {
  pi.registerTool({ name: "hello", description: "Hello", parameters: Type.Object({ name: Type.String() }), execute() {} });
}
`,
  );
  await writeFile(
    join(root, "skills", "fixture", "SKILL.md"),
    "---\nname: fixture\ndescription: Fixture skill\n---\n# Fixture\n",
  );
  return { root, marker };
}

describe("analyzePiPackage", () => {
  it("analyzes a real package path without executing extension module code", async () => {
    const fixture = await fixturePackage();

    const result = await analyzePiPackage(fixture.root);

    expect(result.ok).toBe(true);
    await expect(access(fixture.marker, constants.F_OK)).rejects.toThrow();
    if (result.ok) {
      expect(result.value.extensions[0]?.tools[0]?.name).toBe("hello");
      expect(result.value.skills[0]?.name).toBe("fixture");
    }
  });

  it("produces byte-identical artifacts and changes identity after a source edit", async () => {
    const fixture = await fixturePackage();
    const first = await analyzePiPackage(fixture.root);
    const second = await analyzePiPackage(fixture.root);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(writeDeterministicAnalysis(first.value)).toEqual(writeDeterministicAnalysis(second.value));
    const extensionPath = join(fixture.root, "extensions", "evil.ts");
    await writeFile(extensionPath, `${await readFile(extensionPath, "utf8")}\n// byte change\n`);
    const changed = await analyzePiPackage(fixture.root);

    expect(changed.ok).toBe(true);
    if (changed.ok) {
      expect(changed.value.sourceHash).not.toBe(first.value.sourceHash);
    }
  });
});
