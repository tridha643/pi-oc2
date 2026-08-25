import ts from "typescript-compiler";
import { describe, expect, it } from "vitest";
import { extractStaticToolSchema } from "./typebox-schema-ast.js";

function expression(source: string): ts.Expression {
  const sourceFile = ts.createSourceFile("schema.ts", `const schema = ${source};`, ts.ScriptTarget.Latest, true);
  const statement = sourceFile.statements[0];
  if (!statement || !ts.isVariableStatement(statement)) {
    throw new Error("Test schema did not produce a variable statement.");
  }
  const initializer = statement.declarationList.declarations[0]?.initializer;
  if (initializer === undefined) {
    throw new Error("Test schema did not produce an initializer.");
  }
  return initializer;
}

describe("extractStaticToolSchema", () => {
  it("normalizes the supported TypeBox and StringEnum subset", () => {
    const result = extractStaticToolSchema(
      expression(`Type.Object({
        active: Type.Boolean(),
        count: Type.Optional(Type.Integer({ minimum: 0 })),
        mode: StringEnum(["fast", "safe"] as const),
        nested: Type.Array(Type.Union([Type.String(), Type.Literal(4)]))
      }, { additionalProperties: false })`),
    );

    expect(result).toEqual({
      status: "supported",
      schema: {
        type: "object",
        properties: {
          active: { type: "boolean" },
          count: { type: "integer", minimum: 0 },
          mode: { type: "string", enum: ["fast", "safe"] },
          nested: { type: "array", items: { anyOf: [{ type: "string" }, { enum: [4] }] } },
        },
        required: ["active", "mode", "nested"],
        additionalProperties: false,
      },
    });
  });

  it("separates unsupported static calls from computed expressions", () => {
    expect(extractStaticToolSchema(expression("Type.Record(Type.String(), Type.Number())")).status).toBe("unsupported");
    expect(extractStaticToolSchema(expression("buildSchema()")).status).toBe("computed");
  });
});
