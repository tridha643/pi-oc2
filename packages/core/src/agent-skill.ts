import { parseDocument } from "yaml";
import type { AgentSkill, JsonPrimitive } from "./core-domain.js";
import { coreFailure, coreSuccess, type CoreResult } from "./core-result.js";

/** An expected Agent Skill parsing failure with a stable diagnostic code. */
export interface AgentSkillFailure {
  readonly code: "SKILL_FRONTMATTER_MISSING" | "SKILL_FRONTMATTER_INVALID" | "SKILL_FIELD_INVALID";
  readonly path: string;
  readonly message: string;
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function allowedTools(value: unknown): readonly string[] | undefined {
  if (typeof value === "string") {
    return value.split(/\s+/u).filter((tool) => tool.length > 0);
  }
  if (Array.isArray(value) && value.every((tool) => typeof tool === "string")) {
    return value;
  }
  return undefined;
}

function primitiveMetadata(value: unknown): Readonly<Record<string, JsonPrimitive>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isUnknownRecord(value)) {
    return undefined;
  }
  const metadata: Record<string, JsonPrimitive> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null || typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      metadata[key] = entry;
    } else {
      return undefined;
    }
  }
  return metadata;
}

/** Parses SKILL.md YAML frontmatter while preserving the Markdown body verbatim. */
export function parseAgentSkill(path: string, sourceText: string): CoreResult<AgentSkill, AgentSkillFailure> {
  const match = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(sourceText);
  if (match === null) {
    return coreFailure({
      code: "SKILL_FRONTMATTER_MISSING",
      path,
      message: `Agent Skill is missing leading YAML frontmatter: ${path}`,
    });
  }

  const frontmatterSource = match[1] ?? "";
  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(frontmatterSource, { uniqueKeys: true });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return coreFailure({
      code: "SKILL_FRONTMATTER_INVALID",
      path,
      message: `Agent Skill frontmatter is invalid YAML: ${path}: ${cause}`,
    });
  }
  if (document.errors.length > 0) {
    return coreFailure({
      code: "SKILL_FRONTMATTER_INVALID",
      path,
      message: `Agent Skill frontmatter is invalid YAML: ${path}: ${document.errors[0]?.message ?? "unknown error"}`,
    });
  }
  let frontmatter: unknown;
  try {
    frontmatter = document.toJS();
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return coreFailure({
      code: "SKILL_FRONTMATTER_INVALID",
      path,
      message: `Agent Skill frontmatter cannot be converted safely: ${path}: ${cause}`,
    });
  }
  if (!isUnknownRecord(frontmatter)) {
    return coreFailure({
      code: "SKILL_FRONTMATTER_INVALID",
      path,
      message: `Agent Skill frontmatter must be a mapping: ${path}`,
    });
  }

  const fields = frontmatter;
  if (typeof fields.name !== "string" || fields.name.trim().length === 0 || typeof fields.description !== "string" || fields.description.trim().length === 0) {
    return coreFailure({
      code: "SKILL_FIELD_INVALID",
      path,
      message: `Agent Skill requires non-empty string fields name and description: ${path}`,
    });
  }
  const parsedAllowedTools = allowedTools(fields["allowed-tools"] ?? fields.allowedTools);
  if ((fields["allowed-tools"] !== undefined || fields.allowedTools !== undefined) && parsedAllowedTools === undefined) {
    return coreFailure({
      code: "SKILL_FIELD_INVALID",
      path,
      message: `Agent Skill allowed-tools must be a string or string array: ${path}`,
    });
  }
  const metadata = primitiveMetadata(fields.metadata);
  if (fields.metadata !== undefined && metadata === undefined) {
    return coreFailure({
      code: "SKILL_FIELD_INVALID",
      path,
      message: `Agent Skill metadata values must be JSON primitives: ${path}`,
    });
  }
  if (fields.license !== undefined && typeof fields.license !== "string") {
    return coreFailure({ code: "SKILL_FIELD_INVALID", path, message: `Agent Skill license must be a string: ${path}` });
  }
  if (fields.compatibility !== undefined && typeof fields.compatibility !== "string") {
    return coreFailure({ code: "SKILL_FIELD_INVALID", path, message: `Agent Skill compatibility must be a string: ${path}` });
  }

  return coreSuccess({
    path,
    name: fields.name,
    description: fields.description,
    ...(typeof fields.license === "string" ? { license: fields.license } : {}),
    ...(typeof fields.compatibility === "string" ? { compatibility: fields.compatibility } : {}),
    ...(parsedAllowedTools === undefined ? {} : { allowedTools: parsedAllowedTools }),
    ...(metadata === undefined ? {} : { metadata }),
    body: sourceText.slice(match[0].length),
  });
}
