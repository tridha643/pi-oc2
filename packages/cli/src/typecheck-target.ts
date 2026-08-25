import { existsSync, readFileSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeStableJson } from "@pi-oc2/core/serialization";

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Locates an installed package's root directory via `import.meta.resolve`, rather than a relative
 * `node_modules/.bin`-style lookup. That resolves correctly both when `pioc` runs from its own
 * checkout and when `pi-oc2` is installed as a dependency elsewhere, since Node resolves
 * `packageName` from wherever this module itself was loaded from either way.
 *
 * Tries `"<packageName>/package.json"` first (works for most packages, including type-only ones
 * like `@types/node` that have no runtime entry point at all). Some packages — `@opencode-ai/plugin`
 * among them — declare a catch-all `"./*"` exports pattern that `import.meta.resolve` will happily
 * resolve to a path *matching the pattern* even when no such file exists on disk (Node's exports
 * resolution is purely specifier-shaped, not filesystem-checked, for wildcard patterns); an
 * `existsSync` check after resolving is required to catch that case, not just a try/catch around
 * the call. When either the resolve throws or the resolved file doesn't exist, falls back to
 * resolving the main `"."` entry point and walking up to the nearest real `package.json` above it —
 * needed for packages like `typebox` that restrict `exports` and don't expose their own
 * `package.json` under either strategy.
 */
function resolveInstalledPackageDirectory(packageName: string): string {
  try {
    const packageJsonUrl = import.meta.resolve(`${packageName}/package.json`);
    const packageJsonPath = fileURLToPath(packageJsonUrl);
    if (existsSync(packageJsonPath)) {
      return dirname(packageJsonPath);
    }
  } catch {
    // Fall through to the main-entry-point strategy below.
  }

  const mainEntryUrl = import.meta.resolve(packageName);
  let directory = dirname(fileURLToPath(mainEntryUrl));
  while (!existsSync(join(directory, "package.json"))) {
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`Could not find package.json above the resolved entry point for "${packageName}".`);
    }
    directory = parent;
  }
  return directory;
}

/**
 * Symlinks this CLI's own installed copy of `packageName` into `<nodeModulesDirectory>/<packageName>`,
 * so files anywhere under `nodeModulesDirectory`'s parent can resolve it exactly as a real install
 * would.
 */
async function linkPackageForTypecheck(nodeModulesDirectory: string, packageName: string): Promise<void> {
  const linkPath = join(nodeModulesDirectory, ...packageName.split("/"));
  await mkdir(dirname(linkPath), { recursive: true });
  await symlink(resolveInstalledPackageDirectory(packageName), linkPath, "dir");
}

function resolveTscPath(): string {
  const packageDirectory = resolveInstalledPackageDirectory("typescript");
  const packageJson: unknown = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
  if (!isUnknownRecord(packageJson)) {
    throw new Error('The installed "typescript" package.json is not a JSON object.');
  }
  const bin = packageJson.bin;
  let binEntry: string | undefined;
  if (typeof bin === "string") {
    binEntry = bin;
  } else if (isUnknownRecord(bin) && typeof bin.tsc === "string") {
    binEntry = bin.tsc;
  }
  if (binEntry === undefined) {
    throw new Error('The installed "typescript" package does not declare a tsc bin entry.');
  }
  return join(packageDirectory, binEntry);
}

/**
 * The runtime peer packages a generated target's own files reference by import: `typebox`,
 * `@opencode-ai/plugin`, `@earendil-works/pi-coding-agent` (see `emit-pi-extension.ts` and
 * `opencode2-emission.ts`), and `@pi-oc2/core` — both `@pi-oc2/target-pi` and
 * `@pi-oc2/target-opencode2` now copy each resolved portable module byte-for-byte into
 * `generated/<target>/portable/...` rather than importing it from outside the generated tree, and
 * those copies still import `PortableToolContext`/`PortableToolResult` from `@pi-oc2/core/domain`
 * (see `docs/design.md`'s portable authoring contract). `effect` is `@opencode-ai/plugin`'s own
 * `Schema` dependency, imported directly by generated `server.ts` whenever a port has any tools
 * (`import { Schema } from "effect";`). `@types/node` is needed for generated `server.ts`/`tui.ts`'s
 * plain `node:url` imports to resolve as ambient types rather than "Cannot find name" errors, since
 * TypeScript only auto-includes `@types/*` packages it can actually find in `node_modules`. Neither
 * generator installs its own `node_modules` or emits a `tsconfig.json` in this release, so a
 * generated package cannot typecheck standing alone. `pioc` depends on all of these itself purely so
 * `pioc verify` can typecheck generated output — including the copied portable modules inside it —
 * against real published types instead of either skipping typechecking or faking `any`-typed stubs
 * that would hide real generator bugs.
 */
const GENERATED_PACKAGE_PEER_DEPENDENCIES = [
  "typebox",
  "@opencode-ai/plugin",
  "@earendil-works/pi-coding-agent",
  "@pi-oc2/core",
  "effect",
  "@types/node",
] as const;

/**
 * Writes a permissive `tsconfig.json` and symlinks this CLI's own copies of the generated-package
 * peer dependencies into `directory/node_modules`, so a generated `generated/pi` or
 * `generated/opencode2` directory — including the portable modules copied inside it — becomes
 * typecheckable entirely on its own, with no dependency on where the port root or source actually
 * live. Safe to call against a scratch/temporary copy of generated output; never call it against a
 * checked-in `<port>/generated` directory, since generated output is meant to stay exactly what the
 * generator produced.
 */
export async function prepareGeneratedPackageTypecheck(directory: string): Promise<void> {
  await writeFile(
    join(directory, "tsconfig.json"),
    serializeStableJson({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        // Portable modules are shared executable code. Strict checking prevents one host adapter
        // from accepting an untyped executor that fails only after the other host invokes it.
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        skipLibCheck: true,
        noEmit: true,
        // @pi-oc2/target-opencode2's generated server.ts/tui.ts import the portable module with an
        // explicit ".ts" specifier (unlike @pi-oc2/target-pi's ".js"); only valid under noEmit.
        allowImportingTsExtensions: true,
        // TS's ambient auto-discovery of @types/* packages under node_modules/@types is unreliable
        // for a directory this deep under a freshly mkdtemp'd path (observed: symlinked
        // node_modules/@types/node present and correct, yet plain `node:url` imports still failed
        // with "Cannot find name" as if @types/node were absent). Naming it explicitly bypasses
        // whatever in that auto-discovery path is flaky here.
        types: ["node"],
      },
      include: ["**/*.ts"],
    }),
  );

  const nodeModulesDirectory = join(directory, "node_modules");
  for (const packageName of GENERATED_PACKAGE_PEER_DEPENDENCIES) {
    await linkPackageForTypecheck(nodeModulesDirectory, packageName);
  }
}

export type TypecheckResult = { readonly status: "passed" } | { readonly status: "failed"; readonly diagnostics: string };

/** Runs `tsc --noEmit -p <directory>` and reports whether the generated package typechecks cleanly. */
export async function typecheckGeneratedPackage(directory: string): Promise<TypecheckResult> {
  const tscPath = resolveTscPath();
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [tscPath, "--noEmit", "--pretty", "false", "-p", directory]);
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("close", (exitCode) => {
      resolveResult(exitCode === 0 ? { status: "passed" } : { status: "failed", diagnostics: output.trim() });
    });
  });
}
