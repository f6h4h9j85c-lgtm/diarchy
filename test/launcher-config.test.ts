import { describe, expect, it } from "vitest";

import { DEFAULT_AGENT_LAUNCH, HOOK_TRUST_BYPASS, agentLaunch } from "../src/cli/launcher-config.js";

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
