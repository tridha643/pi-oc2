import { extname } from "node:path";
import ts from "typescript-compiler";
import type {
  CapabilityClassification,
  CapabilityFinding,
  PiCapabilityKind,
  PiExtensionAnalysis,
  PiToolAnalysis,
  SourceLocation,
  ToolRegistrationKind,
} from "./core-domain.js";
import { extractStaticToolSchema, type StaticSchemaBindings } from "./typebox-schema-ast.js";
import { compareLexicalText } from "./pi-source-paths.js";

interface ExtensionFactory {
  readonly declaration: ts.FunctionLikeDeclaration;
  readonly body: ts.Block;
  readonly apiName: string;
}

function hasDefaultModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) === true;
}

function asFunctionLike(node: ts.Node | undefined): ts.FunctionLikeDeclaration | undefined {
  if (node !== undefined && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))) {
    return node;
  }
  return undefined;
}

function findDefaultExportFactory(sourceFile: ts.SourceFile): ExtensionFactory | undefined {
  const declarations = new Map<string, ts.FunctionLikeDeclaration>();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      declarations.set(statement.name.text, statement);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          const functionLike = asFunctionLike(declaration.initializer);
          if (functionLike !== undefined) {
            declarations.set(declaration.name.text, functionLike);
          }
        }
      }
    }
  }

  let functionLike: ts.FunctionLikeDeclaration | undefined;
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && hasDefaultModifier(statement)) {
      functionLike = statement;
      break;
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      functionLike = asFunctionLike(statement.expression);
      if (functionLike === undefined && ts.isIdentifier(statement.expression)) {
        functionLike = declarations.get(statement.expression.text);
      }
      break;
    }
  }

  const firstParameter = functionLike?.parameters[0];
  if (functionLike?.body === undefined || !ts.isBlock(functionLike.body) || firstParameter === undefined || !ts.isIdentifier(firstParameter.name)) {
    return undefined;
  }
  return { declaration: functionLike, body: functionLike.body, apiName: firstParameter.name.text };
}

function scriptKindForPath(path: string): ts.ScriptKind {
  switch (extname(path).toLowerCase()) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function sourceLocation(sourceFile: ts.SourceFile, path: string, node: ts.Node): SourceLocation {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { path, line: position.line + 1, column: position.character + 1 };
}

function finding(
  sourceFile: ts.SourceFile,
  path: string,
  node: ts.Node,
  capability: PiCapabilityKind,
  classification: CapabilityClassification,
  message: string,
  symbol?: string,
): CapabilityFinding {
  const source = sourceLocation(sourceFile, path, node);
  return {
    id: `${capability}:${symbol ?? "anonymous"}:${path}:${source.line}:${source.column}`,
    capability,
    classification,
    required: true,
    message,
    source,
    ...(symbol === undefined ? {} : { symbol }),
  };
}

function literalString(expression: ts.Expression | undefined): string | undefined {
  return expression !== undefined && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
    ? expression.text
    : undefined;
}

function objectProperty(object: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | undefined {
  return object.properties.find((property) => {
    if (!ts.isPropertyAssignment(property) && !ts.isMethodDeclaration(property)) {
      return false;
    }
    return (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === name;
  });
}

function propertyInitializer(property: ts.ObjectLiteralElementLike | undefined): ts.Expression | undefined {
  return property !== undefined && ts.isPropertyAssignment(property) ? property.initializer : undefined;
}

function defineToolObjects(sourceFile: ts.SourceFile): ReadonlyMap<string, ts.ObjectLiteralExpression> {
  const tools = new Map<string, ts.ObjectLiteralExpression>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer !== undefined &&
        ts.isCallExpression(declaration.initializer) &&
        ts.isIdentifier(declaration.initializer.expression) &&
        declaration.initializer.expression.text === "defineTool" &&
        declaration.initializer.arguments[0] !== undefined &&
        ts.isObjectLiteralExpression(declaration.initializer.arguments[0])
      ) {
        tools.set(declaration.name.text, declaration.initializer.arguments[0]);
      }
    }
  }
  return tools;
}

function staticExpressionBindings(sourceFile: ts.SourceFile): StaticSchemaBindings {
  const bindings = new Map<string, ts.Expression>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
        bindings.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return bindings;
}

function analyzeToolObject(
  sourceFile: ts.SourceFile,
  path: string,
  registrationNode: ts.CallExpression,
  object: ts.ObjectLiteralExpression,
  registration: ToolRegistrationKind,
  schemaBindings: StaticSchemaBindings,
): { readonly tool: PiToolAnalysis; readonly findings: readonly CapabilityFinding[] } {
  const name = literalString(propertyInitializer(objectProperty(object, "name")));
  const description = literalString(propertyInitializer(objectProperty(object, "description")));
  const parameters = propertyInitializer(objectProperty(object, "parameters"));
  const findings: CapabilityFinding[] = [
    finding(
      sourceFile,
      path,
      registrationNode,
      "tool",
      "scaffold",
      "Tool metadata can be generated, but its executor requires a portable implementation or target override.",
      name,
    ),
  ];

  let schemaStatus: PiToolAnalysis["schemaStatus"] = "missing";
  let schema: PiToolAnalysis["schema"];
  if (parameters !== undefined) {
    const schemaAnalysis = extractStaticToolSchema(parameters, schemaBindings);
    schemaStatus = schemaAnalysis.status;
    if (schemaAnalysis.status === "supported") {
      schema = schemaAnalysis.schema;
    } else if (schemaAnalysis.status === "computed") {
      findings.push(
        finding(
          sourceFile,
          path,
          parameters,
          "computed-schema",
          "scaffold",
          `Computed tool schema requires a manual portable schema: ${schemaAnalysis.reason}`,
          name,
        ),
      );
    } else {
      findings.push(
        finding(
          sourceFile,
          path,
          parameters,
          "unsupported-schema",
          "unsupported",
          `Tool schema uses an unsupported static construct: ${schemaAnalysis.reason}`,
          name,
        ),
      );
    }
  }

  const source = sourceLocation(sourceFile, path, registrationNode);
  return {
    tool: {
      registration,
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      schemaStatus,
      ...(schema === undefined ? {} : { schema }),
      source,
    },
    findings,
  };
}

function calledApiMethod(call: ts.CallExpression, apiName: string): string | undefined {
  return ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === apiName
    ? call.expression.name.text
    : undefined;
}

function isTopLevelFactoryCall(call: ts.CallExpression, factory: ExtensionFactory): boolean {
  return ts.isExpressionStatement(call.parent) && call.parent.parent === factory.body;
}

function isUiAccess(node: ts.PropertyAccessExpression): boolean {
  if (node.name.text === "ui") {
    return true;
  }
  let expression: ts.Expression = node.expression;
  while (ts.isPropertyAccessExpression(expression)) {
    if (expression.name.text === "ui") {
      return true;
    }
    expression = expression.expression;
  }
  return false;
}

/** Analyzes one Pi extension entry point through the TypeScript AST without executing it. */
export function analyzePiExtensionAst(path: string, sourceText: string): PiExtensionAnalysis {
  const sourceFile = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, scriptKindForPath(path));
  const factory = findDefaultExportFactory(sourceFile);
  const findings: CapabilityFinding[] = [];
  const tools: PiToolAnalysis[] = [];
  const events = new Set<string>();
  const commands = new Set<string>();

  if (factory === undefined) {
    findings.push(
      finding(
        sourceFile,
        path,
        sourceFile,
        "extension-factory",
        "unsupported",
        "Extension has no statically recognizable default-export factory.",
      ),
    );
    return { path, hasDefaultExportFactory: false, tools, events: [], commands: [], findings };
  }

  findings.push(
    finding(
      sourceFile,
      path,
      factory.declaration,
      "extension-factory",
      "direct",
      "Default-export extension factory is statically recognizable.",
    ),
  );
  const definedTools = defineToolObjects(sourceFile);
  const schemaBindings = staticExpressionBindings(sourceFile);
  const uiLines = new Set<number>();

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && isUiAccess(node)) {
      const location = sourceLocation(sourceFile, path, node);
      if (!uiLines.has(location.line)) {
        uiLines.add(location.line);
        findings.push(
          finding(
            sourceFile,
            path,
            node,
            "ui",
            "unsupported",
            "Pi UI access requires a target-specific implementation.",
            node.name.text,
          ),
        );
      }
    }

    if (ts.isCallExpression(node)) {
      const method = calledApiMethod(node, factory.apiName);
      if (method !== undefined) {
        const topLevel = isTopLevelFactoryCall(node, factory);
        if (method === "registerTool") {
          const descriptor = node.arguments[0];
          if (!topLevel || descriptor === undefined) {
            findings.push(
              finding(sourceFile, path, node, "dynamic-registration", "scaffold", "Tool registration is dynamic or nested.", "registerTool"),
            );
          } else if (ts.isObjectLiteralExpression(descriptor)) {
            const analysis = analyzeToolObject(sourceFile, path, node, descriptor, "inline-object", schemaBindings);
            tools.push(analysis.tool);
            findings.push(...analysis.findings);
            if (descriptor.properties.some((property) => ts.isSpreadAssignment(property))) {
              findings.push(
                finding(sourceFile, path, descriptor, "dynamic-registration", "scaffold", "Inline tool descriptor contains a spread assignment.", analysis.tool.name),
              );
            }
          } else if (ts.isIdentifier(descriptor)) {
            const definedTool = definedTools.get(descriptor.text);
            if (definedTool === undefined) {
              findings.push(
                finding(sourceFile, path, node, "dynamic-registration", "scaffold", "Tool descriptor cannot be resolved statically.", "registerTool"),
              );
            } else {
              const analysis = analyzeToolObject(
                sourceFile,
                path,
                node,
                definedTool,
                "define-tool-identifier",
                schemaBindings,
              );
              tools.push(analysis.tool);
              findings.push(...analysis.findings);
            }
          } else {
            findings.push(
              finding(sourceFile, path, node, "dynamic-registration", "scaffold", "Tool descriptor cannot be resolved statically.", "registerTool"),
            );
          }
        } else if (method === "on") {
          const eventName = literalString(node.arguments[0]);
          if (topLevel && eventName !== undefined) {
            events.add(eventName);
            findings.push(
              finding(sourceFile, path, node, "event-hook", "unsupported", "Pi event hook has no proven native target mapping.", eventName),
            );
          } else {
            findings.push(
              finding(sourceFile, path, node, "dynamic-registration", "scaffold", "Event hook name is computed or registration is nested.", "on"),
            );
          }
        } else if (method === "registerCommand") {
          const commandName = literalString(node.arguments[0]);
          if (topLevel && commandName !== undefined) {
            commands.add(commandName);
            findings.push(
              finding(sourceFile, path, node, "command", "scaffold", "Command metadata can be generated, but its handler requires a target override.", commandName),
            );
          } else {
            findings.push(
              finding(sourceFile, path, node, "dynamic-registration", "scaffold", "Command name is computed or registration is nested.", "registerCommand"),
            );
          }
        } else if (method === "registerProvider") {
          findings.push(
            finding(sourceFile, path, node, "provider", "unsupported", "Custom provider registration has no portable first-slice mapping.", "registerProvider"),
          );
        } else if (method.startsWith("register")) {
          findings.push(
            finding(sourceFile, path, node, "dynamic-registration", "scaffold", `Registration method is not statically portable: ${method}.`, method),
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(factory.body, visit);

  tools.sort(
    (left, right) =>
      compareLexicalText(left.name ?? "", right.name ?? "") ||
      compareLexicalText(left.source.path, right.source.path) ||
      left.source.line - right.source.line ||
      left.source.column - right.source.column,
  );
  findings.sort((left, right) => compareLexicalText(left.id, right.id));
  return {
    path,
    hasDefaultExportFactory: true,
    tools,
    events: [...events].sort(compareLexicalText),
    commands: [...commands].sort(compareLexicalText),
    findings,
  };
}
