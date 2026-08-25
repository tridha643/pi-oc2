import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ResolvedPortCapabilities } from "@pi-oc2/core/capabilities";
import type { CapabilityFinding, PiPackageAnalysis, PiToolAnalysis } from "@pi-oc2/core/domain";
import type { PortabilityManifest } from "@pi-oc2/core/manifest";
import { afterEach, describe, expect, it } from "vitest";
import { generateOpenCode2Target } from "./generate-target.js";

const temporaryDirectories: string[] = [];
const sourceHash = "a".repeat(64);
const toolCapabilityId = "tool:greet:extensions/greet.ts:4:3";
const uiCapabilityId = "ui:notify:extensions/greet.ts:5:3";
const execFileAsync = promisify(execFile);
const devPluginPackage = fileURLToPath(new URL("../node_modules/@opencode-ai/plugin", import.meta.url));
const devEffectPackage = fileURLToPath(new URL("../node_modules/effect", import.meta.url));
const nodeTypesPackage = fileURLToPath(new URL("../node_modules/@types/node", import.meta.url));

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function tool(overrides: Partial<PiToolAnalysis> = {}): PiToolAnalysis {
  return {
    registration: "inline-object",
    name: "greet",
    description: "Greet somebody",
    schemaStatus: "supported",
    schema: {
      type: "object",
      properties: {
        loud: { type: "boolean", title: "Speak loudly" },
        name: { type: "string", minLength: 1 },
      },
      required: ["name"],
      additionalProperties: false,
    },
    source: { path: "extensions/greet.ts", line: 4, column: 3 },
    ...overrides,
  };
}

function unnamedTool(): PiToolAnalysis {
  const { name: _name, ...unnamed } = tool();
  return unnamed;
}

function missingSchemaTool(): PiToolAnalysis {
  const { schema: _schema, ...withoutSchema } = tool();
  return { ...withoutSchema, schemaStatus: "missing" };
}

function finding(overrides: Partial<CapabilityFinding> = {}): CapabilityFinding {
  return {
    id: toolCapabilityId,
    capability: "tool",
    classification: "scaffold",
    required: true,
    message: "manual executor",
    source: { path: "extensions/greet.ts", line: 4, column: 3 },
    symbol: "greet",
    ...overrides,
  };
}

function analysis(toolValue: PiToolAnalysis = tool(), extraFindings: readonly CapabilityFinding[] = []): PiPackageAnalysis {
  const toolFinding = finding();
  return {
    schemaVersion: 1,
    packageName: "fixture",
    sourceKind: "package",
    sourceHash,
    files: [],
    resources: [
      { kind: "extension", path: "extensions/greet.ts" },
      { kind: "skill", path: "skills/zeta/SKILL.md" },
      { kind: "skill", path: "skills/review/SKILL.md" },
    ],
    extensions: [
      {
        path: "extensions/greet.ts",
        hasDefaultExportFactory: true,
        tools: [toolValue],
        events: [],
        commands: [],
        findings: [toolFinding, ...extraFindings],
      },
    ],
    skills: [
      {
        path: "skills/zeta/SKILL.md",
        name: "zeta",
        description: "Zeta skill",
        body: "# Zeta\n",
      },
      {
        path: "skills/review/SKILL.md",
        name: "review",
        description: "Review changes",
        body: "# Review\n",
      },
    ],
    findings: [toolFinding, ...extraFindings],
  };
}

function manifest(): PortabilityManifest {
  return {
    schemaVersion: 1,
    source: { packageName: "fixture", sourceHash },
    plugin: { id: "fixture-plugin" },
    requiredCapabilities: [toolCapabilityId],
    resourceMappings: [],
    resolutions: { [toolCapabilityId]: { mode: "manual", module: "portable/greet.ts" } },
  };
}

function resolutions(extra: ResolvedPortCapabilities["capabilities"] = []): ResolvedPortCapabilities {
  return {
    capabilities: [
      {
        capabilityId: toolCapabilityId,
        classification: "scaffold",
        resolution: "manual",
        module: "portable/greet.ts",
      },
      ...extra,
    ],
  };
}

async function fixtureRoots(): Promise<{ readonly portRoot: string; readonly outputRoot: string }> {
  const portRoot = await mkdtemp(join(tmpdir(), "pi-oc2-opencode2-port-"));
  const outputRoot = await mkdtemp(join(tmpdir(), "pi-oc2-opencode2-output-"));
  temporaryDirectories.push(portRoot, outputRoot);
  await mkdir(join(portRoot, "portable"));
  await mkdir(join(portRoot, "skills", "review"), { recursive: true });
  await mkdir(join(portRoot, "skills", "zeta"), { recursive: true });
  await writeFile(
    join(portRoot, "portable", "greet.ts"),
    `type PortableContext = {
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly sessionId?: string;
  readonly update: (update: { readonly text?: string; readonly metadata?: Readonly<Record<string, unknown>> }) => void;
};

export default async function executePortableGreet(args: { readonly name: string }, context: PortableContext) {
  context.update({ text: "working", metadata: { received: args.name } });
  return {
    title: "Greeting",
    text: \`Hello \${args.name}\`,
    metadata: { cwd: context.cwd, sessionId: context.sessionId, signalAborted: context.signal.aborted },
  };
}
`,
  );
  await writeFile(join(portRoot, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review changes\n---\n# Review\n");
  await writeFile(join(portRoot, "skills", "zeta", "SKILL.md"), "---\nname: zeta\ndescription: Zeta skill\n---\n# Zeta\n");
  return { portRoot, outputRoot };
}

async function targetBytes(outputRoot: string): Promise<Readonly<Record<string, string>>> {
  const targetRoot = join(outputRoot, "generated", "opencode2");
  const entries: Record<string, string> = {};
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else entries[relative(targetRoot, child).replaceAll("\\", "/")] = await readFile(child, "utf8");
    }
  }
  await visit(targetRoot);
  return Object.fromEntries(Object.entries(entries).sort(([left], [right]) => left.localeCompare(right)));
}

async function linkDevRuntime(targetRoot: string): Promise<void> {
  await mkdir(join(targetRoot, "node_modules", "@opencode-ai"), { recursive: true });
  await mkdir(join(targetRoot, "node_modules", "@types"), { recursive: true });
  await symlink(devPluginPackage, join(targetRoot, "node_modules", "@opencode-ai", "plugin"));
  await symlink(devEffectPackage, join(targetRoot, "node_modules", "effect"));
  await symlink(nodeTypesPackage, join(targetRoot, "node_modules", "@types", "node"));
}

describe("generateOpenCode2Target", () => {
  it("emits byte-stable Promise plugins, copied portable modules and skills, and pinned package metadata", async () => {
    const { portRoot, outputRoot } = await fixtureRoots();
    await writeFile(join(portRoot, "portable", "tui.ts"), "export default async function applyTuiOverride(_ctx: unknown) {}\n");
    const uiFinding = finding({
      id: uiCapabilityId,
      capability: "ui",
      classification: "unsupported",
      source: { path: "extensions/greet.ts", line: 5, column: 3 },
      symbol: "notify",
    });
    const input = {
      analysis: analysis(tool(), [uiFinding]),
      manifest: manifest(),
      resolvedCapabilities: resolutions([
        {
          capabilityId: uiCapabilityId,
          classification: "unsupported",
          resolution: "manual",
          module: "portable/tui.ts",
        },
      ]),
      portRoot,
      outputRoot,
    } as const;

    const first = await generateOpenCode2Target(input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.targetProfile).toBe("opencode2-dev-18204+plugin-dev-18204+promise-tool-domain");
    expect(first.value.files).toEqual([
      "opencode.jsonc.patch",
      "package.json",
      "portable/greet.ts",
      "portable/tui.ts",
      "server.ts",
      "skills/review/SKILL.md",
      "skills/zeta/SKILL.md",
      "tui.ts",
    ]);

    const firstBytes = await targetBytes(outputRoot);
    const alternateOutputRoot = await mkdtemp(join(tmpdir(), "pi-oc2-opencode2-output-"));
    temporaryDirectories.push(alternateOutputRoot);
    expect((await generateOpenCode2Target({ ...input, outputRoot: alternateOutputRoot })).ok).toBe(true);
    expect(await targetBytes(alternateOutputRoot)).toEqual(firstBytes);
    await writeFile(join(first.value.targetRoot, "stale.txt"), "stale");
    expect((await generateOpenCode2Target(input)).ok).toBe(true);
    expect(await targetBytes(outputRoot)).toEqual(firstBytes);
    await expect(access(join(first.value.targetRoot, "stale.txt"))).rejects.toThrow();

    expect(JSON.parse(firstBytes["package.json"]!)).toMatchObject({
      main: "./server.ts",
      exports: { ".": "./server.ts", "./server": "./server.ts", "./tui": "./tui.ts" },
      dependencies: {
        "@opencode-ai/plugin": "0.0.0-dev-18204",
        effect: "4.0.0-rc.111",
      },
      pioc: {
        sourceCommit: "43dd33842ee70de0675ea3d1362b67b7dbff0051",
        targetProfile: "opencode2-dev-18204+plugin-dev-18204+promise-tool-domain",
      },
    });

    const server = firstBytes["server.ts"]!;
    expect(server).toContain('import { Plugin, Skill } from "@opencode-ai/plugin";');
    expect(server).toContain('import { Schema } from "effect";');
    expect(server).toContain('import executePortableTool0 from "./portable/greet.ts";');
    expect(server).toContain("export default Plugin.define({");
    expect(server).toContain("await ctx.tool.transform((draft) => {");
    expect(server).toContain('name: "greet"');
    expect(server).toContain("input: Schema.Struct({");
    expect(server).toContain("options: { codemode: false }");
    expect(server).toContain("const session = await ctx.session.get({ sessionID: toolContext.sessionID });");
    expect(server).toContain("signal: new AbortController().signal");
    expect(server).toContain("pendingProgress.push(toolContext.progress({");
    expect(server).toContain("await Promise.all(pendingProgress)");
    expect(server).toContain("...(result.metadata === undefined ? {} : { metadata: result.metadata })");
    expect(server).toContain("await ctx.skill.transform((draft) => {");
    expect(server).toContain('id: Skill.ID.make("fixture-plugin:review")');
    expect(server).toContain('name: Skill.Name.make("review")');
    expect(server).toContain("location: Skill.Info.fields.location.make(");
    expect(server).toContain('new URL("./skills/review/SKILL.md", import.meta.url)');
    expect(server).toContain('content: "# Review\\n"');

    const tui = firstBytes["tui.ts"]!;
    expect(tui).toContain('import { Plugin } from "@opencode-ai/plugin/tui";');
    expect(tui).toContain('import applyOpenCode2TuiOverride0 from "./portable/tui.ts";');
    expect(tui).toContain("export default Plugin.define({");
    expect(tui).toContain("await applyOpenCode2TuiOverride0(ctx)");

    expect(firstBytes["skills/review/SKILL.md"]).toBe(
      "---\nname: review\ndescription: Review changes\n---\n# Review\n",
    );
    expect(firstBytes["portable/greet.ts"]).toBe(await readFile(join(portRoot, "portable", "greet.ts"), "utf8"));
    expect(firstBytes["opencode.jsonc.patch"]).toContain('"file://<generated-opencode2-package>/server.ts"');
    expect(firstBytes["opencode.jsonc.patch"]).not.toContain("skills.paths");

    const generatedText = Object.values(firstBytes).join("\n");
    expect(generatedText).not.toMatch(/\.opencode\/(?:tool|tools)|Hooks\.tool|@opencode-ai\/plugin\/tool|\bid\s*,\s*server\b|\bid\s*,\s*tui\b|opencode-pi|pi-coding-agent/u);
  });

  it("emits a Promise TUI no-op when no UI override is resolved", async () => {
    const { portRoot, outputRoot } = await fixtureRoots();
    const result = await generateOpenCode2Target({
      analysis: analysis(),
      manifest: manifest(),
      resolvedCapabilities: resolutions(),
      portRoot,
      outputRoot,
    });
    expect(result.ok).toBe(true);
    expect(await readFile(join(outputRoot, "generated", "opencode2", "tui.ts"), "utf8")).toContain(
      "async setup(ctx) {},",
    );
  });

  it("omits waived tools and their portable executors", async () => {
    const { portRoot, outputRoot } = await fixtureRoots();
    const result = await generateOpenCode2Target({
      analysis: analysis(),
      manifest: manifest(),
      resolvedCapabilities: {
        capabilities: [
          {
            capabilityId: toolCapabilityId,
            classification: "scaffold",
            resolution: "waived",
            reason: "The OpenCode target does not expose this tool.",
          },
        ],
      },
      portRoot,
      outputRoot,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files.some((path) => path.startsWith("portable/"))).toBe(false);
    expect(await readFile(join(result.value.targetRoot, "server.ts"), "utf8")).not.toContain("ctx.tool.transform");
  });

  it("typechecks against dev-18204 and executes registered tools through a fake Promise context", async () => {
    const { portRoot, outputRoot } = await fixtureRoots();
    const result = await generateOpenCode2Target({
      analysis: analysis(),
      manifest: manifest(),
      resolvedCapabilities: resolutions(),
      portRoot,
      outputRoot,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await linkDevRuntime(result.value.targetRoot);
    await writeFile(
      join(result.value.targetRoot, "tsconfig.smoke.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          lib: ["ES2022", "DOM"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          allowImportingTsExtensions: true,
          types: ["node"],
        },
        include: ["server.ts", "tui.ts", "portable/**/*.ts"],
      }),
    );
    const typescriptCompiler = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
    try {
      await execFileAsync(process.execPath, [typescriptCompiler, "-p", join(result.value.targetRoot, "tsconfig.smoke.json"), "--pretty", "false"]);
    } catch (error) {
      const output = error as { readonly stdout?: string; readonly stderr?: string };
      throw new Error(`Generated OpenCode 2 dev typecheck failed:\n${output.stdout ?? ""}${output.stderr ?? ""}`);
    }

    const script = `
import { Schema } from "./generated/opencode2/node_modules/effect/dist/index.js";
const serverModule = await import("./generated/opencode2/server.ts");
const tools = [];
const skills = [];
const sessionGets = [];
const progressStarted = [];
const progressFinished = [];
const registration = { async dispose() {} };
await serverModule.default.setup({
  tool: {
    async transform(register) {
      register({ add(value) { tools.push(value); } });
      return registration;
    },
  },
  skill: {
    async transform(register) {
      register({ add(value) { skills.push(value); } });
      return registration;
    },
  },
  session: {
    async get(input) {
      sessionGets.push(input);
      return { location: { directory: "/project" } };
    },
  },
});
const registeredTool = tools[0];
const validInput = Schema.is(registeredTool.input)({ name: "Ada" });
const invalidInput = Schema.is(registeredTool.input)({ name: "" });
const output = await registeredTool.execute(
  { name: "Ada" },
  {
    sessionID: "session-1",
    agent: "build",
    messageID: "message-1",
    id: "call-1",
    async progress(update) {
      progressStarted.push(update);
      await Promise.resolve();
      progressFinished.push(update);
    },
  },
);
console.log(JSON.stringify({
  serverKeys: Object.keys(serverModule.default),
  toolNames: tools.map((value) => value.name),
  toolOptions: registeredTool.options,
  validInput,
  invalidInput,
  sessionGets,
  progressStarted,
  progressFinished,
  output,
  skills: skills.map((value) => ({
    id: value.id,
    name: value.name,
    description: value.description,
    content: value.content,
    location: value.location.slice(value.location.lastIndexOf("/skills/")),
  })),
}));
`;
    const execution = await execFileAsync("bun", ["-e", script], { cwd: outputRoot });
    expect(JSON.parse(execution.stdout)).toEqual({
      serverKeys: ["id", "setup"],
      toolNames: ["greet"],
      toolOptions: { codemode: false },
      validInput: true,
      invalidInput: false,
      sessionGets: [{ sessionID: "session-1" }],
      progressStarted: [{ title: "working", metadata: { received: "Ada" } }],
      progressFinished: [{ title: "working", metadata: { received: "Ada" } }],
      output: {
        content: "Hello Ada",
        metadata: { cwd: "/project", sessionId: "session-1", signalAborted: false },
      },
      skills: [
        {
          id: "fixture-plugin:review",
          name: "review",
          description: "Review changes",
          content: "# Review\n",
          location: "/skills/review/SKILL.md",
        },
        {
          id: "fixture-plugin:zeta",
          name: "zeta",
          description: "Zeta skill",
          content: "# Zeta\n",
          location: "/skills/zeta/SKILL.md",
        },
      ],
    });
  });

  it.each([
    {
      name: "missing tool name",
      tool: unnamedTool(),
      resolved: resolutions(),
      expectedCode: "OPENCODE2_TOOL_NAME_MISSING",
    },
    {
      name: "missing schema",
      tool: missingSchemaTool(),
      resolved: resolutions(),
      expectedCode: "OPENCODE2_TOOL_SCHEMA_MISSING",
    },
    {
      name: "missing executor resolution",
      tool: tool(),
      resolved: { capabilities: [] },
      expectedCode: "OPENCODE2_TOOL_EXECUTOR_MISSING",
    },
  ])("returns a tagged failure for $name", async ({ tool: toolValue, resolved, expectedCode }) => {
    const { portRoot, outputRoot } = await fixtureRoots();
    const result = await generateOpenCode2Target({
      analysis: analysis(toolValue),
      manifest: manifest(),
      resolvedCapabilities: resolved as ResolvedPortCapabilities,
      portRoot,
      outputRoot,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(expectedCode);
  });

  it("rejects resolved target features outside the Promise tool, skill, and TUI domains", async () => {
    const { portRoot, outputRoot } = await fixtureRoots();
    const commandFinding = finding({
      id: "command:hello:extensions/greet.ts:6:3",
      capability: "command",
      classification: "scaffold",
      source: { path: "extensions/greet.ts", line: 6, column: 3 },
      symbol: "hello",
    });
    const result = await generateOpenCode2Target({
      analysis: analysis(tool(), [commandFinding]),
      manifest: manifest(),
      resolvedCapabilities: resolutions(),
      portRoot,
      outputRoot,
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: "OPENCODE2_UNSUPPORTED_TARGET_FEATURE",
        message:
          "OpenCode 2 target does not implement capability command: command:hello:extensions/greet.ts:6:3",
        capabilityId: "command:hello:extensions/greet.ts:6:3",
        capability: "command",
      },
    });
  });
});
