import { relative, resolve, sep } from "node:path";

/** Converts a package-relative path to the stable slash-separated artifact form. */
export function normalizePiSourcePath(path: string): string {
  return path.split(sep).join("/").replaceAll("\\", "/").replace(/^\.\//u, "");
}

/** Compares strings by code units so artifact order never depends on locale data. */
export function compareLexicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Resolves a declared resource path only when it remains inside the package root. */
export function resolvePiSourcePath(rootPath: string, declaredPath: string): string | undefined {
  const absolutePath = resolve(rootPath, declaredPath);
  const relativePath = relative(rootPath, absolutePath);
  if (relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== "..")) {
    return absolutePath;
  }
  return undefined;
}

/** Produces the normalized package-relative path used in hashes and diagnostics. */
export function relativePiSourcePath(rootPath: string, absolutePath: string): string {
  return normalizePiSourcePath(relative(rootPath, absolutePath));
}
