import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { CapabilityFinding, PiToolAnalysis } from "@pi-oc2/core/domain";
import {
  openCode2PortableTargetPath,
  prepareOpenCode2PortableModules,
} from "./copy-opencode2-portable-modules.js";
import {
  emitOpenCode2ConfigPatch,
  emitOpenCode2PackageJson,
  emitOpenCode2Server,
  emitOpenCode2Tui,
  OPENCODE2_TARGET_PROFILE,
  type OpenCode2PreparedSkill,
  type OpenCode2PreparedTool,
} from "./opencode2-emission.js";
import type {
  GenerateOpenCode2TargetInput,
  GenerateOpenCode2TargetResult,
  OpenCode2TargetFailure,
} from "./opencode2-target-domain.js";

interface OpenCode2SkillCopy {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly contents: Uint8Array;
  readonly name: string;
  readonly description?: string;
  readonly content: string;
}

interface OpenCode2ResolvedTool {
  readonly name: string;
  readonly description: string;
  readonly schema: NonNullable<PiToolAnalysis["schema"]>;
  readonly executorSourcePath: string;
}

function failure(error: OpenCode2TargetFailure): GenerateOpenCode2TargetResult {
  return { ok: false, error };
}

function compareLexicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedRelativePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function pathStaysInside(root: string, relativePath: string): boolean {
  if (relativePath.length === 0 || isAbsolute(relativePath)) return false;
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(root, relativePath);
  const fromRoot = relative(resolvedRoot, resolvedPath);
  return fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

function toolFinding(findings: readonly CapabilityFinding[], tool: PiToolAnalysis): CapabilityFinding | undefined {
  return findings.find(
    (finding) =>
      finding.capability === "tool" &&
      finding.symbol === tool.name &&
      finding.source.path === tool.source.path &&
      finding.source.line === tool.source.line &&
      finding.source.column === tool.source.column,
  );
}

async function regularFileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function prepareOpenCode2Tools(
  input: GenerateOpenCode2TargetInput,
): Promise<{ readonly ok: true; readonly tools: readonly OpenCode2ResolvedTool[] } | { readonly ok: false; readonly error: OpenCode2TargetFailure }> {
  const resolutions = new Map(input.resolvedCapabilities.capabilities.map((entry) => [entry.capabilityId, entry]));
  const prepared: OpenCode2ResolvedTool[] = [];
  const names = new Set<string>();
  const tools = input.analysis.extensions.flatMap((extension) => extension.tools);

  for (const tool of tools) {
    if (tool.name === undefined || tool.name.trim().length === 0) {
      return {
        ok: false,
        error: {
          code: "OPENCODE2_TOOL_NAME_MISSING",
          message: `OpenCode 2 cannot generate a tool without a static name: ${tool.source.path}:${tool.source.line}`,
          sourcePath: tool.source.path,
          sourceLine: tool.source.line,
        },
      };
    }
    const finding = toolFinding(input.analysis.findings, tool);
    const resolution = finding === undefined ? undefined : resolutions.get(finding.id);
    if (resolution?.resolution === "waived") continue;
    if (names.has(tool.name)) {
      return {
        ok: false,
        error: {
          code: "OPENCODE2_TOOL_NAME_DUPLICATE",
          message: `OpenCode 2 Promise tools cannot contain duplicate tool name: ${tool.name}`,
          toolName: tool.name,
        },
      };
    }
    names.add(tool.name);

    if (finding === undefined || resolution?.resolution !== "manual" || resolution.module === undefined) {
      return {
        ok: false,
        error: {
          code: "OPENCODE2_TOOL_EXECUTOR_MISSING",
          message: `OpenCode 2 tool requires a resolved manual portable executor: ${tool.name}`,
          toolName: tool.name,
          ...(finding === undefined ? {} : { capabilityId: finding.id }),
        },
      };
    }
    if (!(await regularFileExists(join(input.portRoot, resolution.module)))) {
      return {
        ok: false,
        error: {
          code: "OPENCODE2_TOOL_EXECUTOR_MISSING",
          message: `OpenCode 2 portable executor file is missing: ${resolution.module}`,
          toolName: tool.name,
          capabilityId: finding.id,
          module: resolution.module,
        },
      };
    }
    if (tool.schemaStatus !== "supported" || tool.schema === undefined) {
      return {
        ok: false,
        error: {
          code: "OPENCODE2_TOOL_SCHEMA_MISSING",
          message: `OpenCode 2 tool requires a supported static schema: ${tool.name}`,
          toolName: tool.name,
        },
      };
    }
    prepared.push({
      name: tool.name,
      description: tool.description ?? tool.name,
      schema: tool.schema,
      executorSourcePath: normalizedRelativePath(resolution.module),
    });
  }

  prepared.sort((left, right) => compareLexicalText(left.name, right.name));
  return { ok: true, tools: prepared };
}

async function prepareOpenCode2TuiOverrides(
  input: GenerateOpenCode2TargetInput,
): Promise<{ readonly ok: true; readonly modules: readonly string[] } | { readonly ok: false; readonly error: OpenCode2TargetFailure }> {
  const resolutions = new Map(input.resolvedCapabilities.capabilities.map((entry) => [entry.capabilityId, entry]));
  const modules = new Set<string>();
  for (const finding of input.analysis.findings.filter((entry) => entry.capability === "ui")) {
    const resolution = resolutions.get(finding.id);
    if (resolution?.resolution === "waived") continue;
    if (resolution?.resolution !== "manual" || resolution.module === undefined) {
      return {
        ok: false,
        error: {
          code: "OPENCODE2_UNSUPPORTED_TARGET_FEATURE",
          message: `OpenCode 2 UI behavior requires a target-specific manual override: ${finding.id}`,
          capabilityId: finding.id,
          capability: "ui",
        },
      };
    }
    if (!(await regularFileExists(join(input.portRoot, resolution.module)))) {
      return {
        ok: false,
        error: {
          code: "OPENCODE2_TARGET_OVERRIDE_MISSING",
          message: `OpenCode 2 target UI override file is missing: ${resolution.module}`,
          capabilityId: finding.id,
          module: resolution.module,
        },
      };
    }
    modules.add(normalizedRelativePath(resolution.module));
  }
  return { ok: true, modules: [...modules].sort(compareLexicalText) };
}

function prepareOpenCode2ToolEmissions(tools: readonly OpenCode2ResolvedTool[]): readonly OpenCode2PreparedTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    schema: tool.schema,
    executorTargetPath: openCode2PortableTargetPath(tool.executorSourcePath),
  }));
}

function prepareOpenCode2SkillEmissions(skills: readonly OpenCode2SkillCopy[]): readonly OpenCode2PreparedSkill[] {
  return skills.map((skill) => ({
    name: skill.name,
    ...(skill.description === undefined ? {} : { description: skill.description }),
    targetPath: skill.targetPath,
    content: skill.content,
  }));
}

function unsupportedTargetFeature(input: GenerateOpenCode2TargetInput): OpenCode2TargetFailure | undefined {
  const resolutions = new Map(input.resolvedCapabilities.capabilities.map((entry) => [entry.capabilityId, entry]));
  const supportedCapabilities = new Set(["extension-factory", "skill", "tool", "ui", "computed-schema", "unsupported-schema"]);
  for (const finding of input.analysis.findings) {
    if (resolutions.get(finding.id)?.resolution === "waived" || supportedCapabilities.has(finding.capability)) continue;
    return {
      code: "OPENCODE2_UNSUPPORTED_TARGET_FEATURE",
      message: `OpenCode 2 target does not implement capability ${finding.capability}: ${finding.id}`,
      capabilityId: finding.id,
      capability: finding.capability,
    };
  }
  return undefined;
}

async function prepareOpenCode2Skills(
  input: GenerateOpenCode2TargetInput,
): Promise<{ readonly ok: true; readonly skills: readonly OpenCode2SkillCopy[] } | { readonly ok: false; readonly error: OpenCode2TargetFailure }> {
  const targets = new Set<string>();
  const skills: OpenCode2SkillCopy[] = [];
  for (const skill of [...input.analysis.skills].sort((left, right) => compareLexicalText(left.path, right.path))) {
    const sourcePath = normalizedRelativePath(skill.path);
    const targetPath = `skills/${skill.name}/SKILL.md`;
    if (!pathStaysInside(input.outputRoot, targetPath)) {
      return {
        ok: false,
        error: {
          code: "OPENCODE2_SKILL_TARGET_INVALID",
          message: `OpenCode 2 skill target must remain inside the generated target: ${targetPath}`,
          skillPath: targetPath,
        },
      };
    }
    if (targets.has(targetPath)) {
      return {
        ok: false,
        error: {
          code: "OPENCODE2_SKILL_TARGET_DUPLICATE",
          message: `OpenCode 2 skill target is duplicated: ${targetPath}`,
          skillPath: targetPath,
        },
      };
    }
    targets.add(targetPath);
    try {
      skills.push({
        sourcePath,
        targetPath,
        contents: await readFile(join(input.portRoot, sourcePath)),
        name: skill.name,
        ...(skill.description === undefined ? {} : { description: skill.description }),
        content: skill.body,
      });
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: {
          code: "OPENCODE2_SKILL_SOURCE_MISSING",
          message: `OpenCode 2 skill source cannot be read: ${sourcePath}: ${cause}`,
          skillPath: sourcePath,
        },
      };
    }
  }
  skills.sort((left, right) => compareLexicalText(left.targetPath, right.targetPath));
  return { ok: true, skills };
}

function insertOpenCode2TargetFile(
  files: Map<string, string | Uint8Array>,
  owners: Map<string, string>,
  targetPath: string,
  contents: string | Uint8Array,
  owner: string,
): OpenCode2TargetFailure | undefined {
  const existingOwner = owners.get(targetPath);
  if (existingOwner !== undefined) {
    return {
      code: "OPENCODE2_TARGET_PATH_COLLISION",
      message: `OpenCode 2 generated target path has multiple owners: ${targetPath}: ${existingOwner}, ${owner}`,
      targetPath,
      sourcePaths: [existingOwner, owner],
    };
  }
  files.set(targetPath, contents);
  owners.set(targetPath, owner);
  return undefined;
}

async function writeOpenCode2Target(
  input: GenerateOpenCode2TargetInput,
  files: ReadonlyMap<string, string | Uint8Array>,
): Promise<GenerateOpenCode2TargetResult> {
  const targetRoot = join(input.outputRoot, "generated", "opencode2");
  let temporaryRoot: string | undefined;
  try {
    await mkdir(input.outputRoot, { recursive: true });
    temporaryRoot = await mkdtemp(join(input.outputRoot, ".pioc-opencode2-"));
    for (const [path, contents] of [...files].sort(([left], [right]) => compareLexicalText(left, right))) {
      const outputPath = join(temporaryRoot, path);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, contents);
    }
    await mkdir(dirname(targetRoot), { recursive: true });
    await rm(targetRoot, { recursive: true, force: true });
    await rename(temporaryRoot, targetRoot);
    return {
      ok: true,
      value: {
        targetRoot,
        files: [...files.keys()].sort(compareLexicalText),
        targetProfile: OPENCODE2_TARGET_PROFILE,
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    if (temporaryRoot !== undefined) {
      await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    return failure({
      code: "OPENCODE2_WRITE_FAILED",
      message: `OpenCode 2 target could not be written: ${targetRoot}: ${cause}`,
      path: targetRoot,
    });
  }
}

/** Generates `generated/opencode2` from validated analysis, manifest, and capability resolution inputs. */
export async function generateOpenCode2Target(input: GenerateOpenCode2TargetInput): Promise<GenerateOpenCode2TargetResult> {
  const unsupported = unsupportedTargetFeature(input);
  if (unsupported !== undefined) return failure(unsupported);

  const tools = await prepareOpenCode2Tools(input);
  if (!tools.ok) return failure(tools.error);
  const tuiOverrides = await prepareOpenCode2TuiOverrides(input);
  if (!tuiOverrides.ok) return failure(tuiOverrides.error);
  const skills = await prepareOpenCode2Skills(input);
  if (!skills.ok) return failure(skills.error);
  const portableModules = await prepareOpenCode2PortableModules(input.portRoot, [
    ...tools.tools.map((tool) => tool.executorSourcePath),
    ...tuiOverrides.modules,
  ]);
  if (!portableModules.ok) return failure(portableModules.error);

  const server = emitOpenCode2Server(
    input.manifest.plugin.id,
    input.analysis.sourceHash,
    prepareOpenCode2ToolEmissions(tools.tools),
    prepareOpenCode2SkillEmissions(skills.skills),
  );
  if (!server.ok) {
    return failure({
      code: "OPENCODE2_TOOL_SCHEMA_UNSUPPORTED",
      message: `OpenCode 2 cannot render schema for tool ${server.toolName}: ${server.message}`,
      toolName: server.toolName,
    });
  }

  const files = new Map<string, string | Uint8Array>();
  const owners = new Map<string, string>();
  const generatedFiles = [
    ["opencode.jsonc.patch", emitOpenCode2ConfigPatch()],
    ["package.json", emitOpenCode2PackageJson(input.manifest.plugin.id, input.analysis.sourceHash)],
    ["server.ts", server.source],
    [
      "tui.ts",
      emitOpenCode2Tui(
        input.manifest.plugin.id,
        input.analysis.sourceHash,
        tuiOverrides.modules.map(openCode2PortableTargetPath),
      ),
    ],
  ] as const;
  for (const [targetPath, contents] of generatedFiles) {
    const collision = insertOpenCode2TargetFile(files, owners, targetPath, contents, `<generated ${targetPath}>`);
    if (collision !== undefined) return failure(collision);
  }
  for (const portableModule of portableModules.modules) {
    const collision = insertOpenCode2TargetFile(
      files,
      owners,
      portableModule.targetPath,
      portableModule.contents,
      portableModule.sourcePath,
    );
    if (collision !== undefined) return failure(collision);
  }
  for (const skill of skills.skills) {
    const collision = insertOpenCode2TargetFile(files, owners, skill.targetPath, skill.contents, skill.sourcePath);
    if (collision !== undefined) return failure(collision);
  }
  return writeOpenCode2Target(input, files);
}
