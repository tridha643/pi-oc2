import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import type { PiPackageAnalysis, PiToolAnalysis } from "@pi-oc2/core";
import type { ResolvedPortCapabilities } from "@pi-oc2/core/capabilities";
import type { PortabilityManifest } from "@pi-oc2/core/manifest";
import ts from "typescript-compiler";
import { afterEach, describe, expect, it } from "vitest";
import { generatePiTarget, type GeneratePiTargetInput } from "./generate-pi-target.js";

const sourceHash = "a".repeat(64);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function toolAnalysis(overrides: Partial<PiToolAnalysis> = {}): PiToolAnalysis {
  return {
    registration: "inline-object",
    name: "portable_echo",
    description: "Echo a portable value",
    schemaStatus: "supported",
    schema: {
      type: "object",
      properties: {
        count: { type: "integer", minimum: 1 },
        mode: { type: "string", enum: ["fast", "safe"] },
        note: { type: "string", minLength: 1 },
      },
      required: ["mode", "note"],
      additionalProperties: false,
    },
    source: { path: "extensions/fixture.ts", line: 3, column: 3 },
    ...overrides,
  };
}

function toolWithoutName(): PiToolAnalysis {
  const { name: _name, ...tool } = toolAnalysis();
  return tool;
}

function toolWithoutSchema(): PiToolAnalysis {
  const { schema: _schema, ...tool } = toolAnalysis({ schemaStatus: "unsupported" });
  return tool;
}

function toolCapabilityId(tool: PiToolAnalysis): string {
  return `tool:${tool.name ?? "anonymous"}:${tool.source.path}:${tool.source.line}:${tool.source.column}`;
}

function packageAnalysis(toolInput: PiToolAnalysis | readonly PiToolAnalysis[] = toolAnalysis()): PiPackageAnalysis {
  const tools = Array.isArray(toolInput) ? toolInput : [toolInput];
  return {
    schemaVersion: 1,
    packageName: "portable-fixture",
    sourceKind: "package",
    sourceHash,
    files: [],
    resources: [
      { kind: "extension", path: "extensions/fixture.ts" },
      { kind: "skill", path: "skills/zeta/SKILL.md" },
      { kind: "skill", path: "skills/alpha/SKILL.md" },
    ],
    extensions: [
      {
        path: "extensions/fixture.ts",
        hasDefaultExportFactory: true,
        tools,
        events: [],
        commands: [],
        findings: [],
      },
    ],
    skills: [
      { path: "skills/zeta/SKILL.md", name: "zeta", description: "Zeta skill", body: "# Zeta\n" },
      { path: "skills/alpha/SKILL.md", name: "alpha", description: "Alpha skill", body: "# Alpha\n" },
    ],
    findings: tools.map((tool) => ({
      id: toolCapabilityId(tool),
      capability: "tool",
      classification: "scaffold",
      required: true,
      message: "manual",
      source: tool.source,
      ...(tool.name === undefined ? {} : { symbol: tool.name }),
    })),
  };
}

function portabilityManifest(): PortabilityManifest {
  return {
    schemaVersion: 1,
    source: { packageName: "portable-fixture", sourceHash },
    plugin: { id: "portable-fixture", name: "Portable fixture" },
    requiredCapabilities: ["tool:portable_echo:extensions/fixture.ts:3:3"],
    resourceMappings: [],
    resolutions: {
      "tool:portable_echo:extensions/fixture.ts:3:3": { mode: "manual", module: "portable/echo.ts" },
    },
  };
}

function resolvedCapabilities(): ResolvedPortCapabilities {
  return {
    capabilities: [
      {
        capabilityId: "tool:portable_echo:extensions/fixture.ts:3:3",
        classification: "scaffold",
        resolution: "manual",
        module: "portable/echo.ts",
      },
    ],
  };
}

async function createPortableFixture(): Promise<GeneratePiTargetInput> {
  const portRoot = await mkdtemp(join(tmpdir(), "pi-oc2-port-root-"));
  const outputRoot = await mkdtemp(join(tmpdir(), "pi-oc2-output-root-"));
  temporaryDirectories.push(portRoot, outputRoot);
  await mkdir(join(portRoot, "portable"), { recursive: true });
  await mkdir(join(portRoot, "skills", "alpha"), { recursive: true });
  await mkdir(join(portRoot, "skills", "zeta"), { recursive: true });
  await writeFile(join(portRoot, "package.json"), '{"type":"module"}\n');
  await writeFile(
    join(portRoot, "portable", "echo.ts"),
    `export default async function executePortableEcho(params, context) {
  context.update({ text: "halfway", metadata: { phase: 1 } });
  return { text: params.note + ":" + params.mode, title: "Portable echo", metadata: { cwd: context.cwd, sessionId: context.sessionId } };
}
`,
  );
  await writeFile(join(portRoot, "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: Alpha skill\n---\n# Alpha\n");
  await writeFile(join(portRoot, "skills", "zeta", "SKILL.md"), "---\nname: zeta\ndescription: Zeta skill\n---\n# Zeta\n");
  return {
    analysis: packageAnalysis(),
    manifest: portabilityManifest(),
    resolvedCapabilities: resolvedCapabilities(),
    portRoot,
    outputRoot,
  };
}

async function generatedBytes(root: string, files: readonly string[]): Promise<Readonly<Record<string, string>>> {
  return Object.fromEntries(
    await Promise.all(files.map(async (path) => [path, (await readFile(join(root, path))).toString("base64")] as const)),
  );
}

describe("generatePiTarget", () => {
  it("emits byte-identical native Pi files, schemas, imports, and copied skills", async () => {
    const input = await createPortableFixture();
    const first = await generatePiTarget(input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstBytes = await generatedBytes(first.value.targetRoot, first.value.files);

    const second = await generatePiTarget(input);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(await generatedBytes(second.value.targetRoot, second.value.files)).toEqual(firstBytes);
    expect(input.outputRoot).not.toBe(input.portRoot);
    expect(second.value.files).toContain("portable/echo.ts");
    expect(await readFile(join(second.value.targetRoot, "portable", "echo.ts"))).toEqual(
      await readFile(join(input.portRoot, "portable", "echo.ts")),
    );

    const extension = await readFile(join(second.value.targetRoot, "extension.ts"), "utf8");
    expect(extension).toContain('import * as portableToolModule0 from "./portable/echo.js";');
    expect(extension).toContain('import { Type } from "typebox";');
    expect(extension).toContain('StringEnum(["fast","safe"] as const)');
    expect(extension).toContain('"count": Type.Optional(Type.Integer({ minimum: 1 }))');
    expect(extension).toContain('content: [{ type: "text", text: portableResult.text }]');
    expect(extension).toContain("details: portableResult.metadata");
    expect(extension.toLowerCase()).not.toContain("opencode");

    const packageJson = JSON.parse(await readFile(join(second.value.targetRoot, "package.json"), "utf8")) as {
      readonly peerDependencies: Readonly<Record<string, string>>;
      readonly dependencies: Readonly<Record<string, string>>;
      readonly pi: { readonly extensions: readonly string[]; readonly skills: readonly string[] };
    };
    expect(packageJson.peerDependencies).toEqual({ "@earendil-works/pi-coding-agent": "0.84.3" });
    expect(packageJson.dependencies).toEqual({ typebox: "1.3.7" });
    expect(packageJson.pi).toEqual({
      extensions: ["./extension.ts"],
      skills: ["./skills/alpha/SKILL.md", "./skills/zeta/SKILL.md"],
    });
    expect(await readFile(join(second.value.targetRoot, "skills", "alpha", "SKILL.md"), "utf8")).toContain("# Alpha");
    expect(await readFile(join(second.value.targetRoot, "skills", "zeta", "SKILL.md"), "utf8")).toContain("# Zeta");
  });

  it("executes the emitted extension through Pi-shaped context, progress, and result adapters", async () => {
    const input = await createPortableFixture();
    const result = await generatePiTarget(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const extensionPath = join(result.value.targetRoot, "extension.ts");
    const extensionSource = await readFile(extensionPath, "utf8");
    const transpiled = ts.transpileModule(extensionSource, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: extensionPath,
    }).outputText;
    const executableExtensionPath = join(result.value.targetRoot, "extension.js");
    await writeFile(executableExtensionPath, transpiled);
    const executorSourcePath = join(result.value.targetRoot, "portable", "echo.ts");
    const executableExecutorPath = join(result.value.targetRoot, "portable", "echo.js");
    await writeFile(
      executableExecutorPath,
      ts.transpileModule(await readFile(executorSourcePath, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        fileName: executorSourcePath,
      }).outputText,
    );

    const require = createRequire(import.meta.url);
    const typeboxEntry = require.resolve("typebox");
    const typeboxRoot = dirname(dirname(typeboxEntry));
    await mkdir(join(result.value.targetRoot, "node_modules"), { recursive: true });
    await symlink(typeboxRoot, join(result.value.targetRoot, "node_modules", "typebox"), "dir");
    await rm(input.portRoot, { recursive: true, force: true });

    const loaded = (await import(`${pathToFileURL(executableExtensionPath).href}?test=${Date.now()}`)) as {
      readonly default: (pi: { registerTool(tool: unknown): void }) => void;
    };
    let registeredTool: {
      execute(
        toolCallId: string,
        params: unknown,
        signal: AbortSignal | undefined,
        onUpdate: (update: unknown) => void,
        context: unknown,
      ): Promise<unknown>;
    } | undefined;
    loaded.default({ registerTool: (tool) => { registeredTool = tool as typeof registeredTool; } });
    expect(registeredTool).toBeDefined();
    if (registeredTool === undefined) return;

    const updates: unknown[] = [];
    const output = await registeredTool.execute(
      "call-1",
      { mode: "safe", note: "hello" },
      undefined,
      (update) => updates.push(update),
      { cwd: "/portable/work", sessionManager: { getSessionId: () => "session-1" } },
    );
    expect(updates).toEqual([
      { content: [{ type: "text", text: "halfway" }], details: { phase: 1 } },
    ]);
    expect(output).toEqual({
      content: [{ type: "text", text: "hello:safe" }],
      details: { cwd: "/portable/work", sessionId: "session-1" },
    });
  });

  it("omits waived tools without copying their portable executor", async () => {
    const input = await createPortableFixture();
    const capabilityId = "tool:portable_echo:extensions/fixture.ts:3:3";
    const result = await generatePiTarget({
      ...input,
      manifest: {
        ...input.manifest,
        resolutions: { [capabilityId]: { mode: "waive", reason: "Pi target intentionally omits this tool." } },
      },
      resolvedCapabilities: {
        capabilities: [
          {
            capabilityId,
            classification: "scaffold",
            resolution: "waived",
            reason: "Pi target intentionally omits this tool.",
          },
        ],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files).not.toContain("portable/echo.ts");
    const extension = await readFile(join(result.value.targetRoot, "extension.ts"), "utf8");
    expect(extension).not.toContain("portable_echo");
    expect(extension).not.toContain("portableToolModule");
  });

  it("deduplicates shared executors and rejects distinct sources that collide in the target", async () => {
    const input = await createPortableFixture();
    const secondTool = toolAnalysis({
      name: "portable_second",
      source: { path: "extensions/fixture.ts", line: 4, column: 3 },
    });
    const secondCapabilityId = toolCapabilityId(secondTool);
    const sharedExecutorInput: GeneratePiTargetInput = {
      ...input,
      analysis: packageAnalysis([toolAnalysis(), secondTool]),
      manifest: {
        ...input.manifest,
        requiredCapabilities: [...input.manifest.requiredCapabilities, secondCapabilityId],
        resolutions: {
          ...input.manifest.resolutions,
          [secondCapabilityId]: { mode: "manual", module: "portable/echo.ts" },
        },
      },
      resolvedCapabilities: {
        capabilities: [
          ...input.resolvedCapabilities.capabilities,
          {
            capabilityId: secondCapabilityId,
            classification: "scaffold",
            resolution: "manual",
            module: "portable/echo.ts",
          },
        ],
      },
    };
    const deduplicated = await generatePiTarget(sharedExecutorInput);
    expect(deduplicated.ok).toBe(true);
    if (!deduplicated.ok) return;
    expect(deduplicated.value.files.filter((path) => path === "portable/echo.ts")).toHaveLength(1);
    const extension = await readFile(join(deduplicated.value.targetRoot, "extension.ts"), "utf8");
    expect(extension.match(/import \* as portableToolModule/gu)).toHaveLength(1);

    await writeFile(join(input.portRoot, "echo.ts"), "export default async () => ({ text: \"collision\" });\n");
    const collision = await generatePiTarget({
      ...sharedExecutorInput,
      manifest: {
        ...sharedExecutorInput.manifest,
        resolutions: {
          ...sharedExecutorInput.manifest.resolutions,
          [secondCapabilityId]: { mode: "manual", module: "echo.ts" },
        },
      },
      resolvedCapabilities: {
        capabilities: [
          input.resolvedCapabilities.capabilities[0]!,
          {
            capabilityId: secondCapabilityId,
            classification: "scaffold",
            resolution: "manual",
            module: "echo.ts",
          },
        ],
      },
    });
    expect(collision).toEqual({
      ok: false,
      error: {
        code: "PI_TARGET_PATH_COLLISION",
        message: "Pi target portable executors collide at: portable/echo.ts",
        toolName: "portable_second",
        path: "portable/echo.ts",
      },
    });
  });

  it.each([
    {
      label: "computed names",
      tool: toolWithoutName(),
      capabilities: resolvedCapabilities(),
      code: "PI_TARGET_TOOL_NAME_UNSUPPORTED",
    },
    {
      label: "unsupported schemas",
      tool: toolWithoutSchema(),
      capabilities: resolvedCapabilities(),
      code: "PI_TARGET_TOOL_SCHEMA_UNSUPPORTED",
    },
    {
      label: "unresolved executors",
      tool: toolAnalysis(),
      capabilities: { capabilities: [] },
      code: "PI_TARGET_MANUAL_EXECUTOR_REQUIRED",
    },
  ])("fails closed with a tagged result for $label", async ({ tool, capabilities, code }) => {
    const input = await createPortableFixture();
    const targetRoot = join(input.outputRoot, "generated", "pi");
    const result = await generatePiTarget({ ...input, analysis: packageAnalysis(tool), resolvedCapabilities: capabilities });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
    await expect(readdir(targetRoot)).rejects.toThrow();
  });
});
