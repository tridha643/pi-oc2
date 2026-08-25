import { describe, expect, it } from "vitest";
import { renderOpenCode2Schema, renderOpenCode2ToolInput } from "./render-opencode2-schema.js";

describe("renderOpenCode2Schema", () => {
  it("renders the complete supported static subset as deterministic Effect Schema expressions", () => {
    const rendered = renderOpenCode2ToolInput({
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, maxLength: 10, pattern: "^[a-z]+$" },
        count: { type: "integer", minimum: 0, maximum: 9 },
        ratio: { type: "number" },
        enabled: { type: "boolean", title: "Enabled flag", default: true },
        tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
        nested: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        mode: { type: "string", enum: ["fast", "safe"] },
        choice: { anyOf: [{ type: "string" }, { enum: [4] }] },
      },
      required: ["choice", "count", "enabled", "mode", "nested", "ratio", "tags", "text"],
    });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.expression).toContain('"choice": Schema.Union([Schema.String, Schema.Literal(4)])');
    expect(rendered.expression).toContain(
      '"count": Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(9))',
    );
    expect(rendered.expression).toContain(
      '"enabled": Schema.Boolean.annotate({ title: "Enabled flag", default: true })',
    );
    expect(rendered.expression).toContain(
      '"mode": Schema.Literals(["fast","safe"])',
    );
    expect(rendered.expression).toContain('"nested": Schema.Struct({');
    expect(rendered.expression).toContain(
      '"tags": Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(3))',
    );
    expect(rendered.expression).toContain(
      '"text": Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(10), Schema.isPattern(new RegExp("^[a-z]+$", "u")))',
    );
    expect(rendered.expression.indexOf('"choice"')).toBeLessThan(rendered.expression.indexOf('"count"'));
  });

  it("fails closed for target formats and top-level shapes without native mappings", () => {
    expect(renderOpenCode2Schema({ type: "string", format: "custom-format" })).toEqual({
      ok: false,
      message: "OpenCode 2 has no deterministic Effect Schema mapping for string format: custom-format",
    });
    expect(renderOpenCode2ToolInput({ type: "string" })).toEqual({
      ok: false,
      message: "OpenCode 2 tool input requires a top-level object schema with properties.",
    });
  });
});
