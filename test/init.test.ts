/**
 * `diarchy init --codex-full-access` (audit finding F006): the Codex sandbox
 * stays on by default, and full access is an explicit opt-in that writes the
 * bypass args, prints a warning, and follows init's overwrite rule.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CliError, EXIT_ERROR, EXIT_OK } from "../src/cli/common.js";
import { CODEX_FULL_ACCESS_WARNING, buildConfig, runInit } from "../src/cli/init.js";
import { CODEX_FULL_ACCESS_ARGS, DEFAULT_AGENT_LAUNCH } from "../src/cli/launcher-config.js";

type Agents = Record<string, { command: string; args: string[] }>;

const temps: string[] = [];
let out: string[] = [];
let err: string[] = [];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void out.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void err.push(args.join(" ")));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "diarchy-init-"));
  temps.push(dir);
  return dir;
}

function agentsIn(dir: string): Agents {
  return (JSON.parse(readFileSync(join(dir, "diarchy.config.json"), "utf8")) as { agents: Agents }).agents;
}

describe("init: codex launch args", () => {
  it("keeps the codex sandbox by default", () => {
    const config = buildConfig("/p", ["claude", "codex"], "vault") as { agents: Agents };
    expect(config.agents.codex).toEqual({ command: "codex", args: ["exec", "--sandbox", "workspace-write", "--dangerously-bypass-hook-trust"] });

    const dir = project();
    expect(runInit(dir, {})).toBe(EXIT_OK);
    expect(agentsIn(dir).codex).toEqual(DEFAULT_AGENT_LAUNCH.codex);
    expect(err.join("\n")).not.toContain("--codex-full-access");
  });

  it("--codex-full-access writes the bypass args for codex only", () => {
    const dir = project();
    expect(runInit(dir, { codexFullAccess: true })).toBe(EXIT_OK);
    const agents = agentsIn(dir);
    expect(agents.codex).toEqual({ command: "codex", args: ["exec", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust"] });
    expect(agents.codex.args).toEqual(CODEX_FULL_ACCESS_ARGS);
    expect(agents.claude).toEqual(DEFAULT_AGENT_LAUNCH.claude);
    expect(out.join("\n")).toContain("Next steps");
  });

  it("--codex-full-access prints the one-paragraph warning after writing", () => {
    const dir = project();
    runInit(dir, { codexFullAccess: true });
    expect(err).toEqual([CODEX_FULL_ACCESS_WARNING]);
    expect(CODEX_FULL_ACCESS_WARNING).toMatch(/^warning: --codex-full-access /);
    expect(CODEX_FULL_ACCESS_WARNING).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(CODEX_FULL_ACCESS_WARNING).toMatch(/runs with your full OS permissions/);
    expect(CODEX_FULL_ACCESS_WARNING.replace(/\n/g, " ")).toContain("Use it only on a machine or container you are willing to let it change.");
    expect(CODEX_FULL_ACCESS_WARNING).toContain("docs/INSTALL-CODEX.md 5");
    expect(CODEX_FULL_ACCESS_WARNING).not.toMatch(/\n\s*\n/);
    expect(CODEX_FULL_ACCESS_WARNING).not.toContain("\u2014");
  });

  it("--codex-full-access refuses an existing config unless --force", () => {
    const dir = project();
    const configPath = join(dir, "diarchy.config.json");
    writeFileSync(configPath, `${JSON.stringify({ vault: "notes" })}\n`);
    const before = readFileSync(configPath, "utf8");

    expect(runInit(dir, { codexFullAccess: true })).toBe(EXIT_ERROR);
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(err.join("\n")).toContain("--codex-full-access was not applied");
    expect(err.join("\n")).toContain("pass --force");
    expect(err).not.toContain(CODEX_FULL_ACCESS_WARNING);

    err = [];
    expect(runInit(dir, { codexFullAccess: true, force: true })).toBe(EXIT_OK);
    expect(agentsIn(dir).codex.args).toEqual(CODEX_FULL_ACCESS_ARGS);
    expect(err).toEqual([CODEX_FULL_ACCESS_WARNING]);
  });

  it("--codex-full-access needs a codex agent and changes nothing without one", () => {
    const dir = project();
    expect(() => runInit(dir, { agents: "claude,cursor", codexFullAccess: true })).toThrow(CliError);
    expect(() => runInit(dir, { agents: "claude,cursor", codexFullAccess: true })).toThrow(/needs an agent named codex/);
    expect(() => readFileSync(join(dir, "diarchy.config.json"))).toThrow();
  });
});
