import type { CapabilityClassification, CapabilityFinding } from "./core-domain.js";
import { coreFailure, coreSuccess, type CoreResult } from "./core-result.js";
import type { PortabilityManifest } from "./portability-manifest.js";
import { compareLexicalText } from "./pi-source-paths.js";

/** The resolution applied to one required capability. */
export interface ResolvedPortCapability {
  readonly capabilityId: string;
  readonly classification: CapabilityClassification;
  readonly resolution: "direct" | "manual" | "waived";
  readonly module?: string;
  readonly reason?: string;
}

/** A complete, lexically ordered required-capability resolution. */
export interface ResolvedPortCapabilities {
  readonly capabilities: readonly ResolvedPortCapability[];
}

/** One required capability that cannot yet pass verification. */
export interface UnresolvedPortCapability {
  readonly capabilityId: string;
  readonly reason: "missing-analysis-finding" | "manual-resolution-required";
  readonly classification?: CapabilityClassification;
}

/** Expected failure returned when required behavior remains unresolved. */
export interface UnresolvedPortCapabilitiesFailure {
  readonly code: "UNRESOLVED_REQUIRED_CAPABILITIES";
  readonly message: string;
  readonly unresolved: readonly UnresolvedPortCapability[];
}

/** Resolves direct behavior automatically and requires explicit manual or waiver decisions for the rest. */
export function resolvePortCapabilities(
  findings: readonly CapabilityFinding[],
  manifest: PortabilityManifest,
): CoreResult<ResolvedPortCapabilities, UnresolvedPortCapabilitiesFailure> {
  const findingsById = new Map(findings.map((finding) => [finding.id, finding]));
  const resolved: ResolvedPortCapability[] = [];
  const unresolved: UnresolvedPortCapability[] = [];
  const requiredIds = [...new Set(manifest.requiredCapabilities)].sort(compareLexicalText);

  for (const capabilityId of requiredIds) {
    const capability = findingsById.get(capabilityId);
    if (capability === undefined) {
      unresolved.push({ capabilityId, reason: "missing-analysis-finding" });
      continue;
    }
    if (capability.classification === "direct") {
      resolved.push({ capabilityId, classification: capability.classification, resolution: "direct" });
      continue;
    }
    const resolution = manifest.resolutions?.[capabilityId];
    if (resolution === undefined) {
      unresolved.push({
        capabilityId,
        reason: "manual-resolution-required",
        classification: capability.classification,
      });
    } else if (resolution.mode === "manual") {
      resolved.push({
        capabilityId,
        classification: capability.classification,
        resolution: "manual",
        module: resolution.module,
      });
    } else {
      resolved.push({
        capabilityId,
        classification: capability.classification,
        resolution: "waived",
        reason: resolution.reason,
      });
    }
  }

  if (unresolved.length > 0) {
    return coreFailure({
      code: "UNRESOLVED_REQUIRED_CAPABILITIES",
      message: `Required capabilities remain unresolved: ${unresolved.map((entry) => entry.capabilityId).join(", ")}`,
      unresolved,
    });
  }
  return coreSuccess({ capabilities: resolved });
}
