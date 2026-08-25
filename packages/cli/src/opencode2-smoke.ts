import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPENCODE2_HOST_VERSION } from "./target-profile.js";

interface ProcessOutcome {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly spawnError?: Error & { readonly code?: string };
}

function runProcess(command: string, args: readonly string[], cwd: string): Promise<ProcessOutcome> {
  return new Promise((resolveOutcome) => {
    const child = spawn(command, args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      resolveOutcome({ exitCode: null, stdout, stderr, spawnError: error });
    });
    child.on("close", (exitCode) => {
      resolveOutcome({ exitCode, stdout, stderr });
    });
  });
}

export type OpenCode2SmokeResult =
  | { readonly status: "skipped"; readonly reason: string }
  | { readonly status: "passed"; readonly command: string }
  | { readonly status: "failed"; readonly reason: string };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolves the `opencode2` executable to run: `$PIOC_OPENCODE2_BIN` if set and non-empty, else `opencode2` on `PATH`. */
function resolveOpenCode2Binary(): string {
  const override = process.env.PIOC_OPENCODE2_BIN?.trim();
  return override !== undefined && override.length > 0 ? override : "opencode2";
}

const VERSION_PATTERN = /\d+\.\d+\.\d+(?:-[\w.-]+)?/u;

/**
 * Runs `<binary> --version` and reports whether it reports exactly {@link OPENCODE2_HOST_VERSION}.
 * `pioc` only ever pins one exact `opencode2` build at a time (see `target-profile.ts`) — an older,
 * newer, or differently-channeled build is exactly the kind of silent host drift this project's
 * lock-and-verify design refuses to paper over, so this never treats "some opencode2 exists" as
 * good enough.
 */
async function checkOpenCode2Version(
  binary: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const outcome = await runProcess(binary, ["--version"], tmpdir());
  if (outcome.spawnError !== undefined) {
    if (outcome.spawnError.code === "ENOENT") {
      return {
        ok: false,
        reason:
          `opencode2 binary "${binary}" was not found on PATH. pioc verify only runs this smoke check against the ` +
          `exact pinned build @opencode-ai/cli@${OPENCODE2_HOST_VERSION}; set PIOC_OPENCODE2_BIN to point at it, or ` +
          `install it, to exercise this check for real.`,
      };
    }
    return { ok: false, reason: `opencode2 binary "${binary}" could not report --version: ${outcome.spawnError.message}` };
  }
  if (outcome.exitCode !== 0) {
    return {
      ok: false,
      reason: `opencode2 binary "${binary}" --version exited ${String(outcome.exitCode)}: ${(outcome.stderr || outcome.stdout).trim()}`,
    };
  }
  const combinedOutput = `${outcome.stdout}${outcome.stderr}`;
  if (combinedOutput.includes(OPENCODE2_HOST_VERSION)) {
    return { ok: true };
  }
  const reportedVersion = VERSION_PATTERN.exec(combinedOutput)?.[0] ?? (combinedOutput.trim() || "<empty --version output>");
  return {
    ok: false,
    reason:
      `opencode2 binary "${binary}" reports version ${reportedVersion}, but pioc verify only runs this smoke check ` +
      `against the exact pinned build @opencode-ai/cli@${OPENCODE2_HOST_VERSION}. Set PIOC_OPENCODE2_BIN to point at ` +
      `that exact build to exercise this check for real.`,
  };
}

/**
 * Reads `opencode2 debug config`'s JSON output and confirms it directly discovered *our*
 * synthesized project — not just some ambient global `opencode.jsonc` — by finding a `document`
 * entry for our `opencode.jsonc` whose `info.plugins` names the generated `server.ts` file
 * directly. Never a package directory: `@pi-oc2/target-opencode2`'s `Plugin.define({ id, setup })`
 * entry point is not resolved by loading a package's `exports`.
 */
function assertDirectPluginDiscovered(
  stdout: string,
  configPath: string,
  expectedPluginUrl: string,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `opencode2 debug config did not print valid JSON: ${cause}` };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: "opencode2 debug config output was not a JSON array." };
  }

  const documentEntry = parsed.find((entry) => isRecord(entry) && entry.type === "document" && entry.path === configPath);
  if (!isRecord(documentEntry)) {
    return {
      ok: false,
      reason: `opencode2 debug config did not discover the generated project config at ${configPath}.`,
    };
  }
  const info = isRecord(documentEntry.info) ? documentEntry.info : {};
  const plugins = Array.isArray(info.plugins) ? info.plugins : [];
  if (!plugins.includes(expectedPluginUrl)) {
    return {
      ok: false,
      reason:
        `opencode2 did not report the generated server.ts as a directly discovered plugin: expected ` +
        `${expectedPluginUrl} among ${JSON.stringify(plugins)}.`,
    };
  }

  return { ok: true };
}

/**
 * Runs a no-model discovery smoke check against the actual regenerated `opencode2` target: points a
 * throwaway project's `opencode.jsonc` at `opencode2TargetRoot/server.ts` directly as a `file://`
 * plugin — never a package directory — and runs `opencode2 --standalone debug config` (falling back
 * to `opencode2 debug config` — see below), then asserts the parsed output directly discovered the
 * plugin by exact file URL. Not merely that some command exited zero, and not by inspecting whatever
 * ambient global `opencode.jsonc` happens to exist on the machine running verification.
 *
 * `@pi-oc2/target-opencode2` targets the real `@opencode-ai/plugin` `Plugin.define({ id, setup })`
 * contract: `async setup(ctx)` registers both tools (`ctx.tool.transform((draft) =>
 * draft.add({...}))`) and skills (`ctx.skill.transform((draft) => draft.add({...}))`) itself, all
 * inline in the one generated `server.ts` — so a correct port needs no separate `.opencode/tools` or
 * `.opencode/skills` installation step, and no `skills.paths` config entry, in the consuming
 * project. `debug config` only lists configuration sources; it never runs a plugin's `setup()`, so
 * it cannot itself prove tools/skills registered correctly — only that `opencode2` will load
 * `server.ts` as a plugin at all. That's the real ceiling of what a no-model check can prove here.
 *
 * Only ever runs the real discovery check against the exact pinned build,
 * `@opencode-ai/cli@0.0.0-dev-18204` (`target-profile.ts`'s `OPENCODE2_HOST_VERSION`) — resolved via
 * `$PIOC_OPENCODE2_BIN` if set, else `opencode2` on `PATH`. Any other installed version (older,
 * newer, or a different channel — this beta has moved its accepted plugin contract more than once)
 * returns `"skipped"` with the exact version it found, rather than either hard-failing verification
 * on a host `pioc` doesn't control or silently reporting a false "passed" against a binary that
 * cannot actually prove anything about this contract. This also means `pioc verify` stays runnable
 * with no `opencode2` installed at all.
 *
 * The pinned dev build still rejects `--standalone` on `debug config` with "Unrecognized flag:
 * --standalone" even though it accepts it on other subcommands — the same kind of drift
 * `docs/adr/0001-compile-native-targets.md` records for the pinned host contract generally. Rather
 * than hard-failing on that, this falls back to the flag-less `opencode2 debug config` only for that
 * specific, recognized error text; any other failure is reported as-is.
 */
export async function runOpenCode2ConfigDiscoverySmoke(opencode2TargetRoot: string): Promise<OpenCode2SmokeResult> {
  const binary = resolveOpenCode2Binary();
  const versionCheck = await checkOpenCode2Version(binary);
  if (!versionCheck.ok) {
    return { status: "skipped", reason: versionCheck.reason };
  }

  const projectDirectory = await mkdtemp(join(tmpdir(), "pioc-opencode2-smoke-"));
  try {
    const realProjectDirectory = await realpath(projectDirectory);
    const realTargetRoot = await realpath(opencode2TargetRoot);
    const serverPath = join(realTargetRoot, "server.ts");

    const expectedPluginUrl = `file://${serverPath}`;
    const configPath = join(realProjectDirectory, "opencode.jsonc");
    await writeFile(configPath, JSON.stringify({ plugin: [expectedPluginUrl] }, null, 2));

    const primary = await runProcess(binary, ["--standalone", "debug", "config"], realProjectDirectory);
    if (primary.spawnError !== undefined) {
      return { status: "failed", reason: `opencode2 could not be started: ${primary.spawnError.message}` };
    }

    let outcome = primary;
    let command = "opencode2 --standalone debug config";
    if (primary.exitCode !== 0) {
      const rejectedStandaloneFlag =
        primary.stderr.includes("Unrecognized flag: --standalone") || primary.stdout.includes("Unrecognized flag: --standalone");
      if (!rejectedStandaloneFlag) {
        return {
          status: "failed",
          reason: `opencode2 --standalone debug config exited ${String(primary.exitCode)}: ${(primary.stderr || primary.stdout).trim()}`,
        };
      }
      outcome = await runProcess(binary, ["debug", "config"], realProjectDirectory);
      command = "opencode2 debug config";
      if (outcome.exitCode !== 0) {
        return {
          status: "failed",
          reason: `opencode2 debug config exited ${String(outcome.exitCode)}: ${(outcome.stderr || outcome.stdout).trim()}`,
        };
      }
    }

    const discovery = assertDirectPluginDiscovered(outcome.stdout, configPath, expectedPluginUrl);
    if (!discovery.ok) {
      return { status: "failed", reason: discovery.reason };
    }
    return { status: "passed", command };
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
}
