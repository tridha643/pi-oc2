# pi-oc2 design

`pi-oc2` is a compiler and porting workflow. It never loads a Pi extension during analysis, and generated OpenCode 2 plugins never import the Pi runtime.

The supplied design pinned the Promise API from `anomalyco/opencode@43dd33842ee70de0675ea3d1362b67b7dbff0051`. The runnable npm snapshot matching that contract is the first release target:

- Pi: `@earendil-works/pi-coding-agent@0.84.3`
- OpenCode 2 host: `@opencode-ai/cli@0.0.0-dev-18204`
- OpenCode plugin types: `@opencode-ai/plugin@0.0.0-dev-18204`
- Server entry: direct `server.ts` file URL with root `Plugin.define({ id, setup })`
- Tool entry: `setup()` registers each tool through `ctx.tool.transform(...)`
- TUI entry: separate `@opencode-ai/plugin/tui` `Plugin.define({ id, setup })`
- Skills: copied as inspectable resources and registered through `ctx.skill.transform(...)`

These values are recorded in `pioc.lock.json`. Verification fails closed when the generator, source hash, or target profile differs.

## Product shape

The repository has four implementation packages:

- `@pi-oc2/core` owns parsing, capability classification, the portable plugin contract, locks, and deterministic serialization.
- `@pi-oc2/target-pi` generates a native Pi extension and Pi package resources.
- `@pi-oc2/target-opencode2` generates native OpenCode 2 server/TUI entries, copied skills, and a config patch.
- `pi-oc2` exposes the `pioc` CLI.

A package author writing a new cross-host plugin defines host-neutral tools once. Each tool receives a small portable context and returns a host-neutral result. The two generated adapters map that contract onto Pi and OpenCode 2.

An existing Pi package follows a stricter path. Static analysis extracts resource paths, tool metadata, supported TypeBox schema calls, hooks, commands, and UI usage. Each finding is classified independently:

- `direct`: the generator can preserve the behavior from declarative input.
- `scaffold`: metadata or schema ports mechanically, but executable behavior needs a manual portable implementation.
- `unsupported`: the target has no safe equivalent in this release.

Nothing silently disappears. A required scaffold or unsupported finding blocks `pioc verify` until `pioc.port.json` resolves or explicitly waives it.

## Portable authoring contract

`pioc.port.json` is the stable compiler input. It contains source identity, plugin identity, required capabilities, resource mappings, and manual override module paths. Generated files are disposable; this manifest and files under `portable/` are authoritative.

The host-neutral executor contract is intentionally small:

```ts
export type PortableToolContext = {
    readonly cwd: string;
    readonly signal: AbortSignal;
    readonly sessionId?: string;
    readonly update: (update: PortableToolUpdate) => void;
};

export type PortableToolResult = {
    readonly text: string;
    readonly title?: string;
    readonly metadata?: Readonly<Record<string, JsonValue>>;
};
```

Pi maps `text` to a text content block and `metadata` to tool-result `details`. OpenCode 2 maps `text` to `output`, preserves `title`, and forwards metadata. Host-only UI stays in target override files rather than the shared executor.

## Determinism rules

1. Analysis never imports or evaluates package code. It reads JSON, Markdown frontmatter, and TypeScript ASTs only.
2. Resource matches, capabilities, findings, imports, and emitted files use lexical ordering with normalized `/` paths.
3. JSON artifacts use one stable serializer, two-space indentation, and a final newline.
4. Generated headers include generator version, source hash, target profile, and a warning that generated files are disposable.
5. Source hashes cover relative path plus file bytes for every analyzed file. Wall-clock time, absolute paths, environment variables, and filesystem iteration order never enter generated output.
6. A second generation into a clean directory must produce byte-identical files.

## Slice 1

The first build supports:

- Pi `package.json` manifests and conventional `extensions/` / `skills/` directories.
- Bare skill directories containing `SKILL.md`.
- Default-export extension factories.
- Top-level `pi.registerTool(...)` and `defineTool(...)` registrations.
- Static `Type.Object`, `Type.String`, `Type.Number`, `Type.Integer`, `Type.Boolean`, `Type.Array`, `Type.Optional`, `Type.Literal`, `Type.Union`, and `StringEnum` schema expressions.
- Literal `pi.on(...)` and `pi.registerCommand(...)` capability discovery.
- Explicit UI, dynamic registration, providers, themes, prompts, and computed schema findings that fail closed.
- Native Pi and OpenCode 2 output generated from a resolved portability manifest.
- `pioc verify` checks lock integrity, unresolved capabilities, type correctness, byte stability, and `opencode2 --standalone debug config` discovery without making a model call.

## Call stacks

### Analyze an existing Pi package

```text
pioc analyze <source>                         packages/cli/src/pioc-cli.ts                 [NEW]
└─ runAnalyzeCommand()                        packages/cli/src/analyze-command.ts           [NEW]
   └─ analyzePiPackage()                      packages/core/src/analyze-pi-package.ts       [NEW]
      ├─ parsePiPackageSource()               packages/core/src/pi-package-source.ts       [NEW]
      ├─ discoverPiResources()                packages/core/src/discover-pi-resources.ts    [NEW]
      ├─ analyzePiExtensionAst()              packages/core/src/analyze-pi-extension-ast.ts [NEW]
      │  ├─ extractStaticToolSchema()         packages/core/src/typebox-schema-ast.ts       [NEW]
      │  └─ classifyPiCapabilities()          packages/core/src/capability-classifier.ts    [NEW]
      ├─ parseAgentSkill()                    packages/core/src/agent-skill.ts              [NEW]
      └─ writeDeterministicAnalysis()         packages/core/src/deterministic-artifacts.ts [NEW]
```

### Generate both native targets

```text
pioc port <source> --out <directory>          packages/cli/src/pioc-cli.ts                    [NEW]
└─ runPortCommand()                           packages/cli/src/port-command.ts                  [NEW]
   ├─ analyzePiPackage()                      packages/core/src/analyze-pi-package.ts           [NEW]
   ├─ parsePortabilityManifest()              packages/core/src/portability-manifest.ts        [NEW]
   ├─ resolvePortCapabilities()               packages/core/src/resolve-port-capabilities.ts   [NEW]
   ├─ generatePiTarget()                      packages/targets-pi/src/generate-pi-target.ts     [NEW]
   │  ├─ emitPiExtension()                    packages/targets-pi/src/emit-pi-extension.ts      [NEW]
   │  └─ copyPiResources()                    packages/targets-pi/src/copy-pi-resources.ts      [NEW]
   ├─ generateOpenCode2Target()               packages/targets-opencode2/src/generate-target.ts [NEW]
   │  ├─ emitOpenCode2Server()                packages/targets-opencode2/src/opencode2-emission.ts [NEW]
   │  │  └─ emit tool/skill transforms        packages/targets-opencode2/src/opencode2-emission.ts [NEW]
   │  ├─ emitOpenCode2Tui()                   packages/targets-opencode2/src/opencode2-emission.ts [NEW]
   │  ├─ copyOpenCode2Skills()                packages/targets-opencode2/src/generate-target.ts   [NEW]
   │  └─ emitOpenCode2ConfigPatch()           packages/targets-opencode2/src/opencode2-emission.ts [NEW]
   ├─ writeCompatibilityReport()              packages/core/src/compatibility-report.ts         [NEW]
   └─ writePortLock()                         packages/core/src/port-lock.ts                     [NEW]
```

### Run a generated portable tool in Pi

```text
Pi extension loader                              generated/pi/extension.ts                [GENERATED]
└─ registerPortableTools(pi)                     generated/pi/extension.ts                [GENERATED]
   └─ pi.registerTool(...).execute()             generated/pi/extension.ts                [GENERATED]
      ├─ executePortableTool()                   generated/pi/portable/<tool>.ts           [COPIED]
      │  └─ source                              <port-root>/portable/<tool>.ts             [AUTHOR]
      └─ mapPortableResultToPi()                 generated/pi/extension.ts                [GENERATED]
```

### Run the same tool in OpenCode 2

```text
OpenCode external plugin loader                  opencode2 dev native runtime
└─ setup(ctx)                                    generated/opencode2/server.ts               [GENERATED]
   └─ ctx.tool.transform(draft)                  @opencode-ai/plugin Promise tool domain
      └─ draft.add(...).execute()                generated/opencode2/server.ts               [GENERATED]
         ├─ ctx.session.get(sessionID)            resolves portable cwd
         ├─ executePortableTool()                generated/opencode2/portable/<tool>.ts      [COPIED]
         │  └─ source                           <port-root>/portable/<tool>.ts               [AUTHOR]
         └─ mapPortableResultToOpenCode2()        generated/opencode2/server.ts               [GENERATED]
```

### Verify a generated port

```text
pioc verify <port-directory>                     packages/cli/src/pioc-cli.ts                    [NEW]
└─ runVerifyCommand()                            packages/cli/src/verify-command.ts                [NEW]
   ├─ verifyPortLock()                           packages/core/src/port-lock.ts                     [NEW]
   ├─ rejectUnresolvedCapabilities()             packages/core/src/resolve-port-capabilities.ts   [NEW]
   ├─ regenerateIntoTemporaryDirectory()         packages/cli/src/verify-command.ts                [NEW]
   ├─ compareGeneratedBytes()                    packages/core/src/deterministic-artifacts.ts      [NEW]
   ├─ typecheckGeneratedPiTarget()               packages/targets-pi/src/verify-pi-target.ts       [NEW]
   ├─ typecheckGeneratedOpenCode2Target()        packages/targets-opencode2/src/verify-target.ts   [NEW]
   └─ runOpenCode2ConfigDiscoverySmoke()         packages/cli/src/opencode2-smoke.ts               [NEW]
      ├─ require exact opencode2 dev-18204 binary
      └─ discover direct server.ts Promise plugin
```
