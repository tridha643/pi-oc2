import { describe, expect, it } from "vitest";
import { analyzePiExtensionAst } from "./analyze-pi-extension-ast.js";

describe("analyzePiExtensionAst", () => {
  it("extracts static tools, literal hooks and commands, and explicit nonportable findings", () => {
    const analysis = analyzePiExtensionAst(
      "extensions/example.ts",
      `
        import { defineTool } from "pi";
        const NestedSchema = Type.Object({ tag: Type.String() });
        const NamedParameters = Type.Object({ value: Type.String(), nested: NestedSchema });
        const namedTool = defineTool({
          name: "named",
          description: "Named tool",
          parameters: NamedParameters,
          execute() {}
        });
        const extension = (pi) => {
          pi.registerTool(namedTool);
          pi.registerTool({ name: "computed", parameters: makeSchema(), execute() {} });
          pi.registerTool({ name: "unsupported", parameters: Type.Record(Type.String(), Type.String()), execute() {} });
          pi.on("session_start", () => {});
          pi.registerCommand("hello", { handler: (_args, ctx) => ctx.ui.notify("hi") });
          pi.registerProvider("custom", {});
          if (enabled) pi.registerTool(namedTool);
        };
        export default extension;
      `,
    );

    expect(analysis.hasDefaultExportFactory).toBe(true);
    expect(analysis.tools.map((tool) => [tool.name, tool.registration, tool.schemaStatus])).toEqual([
      ["computed", "inline-object", "computed"],
      ["named", "define-tool-identifier", "supported"],
      ["unsupported", "inline-object", "unsupported"],
    ]);
    expect(analysis.events).toEqual(["session_start"]);
    expect(analysis.commands).toEqual(["hello"]);
    expect(analysis.tools.find((tool) => tool.name === "named")?.schema).toEqual({
      type: "object",
      properties: {
        value: { type: "string" },
        nested: { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] },
      },
      required: ["nested", "value"],
    });
    expect(analysis.findings.map((entry) => entry.capability)).toEqual(
      expect.arrayContaining(["computed-schema", "unsupported-schema", "ui", "provider", "dynamic-registration"]),
    );
    expect(analysis.findings.find((entry) => entry.capability === "computed-schema")?.classification).toBe("scaffold");
    expect(analysis.findings.find((entry) => entry.capability === "unsupported-schema")?.classification).toBe("unsupported");
  });
});
