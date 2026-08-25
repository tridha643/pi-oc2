import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiPackageAnalysis } from "@pi-oc2/core/domain";
import { serializeStableJson } from "@pi-oc2/core/serialization";

/**
 * Shared fixture helpers for this package's tests. `@pi-oc2/core`'s own tests duplicate a small
 * fixture builder per file; this CLI package's command tests share enough setup (a temp Pi
 * package, a matching manifest) that duplicating it five times would obscure what each test is
 * actually asserting. Port and verify tests run against the real `@pi-oc2/target-pi` /
 * `@pi-oc2/target-opencode2` generators (present in this workspace) rather than fakes, so this
 * fixture matches their real conventions exactly — a default-exported portable executor.
 */

export async function createTempDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeTempDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/**
 * Writes a minimal real Pi package: one extension with a statically direct factory and one
 * `pi.registerTool(...)` call (always a required "scaffold" finding, per
 * `analyze-pi-extension-ast.ts`), plus one skill. Never imported/executed by anything under test.
 */
export async function writeFixturePiPackage(root: string, packageName = "fixture"): Promise<void> {
  await mkdir(join(root, "extensions"), { recursive: true });
  await mkdir(join(root, "skills", "fixture"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: packageName }));
  await writeFile(
    join(root, "extensions", "hello.ts"),
    `export default function (pi) {
  pi.registerTool({
    name: "hello",
    description: "Hello",
    parameters: Type.Object({ name: Type.String() }),
    execute() {},
  });
}
`,
  );
  await writeFile(
    join(root, "skills", "fixture", "SKILL.md"),
    "---\nname: fixture\ndescription: Fixture skill\n---\n# Fixture\n",
  );
}

/**
 * Writes `pioc.port.json` resolving every non-direct finding in `analysis` (in
 * {@link writeFixturePiPackage}'s case, just its "hello" tool) to a manual `portable/hello.ts`
 * module, so `resolvePortCapabilities` succeeds. Reads finding ids from a real `analyzePiPackage`
 * result instead of hardcoding them, since each id embeds the exact source line and column.
 */
export async function writeFixtureManifest(directory: string, analysis: PiPackageAnalysis): Promise<string> {
  await mkdir(join(directory, "portable"), { recursive: true });
  // Default export taking (input, context) and returning a full PortableToolResult: matches
  // @pi-oc2/target-pi's generated extension.ts (`moduleN.default(params, context)`) and
  // @pi-oc2/target-opencode2's generated server.ts (`executeN(args, context)`) exactly, so this
  // fixture typechecks under runVerifyCommand's real typecheck step, not just under generation.
  await writeFile(
    join(directory, "portable", "hello.ts"),
    `import type { PortableToolContext, PortableToolResult } from "@pi-oc2/core/domain";

export default async function execute(
  input: { readonly name?: string },
  context: PortableToolContext,
): Promise<PortableToolResult> {
  context.update({ text: "greeting" });
  return { text: \`Hello, \${input.name ?? "world"}!\` };
}
`,
  );

  const manifestPath = join(directory, "pioc.port.json");
  await writeFile(
    manifestPath,
    serializeStableJson({
      schemaVersion: 1,
      source: { packageName: analysis.packageName, sourceHash: analysis.sourceHash },
      plugin: { id: analysis.packageName },
      requiredCapabilities: analysis.findings.map((finding) => finding.id),
      resolutions: Object.fromEntries(
        analysis.findings
          .filter((finding) => finding.classification !== "direct")
          .map((finding) => [finding.id, { mode: "manual", module: "portable/hello.ts" }]),
      ),
    }),
  );
  return manifestPath;
}
