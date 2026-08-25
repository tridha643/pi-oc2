import { isAbsolute } from "node:path";
import { z } from "zod";
import type { PiResourceKind } from "./core-domain.js";
import { coreFailure, coreSuccess, type CoreResult } from "./core-result.js";

const windowsAbsolutePath = /^(?:[A-Za-z]:[\\/]|\\\\)/u;

const relativePortablePath = z.string().min(1).refine(
  (path) => !isAbsolute(path) && !windowsAbsolutePath.test(path) && !path.split(/[\\/]/u).includes(".."),
  "Path must be relative and remain inside the port root.",
);

const capabilityResolutionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("manual"), module: relativePortablePath }).strict().readonly(),
  z.object({ mode: z.literal("waive"), reason: z.string().min(1) }).strict().readonly(),
]);

const resourceMappingSchema = z
  .object({
    kind: z.enum(["extension", "skill", "prompt", "theme"] satisfies readonly PiResourceKind[]),
    sourcePath: relativePortablePath,
    targetPath: relativePortablePath,
  })
  .strict()
  .readonly();

/** Zod 4 schema for the stable pioc.port.json compiler input. */
export const portabilityManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: z
      .object({
        packageName: z.string().min(1),
        sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict()
      .readonly(),
    plugin: z
      .object({
        id: z.string().min(1),
        name: z.string().min(1).optional(),
      })
      .strict()
      .readonly(),
    requiredCapabilities: z.array(z.string().min(1)).readonly(),
    resourceMappings: z.array(resourceMappingSchema).readonly().optional(),
    resolutions: z.record(z.string(), capabilityResolutionSchema).readonly().optional(),
  })
  .strict()
  .readonly();

/** A manual module or explicit waiver for a non-direct capability. */
export type PortCapabilityResolution = z.infer<typeof capabilityResolutionSchema>;

/** One explicit source-to-target resource mapping in pioc.port.json. */
export type PortResourceMapping = z.infer<typeof resourceMappingSchema>;

/** Validated, recursively readonly compiler input from pioc.port.json. */
export type PortabilityManifest = z.infer<typeof portabilityManifestSchema>;

/** An expected pioc.port.json parse or validation failure. */
export interface PortabilityManifestFailure {
  readonly code: "PORT_MANIFEST_INVALID_JSON" | "PORT_MANIFEST_INVALID";
  readonly message: string;
  readonly issues?: readonly string[];
}

/** Parses and validates pioc.port.json with Zod 4 without throwing expected errors. */
export function parsePortabilityManifest(
  sourceText: string,
): CoreResult<PortabilityManifest, PortabilityManifestFailure> {
  let input: unknown;
  try {
    input = JSON.parse(sourceText);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return coreFailure({
      code: "PORT_MANIFEST_INVALID_JSON",
      message: `pioc.port.json is invalid JSON: ${cause}`,
    });
  }

  const parsed = portabilityManifestSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const path = issue.path.length === 0 ? "$" : `$.${issue.path.join(".")}`;
      return `${path}: ${issue.message}`;
    });
    return coreFailure({
      code: "PORT_MANIFEST_INVALID",
      message: `pioc.port.json failed validation: ${issues.join("; ")}`,
      issues,
    });
  }
  return coreSuccess(parsed.data);
}
