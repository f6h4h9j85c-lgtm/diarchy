/**
 * Launch recipes for the real driver. The Claude PM runs headless with no one
 * to answer a permission prompt, so its default flags must allow the diarchy
 * MCP tools and the shell commands a PM issues up front (audit finding F005),
 * and the launcher must append its resume flag and the prompt where `claude`
 * still reads them as such.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildPrompt, realPlan } from "../src/cli/drivers.js";
import { CLAUDE_ALLOWED_TOOLS, DEFAULT_AGENT_LAUNCH, agentLaunch } from "../src/cli/launcher-config.js";

function docText(name: string): string {
  return readFileSync(new URL(`../docs/${name}`, import.meta.url), "utf8");
}

describe("claude launch flags", () => {
  it("allow the diarchy MCP tools and the PM's shell commands, and deny the rest without waiting for a prompt", () => {
    const { command, args } = agentLaunch("claude", undefined);
    expect(command).toBe("claude");
    expect(args.slice(0, 3)).toEqual(["-p", "--permission-mode", "acceptEdits"]);
    expect(args[args.indexOf("--permission-prompts") + 1]).toBe("none");
    const allowed = args[args.indexOf("--allowedTools") + 1].split(",");
    expect(allowed).toContain("mcp__plugin_diarchy_diarchy__*");
    for (const cmd of ["git", "npm", "node", "gh"]) expect(allowed).toContain(`Bash(${cmd} *)`);
    expect(allowed).toEqual(CLAUDE_ALLOWED_TOOLS);
  });

  it("keep the allow list in one argument so the variadic flag cannot absorb the session flag or the prompt", () => {
    const plan = realPlan({
      projectDir: "/project",
      agent: "claude",
      goalId: "20261025-goal",
      launch: DEFAULT_AGENT_LAUNCH.claude,
      cwd: "/project/.diarchy/worktrees/claude",
      worktree: "/project/.diarchy/worktrees/claude",
      session: null,
    });
    const at = plan.args.indexOf("--allowedTools");
    expect(at).toBeGreaterThan(0);
    expect(plan.args[at + 2]).toBe("--session-id");
    expect(plan.args[plan.args.length - 1]).toBe(buildPrompt("claude", "20261025-goal"));
    expect(plan.args.filter((arg) => arg.startsWith("Bash("))).toEqual([]);
  });

  it("apply to a bare claude command from the config as well", () => {
    expect(agentLaunch("claude", { command: "/usr/local/bin/claude" }).args).toEqual(DEFAULT_AGENT_LAUNCH.claude.args);
  });
});

describe("launch flag doc parity", () => {
  const list = CLAUDE_ALLOWED_TOOLS.join(",");

  it("ARCHITECTURE.md and PROTOCOL.md quote the allow list the launcher uses", () => {
    for (const name of ["ARCHITECTURE.md", "PROTOCOL.md"]) {
      expect(docText(name), name).toContain(list);
      expect(docText(name), name).toContain("--permission-prompts none");
    }
  });

  it("QUICKSTART.md and INSTALL-CLAUDE.md tell the user the Claude PM runs under an allow list", () => {
    for (const name of ["QUICKSTART.md", "INSTALL-CLAUDE.md"]) expect(docText(name), name).toContain("--allowedTools");
  });
});
