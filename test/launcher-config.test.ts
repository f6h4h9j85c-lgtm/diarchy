import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { sandboxNotice } from "../src/cli/drivers.js";
import {
  CODEX_FULL_ACCESS_ARGS,
  DEFAULT_AGENT_LAUNCH,
  HOOK_TRUST_BYPASS,
  SANDBOX_BYPASS,
  agentLaunch,
  runsInWorkspaceWrite,
} from "../src/cli/launcher-config.js";

/**
 * Codex runs a non-managed hook only after its definition is trusted in
 * /hooks; `codex exec` never shows that prompt and skips untrusted hooks
 * silently, so the headless default must pass the bypass flag or the diarchy
 * SessionStart brief and Stop gate never run (docs/INSTALL-CODEX.md 3 and 5).
 */
describe("launcher-config: codex hook trust", () => {
  it("names the flag Codex documents", () => {
    expect(HOOK_TRUST_BYPASS).toBe("--dangerously-bypass-hook-trust");
  });

  it("passes --dangerously-bypass-hook-trust after the sandbox flag in the codex default", () => {
    expect(DEFAULT_AGENT_LAUNCH.codex).toEqual({
      command: "codex",
      args: ["exec", "--sandbox", "workspace-write", HOOK_TRUST_BYPASS],
    });
  });

  it("applies the default when agents.codex is absent or a bare codex executable", () => {
    expect(agentLaunch("codex", undefined).args).toContain(HOOK_TRUST_BYPASS);
    expect(agentLaunch("codex", { command: "codex" }).args).toContain(HOOK_TRUST_BYPASS);
    expect(agentLaunch("codex", { command: "/opt/homebrew/bin/codex" }).args).toContain(HOOK_TRUST_BYPASS);
  });

  it("leaves explicit args alone so an operator can require persisted hook trust", () => {
    expect(agentLaunch("codex", { command: "codex", args: ["exec", "--sandbox", "workspace-write"] }).args).not.toContain(HOOK_TRUST_BYPASS);
    expect(agentLaunch("codex", { command: "codex exec --sandbox workspace-write" }).args).not.toContain(HOOK_TRUST_BYPASS);
  });

  it("does not add the flag to claude or to unknown agents", () => {
    expect(DEFAULT_AGENT_LAUNCH.claude.args).not.toContain(HOOK_TRUST_BYPASS);
    expect(agentLaunch("cursor", undefined)).toEqual({ command: "cursor", args: [] });
  });
});

/**
 * Audit finding F006: under `--sandbox workspace-write` the headless Codex PM
 * cannot commit, push, or open a PR (gitdir read-only, network off, `codex
 * exec` never escalates). The sandbox stays on by default; full access is an
 * explicit opt-in, and `diarchy start` says so in one line.
 */
describe("launcher-config: codex sandbox stays on by default", () => {
  it("keeps --sandbox workspace-write and never bypasses the sandbox in the default", () => {
    for (const launch of [DEFAULT_AGENT_LAUNCH.codex, agentLaunch("codex", undefined), agentLaunch("codex", { command: "codex" })]) {
      expect(launch.args.slice(0, 3)).toEqual(["exec", "--sandbox", "workspace-write"]);
      expect(launch.args).not.toContain(SANDBOX_BYPASS);
      expect(runsInWorkspaceWrite(launch.args)).toBe(true);
    }
  });

  it("names the opt-in args: sandbox and approvals bypassed, hooks still run", () => {
    expect(SANDBOX_BYPASS).toBe("--dangerously-bypass-approvals-and-sandbox");
    expect(CODEX_FULL_ACCESS_ARGS).toEqual(["exec", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust"]);
    expect(runsInWorkspaceWrite(CODEX_FULL_ACCESS_ARGS)).toBe(false);
  });

  it("recognises the other ways to ask for workspace-write", () => {
    expect(runsInWorkspaceWrite(["exec", "-s", "workspace-write"])).toBe(true);
    expect(runsInWorkspaceWrite(["exec", "--sandbox=workspace-write"])).toBe(true);
    expect(runsInWorkspaceWrite(["exec", "-c", 'sandbox_mode="workspace-write"'])).toBe(true);
    expect(runsInWorkspaceWrite(["exec", "--sandbox", "read-only"])).toBe(false);
  });
});

describe("drivers: the start notice for a sandboxed Codex PM", () => {
  it("is one line saying the Codex PM cannot commit and naming the opt-in", () => {
    const notice = sandboxNotice("codex", DEFAULT_AGENT_LAUNCH.codex);
    expect(notice).not.toBeNull();
    expect(notice).toContain("codex runs in the Codex workspace-write sandbox");
    expect(notice).toContain("cannot commit, push, or open a PR");
    // F137: whoever opens the PR for it cites only the commit, so codex stays the author and the other PM reviews.
    expect(notice).toContain("the other PM commits its work and opens its PR citing only commit, with the url in its STATUS body");
    expect(notice).toContain("codex posts the pr evidence itself");
    expect(notice).toContain("diarchy init --codex-full-access");
    expect(notice).not.toContain("\n");
    expect(notice).not.toContain("\u2014");
  });

  it("follows the codex executable, not the agent id", () => {
    expect(sandboxNotice("reviewer", { command: "/opt/homebrew/bin/codex", args: ["exec", "-s", "workspace-write"] })).toContain("reviewer runs in");
  });

  it("stays quiet under full access, for claude, and for other CLIs", () => {
    expect(sandboxNotice("codex", { command: "codex", args: [...CODEX_FULL_ACCESS_ARGS] })).toBeNull();
    expect(sandboxNotice("claude", DEFAULT_AGENT_LAUNCH.claude)).toBeNull();
    expect(sandboxNotice("cursor", { command: "cursor-agent", args: ["--sandbox", "workspace-write"] })).toBeNull();
  });
});

describe("docs: codex sandbox default and the full-access opt-in", () => {
  const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\s+/g, " ");

  it("INSTALL-CODEX.md section 5 states the limitation, who commits, and the opt-in with its risk", () => {
    const text = read("docs/INSTALL-CODEX.md");
    const section = text.slice(text.indexOf("## 5. Headless runs"), text.indexOf("## 6."));
    expect(section).toContain(`codex exec ${DEFAULT_AGENT_LAUNCH.codex.args.slice(1).join(" ")}`);
    expect(section).toContain("cannot commit, push, or open a PR, so the Claude PM commits its work");
    expect(section).toContain("diarchy init --codex-full-access");
    expect(section).toContain(CODEX_FULL_ACCESS_ARGS.map((arg) => `"${arg}"`).join(", "));
    expect(section).toContain("full OS permissions");
    expect(section).toContain("machine or container you are willing to let it change");
  });

  it("ARCHITECTURE.md, README.md, and QUICKSTART.md name the flag", () => {
    for (const path of ["docs/ARCHITECTURE.md", "README.md", "docs/QUICKSTART.md"]) {
      expect(read(path), path).toContain("diarchy init --codex-full-access");
      expect(read(path), path).toContain("cannot commit, push, or open a PR");
    }
  });
});
