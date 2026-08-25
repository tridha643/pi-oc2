import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, resolve, sep } from "node:path";
import type { PiPackageAnalysis, PiToolAnalysis, StaticJsonSchema } from "@pi-oc2/core";
import type { ResolvedPortCapabilities } from "@pi-oc2/core/capabilities";
import type { PortabilityManifest } from "@pi-oc2/core/manifest";
import { preparePiSkills, type PiSkillPreparationFailure, type PreparedPiSkill } from "./copy-pi-resources.js";
import { emitPiExtension, piExecutorImportSpecifier, type PiToolEmission } from "./emit-pi-extension.js";

/** All validated inputs needed to emit one native Pi package. */
export interface GeneratePiTargetInput {
  readonly analysis: PiPackageAnalysis;
  readonly manifest: PortabilityManifest;
  readonly resolvedCapabilities: ResolvedPortCapabilities;
  readonly portRoot: string;
  readonly outputRoot: string;
}

/** The generated Pi package root and its lexically ordered relative files. */
export interface GeneratedPiTarget {
  readonly targetRoot: string;
  readonly files: readonly string[];
}

/** An expected native Pi target generation failure with a stable diagnostic code. */
export type PiTargetGenerationFailure =
  | PiSkillPreparationFailure
  | {
      readonly code:
        | "PI_TARGET_SOURCE_MISMATCH"
        | "PI_TARGET_TOOL_NAME_UNSUPPORTED"
        | "PI_TARGET_TOOL_NAME_DUPLICATE"
        | "PI_TARGET_TOOL_SCHEMA_UNSUPPORTED"
        | "PI_TARGET_MANUAL_EXECUTOR_REQUIRED"
        | "PI_TARGET_MANUAL_EXECUTOR_PATH_UNSUPPORTED"
        | "PI_TARGET_MANUAL_EXECUTOR_UNREADABLE"
        | "PI_TARGET_PATH_COLLISION"
        | "PI_TARGET_WRITE_FAILED";
      readonly message: string;
      readonly toolName?: string;
      readonly path?: string;
    };

/** Tagged result returned for successful generation or expected fail-closed diagnostics. */
export type GeneratePiTargetResult =
  | { readonly ok: true; readonly value: GeneratedPiTarget }
  | { readonly ok: false; readonly error: PiTargetGenerationFailure };

const supportedToolName = /^[A-Za-z0-9_-]{1,64}$/u;

function compareLexicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function serializeStableJson(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (typeof entry === "object" && entry !== null) {
      return Object.fromEntries(
        Object.entries(entry)
          .sort(([left], [right]) => compareLexicalText(left, right))
          .map(([key, item]) => [key, normalize(item)]),
      );
    }
    return entry;
  };
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

function toolCapabilityId(analysis: PiPackageAnalysis, tool: PiToolAnalysis): string | undefined {
  return analysis.findings.find(
    (finding) =>
      finding.capability === "tool" &&
      finding.source.path === tool.source.path &&
      finding.source.line === tool.source.line &&
      finding.source.column === tool.source.column,
  )?.id;
}

interface PreparedPiExecutor {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly bytes: Uint8Array;
}

interface PreparedPiTools {
  readonly tools: readonly PiToolEmission[];
  readonly executors: readonly PreparedPiExecutor[];
}

interface PiExecutorPaths {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly importPath: string;
}

function piExecutorPaths(path: string): PiExecutorPaths | undefined {
  const withPortableSeparators = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (
    withPortableSeparators.length === 0 ||
    isAbsolute(path) ||
    withPortableSeparators.startsWith("/") ||
    withPortableSeparators.split("/").includes("..") ||
    /^[A-Za-z]:\//u.test(withPortableSeparators)
  ) {
    return undefined;
  }
  const sourcePath = posix.normalize(withPortableSeparators);
  if (sourcePath === "." || sourcePath === ".." || sourcePath.startsWith("../")) {
    return undefined;
  }
  const extension = /\.(?:cjs|cts|mjs|mts|tsx?|jsx?)$/u.exec(sourcePath)?.[0];
  if (extension === undefined) {
    return undefined;
  }
  const pathInsidePortable = sourcePath.startsWith("portable/") ? sourcePath.slice("portable/".length) : sourcePath;
  if (pathInsidePortable.length === 0) {
    return undefined;
  }
  const targetPath = `portable/${pathInsidePortable}`;
  return { sourcePath, targetPath, importPath: piExecutorImportSpecifier(targetPath).slice(2) };
}

function isEmittablePiSchema(schema: StaticJsonSchema): boolean {
  if (schema.enum !== undefined) return true;
  if (schema.anyOf !== undefined) return schema.anyOf.every(isEmittablePiSchema);
  switch (schema.type) {
    case "object":
      return Object.values(schema.properties ?? {}).every(isEmittablePiSchema);
    case "array":
      return schema.items !== undefined && isEmittablePiSchema(schema.items);
    case "string":
    case "number":
    case "integer":
    case "boolean":
      return true;
    case undefined:
      return false;
  }
  return false;
}

async function preparePiTools(
  input: GeneratePiTargetInput,
): Promise<
  | { readonly ok: true; readonly value: PreparedPiTools }
  | { readonly ok: false; readonly error: PiTargetGenerationFailure }
> {
  const tools = input.analysis.extensions
    .flatMap((extension) => extension.tools)
    .sort(
      (left, right) =>
        compareLexicalText(left.name ?? "", right.name ?? "") ||
        compareLexicalText(left.source.path, right.source.path) ||
        left.source.line - right.source.line ||
        left.source.column - right.source.column,
    );
  const seenNames = new Set<string>();
  const emissions: PiToolEmission[] = [];
  const executorsBySourcePath = new Map<string, PreparedPiExecutor>();
  const sourcePathByTargetPath = new Map<string, string>();
  const sourcePathByImportPath = new Map<string, string>();

  for (const tool of tools) {
    const capabilityId = toolCapabilityId(input.analysis, tool);
    const resolution = input.resolvedCapabilities.capabilities.find((entry) => entry.capabilityId === capabilityId);
    if (resolution?.resolution === "waived") {
      continue;
    }
    if (tool.name === undefined || !supportedToolName.test(tool.name)) {
      return {
        ok: false,
        error: {
          code: "PI_TARGET_TOOL_NAME_UNSUPPORTED",
          message: `Pi target tool name must be a static 1-64 character identifier: ${tool.name ?? "<computed>"}`,
          ...(tool.name === undefined ? {} : { toolName: tool.name }),
        },
      };
    }
    if (seenNames.has(tool.name)) {
      return {
        ok: false,
        error: {
          code: "PI_TARGET_TOOL_NAME_DUPLICATE",
          message: `Pi target tool names must be unique: ${tool.name}`,
          toolName: tool.name,
        },
      };
    }
    seenNames.add(tool.name);
    if (tool.schemaStatus !== "supported" || tool.schema === undefined || !isEmittablePiSchema(tool.schema)) {
      return {
        ok: false,
        error: {
          code: "PI_TARGET_TOOL_SCHEMA_UNSUPPORTED",
          message: `Pi target tool requires a supported static schema: ${tool.name}: ${tool.schemaStatus}`,
          toolName: tool.name,
        },
      };
    }
    if (capabilityId === undefined || resolution?.resolution !== "manual" || resolution.module === undefined) {
      return {
        ok: false,
        error: {
          code: "PI_TARGET_MANUAL_EXECUTOR_REQUIRED",
          message: `Pi target tool requires a resolved manual portable executor: ${tool.name}`,
          toolName: tool.name,
        },
      };
    }

    const executorPaths = piExecutorPaths(resolution.module);
    if (executorPaths === undefined) {
      return {
        ok: false,
        error: {
          code: "PI_TARGET_MANUAL_EXECUTOR_PATH_UNSUPPORTED",
          message: `Pi target manual executor path must remain inside the port root: ${resolution.module}`,
          toolName: tool.name,
          path: resolution.module,
        },
      };
    }
    const targetPathOwner = sourcePathByTargetPath.get(executorPaths.targetPath);
    const importPathOwner = sourcePathByImportPath.get(executorPaths.importPath);
    if (
      (targetPathOwner !== undefined && targetPathOwner !== executorPaths.sourcePath) ||
      (importPathOwner !== undefined && importPathOwner !== executorPaths.sourcePath)
    ) {
      const collisionPath = targetPathOwner === undefined ? executorPaths.importPath : executorPaths.targetPath;
      return {
        ok: false,
        error: {
          code: "PI_TARGET_PATH_COLLISION",
          message: `Pi target portable executors collide at: ${collisionPath}`,
          toolName: tool.name,
          path: collisionPath,
        },
      };
    }
    sourcePathByTargetPath.set(executorPaths.targetPath, executorPaths.sourcePath);
    sourcePathByImportPath.set(executorPaths.importPath, executorPaths.sourcePath);

    const absoluteModule = resolve(input.portRoot, executorPaths.sourcePath);
    if (!absoluteModule.startsWith(`${resolve(input.portRoot)}${sep}`)) {
      return {
        ok: false,
        error: {
          code: "PI_TARGET_MANUAL_EXECUTOR_PATH_UNSUPPORTED",
          message: `Pi target manual executor path escapes the port root: ${executorPaths.sourcePath}`,
          toolName: tool.name,
          path: executorPaths.sourcePath,
        },
      };
    }
    if (!executorsBySourcePath.has(executorPaths.sourcePath)) {
      try {
        executorsBySourcePath.set(executorPaths.sourcePath, {
          sourcePath: executorPaths.sourcePath,
          targetPath: executorPaths.targetPath,
          bytes: await readFile(absoluteModule),
        });
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          error: {
            code: "PI_TARGET_MANUAL_EXECUTOR_UNREADABLE",
            message: `Pi target manual executor cannot be read: ${executorPaths.sourcePath}: ${cause}`,
            toolName: tool.name,
            path: executorPaths.sourcePath,
          },
        };
      }
    }
    emissions.push({
      tool: { ...tool, name: tool.name, schema: tool.schema },
      executorTargetPath: executorPaths.targetPath,
    });
  }
  return {
    ok: true,
    value: {
      tools: emissions,
      executors: [...executorsBySourcePath.values()].sort((left, right) =>
        compareLexicalText(left.targetPath, right.targetPath),
      ),
    },
  };
}

function targetPathCollision(paths: readonly string[]): string | undefined {
  const sortedPaths = [...paths].sort(compareLexicalText);
  for (let ownerIndex = 0; ownerIndex < sortedPaths.length; ownerIndex += 1) {
    const ownerPath = sortedPaths[ownerIndex];
    if (ownerPath === undefined) continue;
    for (let candidateIndex = ownerIndex + 1; candidateIndex < sortedPaths.length; candidateIndex += 1) {
      const candidatePath = sortedPaths[candidateIndex];
      if (candidatePath !== undefined && (candidatePath === ownerPath || candidatePath.startsWith(`${ownerPath}/`))) {
        return candidatePath;
      }
    }
  }
  return undefined;
}

function generatedPackageName(pluginId: string): string {
  const segment = pluginId.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "plugin";
  return `@pi-oc2/generated-pi-${segment}`;
}

function generatedPackageJson(input: GeneratePiTargetInput, skills: readonly PreparedPiSkill[]): string {
  return serializeStableJson({
    name: generatedPackageName(input.manifest.plugin.id),
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies: { typebox: "1.3.7" },
    peerDependencies: { "@earendil-works/pi-coding-agent": "0.84.3" },
    pi: {
      extensions: ["./extension.ts"],
      skills: skills.map((skill) => `./${skill.targetPath}`),
    },
  });
}

/** Deterministically emits a native Pi package under outputRoot/generated/pi. */
export async function generatePiTarget(input: GeneratePiTargetInput): Promise<GeneratePiTargetResult> {
  if (input.analysis.packageName !== input.manifest.source.packageName || input.analysis.sourceHash !== input.manifest.source.sourceHash) {
    return {
      ok: false,
      error: {
        code: "PI_TARGET_SOURCE_MISMATCH",
        message: "Pi target analysis does not match pioc.port.json source identity.",
      },
    };
  }

  const tools = await preparePiTools(input);
  if (!tools.ok) return tools;
  const skills = await preparePiSkills(input.analysis, input.manifest, input.portRoot);
  if (!skills.ok) return skills;

  const collision = targetPathCollision([
    "extension.ts",
    "package.json",
    ...skills.value.map((skill) => skill.targetPath),
    ...tools.value.executors.flatMap((executor) => {
      const importPath = piExecutorImportSpecifier(executor.targetPath).slice(2);
      return importPath === executor.targetPath ? [executor.targetPath] : [executor.targetPath, importPath];
    }),
  ]);
  if (collision !== undefined) {
    return {
      ok: false,
      error: {
        code: "PI_TARGET_PATH_COLLISION",
        message: `Pi target files collide at: ${collision}`,
        path: collision,
      },
    };
  }

  const targetRoot = join(resolve(input.outputRoot), "generated", "pi");
  const files = [
    "extension.ts",
    "package.json",
    ...skills.value.map((skill) => skill.targetPath),
    ...tools.value.executors.map((executor) => executor.targetPath),
  ].sort(compareLexicalText);
  try {
    await rm(targetRoot, { recursive: true, force: true });
    await mkdir(targetRoot, { recursive: true });
    await writeFile(join(targetRoot, "extension.ts"), emitPiExtension(input.analysis.sourceHash, tools.value.tools), "utf8");
    await writeFile(join(targetRoot, "package.json"), generatedPackageJson(input, skills.value), "utf8");
    for (const executor of tools.value.executors) {
      const targetPath = join(targetRoot, executor.targetPath);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, executor.bytes);
    }
    for (const skill of skills.value) {
      const targetPath = join(targetRoot, skill.targetPath);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, skill.bytes);
    }
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: {
        code: "PI_TARGET_WRITE_FAILED",
        message: `Pi target files could not be written: ${cause}`,
        path: targetRoot,
      },
    };
  }
  return { ok: true, value: { targetRoot, files } };
}
