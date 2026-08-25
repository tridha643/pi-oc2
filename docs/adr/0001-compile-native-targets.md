# ADR 0001: Compile native Pi and OpenCode 2 targets

- Status: accepted
- Date: 2026-08-25

## Decision

Build a static compiler with native Pi and OpenCode 2 output adapters. Do not build a runtime compatibility host, import Pi extensions during analysis, or make generated OpenCode 2 plugins depend on Pi.

The compiler treats `pioc.port.json` plus manual files under `portable/` as the source of truth. Generated target files are disposable. Existing Pi packages first produce an evidence-backed capability report; unresolved behavior blocks verification.

Target the exact OpenCode 2 Promise contract in the initial design snapshot and its runnable dev packages:

- source `anomalyco/opencode@43dd33842ee70de0675ea3d1362b67b7dbff0051`
- `@opencode-ai/cli@0.0.0-dev-18204`
- `@opencode-ai/plugin@0.0.0-dev-18204`
- server direct-file export `Plugin.define({ id, setup })`
- native tools through `ctx.tool.transform(...)`
- native skills through `ctx.skill.transform(...)`
- separate TUI `Plugin.define({ id, setup })`

## Constraint

Pi extensions can execute arbitrary startup code, mutate runtime state, persist custom session entries, and render arbitrary terminal UI. Importing one to inspect it would run untrusted code. Pretending those behaviors have direct OpenCode 2 equivalents would silently lose behavior.

The compiler must produce repeatable bytes from source files alone and must stop when it cannot prove a mapping.

## Adapter audit

The existing `/Users/tri-modem/Desktop/opencode-pi` fork was inspected only as source evidence for the active `opencode2` loader. It cannot own generated behavior because the supplied design explicitly deprecates it as a compatibility runtime, and depending on it would make generated plugins non-standalone.

The Pi extension API and OpenCode 2 plugin API cannot be reused as one shared adapter. Their tool results, contexts, hooks, persistence, commands, and TUI models differ. A small host-neutral tool contract can be shared, while each host needs a native adapter that owns those differences.

## Rejected alternatives

1. **Runtime shim around Pi.** Rejected because it executes Pi inside OpenCode 2, carries Pi lifecycle and UI assumptions into the target, and violates the standalone requirement.
2. **Import packages to discover registrations.** Rejected because extension factories have full process access and may start background resources or mutate files during analysis.
3. **Generate against the older beta-18155 compatibility API.** Rejected after real-host verification: that binary predates the supplied `43dd338` tool-domain contract. The exact dev-18204 snapshot exposes `ctx.tool.transform` and invokes the generated tool successfully end to end.
4. **Translate arbitrary executor functions.** Rejected because closure capture, host context calls, side effects, and runtime-only values cannot be preserved by safe static rewriting. The analyzer ports descriptors and schemas, then requires a portable executor or a target-specific override.

## Consequences

- New cross-host plugins start from a portable contract and generate both adapters.
- Existing Pi packages usually need manual executor and UI work even when their schemas port directly.
- Compatibility reports are more conservative, but every missing behavior is visible and testable.
- A future OpenCode 2 API change adds a new target profile instead of changing old generated output in place.

## Call stack

```text
pioc port <source>                              packages/cli/src/port-command.ts                  [NEW]
├─ analyzePiPackage()                          packages/core/src/analyze-pi-package.ts           [NEW]
├─ resolvePortCapabilities()                   packages/core/src/resolve-port-capabilities.ts   [NEW]
├─ generatePiTarget()                          packages/targets-pi/src/generate-pi-target.ts     [NEW]
└─ generateOpenCode2Target()                   packages/targets-opencode2/src/generate-target.ts [NEW]
```
