import type { StaticJsonSchema } from "@pi-oc2/core";

const schemaOptionNames = [
  "additionalProperties",
  "default",
  "description",
  "format",
  "maxItems",
  "maxLength",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "pattern",
  "title",
] as const;

function compareLexicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function emitValue(value: unknown): string {
  return JSON.stringify(value);
}

function emitSchemaOptions(schema: StaticJsonSchema, excluded: ReadonlySet<string> = new Set()): string {
  const options = schemaOptionNames.flatMap((name) => {
    const value = schema[name];
    return value === undefined || excluded.has(name) ? [] : [`${name}: ${emitValue(value)}`];
  });
  return options.length === 0 ? "" : `, { ${options.join(", ")} }`;
}

function emitObjectSchema(schema: StaticJsonSchema): string {
  const required = new Set(schema.required ?? []);
  const properties = Object.entries(schema.properties ?? {})
    .sort(([left], [right]) => compareLexicalText(left, right))
    .map(([name, property]) => {
      const expression = emitPiToolSchema(property);
      return `${JSON.stringify(name)}: ${required.has(name) ? expression : `Type.Optional(${expression})`}`;
    });
  return `Type.Object({ ${properties.join(", ")} }${emitSchemaOptions(schema)})`;
}

function emitEnumSchema(schema: StaticJsonSchema): string | undefined {
  const values = schema.enum;
  if (values === undefined) {
    return undefined;
  }
  if (schema.type === "string" && values.every((value) => typeof value === "string")) {
    return `StringEnum(${emitValue(values)} as const${emitSchemaOptions(schema, new Set(["additionalProperties"]))})`;
  }
  if (values.length === 1) {
    return `Type.Literal(${emitValue(values[0])}${emitSchemaOptions(schema)})`;
  }
  return `Type.Union([${values.map((value) => `Type.Literal(${emitValue(value)})`).join(", ")}]${emitSchemaOptions(schema)})`;
}

/** Recreates one normalized static schema with deterministic TypeBox builder syntax. */
export function emitPiToolSchema(schema: StaticJsonSchema): string {
  const enumExpression = emitEnumSchema(schema);
  if (enumExpression !== undefined) {
    return enumExpression;
  }
  if (schema.anyOf !== undefined) {
    return `Type.Union([${schema.anyOf.map(emitPiToolSchema).join(", ")}]${emitSchemaOptions(schema)})`;
  }
  switch (schema.type) {
    case "object":
      return emitObjectSchema(schema);
    case "array":
      if (schema.items === undefined) {
        throw new Error("Pi schema emission invariant failed: array schema has no items.");
      }
      return `Type.Array(${emitPiToolSchema(schema.items)}${emitSchemaOptions(schema)})`;
    case "string":
      return `Type.String(${emitSchemaOptions(schema).slice(2)})`;
    case "number":
      return `Type.Number(${emitSchemaOptions(schema).slice(2)})`;
    case "integer":
      return `Type.Integer(${emitSchemaOptions(schema).slice(2)})`;
    case "boolean":
      return `Type.Boolean(${emitSchemaOptions(schema).slice(2)})`;
    case undefined:
      throw new Error("Pi schema emission invariant failed: schema has no supported shape.");
  }
  throw new Error(`Pi schema emission invariant failed: unsupported schema type: ${String(schema.type)}`);
}
