import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { PiPackageAnalysis } from "@pi-oc2/core";
import type { PortabilityManifest } from "@pi-oc2/core/manifest";

/** One skill file ready to be copied into the generated Pi package. */
export interface PreparedPiSkill {
  readonly targetPath: string;
  readonly bytes: Uint8Array;
}

/** An expected skill resource preparation failure. */
export interface PiSkillPreparationFailure {
  readonly code: "PI_TARGET_SKILL_PATH_UNSUPPORTED" | "PI_TARGET_SKILL_DUPLICATE" | "PI_TARGET_SKILL_UNREADABLE";
  readonly path: string;
  readonly message: string;
}

function portableRelativePath(path: string): string | undefined {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  return normalized.length > 0 && !isAbsolute(path) && !normalized.split("/").includes("..") ? normalized : undefined;
}

function compareLexicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function skillTargetPath(skillPath: string, manifest: PortabilityManifest): string {
  return manifest.resourceMappings?.find((mapping) => mapping.kind === "skill" && mapping.sourcePath === skillPath)?.targetPath ?? skillPath;
}

/** Reads source skills in lexical target order without changing their bytes. */
export async function preparePiSkills(
  analysis: PiPackageAnalysis,
  manifest: PortabilityManifest,
  portRoot: string,
): Promise<{ readonly ok: true; readonly value: readonly PreparedPiSkill[] } | { readonly ok: false; readonly error: PiSkillPreparationFailure }> {
  const plans = analysis.skills
    .map((skill) => ({ sourcePath: skill.path, targetPath: skillTargetPath(skill.path, manifest) }))
    .sort((left, right) => compareLexicalText(left.targetPath, right.targetPath));
  const seenTargets = new Set<string>();
  const prepared: PreparedPiSkill[] = [];

  for (const plan of plans) {
    const sourcePath = portableRelativePath(plan.sourcePath);
    const targetPath = portableRelativePath(plan.targetPath);
    if (sourcePath === undefined || targetPath === undefined || !targetPath.endsWith("SKILL.md")) {
      return {
        ok: false,
        error: {
          code: "PI_TARGET_SKILL_PATH_UNSUPPORTED",
          path: plan.targetPath,
          message: `Pi target skill path must be a relative SKILL.md path: ${plan.targetPath}`,
        },
      };
    }
    if (seenTargets.has(targetPath)) {
      return {
        ok: false,
        error: {
          code: "PI_TARGET_SKILL_DUPLICATE",
          path: targetPath,
          message: `Pi target skill mappings collide at: ${targetPath}`,
        },
      };
    }
    seenTargets.add(targetPath);

    const absoluteSourcePath = resolve(portRoot, sourcePath);
    if (!absoluteSourcePath.startsWith(`${resolve(portRoot)}${sep}`)) {
      return {
        ok: false,
        error: {
          code: "PI_TARGET_SKILL_PATH_UNSUPPORTED",
          path: sourcePath,
          message: `Pi target skill source escapes the port root: ${sourcePath}`,
        },
      };
    }
    try {
      prepared.push({ targetPath, bytes: await readFile(absoluteSourcePath) });
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: {
          code: "PI_TARGET_SKILL_UNREADABLE",
          path: sourcePath,
          message: `Pi target skill cannot be read: ${sourcePath}: ${cause}`,
        },
      };
    }
  }
  return { ok: true, value: prepared };
}
