import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { PiPackageAnalysis } from "@pi-oc2/core/domain";
import { EXIT_DOMAIN_FAILURE, PiocCliError } from "./cli-error.js";

/**
 * Copies every resource `analyzePiPackage` discovered (skills today; every kind for
 * forward-compatibility) from `<sourcePath>/<resource.path>` to `<portRoot>/<resource.path>`, where
 * `portRoot` is the directory holding `pioc.port.json` and `portable/` (`dirname(--manifest)`) —
 * not `--out`, which only receives generated output and may be a third, unrelated directory.
 *
 * `@pi-oc2/target-pi`'s `preparePiSkills` and `@pi-oc2/target-opencode2`'s
 * `prepareOpenCode2Skills` both read skill bytes via `readFile(join(portRoot, skill.path))` —
 * relative to the port root, not the analyzed source, not `--out` — so a port whose `portRoot` isn't
 * the source package itself needs its own copy. This makes `pioc port` do that staging
 * automatically instead of requiring every author to keep two source trees in sync by hand. A no-op
 * when `sourcePath` and `portRoot` are the same directory (in-place porting).
 */
export async function stagePortResources(sourcePath: string, portRoot: string, analysis: PiPackageAnalysis): Promise<void> {
  const resolvedSource = resolve(sourcePath);
  const resolvedPortRoot = resolve(portRoot);
  if (resolvedSource === resolvedPortRoot) {
    return;
  }

  for (const resource of analysis.resources) {
    const from = join(resolvedSource, resource.path);
    const to = join(resolvedPortRoot, resource.path);
    try {
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new PiocCliError(
        "PORT_RESOURCE_STAGING_FAILED",
        `Could not stage ${resource.kind} resource into the port root: ${resource.path}: ${cause}`,
        EXIT_DOMAIN_FAILURE,
      );
    }
  }
}
