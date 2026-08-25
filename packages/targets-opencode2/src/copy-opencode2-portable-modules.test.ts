import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareOpenCode2PortableModules } from "./copy-opencode2-portable-modules.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function portableModuleRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-oc2-portable-modules-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "portable"));
  return root;
}

describe("prepareOpenCode2PortableModules", () => {
  it("copies bytes once per source and orders generated target paths lexically", async () => {
    const portRoot = await portableModuleRoot();
    await writeFile(join(portRoot, "alpha.ts"), new Uint8Array([0, 1, 2, 255]));
    await writeFile(join(portRoot, "portable", "zeta.ts"), "zeta\n");

    const result = await prepareOpenCode2PortableModules(portRoot, [
      "portable/zeta.ts",
      "alpha.ts",
      "./portable/zeta.ts",
      "portable//zeta.ts",
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.modules.map((module) => [module.sourcePath, module.targetPath])).toEqual([
      ["alpha.ts", "portable/alpha.ts"],
      ["portable/zeta.ts", "portable/zeta.ts"],
    ]);
    expect([...result.modules[0]!.contents]).toEqual([0, 1, 2, 255]);
    expect(new TextDecoder().decode(result.modules[1]!.contents)).toBe("zeta\n");
  });

  it("rejects distinct portable sources that map to the same generated target path", async () => {
    const portRoot = await portableModuleRoot();
    await writeFile(join(portRoot, "collision.ts"), "root\n");
    await writeFile(join(portRoot, "portable", "collision.ts"), "portable\n");

    const result = await prepareOpenCode2PortableModules(portRoot, ["portable/collision.ts", "collision.ts"]);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "OPENCODE2_TARGET_PATH_COLLISION",
        message:
          "OpenCode 2 portable modules collide at generated target path portable/collision.ts: collision.ts, portable/collision.ts",
        targetPath: "portable/collision.ts",
        sourcePaths: ["collision.ts", "portable/collision.ts"],
      },
    });
  });
});
