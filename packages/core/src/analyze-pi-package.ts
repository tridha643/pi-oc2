import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentSkill,
  CapabilityFinding,
  PiCapabilityKind,
  PiExtensionAnalysis,
  PiPackageAnalysis,
  PiResource,
} from "./core-domain.js";
import { coreFailure, coreSuccess, type CoreResult } from "./core-result.js";
import { parseAgentSkill, type AgentSkillFailure } from "./agent-skill.js";
import { analyzePiExtensionAst } from "./analyze-pi-extension-ast.js";
import { parsePiPackageSource, type PiPackageSourceFailure } from "./pi-package-source.js";
import { computePiSourceHash } from "./source-hash.js";
import { compareLexicalText } from "./pi-source-paths.js";

/** An expected package analysis failure from source discovery, skill parsing, or file I/O. */
export type PiPackageAnalysisFailure =
  | PiPackageSourceFailure
  | AgentSkillFailure
  | { readonly code: "ANALYZED_FILE_UNREADABLE"; readonly path: string; readonly message: string };

function resourceFinding(resource: PiResource, symbol?: string): CapabilityFinding | undefined {
  const capabilityByKind: Partial<Record<PiResource["kind"], PiCapabilityKind>> = {
    skill: "skill",
    prompt: "prompt",
    theme: "theme",
  };
  const classificationByKind = {
    skill: "direct",
    prompt: "scaffold",
    theme: "unsupported",
  } as const;
  const capability = capabilityByKind[resource.kind];
  if (capability === undefined || resource.kind === "extension") {
    return undefined;
  }
  const classification = classificationByKind[resource.kind];
  return {
    id: `${capability}:${symbol ?? resource.path}:${resource.path}:1:1`,
    capability,
    classification,
    required: true,
    message:
      resource.kind === "skill"
        ? "Skill resource can be copied directly to native targets."
        : resource.kind === "prompt"
          ? "Prompt resource requires an explicit target resource mapping."
          : "Pi theme resource has no native first-slice mapping.",
    source: { path: resource.path, line: 1, column: 1 },
    ...(symbol === undefined ? {} : { symbol }),
  };
}

/** Performs complete syntax-only analysis of a Pi package root or bare SKILL.md directory. */
export async function analyzePiPackage(
  sourcePath: string,
): Promise<CoreResult<PiPackageAnalysis, PiPackageAnalysisFailure>> {
  const parsedSource = await parsePiPackageSource(sourcePath);
  if (!parsedSource.ok) {
    return parsedSource;
  }
  const source = parsedSource.value;

  let sourceIdentity;
  try {
    sourceIdentity = await computePiSourceHash(source.rootPath, source.analyzedPaths);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return coreFailure({
      code: "ANALYZED_FILE_UNREADABLE",
      path: source.rootPath,
      message: `Analyzed source file cannot be read: ${cause}`,
    });
  }

  const extensions: PiExtensionAnalysis[] = [];
  const skills: AgentSkill[] = [];
  const findings: CapabilityFinding[] = [];
  for (const resource of source.resources) {
    let sourceText: string;
    try {
      sourceText = await readFile(join(source.rootPath, resource.path), "utf8");
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      return coreFailure({
        code: "ANALYZED_FILE_UNREADABLE",
        path: resource.path,
        message: `Analyzed source file cannot be read: ${resource.path}: ${cause}`,
      });
    }

    if (resource.kind === "extension") {
      const extension = analyzePiExtensionAst(resource.path, sourceText);
      extensions.push(extension);
      findings.push(...extension.findings);
    } else if (resource.kind === "skill") {
      const skill = parseAgentSkill(resource.path, sourceText);
      if (!skill.ok) {
        return skill;
      }
      skills.push(skill.value);
      const skillFinding = resourceFinding(resource, skill.value.name);
      if (skillFinding !== undefined) {
        findings.push(skillFinding);
      }
    } else {
      const finding = resourceFinding(resource);
      if (finding !== undefined) {
        findings.push(finding);
      }
    }
  }

  extensions.sort((left, right) => compareLexicalText(left.path, right.path));
  skills.sort((left, right) => compareLexicalText(left.path, right.path));
  findings.sort((left, right) => compareLexicalText(left.id, right.id));
  return coreSuccess({
    schemaVersion: 1,
    packageName: source.packageName,
    sourceKind: source.kind,
    sourceHash: sourceIdentity.sourceHash,
    files: sourceIdentity.files,
    resources: source.resources,
    extensions,
    skills,
    findings,
  });
}
