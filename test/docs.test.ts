/** User-facing docs and plugin prose that must agree with the normative specs and the installed layout. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), "utf8");

/** The text from `heading` up to the next heading of the same or higher level. */
function section(doc: string, heading: string): string {
  const start = doc.indexOf(`\n${heading}\n`);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const level = /^#+/.exec(heading)?.[0] ?? "##";
  const rest = doc.slice(start + heading.length + 2);
  const end = rest.search(new RegExp(`^#{1,${level.length}} `, "m"));
  return end < 0 ? rest : rest.slice(0, end);
}

/** Message types named in an "only ... accepted" clause. */
function acceptedTypes(text: string): string[] {
  const clause = /only (.+?) (?:is|are) accepted/.exec(text)?.[1];
  expect(clause, text).toBeDefined();
  return [...new Set(clause?.match(/\b[A-Z][A-Z_]+\b/g) ?? [])].sort();
}

describe("docs: diarchy-pm skill and ANTI-SLOP.md", () => {
  const antiSlop = read("docs", "ANTI-SLOP.md");
  const rule = (id: string): string => antiSlop.split("\n").find((line) => line.startsWith(`| ${id} |`)) ?? "";
  const skill = read("skills", "diarchy-pm", "SKILL.md");

  it("the PLAN cap accepts the types PLAN_BUDGET accepts", () => {
    expect(acceptedTypes(section(skill, "## PLAN phase"))).toEqual(acceptedTypes(rule("PLAN_BUDGET")));
  });

  it("the talk cap accepts the types TALK_WORK_RATIO accepts", () => {
    expect(acceptedTypes(section(skill, "## EXECUTE phase"))).toEqual(acceptedTypes(rule("TALK_WORK_RATIO")));
  });

  it("STATUS evidence asks for a PR url only once a PR is opened", () => {
    expect(section(skill, "## EXECUTE phase")).toContain("`commit` sha, `test` command plus result, `pr` url once opened.");
  });
});

describe("docs: install paths", () => {
  it("INSTALL-CLAUDE.md gives the shell form's own minimum version and a form for older versions", () => {
    const doc = read("docs", "INSTALL-CLAUDE.md");
    const pathB = section(doc, "## Path B: from a shell");
    expect(pathB).toContain("claude plugin install diarchy --marketplace f6h4h9j85c-lgtm/diarchy");
    expect(pathB).toContain("2.1.292 or later");
    expect(pathB).toContain("claude plugin marketplace add f6h4h9j85c-lgtm/diarchy\nclaude plugin install diarchy@diarchy");
    const requirements = doc.split("\n").find((line) => line.startsWith("Requirements:")) ?? "";
    expect(requirements).toContain("2.1.292");
  });

  it("QUICKSTART.md gives the shell form's minimum version and the same form for older versions as INSTALL-CLAUDE.md", () => {
    const pathB = section(read("docs", "INSTALL-CLAUDE.md"), "## Path B: from a shell");
    const blocks = [...pathB.matchAll(/```\n([\s\S]*?)\n```/g)].map((match) => match[1]);
    expect(blocks).toHaveLength(2);
    const quick = section(read("docs", "QUICKSTART.md"), "## 1. Install the plugin in both CLIs");
    expect(quick).toContain(`Claude Code 2.1.292 or later, from a shell:\n\n\`\`\`\n${blocks[0]}\n\`\`\``);
    expect(quick).toContain("On Claude Code 2.1.275 to 2.1.291");
    expect(quick).toContain(`\`\`\`\n${blocks[1]}\n\`\`\``);
  });

  it("templates/AGENTS.md names skills, not repository paths that exist only in the diarchy checkout", () => {
    const template = read("templates", "AGENTS.md");
    expect(template).not.toMatch(/\.agents\/skills|skills\/diarchy-\w+\/SKILL\.md/);
    expect(template).toContain("`$diarchy-pm`");
  });
});
