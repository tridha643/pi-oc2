import {
  generatePiTarget,
  type GeneratePiTargetInput,
  type GeneratePiTargetResult,
} from "@pi-oc2/target-pi";
import {
  generateOpenCode2Target,
  type GenerateOpenCode2TargetInput,
  type GeneratedOpenCode2Target,
  type OpenCode2TargetFailure,
} from "@pi-oc2/target-opencode2";
import { cliSuccess, type CoreResult } from "./cli-result.js";

export type { GeneratePiTargetInput, GeneratePiTargetResult } from "@pi-oc2/target-pi";
export type { GenerateOpenCode2TargetInput, GeneratedOpenCode2Target, OpenCode2TargetFailure } from "@pi-oc2/target-opencode2";

/** OpenCode 2 target generation result reconstructed from the package's exported domain types. */
export type GenerateOpenCode2TargetResult = CoreResult<GeneratedOpenCode2Target, OpenCode2TargetFailure>;

/** Callable Pi target generator contract used by CLI commands and test seams. */
export type GeneratePiTargetFunction = (input: GeneratePiTargetInput) => Promise<GeneratePiTargetResult>;

/** Callable OpenCode 2 target generator contract used by CLI commands and test seams. */
export type GenerateOpenCode2TargetFunction = (input: GenerateOpenCode2TargetInput) => Promise<GenerateOpenCode2TargetResult>;

/** Kept as a stable CLI error contract for corrupted package installations. */
export interface TargetGeneratorUnavailable {
  readonly code: "TARGET_GENERATOR_UNAVAILABLE";
  readonly packageName: string;
  readonly message: string;
}

/** Returns the installed, statically typed Pi target generator dependency. */
export function loadPiTargetGenerator(): Promise<CoreResult<GeneratePiTargetFunction, TargetGeneratorUnavailable>> {
  return Promise.resolve(cliSuccess(generatePiTarget));
}

/** Returns the installed, statically typed OpenCode 2 target generator dependency. */
export function loadOpenCode2TargetGenerator(): Promise<CoreResult<GenerateOpenCode2TargetFunction, TargetGeneratorUnavailable>> {
  return Promise.resolve(cliSuccess(generateOpenCode2Target));
}
