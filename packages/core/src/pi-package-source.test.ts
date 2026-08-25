import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { parsePiPackageSource } from "./pi-package-source.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-oc2-source-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("parsePiPackageSource", () => {
  it("parses manifest resources in normalized lexical order", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "extensions"));
    await mkdir(join(root, "skills", "zeta"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "fixture",
        pi: { extensions: ["./extensions/z.ts", "./extensions/a.ts"], skills: ["./skills"] },
      }),
    );
    await writeFile(join(root, "extensions", "z.ts"), "export default () => {};\n");
    await writeFile(join(root, "extensions", "a.ts"), "export default () => {};\n");
    await writeFile(join(root, "skills", "zeta", "SKILL.md"), "---\nname: zeta\ndescription: Zeta\n---\nBody\n");

    const result = await parsePiPackageSource(root);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.resources.map((resource) => `${resource.kind}:${resource.path}`)).toEqual([
        "extension:extensions/a.ts",
        "extension:extensions/z.ts",
        "skill:skills/zeta/SKILL.md",
      ]);
      expect(result.value.analyzedPaths).toEqual([
        "extensions/a.ts",
        "extensions/z.ts",
        "package.json",
        "skills/zeta/SKILL.md",
      ]);
    }
  });

  it("expands manifest globs and applies exclusions before hashing", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "extensions", "nested"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "glob-fixture",
        pi: { extensions: ["extensions/**/*.ts", "!extensions/legacy.ts"] },
      }),
    );
    await writeFile(join(root, "extensions", "nested", "active.ts"), "export default () => {};\n");
    await writeFile(join(root, "extensions", "legacy.ts"), "throw new Error('must stay excluded');\n");

    const result = await parsePiPackageSource(root);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.resources).toEqual([{ kind: "extension", path: "extensions/nested/active.ts" }]);
      expect(result.value.analyzedPaths).toEqual(["extensions/nested/active.ts", "package.json"]);
    }
  });

  it("parses a bare SKILL.md directory and hashes its adjacent resources", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "references"));
    await writeFile(join(root, "SKILL.md"), "---\nname: bare\ndescription: Bare skill\n---\nBody\n");
    await writeFile(join(root, "references", "notes.md"), "Reference\n");

    const result = await parsePiPackageSource(root);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("bare-skill");
      expect(result.value.resources).toEqual([{ kind: "skill", path: "SKILL.md" }]);
      expect(result.value.analyzedPaths).toEqual(["SKILL.md", "references/notes.md"]);
    }
  });
});
