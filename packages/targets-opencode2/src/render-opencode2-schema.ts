import type { StaticJsonSchema } from "@pi-oc2/core/domain";

/** A rendered Effect Schema expression or a target-specific schema failure. */
export type RenderOpenCode2SchemaResult =
  | { readonly ok: true; readonly expression: string }
  | { readonly ok: false; readonly message: string };

function schemaFailure(message: string): RenderOpenCode2SchemaResult {
  return { ok: false, message };
}

function appendSchemaAnnotations(expression: string, schema: StaticJsonSchema): RenderOpenCode2SchemaResult {
  const annotations: string[] = [];
  if (schema.title !== undefined) annotations.push(`title: ${JSON.stringify(schema.title)}`);
  if (schema.description !== undefined) annotations.push(`description: ${JSON.stringify(schema.description)}`);
  if (schema.format !== undefined) annotations.push(`format: ${JSON.stringify(schema.format)}`);
  if (schema.default !== undefined) annotations.push(`default: ${JSON.stringify(schema.default)}`);
  return {
    ok: true,
    expression: annotations.length === 0 ? expression : `${expression}.annotate({ ${annotations.join(", ")} })`,
  };
}

function renderEnumSchema(schema: StaticJsonSchema): RenderOpenCode2SchemaResult | undefined {
  if (schema.enum === undefined) return undefined;
  const expression = schema.enum.length === 0
    ? "Schema.Never"
    : schema.enum.length === 1
      ? `Schema.Literal(${JSON.stringify(schema.enum[0])})`
      : `Schema.Literals(${JSON.stringify(schema.enum)})`;
  return appendSchemaAnnotations(expression, schema);
}

function renderUnionSchema(schema: StaticJsonSchema): RenderOpenCode2SchemaResult | undefined {
  if (schema.anyOf === undefined) return undefined;
  if (schema.anyOf.length === 0) return appendSchemaAnnotations("Schema.Never", schema);
  const members: string[] = [];
  for (const member of schema.anyOf) {
    const rendered = renderOpenCode2Schema(member);
    if (!rendered.ok) return rendered;
    members.push(rendered.expression);
  }
  const expression = members.length === 1 ? members[0]! : `Schema.Union([${members.join(", ")}])`;
  return appendSchemaAnnotations(expression, schema);
}

function renderStringSchema(schema: StaticJsonSchema): RenderOpenCode2SchemaResult {
  const checks: string[] = [];
  if (schema.minLength !== undefined) checks.push(`Schema.isMinLength(${schema.minLength})`);
  if (schema.maxLength !== undefined) checks.push(`Schema.isMaxLength(${schema.maxLength})`);
  if (schema.pattern !== undefined) {
    try {
      new RegExp(schema.pattern, "u");
    } catch {
      return schemaFailure(`OpenCode 2 cannot render invalid regular expression pattern: ${schema.pattern}`);
    }
    checks.push(`Schema.isPattern(new RegExp(${JSON.stringify(schema.pattern)}, "u"))`);
  }
  const supportedFormats = new Set(["email", "uri", "url", "uuid", "date-time", "date", "time", "ipv4", "ipv6"]);
  if (schema.format !== undefined && !supportedFormats.has(schema.format)) {
    return schemaFailure(`OpenCode 2 has no deterministic Effect Schema mapping for string format: ${schema.format}`);
  }
  const expression = checks.length === 0 ? "Schema.String" : `Schema.String.check(${checks.join(", ")})`;
  return appendSchemaAnnotations(expression, schema);
}

function renderNumberSchema(schema: StaticJsonSchema): RenderOpenCode2SchemaResult {
  const checks: string[] = [];
  if (schema.minimum !== undefined) checks.push(`Schema.isGreaterThanOrEqualTo(${schema.minimum})`);
  if (schema.maximum !== undefined) checks.push(`Schema.isLessThanOrEqualTo(${schema.maximum})`);
  const base = schema.type === "integer" ? "Schema.Int" : "Schema.Finite";
  const expression = checks.length === 0 ? base : `${base}.check(${checks.join(", ")})`;
  return appendSchemaAnnotations(expression, schema);
}

function renderArraySchema(schema: StaticJsonSchema): RenderOpenCode2SchemaResult {
  if (schema.items === undefined) {
    return schemaFailure("OpenCode 2 array schemas require an item schema.");
  }
  const item = renderOpenCode2Schema(schema.items);
  if (!item.ok) return item;
  const checks: string[] = [];
  if (schema.minItems !== undefined) checks.push(`Schema.isMinLength(${schema.minItems})`);
  if (schema.maxItems !== undefined) checks.push(`Schema.isMaxLength(${schema.maxItems})`);
  const array = `Schema.Array(${item.expression})`;
  const expression = checks.length === 0 ? array : `${array}.check(${checks.join(", ")})`;
  return appendSchemaAnnotations(expression, schema);
}

function renderObjectSchema(schema: StaticJsonSchema): RenderOpenCode2SchemaResult {
  const required = new Set(schema.required ?? []);
  const properties: string[] = [];
  for (const [name, propertySchema] of Object.entries(schema.properties ?? {}).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    const property = renderOpenCode2Schema(propertySchema);
    if (!property.ok) return property;
    const expression = required.has(name) ? property.expression : `Schema.optionalKey(${property.expression})`;
    properties.push(`${JSON.stringify(name)}: ${expression}`);
  }
  const struct = `Schema.Struct({${properties.length === 0 ? "" : `\n${properties.map((line) => `      ${line},`).join("\n")}\n    `}})`;
  const expression = schema.additionalProperties === false
    ? struct
    : `Schema.StructWithRest(${struct}, [Schema.Record(Schema.String, Schema.Unknown)])`;
  return appendSchemaAnnotations(expression, schema);
}

/** Renders the supported static JSON-schema subset as an Effect Schema expression. */
export function renderOpenCode2Schema(schema: StaticJsonSchema): RenderOpenCode2SchemaResult {
  const enumSchema = renderEnumSchema(schema);
  if (enumSchema !== undefined) return enumSchema;
  const unionSchema = renderUnionSchema(schema);
  if (unionSchema !== undefined) return unionSchema;

  switch (schema.type) {
    case "string":
      return renderStringSchema(schema);
    case "number":
    case "integer":
      return renderNumberSchema(schema);
    case "boolean":
      return appendSchemaAnnotations("Schema.Boolean", schema);
    case "array":
      return renderArraySchema(schema);
    case "object":
      return renderObjectSchema(schema);
    case undefined:
      return schemaFailure("OpenCode 2 cannot render a schema without type, enum, or anyOf.");
    default:
      return schemaFailure(`OpenCode 2 cannot render unknown schema type: ${String(schema.type)}`);
  }
}

/** Renders the required top-level object schema for one Promise-domain tool input. */
export function renderOpenCode2ToolInput(schema: StaticJsonSchema): RenderOpenCode2SchemaResult {
  if (schema.type !== "object" || schema.properties === undefined) {
    return schemaFailure("OpenCode 2 tool input requires a top-level object schema with properties.");
  }
  return renderObjectSchema(schema);
}
