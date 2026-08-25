/** Builds the scaffolded package.json's text. `packageName` becomes both the npm and Pi package name. */
export function initPackageJson(packageName: string): string {
  return (
    JSON.stringify(
      {
        name: packageName,
        version: "0.1.0",
        private: true,
        type: "module",
        description: "Example dual-host Pi / OpenCode 2 plugin, scaffolded by `pioc init`.",
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * The scaffolded extension. Uses only the statically supported subset `docs/design.md`'s Slice 1
 * documents (a top-level default-export factory, a literal `pi.registerTool(...)` call, and
 * `Type.Object` / `Type.Optional` / `Type.String` schema calls) so `pioc analyze` classifies the
 * factory and schema as direct, leaving only the tool's executor as a required manual resolution
 * — exactly the case `pioc.port.json` below resolves against `../portable/hello.ts`.
 *
 * Imports `Type` from `"typebox"` and calls the portable executor the same way
 * `@pi-oc2/target-pi`'s generated `extension.ts` does (a default-exported
 * `(input, context) => Promise<PortableToolResult>`), so this hand-authored extension and the one
 * `pioc port` generates from it stay behaviorally identical.
 */
export const INIT_EXTENSION_SOURCE = `import { Type } from "typebox";
import executeHello from "../portable/hello.js";

/**
 * Minimal dual-host example extension. \`pioc port\` maps this factory and its one tool onto a
 * native Pi extension and a native OpenCode 2 plugin; the tool's behavior lives in
 * ../portable/hello.ts so both generated hosts run the identical implementation.
 */
export default function helloExtension(pi) {
  pi.registerTool({
    name: "hello",
    description: "Returns a friendly greeting through the portable dual-host executor.",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Who to greet." })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const result = await executeHello(params, {
        cwd: ctx.cwd,
        signal: signal ?? new AbortController().signal,
        sessionId: ctx.sessionManager?.getSessionId(),
        update(update) {
          onUpdate?.({
            content: update.text === undefined ? [] : [{ type: "text", text: update.text }],
            details: update.metadata,
          });
        },
      });
      return { content: [{ type: "text", text: result.text }], details: result.metadata };
    },
  });
}
`;

/**
 * The scaffolded portable executor. \`pi.registerTool(...)\`'s tool descriptor is always a required
 * "scaffold" finding (its executor cannot be ported mechanically, per
 * \`docs/adr/0001-compile-native-targets.md\`'s rejection of translating arbitrary executor
 * functions) — this file is the manual implementation \`pioc.port.json\` points that finding at.
 *
 * Exports its executor as the **default** export. Both generators copy this module into their own
 * \`generated/<target>/portable/\` directory, then call \`module.default(params, context)\` from a
 * local import. Its \`(input, context)\` signature matches the \`PortableToolContext\` /
 * \`PortableToolResult\` contract from
 * \`docs/design.md\`; \`input\` is this tool's own parsed arguments, opaque to that shared contract.
 */
export const INIT_PORTABLE_EXECUTOR_SOURCE = `import type { PortableToolContext, PortableToolResult } from "@pi-oc2/core/domain";

export interface HelloInput {
  readonly name?: string | undefined;
}

/** Runs unmodified on both generated hosts; see ../extensions/index.ts for how each host reaches it. */
export default async function execute(input: HelloInput, context: PortableToolContext): Promise<PortableToolResult> {
  const who = input.name === undefined || input.name.length === 0 ? "world" : input.name;
  context.update({ text: \`Greeting \${who}...\` });
  return { text: \`Hello, \${who}!\`, title: "hello" };
}
`;

export const INIT_SKILL_SOURCE = `---
name: hello-guide
description: Explains the example "hello" tool this scaffold ships and how to extend it.
---
# Hello

This is a minimal example skill bundled with a scaffolded dual-host plugin. Replace it with real
guidance once the "hello" tool grows into something worth documenting for an agent.

The tool's behavior lives in \`portable/hello.ts\` and runs unmodified on both the generated Pi
extension and the generated OpenCode 2 plugin. Edit that file, not the generated targets under
\`generated/pi/\` or \`generated/opencode2/\` once you run \`pioc port\` — those are disposable.
`;
