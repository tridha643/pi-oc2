/** Main static Pi package analyzer. */
export { analyzePiPackage } from "./analyze-pi-package.js";

/** Stable public analysis and portable execution domain types. */
export type {
  AgentSkill,
  CapabilityFinding,
  PiPackageAnalysis,
  PiToolAnalysis,
  PortableToolContext,
  PortableToolResult,
  PortableToolUpdate,
  StaticJsonSchema,
} from "./core-domain.js";

/** Tagged result type used for expected compiler outcomes. */
export type { CoreResult } from "./core-result.js";
