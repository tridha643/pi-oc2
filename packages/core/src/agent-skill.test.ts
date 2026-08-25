import { describe, expect, it } from "vitest";
import { parseAgentSkill } from "./agent-skill.js";

describe("parseAgentSkill", () => {
  it("parses YAML frontmatter and preserves the Markdown body", () => {
    const result = parseAgentSkill(
      "skills/review/SKILL.md",
      `---
name: review
description: >-
  Review source safely.
license: MIT
allowed-tools: Read Bash(git:*)
metadata:
  author: tri
  stable: true
---
# Review

Keep this body unchanged.
`,
    );

    expect(result).toEqual({
      ok: true,
      value: {
        path: "skills/review/SKILL.md",
        name: "review",
        description: "Review source safely.",
        license: "MIT",
        allowedTools: ["Read", "Bash(git:*)"],
        metadata: { author: "tri", stable: true },
        body: "# Review\n\nKeep this body unchanged.\n",
      },
    });
  });
});
