import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { PiPackageSource, PiResourceKind } from "./core-domain.js";
import { coreFailure, coreSuccess, type CoreResult } from "./core-result.js";
import {
  discoverPiResources,
  type PiResourceDeclaration,
  type PiResourceDiscoveryFailure,
} from "./discover-pi-resources.js";
import { compareLexicalText } from "./pi-source-paths.js";

/** A stable source parsing error suitable for CLI diagnostics. */
export interface PiPackageSourceFailure {
  readonly code:
    | "SOURCE_NOT_DIRECTORY"
    | "SOURCE_NOT_PI_PACKAGE"
    | "PACKAGE_JSON_INVALID"
    | "PI_MANIFEST_INVALID"
    | PiResourceDiscoveryFailure["code"];
  readonly path: string;
  readonly message: string;
}

interface PackageJsonShape {
  readonly name?: unknown;
  readonly pi?: unknown;
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const manifestFields: Readonly<Record<string, PiResourceKind>> = {
  extensions: "extension",
  skills: "skill",
  prompts: "prompt",
  themes: "theme",
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function parseManifestDeclarations(
  packageJson: PackageJsonShape,
): CoreResult<readonly PiResourceDeclaration[], PiPackageSourceFailure> {
  if (packageJson.pi === undefined) {
    return coreSuccess([]);
  }
  if (!isUnknownRecord(packageJson.pi)) {
    return coreFailure({
      code: "PI_MANIFEST_INVALID",
      path: "package.json",
      message: "Pi package manifest must be an object at package.json#pi.",
    });
  }

  const manifest = packageJson.pi;
  const declarations: PiResourceDeclaration[] = [];
  for (const [field, kind] of Object.entries(manifestFields)) {
    const entries = manifest[field];
    if (entries === undefined) {
      continue;
    }
    if (!Array.isArray(entries)) {
      return coreFailure({
        code: "PI_MANIFEST_INVALID",
        path: "package.json",
        message: `Pi package manifest field pi.${field} must be an array of relative paths.`,
      });
    }
    for (const path of entries) {
      if (typeof path !== "string") {
        return coreFailure({
          code: "PI_MANIFEST_INVALID",
          path: "package.json",
          message: `Pi package manifest field pi.${field} must be an array of relative paths.`,
        });
      }
      declarations.push({ kind, path });
    }
  }
  return coreSuccess(declarations);
}

async function conventionDeclarations(rootPath: string): Promise<readonly PiResourceDeclaration[]> {
  const conventions: readonly PiResourceDeclaration[] = [
    { kind: "extension", path: "extensions" },
    { kind: "skill", path: "skills" },
    { kind: "prompt", path: "prompts" },
    { kind: "theme", path: "themes" },
  ];
  const results: PiResourceDeclaration[] = [];
  for (const convention of conventions) {
    if (await pathExists(join(rootPath, convention.path))) {
      results.push(convention);
    }
  }
  return results;
}

/** Parses a Pi package root or bare SKILL.md directory without loading extension code. */
export async function parsePiPackageSource(
  sourcePath: string,
): Promise<CoreResult<PiPackageSource, PiPackageSourceFailure>> {
  const rootPath = resolve(sourcePath);
  try {
    if (!(await stat(rootPath)).isDirectory()) {
      return coreFailure({
        code: "SOURCE_NOT_DIRECTORY",
        path: sourcePath,
        message: `Pi source must be a directory: ${sourcePath}`,
      });
    }
  } catch {
    return coreFailure({
      code: "SOURCE_NOT_DIRECTORY",
      path: sourcePath,
      message: `Pi source directory does not exist: ${sourcePath}`,
    });
  }

  const packageJsonPath = join(rootPath, "package.json");
  const skillPath = join(rootPath, "SKILL.md");
  if (!(await pathExists(packageJsonPath))) {
    if (!(await pathExists(skillPath))) {
      return coreFailure({
        code: "SOURCE_NOT_PI_PACKAGE",
        path: sourcePath,
        message: `Pi source has neither package.json nor SKILL.md: ${sourcePath}`,
      });
    }
    const discovered = await discoverPiResources(rootPath, [{ kind: "skill", path: "." }]);
    if ("code" in discovered) {
      return coreFailure(discovered);
    }
    return coreSuccess({
      kind: "bare-skill",
      rootPath,
      packageName: basename(rootPath),
      resources: discovered.resources,
      analyzedPaths: discovered.analyzedPaths,
    });
  }

  let parsedPackageJson: unknown;
  try {
    parsedPackageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return coreFailure({
      code: "PACKAGE_JSON_INVALID",
      path: "package.json",
      message: `Pi package package.json is invalid JSON: ${cause}`,
    });
  }
  if (!isUnknownRecord(parsedPackageJson)) {
    return coreFailure({
      code: "PACKAGE_JSON_INVALID",
      path: "package.json",
      message: "Pi package package.json must contain a JSON object.",
    });
  }
  const packageJson: PackageJsonShape = parsedPackageJson;

  const manifestDeclarations = parseManifestDeclarations(packageJson);
  if (!manifestDeclarations.ok) {
    return manifestDeclarations;
  }
  const declarations =
    packageJson.pi === undefined ? await conventionDeclarations(rootPath) : manifestDeclarations.value;
  const discovered = await discoverPiResources(rootPath, declarations);
  if ("code" in discovered) {
    return coreFailure(discovered);
  }

  const packageName = typeof packageJson.name === "string" && packageJson.name.length > 0 ? packageJson.name : basename(rootPath);
  return coreSuccess({
    kind: "package",
    rootPath,
    packageName,
    manifestPath: "package.json",
    resources: discovered.resources,
    analyzedPaths: ["package.json", ...discovered.analyzedPaths].sort(compareLexicalText),
  });
}
