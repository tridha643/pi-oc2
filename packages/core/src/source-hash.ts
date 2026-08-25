import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AnalyzedSourceFile } from "./core-domain.js";
import { compareLexicalText } from "./pi-source-paths.js";

/** Source hash output with both the aggregate identity and per-file evidence. */
export interface PiSourceHash {
  readonly sourceHash: string;
  readonly files: readonly AnalyzedSourceFile[];
}

function lengthPrefix(length: number): Buffer {
  const prefix = Buffer.allocUnsafe(8);
  prefix.writeBigUInt64BE(BigInt(length));
  return prefix;
}

/** Hashes normalized relative paths and exact file bytes in lexical order. */
export async function computePiSourceHash(rootPath: string, relativePaths: readonly string[]): Promise<PiSourceHash> {
  const aggregateHash = createHash("sha256");
  const files: AnalyzedSourceFile[] = [];
  const sortedPaths = [...new Set(relativePaths)].sort(compareLexicalText);

  for (const relativePath of sortedPaths) {
    const pathBytes = Buffer.from(relativePath, "utf8");
    const fileBytes = await readFile(join(rootPath, relativePath));
    const fileHash = createHash("sha256").update(fileBytes).digest("hex");
    aggregateHash.update(lengthPrefix(pathBytes.byteLength));
    aggregateHash.update(pathBytes);
    aggregateHash.update(lengthPrefix(fileBytes.byteLength));
    aggregateHash.update(fileBytes);
    files.push({ path: relativePath, byteLength: fileBytes.byteLength, sha256: fileHash });
  }

  return { sourceHash: aggregateHash.digest("hex"), files };
}
