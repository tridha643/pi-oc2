/** A JSON primitive accepted by deterministic compiler artifacts. */
export type JsonPrimitive = string | number | boolean | null;

/** A recursively readonly JSON value accepted by deterministic compiler artifacts. */
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** A statically normalized subset of JSON Schema. */
export interface StaticJsonSchema {
  readonly type?: "object" | "string" | "number" | "integer" | "boolean" | "array";
  readonly properties?: Readonly<Record<string, StaticJsonSchema>>;
  readonly required?: readonly string[];
  readonly items?: StaticJsonSchema;
  readonly enum?: readonly JsonPrimitive[];
  readonly anyOf?: readonly StaticJsonSchema[];
  readonly title?: string;
  readonly description?: string;
  readonly default?: JsonPrimitive;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly pattern?: string;
  readonly format?: string;
  readonly additionalProperties?: boolean;
}

/** The package resource kinds understood by Pi's package manifest. */
export type PiResourceKind = "extension" | "skill" | "prompt" | "theme";

/** One loadable Pi package resource, expressed relative to the package root. */
export interface PiResource {
  readonly kind: PiResourceKind;
  readonly path: string;
}

/** One file included in a package's deterministic source identity. */
export interface AnalyzedSourceFile {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
}

/** The supported shapes accepted as an analysis source. */
export type PiPackageSourceKind = "package" | "bare-skill";

/** Parsed package metadata and lexically ordered resource declarations. */
export interface PiPackageSource {
  readonly kind: PiPackageSourceKind;
  readonly rootPath: string;
  readonly packageName: string;
  readonly manifestPath?: string;
  readonly resources: readonly PiResource[];
  readonly analyzedPaths: readonly string[];
}

/** The directness of a discovered capability in the first compiler slice. */
export type CapabilityClassification = "direct" | "scaffold" | "unsupported";

/** A searchable category for behavior discovered without executing source code. */
export type PiCapabilityKind =
  | "extension-factory"
  | "tool"
  | "event-hook"
  | "command"
  | "ui"
  | "dynamic-registration"
  | "provider"
  | "computed-schema"
  | "unsupported-schema"
  | "skill"
  | "prompt"
  | "theme";

/** A source location using a normalized package-relative path and one-based coordinates. */
export interface SourceLocation {
  readonly path: string;
  readonly line: number;
  readonly column: number;
}

/** One independently resolvable behavior discovered by static analysis. */
export interface CapabilityFinding {
  readonly id: string;
  readonly capability: PiCapabilityKind;
  readonly classification: CapabilityClassification;
  readonly required: boolean;
  readonly message: string;
  readonly source: SourceLocation;
  readonly symbol?: string;
}

/** How a tool descriptor reached pi.registerTool. */
export type ToolRegistrationKind = "inline-object" | "define-tool-identifier";

/** Static schema support status for a discovered tool descriptor. */
export type ToolSchemaStatus = "supported" | "unsupported" | "computed" | "missing";

/** A tool descriptor extracted from TypeScript syntax without evaluating it. */
export interface PiToolAnalysis {
  readonly registration: ToolRegistrationKind;
  readonly name?: string;
  readonly description?: string;
  readonly schemaStatus: ToolSchemaStatus;
  readonly schema?: StaticJsonSchema;
  readonly source: SourceLocation;
}

/** The static result for one extension entry point. */
export interface PiExtensionAnalysis {
  readonly path: string;
  readonly hasDefaultExportFactory: boolean;
  readonly tools: readonly PiToolAnalysis[];
  readonly events: readonly string[];
  readonly commands: readonly string[];
  readonly findings: readonly CapabilityFinding[];
}

/** Parsed Agent Skill frontmatter plus the unchanged Markdown body. */
export interface AgentSkill {
  readonly path: string;
  readonly name: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly allowedTools?: readonly string[];
  readonly metadata?: Readonly<Record<string, JsonPrimitive>>;
  readonly body: string;
}

/** Complete deterministic static analysis of one Pi package or bare skill. */
export interface PiPackageAnalysis {
  readonly schemaVersion: 1;
  readonly packageName: string;
  readonly sourceKind: PiPackageSourceKind;
  readonly sourceHash: string;
  readonly files: readonly AnalyzedSourceFile[];
  readonly resources: readonly PiResource[];
  readonly extensions: readonly PiExtensionAnalysis[];
  readonly skills: readonly AgentSkill[];
  readonly findings: readonly CapabilityFinding[];
}

/** A portable tool progress update emitted to either generated host adapter. */
export interface PortableToolUpdate {
  readonly text?: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

/** The host-neutral execution context supplied to a portable tool. */
export interface PortableToolContext {
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly sessionId?: string;
  readonly update: (update: PortableToolUpdate) => void;
}

/** The host-neutral result returned by a portable tool. */
export interface PortableToolResult {
  readonly text: string;
  readonly title?: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

/** A compiler lock whose serialized bytes identify source and target inputs. */
export interface PiocLock {
  readonly schemaVersion: 1;
  readonly generatorVersion: string;
  readonly sourceHash: string;
  readonly targetProfile: string;
}
