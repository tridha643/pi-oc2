import type { CapabilityFinding, PiPackageAnalysis, PiocLock } from "./core-domain.js";
import { compareLexicalText } from "./pi-source-paths.js";

function normalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeJsonValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => compareLexicalText(left, right))
        .map(([key, entry]) => [key, normalizeJsonValue(entry)]),
    );
  }
  return value;
}

function markdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\r", "").replaceAll("\n", "<br>");
}

function findingRows(findings: readonly CapabilityFinding[]): string {
  if (findings.length === 0) {
    return "No capabilities were discovered.\n";
  }
  return [
    "| Capability | Classification | Symbol | Source | Message |",
    "| --- | --- | --- | --- | --- |",
    ...[...findings]
      .sort((left, right) => compareLexicalText(left.id, right.id))
      .map(
        (finding) =>
          `| ${finding.capability} | ${finding.classification} | ${markdownCell(finding.symbol ?? "")} | ${markdownCell(`${finding.source.path}:${finding.source.line}`)} | ${markdownCell(finding.message)} |`,
      ),
    "",
  ].join("\n");
}

/** Serializes JSON with lexical object keys, two-space indentation, and one final newline. */
export function serializeStableJson(value: unknown): string {
  return `${JSON.stringify(normalizeJsonValue(value), null, 2)}\n`;
}

/** Serializes the compiler lock through the same deterministic JSON contract as analysis. */
export function serializePiocLock(lock: PiocLock): string {
  return serializeStableJson(lock);
}

/** Serializes an analysis into a stable human-readable compatibility report. */
export function serializeCompatibilityMarkdown(analysis: PiPackageAnalysis): string {
  const resources =
    analysis.resources.length === 0
      ? "No resources were discovered.\n"
      : [
          "| Kind | Path |",
          "| --- | --- |",
          ...analysis.resources.map((resource) => `| ${resource.kind} | ${markdownCell(resource.path)} |`),
          "",
        ].join("\n");
  return [
    `# Compatibility analysis: ${analysis.packageName}`,
    "",
    `Source kind: ${analysis.sourceKind}`,
    "",
    `Source SHA-256: \`${analysis.sourceHash}\``,
    "",
    "## Resources",
    "",
    resources,
    "## Capabilities",
    "",
    findingRows(analysis.findings),
  ].join("\n");
}

/** Produces byte-stable machine and human analysis artifacts from one analysis value. */
export function writeDeterministicAnalysis(analysis: PiPackageAnalysis): {
  readonly json: string;
  readonly markdown: string;
} {
  return {
    json: serializeStableJson(analysis),
    markdown: serializeCompatibilityMarkdown(analysis),
  };
}
