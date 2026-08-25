import ts from "typescript-compiler";
import type { JsonPrimitive, StaticJsonSchema } from "./core-domain.js";
import { compareLexicalText } from "./pi-source-paths.js";

/** A TypeBox expression normalized entirely from syntax. */
export interface SupportedStaticSchema {
  readonly status: "supported";
  readonly schema: StaticJsonSchema;
}

/** A schema expression whose value depends on runtime computation. */
export interface ComputedStaticSchema {
  readonly status: "computed";
  readonly reason: string;
}

/** A static TypeBox call outside the compiler's supported schema subset. */
export interface UnsupportedStaticSchema {
  readonly status: "unsupported";
  readonly reason: string;
}

/** The conservative result of statically inspecting one tool schema expression. */
export type StaticSchemaAnalysis = SupportedStaticSchema | ComputedStaticSchema | UnsupportedStaticSchema;

/** Top-level constant expressions available for safe identifier resolution during schema analysis. */
export type StaticSchemaBindings = ReadonlyMap<string, ts.Expression>;

interface InternalSchema {
  readonly schema: StaticJsonSchema;
  readonly optional: boolean;
}

type InternalSchemaResult =
  | { readonly status: "supported"; readonly value: InternalSchema }
  | ComputedStaticSchema
  | UnsupportedStaticSchema;

function computed(reason: string): ComputedStaticSchema {
  return { status: "computed", reason };
}

function unsupported(reason: string): UnsupportedStaticSchema {
  return { status: "unsupported", reason };
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function unwrapStaticExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function staticPrimitive(input: ts.Expression): JsonPrimitive | undefined {
  const expression = unwrapStaticExpression(input);
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  if (ts.isNumericLiteral(expression)) {
    return Number(expression.text);
  }
  if (expression.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (expression.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  }
  if (expression.kind === ts.SyntaxKind.NullKeyword) {
    return null;
  }
  if (
    ts.isPrefixUnaryExpression(expression) &&
    expression.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expression.operand)
  ) {
    return -Number(expression.operand.text);
  }
  return undefined;
}

function callName(expression: ts.LeftHandSideExpression): string | undefined {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  return undefined;
}

function parseSchemaOptions(expression: ts.Expression | undefined): StaticSchemaAnalysis {
  if (expression === undefined) {
    return { status: "supported", schema: {} };
  }
  const optionsExpression = unwrapStaticExpression(expression);
  if (!ts.isObjectLiteralExpression(optionsExpression)) {
    return computed("Schema options are not an object literal.");
  }

  const options: Record<string, JsonPrimitive> = {};
  const stringKeys = new Set(["description", "format", "pattern", "title"]);
  const numberKeys = new Set(["maximum", "maxItems", "maxLength", "minimum", "minItems", "minLength"]);
  const booleanKeys = new Set(["additionalProperties"]);
  for (const property of optionsExpression.properties) {
    if (!ts.isPropertyAssignment(property)) {
      return computed("Schema options contain a computed or spread property.");
    }
    const key = propertyNameText(property.name);
    if (key === undefined) {
      return computed("Schema option name is computed.");
    }
    if (key !== "default" && !stringKeys.has(key) && !numberKeys.has(key) && !booleanKeys.has(key)) {
      return unsupported(`Schema option is outside the supported subset: ${key}`);
    }
    const value = staticPrimitive(property.initializer);
    if (value === undefined) {
      return computed(`Schema option is not a literal: ${key}`);
    }
    if (stringKeys.has(key) && typeof value !== "string") {
      return unsupported(`Schema option must be a string: ${key}`);
    }
    if (numberKeys.has(key) && typeof value !== "number") {
      return unsupported(`Schema option must be a number: ${key}`);
    }
    if (booleanKeys.has(key) && typeof value !== "boolean") {
      return unsupported(`Schema option must be a boolean: ${key}`);
    }
    options[key] = value;
  }
  // SAFETY: The loop above accepts only StaticJsonSchema option keys and validates each value's primitive type.
  return { status: "supported", schema: options as StaticJsonSchema };
}

function mergeOptions(schema: StaticJsonSchema, expression: ts.Expression | undefined): InternalSchemaResult {
  const parsedOptions = parseSchemaOptions(expression);
  if (parsedOptions.status !== "supported") {
    return parsedOptions;
  }
  return { status: "supported", value: { schema: { ...schema, ...parsedOptions.schema }, optional: false } };
}

function analyzeObject(call: ts.CallExpression, bindings: StaticSchemaBindings): InternalSchemaResult {
  const propertiesExpression = call.arguments[0] === undefined ? undefined : unwrapStaticExpression(call.arguments[0]);
  if (propertiesExpression === undefined || !ts.isObjectLiteralExpression(propertiesExpression)) {
    return computed("Type.Object properties are not an object literal.");
  }

  const properties: Record<string, StaticJsonSchema> = {};
  const required: string[] = [];
  for (const property of propertiesExpression.properties) {
    if (!ts.isPropertyAssignment(property)) {
      return computed("Type.Object contains a computed, shorthand, or spread property.");
    }
    const key = propertyNameText(property.name);
    if (key === undefined) {
      return computed("Type.Object property name is computed.");
    }
    const propertySchema = analyzeInternalSchema(property.initializer, bindings);
    if (propertySchema.status !== "supported") {
      return propertySchema;
    }
    properties[key] = propertySchema.value.schema;
    if (!propertySchema.value.optional) {
      required.push(key);
    }
  }

  const baseSchema: StaticJsonSchema = {
    type: "object",
    properties,
    required: required.sort(compareLexicalText),
  };
  return mergeOptions(baseSchema, call.arguments[1]);
}

function analyzeArray(call: ts.CallExpression, bindings: StaticSchemaBindings): InternalSchemaResult {
  const itemExpression = call.arguments[0];
  if (itemExpression === undefined) {
    return unsupported("Type.Array requires an item schema.");
  }
  const itemSchema = analyzeInternalSchema(itemExpression, bindings);
  if (itemSchema.status !== "supported") {
    return itemSchema;
  }
  if (itemSchema.value.optional) {
    return unsupported("Type.Optional cannot be used as an array item schema.");
  }
  return mergeOptions({ type: "array", items: itemSchema.value.schema }, call.arguments[1]);
}

function analyzeLiteral(call: ts.CallExpression): InternalSchemaResult {
  const literalExpression = call.arguments[0];
  if (literalExpression === undefined) {
    return unsupported("Type.Literal requires a literal value.");
  }
  const value = staticPrimitive(literalExpression);
  if (value === undefined) {
    return computed("Type.Literal value is computed.");
  }
  return mergeOptions({ enum: [value] }, call.arguments[1]);
}

function analyzeUnion(call: ts.CallExpression, bindings: StaticSchemaBindings): InternalSchemaResult {
  const membersExpression = call.arguments[0] === undefined ? undefined : unwrapStaticExpression(call.arguments[0]);
  if (membersExpression === undefined || !ts.isArrayLiteralExpression(membersExpression)) {
    return computed("Type.Union members are not an array literal.");
  }
  const anyOf: StaticJsonSchema[] = [];
  for (const member of membersExpression.elements) {
    const memberSchema = analyzeInternalSchema(member, bindings);
    if (memberSchema.status !== "supported") {
      return memberSchema;
    }
    if (memberSchema.value.optional) {
      return unsupported("Type.Optional cannot be used as a union member.");
    }
    anyOf.push(memberSchema.value.schema);
  }
  return mergeOptions({ anyOf }, call.arguments[1]);
}

function analyzeStringEnum(call: ts.CallExpression): InternalSchemaResult {
  const valuesExpression = call.arguments[0] === undefined ? undefined : unwrapStaticExpression(call.arguments[0]);
  if (valuesExpression === undefined || !ts.isArrayLiteralExpression(valuesExpression)) {
    return computed("StringEnum values are not an array literal.");
  }
  const values: string[] = [];
  for (const element of valuesExpression.elements) {
    const value = staticPrimitive(element);
    if (typeof value !== "string") {
      return computed("StringEnum contains a non-literal string value.");
    }
    values.push(value);
  }
  return mergeOptions({ type: "string", enum: values }, call.arguments[1]);
}

function analyzeInternalSchema(input: ts.Expression, bindings: StaticSchemaBindings): InternalSchemaResult {
  const expression = unwrapStaticExpression(input);
  if (ts.isIdentifier(expression)) {
    const boundExpression = bindings.get(expression.text);
    if (boundExpression === undefined) {
      return computed(`Schema identifier cannot be resolved statically: ${expression.text}`);
    }
    const remainingBindings = new Map(bindings);
    remainingBindings.delete(expression.text);
    return analyzeInternalSchema(boundExpression, remainingBindings);
  }
  if (!ts.isCallExpression(expression)) {
    return computed("Schema value is not a supported static call expression.");
  }
  const name = callName(expression.expression);
  const isTypeMethod =
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === "Type";
  if (name !== "StringEnum" && !isTypeMethod) {
    return computed(`Schema helper is not statically recognized: ${name ?? "unknown"}`);
  }
  switch (name) {
    case "Object":
      return analyzeObject(expression, bindings);
    case "String":
      return mergeOptions({ type: "string" }, expression.arguments[0]);
    case "Number":
      return mergeOptions({ type: "number" }, expression.arguments[0]);
    case "Integer":
      return mergeOptions({ type: "integer" }, expression.arguments[0]);
    case "Boolean":
      return mergeOptions({ type: "boolean" }, expression.arguments[0]);
    case "Array":
      return analyzeArray(expression, bindings);
    case "Literal":
      return analyzeLiteral(expression);
    case "Union":
      return analyzeUnion(expression, bindings);
    case "StringEnum":
      return analyzeStringEnum(expression);
    case "Optional": {
      const innerExpression = expression.arguments[0];
      if (innerExpression === undefined) {
        return unsupported("Type.Optional requires an inner schema.");
      }
      const innerSchema = analyzeInternalSchema(innerExpression, bindings);
      if (innerSchema.status !== "supported") {
        return innerSchema;
      }
      return { status: "supported", value: { schema: innerSchema.value.schema, optional: true } };
    }
    default:
      if (ts.isPropertyAccessExpression(expression.expression)) {
        return unsupported(`TypeBox call is outside the supported subset: ${name ?? "unknown"}`);
      }
      return computed(`Schema helper is not statically recognized: ${name ?? "unknown"}`);
  }
}

/** Normalizes supported TypeBox syntax into serializable JSON Schema without evaluation. */
export function extractStaticToolSchema(
  expression: ts.Expression,
  bindings: StaticSchemaBindings = new Map(),
): StaticSchemaAnalysis {
  const result = analyzeInternalSchema(expression, bindings);
  if (result.status !== "supported") {
    return result;
  }
  if (result.value.optional) {
    return unsupported("Type.Optional is only supported on Type.Object properties.");
  }
  return { status: "supported", schema: result.value.schema };
}
