/** User-facing docs and plugin prose that must agree with the normative specs and the installed layout. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { nextStep } from "../src/cli/brief.js";
import { parseGoalState, type GoalState } from "../src/protocol/index.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "src", "cli", "index.ts");
const TSX = pathToFileURL(join(ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
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

describe("docs: talk gate and DONE summaries match ANTI-SLOP.md and PROTOCOL.md 9.2", () => {
  const antiSlop = read("docs", "ANTI-SLOP.md");
  const rule = (id: string): string => antiSlop.split("\n").find((line) => line.startsWith(`| ${id} |`)) ?? "";
  const readme = read("README.md");
  const skill = read("skills", "diarchy-pm", "SKILL.md");
  const line = (doc: string, start: string): string => doc.split("\n").find((entry) => entry.startsWith(start)) ?? "";

  it("only a STATUS carrying work evidence clears the talk gate, wherever the gate is described", () => {
    const work = /without a STATUS carrying work evidence \(a commit, pr, review, or a passing or failing test\)/i;
    const step5 = line(readme, "5. EXECUTE.");
    expect(step5).toMatch(work);
    expect(acceptedTypes(step5)).toEqual(acceptedTypes(rule("TALK_WORK_RATIO")));
    expect(section(skill, "## EXECUTE phase")).toMatch(work);
    const prose = ["README.md", "docs/QUICKSTART.md", "docs/ARCHITECTURE.md", "skills/diarchy-pm/SKILL.md", "skills/diarchy-review/SKILL.md", "src/cli/brief.ts"];
    for (const file of prose) expect(read(file), file).not.toMatch(/without a STATUS(?! carrying work evidence)|\bper STATUS\b/);
  });

  it("every DONE summary names each 9.2 precondition, the PR from every implementer and the unanswered CHALLENGE included", () => {
    const summaries: Record<string, string> = {
      "ANTI-SLOP.md DONE_PRECONDITION": rule("DONE_PRECONDITION").split(" | ")[1],
      "README.md step 9": line(readme, "9. The lead posts DONE"),
      "README.md rule table": line(readme, "| Work and review:"),
      "QUICKSTART.md 7": section(read("docs", "QUICKSTART.md"), "## 7. Stop"),
      "diarchy-pm EXECUTE": line(skill, "3. Post DONE only when"),
    };
    // (b) ACs, (c) cross-review, (d) threads, CHALLENGEs and the deadlock watch, (e) tasks, (f) a PR per implementer.
    const preconditions = [/\bAC\b/, /approve|cross-review|unreviewed/, /thread/, /unanswered CHALLENGE|CHALLENGE (is )?unanswered/, /deadlock watch/, /\btask\b/, /implementer/];
    for (const [name, text] of Object.entries(summaries)) {
      expect(text, name).not.toBe("");
      for (const pattern of preconditions) expect(text, `${name} ${pattern}`).toMatch(pattern);
    }
  });
});

describe("implement brief", () => {
  const state = (reviewRequired: boolean): GoalState => {
    const base = parseYaml(read("test", "fixtures", "protocol", "bases", "execute-assigned.yaml"), { schema: "core" }) as Record<string, unknown>;
    return parseGoalState({ ...base, review_required: reviewRequired });
  };

  it("asks the implementer for the pr evidence DONE 9.2(f) needs, unless review.required is false", () => {
    expect(state(true).tasks.T1).toMatchObject({ assignee: "codex", kind: "implement", status: "assigned" });
    expect(nextStep(state(true), [], "codex", []).text).toMatch(/: finish it, then call status with commit, pr, and test evidence$/);
    expect(nextStep(state(false), [], "codex", []).text).toMatch(/: finish it, then call status with commit and test evidence$/);
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

  it("README, INSTALL-CODEX.md, and QUICKSTART.md install the CLI before the Codex plugin and register the server as that global diarchy", () => {
    // Codex copies a plugin without node_modules, so the plugin's bin/diarchy.js hands every call to the diarchy on PATH.
    const install = "npm install -g github:f6h4h9j85c-lgtm/diarchy";
    const toml = 'command = "diarchy"\nargs = ["mcp", "--agent", "codex"]\n';
    const docs: [string, string, string][] = [
      ["README.md", section(read("README.md"), "### Codex CLI"), toml],
      ["docs/INSTALL-CODEX.md", read("docs", "INSTALL-CODEX.md"), toml],
      ["docs/QUICKSTART.md", read("docs", "QUICKSTART.md"), '`command = "diarchy"` and `args = ["mcp", "--agent", "codex"]`'],
    ];
    for (const [file, text, server] of docs) {
      expect(text.indexOf(install), file).toBeGreaterThanOrEqual(0);
      expect(text.indexOf(install), file).toBeLessThan(text.indexOf("codex plugin marketplace add"));
      expect(text, file).toContain(server);
      expect(text, file).not.toContain("installed plugin directory");
      expect(text, file).not.toContain("/abs/path/to/diarchy/bin/diarchy.js");
    }
  });

  it("templates/AGENTS.md names skills, not repository paths that exist only in the diarchy checkout", () => {
    const template = read("templates", "AGENTS.md");
    expect(template).not.toMatch(/\.agents\/skills|skills\/diarchy-\w+\/SKILL\.md/);
    expect(template).toContain("`$diarchy-pm`");
  });
});

describe("docs: the sandboxed Codex PM's PR stays its own (PROTOCOL.md 9.1, 9.2(f))", () => {
  const flat = (...parts: string[]): string => read(...parts).replace(/\s+/g, " ");

  it("diarchy-pm tells the implementer to post its own pr evidence and the committing PM to cite only commit", () => {
    const execute = section(read("skills", "diarchy-pm", "SKILL.md"), "## EXECUTE phase");
    expect(execute).toContain("Post your own PR's `pr` evidence (first citer = author); a PM committing or opening a PR for a sandboxed PM cites only `commit`, url in body.");
  });

  it("diarchy-review, AGENTS.md, INSTALL-CODEX.md 5, and QUICKSTART.md say the same", () => {
    expect(flat("skills", "diarchy-review", "SKILL.md")).toContain(
      "a PM that commits or opens the PR for a sandboxed implementer cites only `commit` and passes the url in its STATUS body",
    );
    const agents = flat("templates", "AGENTS.md");
    expect(agents).toContain("cites only `commit`, and gives the url in its STATUS body");
    expect(agents).toContain("the implementer always posts the `pr` evidence itself");
    const install = section(read("docs", "INSTALL-CODEX.md"), "## 5. Headless runs").replace(/\s+/g, " ");
    expect(install).toContain("The Codex PM still posts that PR's `pr` evidence itself (PROTOCOL.md 9.1).");
    expect(install).toContain("cites only `commit` and passes the url in its STATUS body, and the Codex PM then cites that url as `pr`");
    const quick = flat("docs", "QUICKSTART.md");
    expect(quick).toContain("citing only the commit and passing the url in its STATUS body. The Codex PM then posts the `pr` evidence itself");
    expect(quick).toContain("each implementer has introduced a PR with its own `pr` evidence");
  });

  it("the review skill and INSTALL-CODEX.md 5 give a sandboxed reviewer a read-only way to test the PR head", () => {
    const archive = 'd=$(mktemp -d) && git archive <branch> | tar -x -C "$d"';
    expect(read("skills", "diarchy-review", "SKILL.md")).toContain(`\`${archive}\``);
    expect(read("skills", "diarchy-review", "SKILL.md")).toContain("`git diff main...<branch>`");
    const install = section(read("docs", "INSTALL-CODEX.md"), "## 5. Headless runs").replace(/\s+/g, " ");
    expect(install).toContain(archive);
    expect(install).toContain("git diff main...<branch>");
  });
});

describe("docs: answering a deadlock", () => {
  it("QUICKSTART.md says a plan ruling is refused while another thread is open and the plain reply answers then", () => {
    const answer = section(read("docs", "QUICKSTART.md"), "## 6. Answer");
    expect(answer).toContain("unless another thread is still open: then `--decision plan` is refused (PHASE_GATE decides plan last)");
    expect(answer).toContain('answer with the plain `diarchy reply "<ruling>"` that goal.md shows');
  });
});

describe("docs: diarchy doctor and diarchy smoke", () => {
  it("CONTRIBUTING's Live smoke test names every diarchy smoke option, and every other flag it names belongs to another command", () => {
    const help = spawnSync(process.execPath, ["--import", TSX, CLI, "smoke", "--help"], { encoding: "utf8" });
    expect(help.status, help.stderr).toBe(0);
    const options = new Set([...help.stdout.matchAll(/^\s+(?:-\w, )?(--[a-z][a-z-]*)/gm)].map((match) => match[1]).filter((flag) => flag !== "--help"));
    expect(options.size).toBeGreaterThanOrEqual(8);
    const text = section(read("CONTRIBUTING.md"), "## Live smoke test");
    const named = new Set(text.match(/--[a-z][a-z-]*/g) ?? []);
    // doctor's --live, claude's --max-budget-usd, gh repo create's --private
    const elsewhere = ["--live", "--max-budget-usd", "--private"];
    for (const flag of options) expect([...named], `${flag} is not in CONTRIBUTING.md`).toContain(flag);
    for (const flag of named) if (!elsewhere.includes(flag)) expect([...options], `${flag} is not a diarchy smoke option`).toContain(flag);
    expect(text).toContain("0 when the goal is DONE, 2 when it is BLOCKED after both PMs posted, 1 otherwise");
  });

  it("the install steps check with diarchy doctor and point at diarchy smoke, and the README status names it", () => {
    const readme = read("README.md");
    for (const heading of ["### Claude Code", "### Codex CLI"]) expect(section(readme, heading), heading).toMatch(/Verify:[^\n]*`diarchy doctor`/);
    const status = section(readme, "## Status and roadmap");
    expect(status).not.toContain("v0.1 ships");
    expect(status).toContain("`diarchy smoke`");
    const steps = {
      quickstart: section(read("docs", "QUICKSTART.md"), "## 1. Install the plugin in both CLIs"),
      claude: section(read("docs", "INSTALL-CLAUDE.md"), "## Confirm it is connected"),
      codex: section(read("docs", "INSTALL-CODEX.md"), "## 6. Confirm it is connected"),
    };
    for (const [name, text] of Object.entries(steps)) {
      expect(text, name).toContain("diarchy doctor");
      expect(text.replace(/\s+/g, " "), name).toContain("`diarchy smoke`");
      expect(text.replace(/\s+/g, " "), name).toContain("Live smoke test");
    }
  });
});
