/** Generates the pinned Promise server, native tools, TUI, skills, and config artifacts. */
export { generateOpenCode2Target } from "./generate-target.js";

/** Public input, output, and expected failure contracts for OpenCode 2 generation. */
export type {
  GenerateOpenCode2TargetInput,
  GeneratedOpenCode2Target,
  OpenCode2TargetFailure,
} from "./opencode2-target-domain.js";
