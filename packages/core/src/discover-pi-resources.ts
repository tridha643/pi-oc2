import { stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import { glob } from "tinyglobby";
import type { PiResource, PiResourceKind } from "./core-domain.js";
import { compareLexicalText, normalizePiSourcePath, relativePiSourcePath, resolvePiSourcePath } from "./pi-source-paths.js";

/** A manifest or convention resource root paired with its Pi resource kind. */
export interface PiResourceDeclaration {
  readonly kind: PiResourceKind;
  readonly path: string;
}

/** Lexically ordered resource entries and all files covered by their declared roots. */
export interface DiscoveredPiResources {
  readonly resources: readonly PiResource[];
  readonly analyzedPaths: readonly string[];
}

/** A deterministic resource-discovery failure caused by a declared source path. */
export interface PiResourceDiscoveryFailure {
  readonly code: "RESOURCE_PATH_OUTSIDE_ROOT" | "RESOURCE_PATH_MISSING";
  readonly path: string;
  readonly message: string;
}

const extensionFileExtensions = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const globMagic = /[*?\[\]{}()]/u;

function isResourceEntry(kind: PiResourceKind, path: string): boolean {
  const extension = extname(path).toLowerCase();
  switch (kind) {
    case "extension":
      return extensionFileExtensions.has(extension) && !path.endsWith(".d.ts");
    case "skill":
      return path.endsWith("/SKILL.md") || path === "SKILL.md";
    case "prompt":
      return extension === ".md";
    case "theme":
      return extension === ".json";
  }
}

function isSafeManifestPattern(pattern: string): boolean {
  if (isAbsolute(pattern)) {
    return false;
  }
  return !normalizePiSourcePath(pattern).split("/").includes("..");
}

async function expandPositivePattern(
  rootPath: string,
  declarationPath: string,
): Promise<string[] | PiResourceDiscoveryFailure> {
  const normalizedPath = normalizePiSourcePath(declarationPath).replace(/^\.\//u, "");
  if (globMagic.test(normalizedPath)) {
    return [normalizedPath];
  }

  const absolutePath = resolvePiSourcePath(rootPath, normalizedPath);
  if (absolutePath === undefined) {
    return {
      code: "RESOURCE_PATH_OUTSIDE_ROOT",
      path: declarationPath,
      message: `Pi resource path escapes package root: ${declarationPath}`,
    };
  }

  try {
    const pathStat = await stat(absolutePath);
    if (pathStat.isDirectory()) {
      return [normalizedPath === "." || normalizedPath.length === 0 ? "**/*" : `${normalizedPath}/**/*`];
    }
    if (pathStat.isFile()) {
      return [normalizedPath];
    }
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return {
      code: "RESOURCE_PATH_MISSING",
      path: declarationPath,
      message: `Pi resource path cannot be read: ${declarationPath}: ${cause}`,
    };
  }

  return {
    code: "RESOURCE_PATH_MISSING",
    path: declarationPath,
    message: `Pi resource path is not a regular file or directory: ${declarationPath}`,
  };
}

/** Discovers manifest paths, manifest globs, exclusions, and convention resources without importing source. */
export async function discoverPiResources(
  rootPath: string,
  declarations: readonly PiResourceDeclaration[],
): Promise<DiscoveredPiResources | PiResourceDiscoveryFailure> {
  const resources = new Map<string, PiResource>();
  const analyzedPaths = new Set<string>();
  const declarationsByKind = new Map<PiResourceKind, PiResourceDeclaration[]>();

  for (const declaration of declarations) {
    const entries = declarationsByKind.get(declaration.kind) ?? [];
    entries.push(declaration);
    declarationsByKind.set(declaration.kind, entries);
  }

  for (const [kind, kindDeclarations] of declarationsByKind) {
    const positivePatterns: string[] = [];
    const negativePatterns: string[] = [];

    for (const declaration of kindDeclarations) {
      const excluded = declaration.path.startsWith("!");
      const rawPattern = excluded ? declaration.path.slice(1) : declaration.path;
      if (!isSafeManifestPattern(rawPattern)) {
        return {
          code: "RESOURCE_PATH_OUTSIDE_ROOT",
          path: declaration.path,
          message: `Pi resource path escapes package root: ${declaration.path}`,
        };
      }
      if (excluded) {
        negativePatterns.push(`!${normalizePiSourcePath(rawPattern).replace(/^\.\//u, "")}`);
        continue;
      }

      const expanded = await expandPositivePattern(rootPath, rawPattern);
      if (!Array.isArray(expanded)) {
        return expanded;
      }
      positivePatterns.push(...expanded);
    }

    if (positivePatterns.length === 0) {
      continue;
    }

    const matchedPaths = await glob([...positivePatterns, ...negativePatterns], {
      cwd: rootPath,
      absolute: true,
      dot: true,
      onlyFiles: true,
      followSymbolicLinks: false,
    });

    for (const absolutePath of matchedPaths) {
      const relativePath = relativePiSourcePath(rootPath, absolutePath);
      analyzedPaths.add(relativePath);
      if (isResourceEntry(kind, relativePath)) {
        resources.set(`${kind}:${relativePath}`, { kind, path: relativePath });
      }
    }
  }

  return {
    resources: [...resources.values()].sort(
      (left, right) => compareLexicalText(left.path, right.path) || compareLexicalText(left.kind, right.kind),
    ),
    analyzedPaths: [...analyzedPaths].sort(compareLexicalText),
  };
}
