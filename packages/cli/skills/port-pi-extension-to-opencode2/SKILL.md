---
name: port-pi-extension-to-opencode2
description: Author a new dual-host Pi/OpenCode 2 plugin, or faithfully port an existing Pi package to a native OpenCode 2 plugin, using the pioc compiler. Use when asked to write a plugin that must run on both Pi and OpenCode 2, or to port/migrate/convert an existing Pi extension or skill to OpenCode 2.
license: MIT
---

# Porting Pi extensions to OpenCode 2 with `pioc`

`pioc` (npm package `pi-oc2`) is a static compiler, not a runtime bridge. It never imports or
executes a Pi package to analyze it, and the OpenCode 2 plugins it generates never import Pi or any
compatibility shim at runtime. Every command fails closed on anything it cannot prove: an
unresolved capability, a drifted lock, a byte mismatch, a type error.

Two workflows share this compiler. Pick the one that matches the task:

1. **New dual-host plugin** — nothing exists yet. Start from `pioc init`, then port.
2. **Existing Pi package** — a real extension/skill needs an OpenCode 2 equivalent. Start from
   `pioc analyze`, read `COMPAT.md`, then author `pioc.port.json` and any required `portable/`
   modules before porting.

## Hard rules

- **Never import, `require`, or otherwise execute a Pi package's source to inspect it.** Its
  extension factory has full process access and may start background work or mutate files just by
  being loaded. `pioc analyze` reads JSON, YAML frontmatter, and TypeScript ASTs only — read
  `COMPAT.md`, don't run the code.
- **Never build or depend on a runtime compatibility bridge** (running Pi extensions inside
  OpenCode 2, or vice versa, via a shim). A generated OpenCode 2 plugin that imports Pi at runtime
  is not standalone and is not a valid `pioc` output. This includes any `pi-opencode` /
  `opencode-pi`-style compatibility host — treat those as reference-only source evidence for the
  active `opencode2` loader, never as a dependency, fallback, or generator owner.
- **Always run static analysis before editing anything.** For an existing package, that means
  `pioc analyze` and reading `COMPAT.md` before writing `pioc.port.json` or any `portable/` module —
  the compat report is the evidence for every decision after it, not an afterthought.
- **Write portable executors by hand.** `pioc port` never invents tool logic. A tool's behavior is
  a required "scaffold" finding every time, with no exception, because closure capture, host
  context calls, and side effects cannot be preserved by safe static rewriting (see
  `docs/adr/0001-compile-native-targets.md`'s "Translate arbitrary executor functions" rejection).
  You write `portable/<name>.ts`; `pioc port` only wires it into both generated hosts.

## Workflow A: new dual-host plugin

```
pioc init <directory>
```

Scaffolds a minimal, immediately portable example in `<directory>`: `package.json` (the Pi package
manifest), `extensions/index.ts` (one tool, statically direct schema), `portable/hello.ts` (the
manual executor, already correctly wired), `skills/hello-guide/SKILL.md`, and a `pioc.port.json` whose
`requiredCapabilities`/`resolutions` are computed from a real analysis of what it just wrote — so it
resolves cleanly with no further editing. Refuses to touch anything if any target file already
exists; it never overwrites.

Edit `extensions/index.ts` to add tools (following the same `pi.registerTool({ name, description,
parameters: Type.Object(...), execute(...) })` shape), and put each tool's real behavior in its own
`portable/<name>.ts` file — never inline it only in the extension file, since that's what
`pioc port` reads to generate the OpenCode 2 side.

Then port and verify in place (`<source>`, the port root, and `--out` can all be the same directory
for a plugin authored this way — nothing requires it, but it's the simplest layout when everything
was just scaffolded together):

```
pioc port <directory> --manifest <directory>/pioc.port.json --out <directory>
pioc verify <directory>
```

## Workflow B: porting an existing Pi package

1. **Analyze first, unconditionally:**

   ```
   pioc analyze <source> --out <analysis-dir>
   ```

   Writes `analysis.json` (machine-readable) and `<analysis-dir>/COMPAT.md` (a table of every
   discovered capability, its classification, and why). Read `COMPAT.md` before writing anything
   else — it is the whole evidence base for the manifest you're about to author.

2. **Classify every row and decide what to do about it:**

   | Classification | Meaning | What you do |
   | --- | --- | --- |
   | `direct` | The generator can preserve this behavior from declarative input alone (a statically-shaped default-export factory, a supported `Type.Object`/`Type.String`/... schema, a skill resource). | Nothing — no `resolutions` entry needed. |
   | `scaffold` | Metadata/schema ports mechanically, but real behavior needs a hand-written portable module (every tool registration; a computed schema; a command handler). | Write `portable/<name>.ts` (default export, see below) and add a `"mode": "manual", "module": "portable/<name>.ts"` resolution keyed by the finding's `id`. |
   | `unsupported` | No safe native mapping exists this release (custom UI access, dynamic/computed registration, custom providers, event hooks, themes, computed/unsupported schema constructs). | Either redesign that behavior out of the ported plugin, or add an explicit `"mode": "waive", "reason": "..."` resolution that documents why it's being dropped. Waiving is a decision you make and record — `pioc` never drops a finding silently. |

   A required finding left with no resolution blocks `pioc port` and `pioc verify` with
   `UNRESOLVED_REQUIRED_CAPABILITIES`, listing exactly which finding ids are still open.

3. **Author `pioc.port.json` next to the resources it will reference** (its directory becomes the
   port root — see "Directory layout" below):

   ```json
   {
     "schemaVersion": 1,
     "source": { "packageName": "<from analysis.json>", "sourceHash": "<from analysis.json>" },
     "plugin": { "id": "<stable-plugin-id>" },
     "requiredCapabilities": ["<every finding id you want ported, from analysis.json>"],
     "resolutions": {
       "<scaffold-or-unsupported-finding-id>": { "mode": "manual", "module": "portable/<name>.ts" }
     }
   }
   ```

4. **Write each `portable/<name>.ts`** the manifest points a `manual` resolution at. The contract
   (`docs/design.md`'s portable authoring contract) is a **default export**:

   ```ts
   import type { PortableToolContext, PortableToolResult } from "@pi-oc2/core/domain";

   export default async function execute(input: MyToolInput, context: PortableToolContext): Promise<PortableToolResult> {
     context.update({ text: "progress..." }); // optional
     return { text: "final result", title: "optional title", metadata: { optional: "json" } };
   }
   ```

   Both generators copy this file byte-for-byte into their own generated output (under
   `generated/<target>/portable/...`) and import the copy locally, so the generated targets never
   reach back out to the port root at runtime: `@pi-oc2/target-pi` emits one `extension.ts` that
   imports every tool's copy directly — `import * as m from "./portable/<name>.js"; ...;
   m.default(params, context)`. `@pi-oc2/target-opencode2` emits one `server.ts` whose `setup(ctx)`
   registers every tool and skill inline via `ctx.tool.transform`/`ctx.skill.transform` (see
   "Running a generated tool" below), importing each tool's copy directly from the same
   directory and keeping the `.ts` extension — `import run from "./portable/<name>.ts"; ...;
   run(args, context)`. Keep each executor self-contained except for package imports and type-only
   `@pi-oc2/core/domain` imports. Slice 1 copies the resolved module, not neighboring relative
   helper files, and strict verification rejects unresolved relative imports. `input`/`args` is
   your tool's own parsed arguments — not part of the shared contract. Host-only UI stays out of
   this file entirely; put it in a target-specific override instead of trying to make one file
   serve both.

5. **Generate both targets:**

   ```
   pioc port <source> --manifest <port>/pioc.port.json --out <port>
   ```

6. **Verify:**

   ```
   pioc verify <port>
   ```

### Directory layout

`<source>`, the port root (`dirname(--manifest)` — the directory holding `pioc.port.json` and
`portable/`), and `--out` (where `generated/`, `COMPAT.md`, and `pioc.lock.json` land) can be three
entirely distinct directories with no ancestor/descendant relationship. `@pi-oc2/target-pi` and
`@pi-oc2/target-opencode2` both copy each resolved portable module byte-for-byte into their own
`generated/<target>/portable/...` and import that copy locally, so nothing generated ever reaches
back out to the port root at runtime, and `--out` never needs to be — or contain — the port root.

`pioc port` still stages a copy of every resource `pioc analyze` discovered (skills today) from
`<source>` into the port root automatically (not into `--out`), since `@pi-oc2/target-pi`'s
`preparePiSkills` and `@pi-oc2/target-opencode2`'s `prepareOpenCode2Skills` both read skill bytes
relative to the port root, not `<source>`.

Common layouts: `<source> == portRoot == --out` (in-place porting, what `pioc init` sets up),
`<source> == portRoot != --out` (port in place, generate elsewhere), or all three separate (a
dedicated porting-files directory, a source you don't want to touch, and a scratch/CI output
directory).

## Exact commands

| Command | Purpose |
| --- | --- |
| `pioc analyze <source> --out <dir>` | Static analysis only. Writes `<dir>/analysis.json` and `<dir>/COMPAT.md`. Deterministic: same source bytes in, byte-identical output out. |
| `pioc port <source> --manifest <file> --out <port>` | Validates `<file>`'s `source.sourceHash` against `<source>`'s current hash, resolves every required capability, generates `<port>/generated/pi/` and `<port>/generated/opencode2/`, writes `<port>/COMPAT.md` and `<port>/pioc.lock.json`. |
| `pioc verify <port>` | Rejects lock/source/target drift and any unresolved finding, regenerates into a temp directory (reading the port root back from `pioc.lock.json`) and byte-compares it against `<port>/generated/`, typechecks both regenerated targets against their real peer types, and — only when the resolved `opencode2` binary reports the exact pinned version — runs a no-model discovery smoke check that proves `opencode2` directly discovers `<port>/generated/opencode2/server.ts` as a plugin, not just that some command exited zero. |
| `pioc init <directory>` | Scaffolds a new dual-host plugin example. Never overwrites existing files. |

## Target pins

Recorded in `pioc.lock.json`; `pioc verify` rejects anything ported against a different pin
(`PORT_LOCK_TARGET_PROFILE_DRIFT`) rather than silently regenerating against a moved host:

- Pi: `@earendil-works/pi-coding-agent@0.84.3`
- OpenCode 2 host: `@opencode-ai/cli@0.0.0-dev-18204` (the package that installs the `opencode2`
  binary — `opencode2 --version` must report exactly `0.0.0-dev-18204`)
- OpenCode 2 plugin types: `@opencode-ai/plugin@0.0.0-dev-18204` — its native `Plugin.define({ id,
  setup })` contract (`import { Plugin } from "@opencode-ai/plugin"`), where `setup(ctx)` registers
  every tool and skill itself via `ctx.tool.transform(...)` / `ctx.skill.transform(...)`. Never a
  legacy `Hooks`-based `{ id, server }` export, never a package-directory-resolved plugin, and never
  a separate `.opencode/tools` or `.opencode/skills` installation step.
- Schema library: `typebox@1.3.7` (Pi target) and `effect@4.0.0-rc.111` (OpenCode 2 target's
  `Schema` — a real, direct dependency of `@opencode-ai/plugin@0.0.0-dev-18204` itself)

`pioc.lock.json` records these as `"opencode2-dev-18204+plugin-dev-18204+promise-tool-domain"`.
The dev channel can move its plugin contract, so `docs/design.md`, the ADR, and
`target-profile.ts` pin the same snapshot. `pioc verify`'s `PORT_LOCK_TARGET_PROFILE_DRIFT` check
and `runOpenCode2ConfigDiscoverySmoke`'s exact `--version` check fail closed rather than testing the
wrong host shape.

## Verification

`pioc verify` is the only source of truth that a port is correct; treat a port as unfinished until
it passes:

1. **Lock integrity** — `pioc.lock.json`'s recorded target profile must match the current `pioc`
   build's pins.
2. **Source drift** — `<source>` must still hash to what the lock recorded.
3. **Manifest drift** — `pioc.port.json`'s `source.sourceHash` must still match the lock.
4. **Unresolved capabilities** — every required finding must still resolve (direct, manual, or
   waived).
5. **Byte stability** — regenerating into a scratch directory must produce byte-identical output to
   what's checked into `<port>/generated/`. If it doesn't, either generated output was hand-edited
   (don't — it's disposable, re-run `pioc port` instead) or the source/manifest changed without a
   fresh `pioc port`.
6. **Typecheck** — both regenerated targets must typecheck against the real
   `@earendil-works/pi-coding-agent` / `@opencode-ai/plugin` / `effect` / `typebox` types, including
   your `portable/*.ts` modules.
7. **OpenCode 2 discovery smoke** (only when the resolved `opencode2` binary is the exact pinned
   build) — `pioc` first runs `<binary> --version` and compares it against `target-profile.ts`'s
   `OPENCODE2_HOST_VERSION` (`0.0.0-dev-18204`). The binary resolves from `$PIOC_OPENCODE2_BIN` if
   set, else `opencode2` on `PATH`. Anything else — missing, older, newer, or a different channel —
   returns `"skipped"` with the exact version it found, never a false `"passed"`. Only when the
   version matches exactly does `pioc` create a throwaway project whose `opencode.jsonc` names
   `<port>/generated/opencode2/server.ts` directly as a `file://` plugin — never a package directory
   — run a no-model `opencode2 --standalone debug config` (falling back to `opencode2 debug config`
   if the installed build rejects that flag there), and parse the output to confirm `opencode2`
   directly discovered the plugin by exact file URL. Not merely that the command exited zero, and
   not by inspecting whatever ambient global `opencode.jsonc` happens to exist on the machine
   running verification. `debug config` never runs a plugin's `setup()`, so this cannot itself prove
   tools or skills registered correctly — only that `opencode2` will load `server.ts` as a plugin at
   all. That's the real ceiling of what a no-model check can prove here.

## Installing a generated OpenCode 2 target into a real project

`generated/opencode2/` is not a loadable package directory — nothing resolves its `package.json`'s
`exports` to find the plugin, and there is no separate file-installation step for tools or skills.
`Plugin.define({ id, setup })`'s `setup(ctx)` registers everything itself, inline, the moment
`opencode2` loads `server.ts` — via `ctx.tool.transform(...)` for every tool and
`ctx.skill.transform(...)` for every skill (see "Running a generated tool" below). The only thing a
real consuming project needs is one `plugin` entry in its own `opencode.jsonc`:

```jsonc
{ "plugin": ["file:///absolute/path/to/generated/opencode2/server.ts"] }
```

`pioc port` writes this exact instruction, with the placeholder already in the right shape, to
`<port>/generated/opencode2/opencode.jsonc.patch` — merge it into the real project's
`opencode.jsonc` rather than retyping it. Nothing needs to be copied or symlinked into the
consuming project's own `.opencode/` for either tools or skills.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `UNRESOLVED_REQUIRED_CAPABILITIES` | A finding id in `requiredCapabilities` has no `direct` classification and no `resolutions` entry. | Add a `manual` resolution pointing at a real `portable/*.ts`, or a `waive` resolution with a reason. |
| `PORT_SOURCE_HASH_MISMATCH` | `<source>` changed since `pioc.port.json`'s `source.sourceHash` was written. | Re-run `pioc analyze`, review what changed in the new `COMPAT.md`, update `source.sourceHash`. |
| `TARGET_GENERATOR_UNAVAILABLE` | `@pi-oc2/target-pi` / `@pi-oc2/target-opencode2` isn't installed or failed to load. | Check the workspace install; this is an environment problem, not a source problem. |
| `PI_TARGET_MANUAL_EXECUTOR_REQUIRED` / `OPENCODE2_TOOL_EXECUTOR_MISSING` | A tool's capability finding has no resolved `manual` module. | Same fix as `UNRESOLVED_REQUIRED_CAPABILITIES` — the generator is enforcing it a second time. |
| `PI_TARGET_TOOL_SCHEMA_UNSUPPORTED` / `unsupported-schema` finding | A tool's `parameters` uses TypeBox syntax outside the supported subset (`Type.Object`, `.String`, `.Number`, `.Integer`, `.Boolean`, `.Array`, `.Optional`, `.Literal`, `.Union`, `StringEnum`), or a computed/dynamic schema expression. | Rewrite the schema as a static literal expression, or waive the finding and drop the tool from this port. |
| `PORT_LOCK_TARGET_PROFILE_DRIFT` | The port was generated with a different `pioc` build than the one running `verify`. | Re-run `pioc port` with the current build. |
| `PORT_TARGET_BYTES_DRIFT` | Checked-in `<port>/generated/` was hand-edited, or source/manifest changed without regenerating. | Never edit `generated/` by hand. Re-run `pioc port`. |
| `VERIFY_TYPECHECK_FAILED` | Generated code or a `portable/*.ts` module has a real type error against the pinned host types. | Read the reported diagnostics (they're real `tsc` output against `@earendil-works/pi-coding-agent`/`@opencode-ai/plugin`/`effect`/`typebox`'s real types) and fix the portable module or schema. |
| `PI_TARGET_PATH_COLLISION` / `OPENCODE2_TARGET_PATH_COLLISION` | Two portable modules (or a portable module and a skill) normalize to the same generated path, e.g. two different `resolutions[...].module` values both ending in `portable/hello.ts` relative to different subdirectories. | Rename one of the source portable files so their generated `portable/...` paths no longer collide. |
| `PI_TARGET_MANUAL_EXECUTOR_UNREADABLE` / `OPENCODE2_PORTABLE_MODULE_UNREADABLE` | A `resolutions[...].module` path doesn't exist relative to the port root (`dirname(--manifest)`), even though the manifest is otherwise valid. | Confirm the file actually lives under the port root, not under `<source>` or `--out` — manual modules are always resolved against `dirname(--manifest)`. |
| `pioc verify` reports the OpenCode 2 smoke as `"skipped"` with a version reason | The resolved `opencode2` binary (`$PIOC_OPENCODE2_BIN`, or `opencode2` on `PATH`) isn't the exact pinned `0.0.0-dev-18204` build — an ambient older beta install is the common case, not a bug. This is expected, not an error; verification still passes otherwise. | To exercise the smoke check for real, install or point `PIOC_OPENCODE2_BIN` at an exact `@opencode-ai/cli@0.0.0-dev-18204` build. |
| `VERIFY_OPENCODE2_SMOKE_FAILED` | The exact pinned `opencode2` binary was found (version check passed) but then `opencode2` (with or without `--standalone`) exited non-zero, printed output `pioc` couldn't parse as JSON, or its parsed output was missing the exact `file://` URL to `<port>/generated/opencode2/server.ts`. | This doesn't call a model, so a failure here means the binary, its config discovery, or the generated target's shape is broken — not necessarily the port's own logic. |
| Every `pi.registerTool(...)` is `scaffold`, even with a fully static schema | This is not a bug — a tool's *executor* can never be proven safe to translate, only its metadata/schema can, so every tool always needs a `portable/*.ts` regardless of how simple its schema is. | Write the portable module; this is required, not optional. |

## Call stack: porting an existing package end to end

```text
pioc analyze <source> --out <dir>              packages/cli/src/pioc-cli.ts
└─ runAnalyzeCommand()                         packages/cli/src/analyze-command.ts
   ├─ analyzePiPackage()                       @pi-oc2/core (packages/core/src/analyze-pi-package.ts)
   │  ├─ parsePiPackageSource()                @pi-oc2/core: pi-package-source.ts
   │  ├─ discoverPiResources()                 @pi-oc2/core: discover-pi-resources.ts
   │  ├─ analyzePiExtensionAst()               @pi-oc2/core: analyze-pi-extension-ast.ts
   │  │  ├─ extractStaticToolSchema()          @pi-oc2/core: typebox-schema-ast.ts
   │  │  └─ (capability findings: direct/scaffold/unsupported)
   │  ├─ parseAgentSkill()                     @pi-oc2/core: agent-skill.ts
   │  └─ computePiSourceHash()                 @pi-oc2/core: source-hash.ts
   └─ writeDeterministicAnalysis()             @pi-oc2/core: deterministic-artifacts.ts
      writes analysis.json + COMPAT.md

# --- read COMPAT.md; author pioc.port.json + portable/*.ts by hand; nothing below runs source code ---

pioc port <source> --manifest <port-root>/pioc.port.json --out <port>   packages/cli/src/pioc-cli.ts
└─ runPortCommand()                            packages/cli/src/port-command.ts
   ├─ parsePortabilityManifest()               @pi-oc2/core: portability-manifest.ts
   ├─ analyzePiPackage()                       @pi-oc2/core (re-run, source-hash-checked against the manifest)
   ├─ resolvePortCapabilities()                @pi-oc2/core: resolve-port-capabilities.ts
   ├─ stagePortResources()                     packages/cli/src/stage-port-resources.ts
   │     (copies analyzed skills from <source> into dirname(--manifest) — the port root — since
   │      @pi-oc2/target-pi/-opencode2 read them relative to portRoot, not <source> or --out;
   │      a no-op when <source> and the port root are the same directory)
   ├─ generatePiTarget()                       @pi-oc2/target-pi (packages/targets-pi/src/generate-pi-target.ts)
   │  ├─ preparePiTools()                      resolves + reads each tool's manual portable module from portRoot
   │  ├─ preparePiSkills()                     copy-pi-resources.ts — reads skills from portRoot
   │  └─ emitPiExtension()                     emit-pi-extension.ts -> <port>/generated/pi/{extension,package}.json
   │        + copies each portable module into <port>/generated/pi/portable/... (self-contained;
   │          no import ever reaches back out to the port root)
   ├─ generateOpenCode2Target()                @pi-oc2/target-opencode2 (packages/targets-opencode2/src/generate-target.ts)
   │  ├─ prepareOpenCode2Tools() / Skills() / TuiOverrides()    reads portable/skill/UI-override files from portRoot
   │  ├─ prepareOpenCode2PortableModules()      copy-opencode2-portable-modules.ts — copies modules into generated/opencode2/portable/...
   │  ├─ (skills copied)                        -> <port>/generated/opencode2/skills/<name>/SKILL.md
   │  ├─ emitOpenCode2Server()                  -> <port>/generated/opencode2/server.ts
   │  │     (Plugin.define({ id, async setup(ctx) { ... } }) — setup(ctx) itself calls
   │  │      ctx.tool.transform(...) once per tool and ctx.skill.transform(...) once per skill,
   │  │      all inline in this one file; never Hooks, never separate .opencode/tools files)
   │  └─ emitOpenCode2Tui/ConfigPatch/PackageJson()  -> <port>/generated/opencode2/{tui.ts,opencode.jsonc.patch,package.json}
   └─ writes <port>/COMPAT.md and <port>/pioc.lock.json    packages/cli/src/port-lock.ts
         (pioc.lock.json's manifestPath, relative to <port>, is how "pioc verify <port>" finds the
          port root back again — it is never assumed to equal <port>)

pioc verify <port>                             packages/cli/src/pioc-cli.ts
└─ runVerifyCommand()                          packages/cli/src/verify-command.ts
   ├─ parsePortLockFile()                      packages/cli/src/port-lock.ts (lock + target-profile drift)
   ├─ dirname(resolve(<port>, lock.manifestPath))   recovers the port root
   ├─ analyzePiPackage() + resolvePortCapabilities()   (source + capability drift)
   ├─ stagePortResources()                     re-syncs the port root's staged copies from <source> (source already
   │                                             confirmed unchanged above)
   ├─ generatePiTarget() / generateOpenCode2Target()    (regenerate into a bare temp directory — no portable
   │                                             symlink needed; both generators copy portable/ in themselves)
   ├─ compareDirectoriesByteExact()             packages/cli/src/fs-utils.ts  (byte drift, vs. <port>/generated/)
   ├─ prepareGeneratedPackageTypecheck() + typecheckGeneratedPackage()   packages/cli/src/typecheck-target.ts
   └─ runOpenCode2ConfigDiscoverySmoke()        packages/cli/src/opencode2-smoke.ts
         resolves $PIOC_OPENCODE2_BIN or "opencode2" on PATH, runs --version, and only proceeds if
         it reports exactly 0.0.0-dev-18204 (else "skipped" with the version found) — then writes a
         temp opencode.jsonc naming .../server.ts directly as the plugin, runs debug config there,
         and asserts the plugin file URL is directly discovered
```

## Running a generated tool or skill (for context, not something you invoke directly)

Pi loads one `extension.ts`; OpenCode 2 loads one `server.ts` whose `Plugin.define({ id, setup })`
registers everything the moment `opencode2` loads it — both are Promise-based host entry points, not
file-per-resource conventions:

```text
Pi:
pi.registerTool(...).execute(_id, params, signal, onUpdate, ctx)     generated/pi/extension.ts
-> import * as m from "./portable/<name>.js" (copied into generated/pi/portable/ at port time)
-> m.default(params, { cwd: ctx.cwd, signal, sessionId, update })
-> maps PortableToolResult.text/metadata to a Pi tool content block + details

OpenCode 2 — plugin load:
import { Plugin, Skill } from "@opencode-ai/plugin"          generated/opencode2/server.ts
export default Plugin.define({ id, async setup(ctx) { ... } })
-> opencode2 loads server.ts (the file:// URL from opencode.jsonc's "plugin" array) and calls setup(ctx)

OpenCode 2 — one tool, inline inside setup(ctx):
await ctx.tool.transform((draft) => { draft.add({ name, description, input, async execute(input, toolContext) { ... } }); });
-> import executePortableTool0 from "./portable/<name>.ts" (copied into generated/opencode2/portable/ at port time)
-> executePortableTool0(input, { cwd: session.location.directory, signal, sessionId: toolContext.sessionID, update })
-> maps PortableToolResult.text/title/metadata to { content, metadata }

OpenCode 2 — one skill, inline inside the same setup(ctx):
await ctx.skill.transform((draft) => { draft.add({ id: Skill.ID.make(...), name: Skill.Name.make(...), content, location }); });
-> content is the skill's Markdown body, embedded directly in server.ts — no separate SKILL.md read at runtime
```

Both hosts' tool executors call the exact same `portable/<name>.ts` default export — a
byte-identical copy of the one file you authored under the port root, embedded in each generated
target. That's the entire point: write it once, verify it typechecks against both hosts' real
types, and never write host-specific tool logic outside a target's own override file.

`setup(ctx)` is the only place tools or skills get registered — there is no separate
`.opencode/tools` or `.opencode/skills` file convention to install into a consuming project, and no
`Hooks`-based export to look for.
