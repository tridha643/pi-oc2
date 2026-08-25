import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computePiSourceHash } from "./source-hash.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("computePiSourceHash", () => {
  it("is order-independent and changes when exact source bytes change", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-oc2-hash-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "a.txt"), "alpha");
    await writeFile(join(root, "b.txt"), "beta");

    const first = await computePiSourceHash(root, ["b.txt", "a.txt"]);
    const reordered = await computePiSourceHash(root, ["a.txt", "b.txt"]);
    await writeFile(join(root, "a.txt"), "alpha\n");
    const changed = await computePiSourceHash(root, ["a.txt", "b.txt"]);

    expect(first).toEqual(reordered);
    expect(changed.sourceHash).not.toBe(first.sourceHash);
    expect(changed.files.find((file) => file.path === "a.txt")?.sha256).not.toBe(
      first.files.find((file) => file.path === "a.txt")?.sha256,
    );
  });
});
