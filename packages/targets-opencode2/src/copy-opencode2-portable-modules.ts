import { readFile } from "node:fs/promises";
import { posix, resolve, sep, win32 } from "node:path";

/** One resolved portable module copied into the generated OpenCode 2 package. */
export interface OpenCode2PortableModuleCopy {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly contents: Uint8Array;
}

/** A fail-closed portable module path, read, or generated target collision. */
export type OpenCode2PortableModuleFailure =
  | {
      readonly code: "OPENCODE2_PORTABLE_MODULE_PATH_INVALID" | "OPENCODE2_PORTABLE_MODULE_UNREADABLE";
      readonly message: string;
      readonly sourcePath: string;
    }
  | {
      readonly code: "OPENCODE2_TARGET_PATH_COLLISION";
      readonly message: string;
      readonly targetPath: string;
      readonly sourcePaths: readonly [string, string];
    };

function compareLexicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizePortableSourcePath(path: string): string {
  return posix.normalize(path.replaceAll("\\", "/")).replace(/^\.\//u, "");
}

function portableModuleTargetPath(sourcePath: string): string {
  const packageRelativePath = sourcePath.startsWith("portable/") ? sourcePath.slice("portable/".length) : sourcePath;
  return `portable/${packageRelativePath}`;
}

function validPortableSourcePath(path: string): boolean {
  return path.length > 0 && !posix.isAbsolute(path) && !win32.isAbsolute(path) && !path.split("/").includes("..");
}

/** Copies resolved portable modules byte-for-byte under generated `portable/`, deduplicated in lexical order. */
export async function prepareOpenCode2PortableModules(
  portRoot: string,
  resolvedModulePaths: readonly string[],
): Promise<
  | { readonly ok: true; readonly modules: readonly OpenCode2PortableModuleCopy[] }
  | { readonly ok: false; readonly error: OpenCode2PortableModuleFailure }
> {
  for (const modulePath of resolvedModulePaths) {
    const slashPath = modulePath.replaceAll("\\", "/").replace(/^\.\//u, "");
    if (!validPortableSourcePath(slashPath)) {
      return {
        ok: false,
        error: {
          code: "OPENCODE2_PORTABLE_MODULE_PATH_INVALID",
          message: `OpenCode 2 portable module path must remain inside the port root: ${slashPath}`,
          sourcePath: slashPath,
        },
      };
    }
  }
  const sourcePaths = [...new Set(resolvedModulePaths.map(normalizePortableSourcePath))].sort(compareLexicalText);
  const sourceByTargetPath = new Map<string, string>();
  const modules: OpenCode2PortableModuleCopy[] = [];

  for (const sourcePath of sourcePaths) {
    const targetPath = portableModuleTargetPath(sourcePath);
    const existingSourcePath = sourceByTargetPath.get(targetPath);
    if (existingSourcePath !== undefined && existingSourcePath !== sourcePath) {
      return {
        ok: false,
        error: {
          code: "OPENCODE2_TARGET_PATH_COLLISION",
          message: `OpenCode 2 portable modules collide at generated target path ${targetPath}: ${existingSourcePath}, ${sourcePath}`,
          targetPath,
          sourcePaths: [existingSourcePath, sourcePath],
        },
      };
    }
    sourceByTargetPath.set(targetPath, sourcePath);

    const absoluteSourcePath = resolve(portRoot, sourcePath);
    if (!absoluteSourcePath.startsWith(`${resolve(portRoot)}${sep}`)) {
      return {
        ok: false,
        error: {
          code: "OPENCODE2_PORTABLE_MODULE_PATH_INVALID",
          message: `OpenCode 2 portable module path escapes the port root: ${sourcePath}`,
          sourcePath,
        },
      };
    }
    try {
      modules.push({ sourcePath, targetPath, contents: await readFile(absoluteSourcePath) });
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: {
          code: "OPENCODE2_PORTABLE_MODULE_UNREADABLE",
          message: `OpenCode 2 portable module cannot be read: ${sourcePath}: ${cause}`,
          sourcePath,
        },
      };
    }
  }

  modules.sort((left, right) => compareLexicalText(left.targetPath, right.targetPath));
  return { ok: true, modules };
}

/** Returns the generated package path for one validated portable source module. */
export function openCode2PortableTargetPath(sourcePath: string): string {
  return portableModuleTargetPath(normalizePortableSourcePath(sourcePath));
}
