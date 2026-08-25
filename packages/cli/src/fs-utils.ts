import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** Converts a filesystem-native relative path to the stable slash-separated artifact form. */
export function normalizeRelativePath(path: string): string {
  return path.split(sep).join("/");
}

/**
 * Expresses `toPath` relative to `fromDirectory`, normalized to `/` so it never carries an
 * absolute path. Returns `"."`, never `""`, when the two paths are the same directory (in-place
 * porting, where `<source>` and `--out` coincide) — `""` round-trips through `JSON.stringify` and
 * back fine, but reads as "missing" rather than "this directory" to a human or a naive validator.
 */
export function toPortableRelativePath(fromDirectory: string, toPath: string): string {
  const relativePath = normalizeRelativePath(relative(fromDirectory, toPath));
  return relativePath.length === 0 ? "." : relativePath;
}

/** True when `path` exists, regardless of whether it is a file or a directory. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Creates `path` and any missing parent directories. */
export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/** Writes `content` to `path`, creating parent directories as needed. */
export async function writeTextFile(path: string, content: string): Promise<void> {
  await ensureDirectory(join(path, ".."));
  await writeFile(path, content, "utf8");
}

/** Lists every regular file under `rootPath`, as `/`-normalized paths relative to it, in lexical order. */
export async function listFilesRecursive(rootPath: string): Promise<readonly string[]> {
  const results: string[] = [];

  async function walk(currentPath: string): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const entryPath = join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile()) {
        results.push(normalizeRelativePath(relative(rootPath, entryPath)));
      }
    }
  }

  if (await pathExists(rootPath)) {
    await walk(rootPath);
  }
  return results.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** One path that differs between two directory trees compared by {@link compareDirectoriesByteExact}. */
export interface DirectoryDrift {
  readonly path: string;
  readonly reason: "missing-in-left" | "missing-in-right" | "content-differs";
}

/** Recursively compares two directory trees byte-for-byte, returning every path that differs. */
export async function compareDirectoriesByteExact(leftRoot: string, rightRoot: string): Promise<readonly DirectoryDrift[]> {
  const leftFiles = new Set(await listFilesRecursive(leftRoot));
  const rightFiles = new Set(await listFilesRecursive(rightRoot));
  const drift: DirectoryDrift[] = [];

  for (const path of leftFiles) {
    if (!rightFiles.has(path)) {
      drift.push({ path, reason: "missing-in-right" });
    }
  }
  for (const path of rightFiles) {
    if (!leftFiles.has(path)) {
      drift.push({ path, reason: "missing-in-left" });
    }
  }
  for (const path of leftFiles) {
    if (!rightFiles.has(path)) {
      continue;
    }
    const [leftBytes, rightBytes] = await Promise.all([readFile(join(leftRoot, path)), readFile(join(rightRoot, path))]);
    if (!leftBytes.equals(rightBytes)) {
      drift.push({ path, reason: "content-differs" });
    }
  }

  return drift.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}
