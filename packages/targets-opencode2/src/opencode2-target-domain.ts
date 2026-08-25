import type { CoreResult } from "@pi-oc2/core";
import type { ResolvedPortCapabilities } from "@pi-oc2/core/capabilities";
import type { PiPackageAnalysis } from "@pi-oc2/core/domain";
import type { PortabilityManifest } from "@pi-oc2/core/manifest";
import type { OpenCode2PortableModuleFailure } from "./copy-opencode2-portable-modules.js";

/** All validated compiler inputs and roots needed to emit one OpenCode 2 target. */
export interface GenerateOpenCode2TargetInput {
  readonly analysis: PiPackageAnalysis;
  readonly manifest: PortabilityManifest;
  readonly resolvedCapabilities: ResolvedPortCapabilities;
  readonly portRoot: string;
  readonly outputRoot: string;
}

/** The generated target root and its lexically ordered target-relative files. */
export interface GeneratedOpenCode2Target {
  readonly targetRoot: string;
  readonly files: readonly string[];
  readonly targetProfile: "opencode2-dev-18204+plugin-dev-18204+promise-tool-domain";
}

/** An expected target-generation failure that callers can report without parsing thrown errors. */
export type OpenCode2TargetFailure =
  | OpenCode2PortableModuleFailure
  | {
      readonly code: "OPENCODE2_TOOL_NAME_MISSING";
      readonly message: string;
      readonly sourcePath: string;
      readonly sourceLine: number;
    }
  | {
      readonly code: "OPENCODE2_TOOL_NAME_DUPLICATE";
      readonly message: string;
      readonly toolName: string;
    }
  | {
      readonly code: "OPENCODE2_TOOL_SCHEMA_MISSING" | "OPENCODE2_TOOL_SCHEMA_UNSUPPORTED";
      readonly message: string;
      readonly toolName: string;
    }
  | {
      readonly code: "OPENCODE2_TOOL_EXECUTOR_MISSING";
      readonly message: string;
      readonly toolName: string;
      readonly capabilityId?: string;
      readonly module?: string;
    }
  | {
      readonly code: "OPENCODE2_UNSUPPORTED_TARGET_FEATURE";
      readonly message: string;
      readonly capabilityId: string;
      readonly capability: string;
    }
  | {
      readonly code: "OPENCODE2_TARGET_OVERRIDE_MISSING";
      readonly message: string;
      readonly capabilityId: string;
      readonly module: string;
    }
  | {
      readonly code:
        | "OPENCODE2_SKILL_SOURCE_MISSING"
        | "OPENCODE2_SKILL_TARGET_DUPLICATE"
        | "OPENCODE2_SKILL_TARGET_INVALID";
      readonly message: string;
      readonly skillPath: string;
    }
  | {
      readonly code: "OPENCODE2_WRITE_FAILED";
      readonly message: string;
      readonly path: string;
    };

/** Tagged result returned for deterministic target generation and expected failures. */
export type GenerateOpenCode2TargetResult = CoreResult<GeneratedOpenCode2Target, OpenCode2TargetFailure>;
