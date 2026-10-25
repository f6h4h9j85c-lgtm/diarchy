import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const at = (...parts: string[]) => join(root, ...parts);
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

/**
 * Minimal TOML parser for the subset used by .codex/agents/*.toml: comments,
 * `[table]` headers, bare keys, basic and literal strings (single and
 * multi-line), integers, floats, booleans, and single-line arrays of those.
 * A dependency (smol-toml) would do the same job but would touch
 * package-lock.json, which another branch is editing concurrently.
 */
type TomlValue = string | number | boolean | TomlValue[];
type TomlTable = { [key: string]: TomlValue | TomlTable };

function parseToml(src: string): TomlTable {
  const out: TomlTable = {};
  let table = out;
  let i = 0;

  const peek = (n = 0) => src[i + n] ?? "";
  const startsWith = (s: string) => src.startsWith(s, i);
  const fail = (msg: string): never => {
    const line = src.slice(0, i).split("\n").length;
    throw new Error(`TOML line ${line}: ${msg}`);
  };
  const skipWs = () => {
    while (peek() === " " || peek() === "\t") i++;
  };
  const skipLineEnd = () => {
    skipWs();
    if (peek() === "#") while (i < src.length && peek() !== "\n") i++;
    if (peek() === "\n") i++;
    else if (peek() === "\r" && peek(1) === "\n") i += 2;
    else if (i < src.length) fail(`unexpected "${peek()}"`);
  };
  const unescape = (s: string) =>
    s.replace(/\\(["\\nt]|u[0-9a-fA-F]{4})/g, (_, e: string) =>
      e === "n" ? "\n" : e === "t" ? "\t" : e[0] === "u" ? String.fromCharCode(parseInt(e.slice(1), 16)) : e,
    );
  const readUntil = (delim: string, raw: boolean): string => {
    const start = i;
    while (i < src.length) {
      if (!raw && peek() === "\\") {
        i += 2;
        continue;
      }
      if (startsWith(delim)) {
        const body = src.slice(start, i);
        i += delim.length;
        return body;
      }
      i++;
    }
    return fail(`unterminated string (expected ${delim})`);
  };
  const readString = (): string => {
    if (startsWith('"""')) {
      i += 3;
      if (peek() === "\n") i++;
      return unescape(readUntil('"""', false));
    }
    if (startsWith("'''")) {
      i += 3;
      if (peek() === "\n") i++;
      return readUntil("'''", true);
    }
    if (peek() === '"') {
      i++;
      return unescape(readUntil('"', false));
    }
    i++;
    return readUntil("'", true);
  };
  const readValue = (): TomlValue => {
    skipWs();
    const c = peek();
    if (c === '"' || c === "'") return readString();
    if (c === "[") {
      i++;
      const arr: TomlValue[] = [];
      for (;;) {
        skipWs();
        if (peek() === "]") {
          i++;
          return arr;
        }
        arr.push(readValue());
        skipWs();
        if (peek() === ",") i++;
        else if (peek() !== "]") fail("expected , or ] in array");
      }
    }
    const m = /^(true|false|[+-]?\d[\d_]*(?:\.\d+)?)/.exec(src.slice(i));
    if (!m) return fail(`cannot parse value starting at "${src.slice(i, i + 12)}"`);
    i += m[0].length;
    if (m[0] === "true") return true;
    if (m[0] === "false") return false;
    return Number(m[0].replace(/_/g, ""));
  };

  while (i < src.length) {
    skipWs();
    if (peek() === "\n" || peek() === "\r" || peek() === "#" || i >= src.length) {
      skipLineEnd();
      continue;
    }
    if (peek() === "[") {
      i++;
      const name = readUntil("]", true).trim();
      if (!/^[A-Za-z0-9_.-]+$/.test(name)) fail(`unsupported table header [${name}]`);
      table = out;
      for (const part of name.split(".")) {
        const next = (table[part] ??= {}) as TomlTable;
        table = next;
      }
      skipLineEnd();
      continue;
    }
    const keyMatch = /^[A-Za-z0-9_-]+/.exec(src.slice(i));
    if (!keyMatch) fail(`expected key at "${src.slice(i, i + 12)}"`);
    const key = keyMatch![0];
    i += key.length;
    skipWs();
    if (peek() !== "=") fail(`expected = after key ${key}`);
    i++;
    table[key] = readValue();
    skipLineEnd();
  }
  return out;
}

function markdownFrontmatter(path: string): { fields: Record<string, string>; body: string } {
  const text = readFileSync(path, "utf8");
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${relative(root, path)}: missing frontmatter`);
  const fields: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { fields, body: m[2].replace(/^\n+|\n+$/g, "") };
}

function walk(dir: string, base = dir): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full, base));
    else files.push(relative(base, full));
  }
  return files.sort();
}

const AGENT_NAMES = ["planner", "designer", "implementer", "reviewer", "security"];
const pkg = readJson(at("package.json")) as { version: string };
/** The manifest Codex reads: `.codex-plugin/plugin.json` takes precedence over a root `plugin.json`. */
const codexManifest = existsSync(at(".codex-plugin", "plugin.json")) ? at(".codex-plugin", "plugin.json") : at("plugin.json");

describe("codex-config: TOML parser", () => {
  it("parses the subset used by the agent files", () => {
    const parsed = parseToml(
      '# comment\nname = "a"\nn = 42\nflag = true\nlist = ["x", "y"]\nml = """\nline1\n"line2"\n"""\n[t.u]\nk = \'raw\\n\'\n',
    );
    expect(parsed).toEqual({
      name: "a",
      n: 42,
      flag: true,
      list: ["x", "y"],
      ml: 'line1\n"line2"\n',
      t: { u: { k: "raw\\n" } },
    });
  });

  it("rejects unterminated strings", () => {
    expect(() => parseToml('name = "oops\n')).toThrow(/unterminated/);
  });
});

describe("codex-config: .codex/agents/*.toml", () => {
  const dir = at(".codex", "agents");
  const files = readdirSync(dir).filter((f) => f.endsWith(".toml")).sort();

  it("has exactly the five role agents", () => {
    expect(files.map((f) => f.replace(/\.toml$/, ""))).toEqual([...AGENT_NAMES].sort());
  });

  for (const file of files) {
    it(`${file} has name, description, developer_instructions and matches agents/*.md`, () => {
      const toml = parseToml(readFileSync(join(dir, file), "utf8"));
      const stem = file.replace(/\.toml$/, "");
      expect(toml.name).toBe(stem);
      expect(typeof toml.description).toBe("string");
      expect((toml.description as string).length).toBeGreaterThan(20);
      expect(typeof toml.developer_instructions).toBe("string");
      expect((toml.developer_instructions as string).trim().length).toBeGreaterThan(200);
      if ("model" in toml) expect(typeof toml.model).toBe("string");

      const md = markdownFrontmatter(at("agents", `${stem}.md`));
      expect(md.fields.name).toBe(stem);
      expect(md.fields.description).toBe(toml.description);
      expect((toml.developer_instructions as string).trim()).toBe(md.body);
    });
  }
});

describe("codex-config: agents/*.md", () => {
  const files = readdirSync(at("agents")).filter((f) => f.endsWith(".md")).sort();

  it("names match .codex/agents/*.toml", () => {
    const tomlNames = readdirSync(at(".codex", "agents"))
      .filter((f) => f.endsWith(".toml"))
      .map((f) => f.replace(/\.toml$/, ""))
      .sort();
    expect(files.map((f) => f.replace(/\.md$/, ""))).toEqual(tomlNames);
  });

  for (const file of files) {
    it(`${file} has name, description, tools and a 150 to 300 word body`, () => {
      const { fields, body } = markdownFrontmatter(at("agents", file));
      expect(fields.name).toBe(file.replace(/\.md$/, ""));
      expect(fields.description.length).toBeGreaterThan(20);
      expect(fields.tools.split(",").map((t) => t.trim()).filter(Boolean).length).toBeGreaterThan(0);
      const words = body.split(/\s+/).filter(Boolean).length;
      expect(words).toBeGreaterThanOrEqual(150);
      expect(words).toBeLessThanOrEqual(300);
    });
  }
});

describe("codex-config: JSON manifests", () => {
  it(".claude-plugin/plugin.json has name, version, description, author", () => {
    const m = readJson(at(".claude-plugin", "plugin.json"));
    expect(m.name).toBe("diarchy");
    expect(m.version).toBe(pkg.version);
    expect(typeof m.description).toBe("string");
    expect(typeof (m.author as { name?: string }).name).toBe("string");
  });

  it(".codex-plugin/plugin.json (Codex) has name, version, description, skills, mcpServers", () => {
    const m = readJson(at(".codex-plugin", "plugin.json"));
    expect(m.name).toBe("diarchy");
    expect(m.version).toBe(pkg.version);
    expect(typeof m.description).toBe("string");
    // Codex's manifest key is mcpServers (not mcp), and every path must start with ./
    expect(m.skills).toBe("./.agents/skills");
    expect(m.mcpServers).toBe("./mcp.json");
    expect(existsSync(at(m.skills as string))).toBe(true);
    expect(existsSync(at(m.mcpServers as string))).toBe(true);
  });

  it("ships no root plugin.json: Codex ignores one without the agent-plugins $schema and Claude never reads it", () => {
    expect(existsSync(at("plugin.json"))).toBe(false);
  });

  it("package.json files ships both plugin manifests, both MCP files, the hooks and the Codex copies", () => {
    const files = (readJson(at("package.json")) as { files: string[] }).files;
    for (const entry of [".claude-plugin", ".codex-plugin", ".mcp.json", "mcp.json", ".agents", ".codex", "hooks", "bin"]) {
      expect(files, entry).toContain(entry);
    }
  });

  for (const path of [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"]) {
    it(`${path} lists the diarchy plugin with a local source`, () => {
      const m = readJson(at(path)) as { name: string; owner: { name: string }; plugins: Record<string, string>[] };
      expect(m.name).toBe("diarchy");
      expect(typeof m.owner.name).toBe("string");
      expect(m.plugins).toHaveLength(1);
      expect(m.plugins[0].name).toBe("diarchy");
      expect(m.plugins[0].source).toBe("./");
      expect(typeof m.plugins[0].description).toBe("string");
    });
  }

  it(".mcp.json (Claude) starts the stdio server as agent claude", () => {
    const m = readJson(at(".mcp.json")) as { mcpServers: Record<string, { command: string; args: string[] }> };
    const s = m.mcpServers.diarchy;
    expect(s.command).toBe("node");
    expect(s.args[0]).toBe("${CLAUDE_PLUGIN_ROOT}/bin/diarchy.js");
    expect(s.args.slice(1)).toEqual(["mcp", "--agent", "claude"]);
  });

  it("mcp.json (Codex) starts the stdio server as agent codex from the plugin root with tool_timeout_sec >= 600", () => {
    const m = readJson(at("mcp.json")) as {
      mcpServers: Record<
        string,
        { command: string; args: string[]; cwd: string; env_vars: string[]; tool_timeout_sec: number; startup_timeout_sec: number }
      >;
    };
    const s = m.mcpServers.diarchy;
    expect(s.command).toBe("node");
    // Codex rewrites a relative cwd to the plugin root but never rewrites args,
    // so the script path stays relative and resolves through cwd.
    expect(s.cwd).toBe(".");
    expect(s.args[0]).toBe("bin/diarchy.js");
    expect(existsSync(at(s.args[0]))).toBe(true);
    expect(s.args.slice(1)).toEqual(["mcp", "--agent", "codex"]);
    // With cwd at the plugin root the server finds the project only through DIARCHY_PROJECT.
    expect(s.env_vars).toContain("DIARCHY_PROJECT");
    expect(s.tool_timeout_sec).toBeGreaterThanOrEqual(600);
    expect(s.startup_timeout_sec).toBeGreaterThan(0);
  });
});

describe("codex-config: hooks", () => {
  type HookEntry = { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] };
  type HooksFile = { hooks: Record<string, HookEntry[]> };

  /** Every hook command in a hooks file, in file order. */
  const commandsOf = (path: string): string[] =>
    Object.values((readJson(at(path)) as unknown as HooksFile).hooks).flatMap((entries) =>
      entries.flatMap((entry) => entry.hooks.map((hook) => hook.command)),
    );

  // Each CLI loads its own file through its own plugin manifest and sets the
  // plugin root in the environment of plugin hooks: CLAUDE_PLUGIN_ROOT for
  // Claude Code, PLUGIN_ROOT for Codex (which also sets CLAUDE_PLUGIN_ROOT).
  const HOOK_FILES = [
    ["hooks/hooks.json", "claude", "CLAUDE_PLUGIN_ROOT"],
    ["hooks/codex-hooks.json", "codex", "PLUGIN_ROOT"],
  ] as const;

  for (const [path, agent, rootVar] of HOOK_FILES) {
    it(`${path} wires SessionStart, PreToolUse, and Stop to the shared wrappers as ${agent}, resolved from \${${rootVar}}`, () => {
      const h = readJson(at(path)) as unknown as HooksFile;
      expect(Object.keys(h.hooks).sort()).toEqual(["PreToolUse", "SessionStart", "Stop"]);
      const commands: Record<string, string> = {};
      for (const event of ["SessionStart", "PreToolUse", "Stop"]) {
        const entries = h.hooks[event];
        expect(entries.length).toBeGreaterThan(0);
        for (const entry of entries) {
          for (const hook of entry.hooks) {
            expect(hook.type).toBe("command");
            expect(hook.timeout).toBeGreaterThan(0);
            expect(hook.command.endsWith(` ${agent}`)).toBe(true);
            commands[event] = hook.command;
          }
        }
      }
      for (const command of commandsOf(path)) {
        // Never a cwd-relative script: hooks run in the session directory, not the plugin.
        expect(command, command).toMatch(new RegExp(`^bash "\\$\\{${rootVar}\\}/hooks/[a-z-]+\\.sh" ${agent}$`));
        expect(command, command).not.toContain("DIARCHY_ROOT");
      }
      // Every SessionStart source both CLIs send, `fork` included (--fork-session, /fork, /branch).
      expect(h.hooks.SessionStart[0].matcher?.split("|").sort()).toEqual(["clear", "compact", "fork", "resume", "startup"]);
      expect(h.hooks.PreToolUse[0].matcher).toBe("Bash");
      expect(commands.SessionStart).toContain("/hooks/session-start.sh");
      expect(commands.PreToolUse).toContain("/hooks/pre-tool-guard.sh");
      expect(commands.Stop).toContain("/hooks/stop-gate.sh");
    });

    it(`${path} runs the plugin's wrappers as ${agent} from any cwd, never a project-supplied hooks/ script`, () => {
      const tmp = mkdtempSync(join(tmpdir(), "diarchy-hooks-"));
      try {
        // A project directory that ships its own hooks/*.sh: a cwd-relative command would run these.
        const project = join(tmp, "project");
        const marker = join(tmp, "project-script-ran");
        mkdirSync(join(project, "hooks"), { recursive: true });
        for (const script of ["session-start.sh", "pre-tool-guard.sh", "stop-gate.sh"]) {
          writeFileSync(join(project, "hooks", script), `#!/usr/bin/env bash\ntouch "${marker}"\n`, { mode: 0o755 });
        }
        // Stand-in for bin/diarchy.js: prints its arguments as one JSON object.
        const fakeBin = join(tmp, "diarchy.js");
        writeFileSync(fakeBin, "console.log(JSON.stringify({ argv: process.argv.slice(2) }));\n");
        const env: NodeJS.ProcessEnv = { ...process.env, [rootVar]: root.replace(/\/$/, ""), DIARCHY_BIN: fakeBin };
        delete env.DIARCHY_ROOT;
        // pre-tool-guard.sh skips node unless the event mentions diarchy; the other two ignore stdin.
        const input = JSON.stringify({ tool_name: "Bash", tool_input: { command: "diarchy reply ok" } });
        for (const command of commandsOf(path)) {
          const run = spawnSync("sh", ["-c", command], { cwd: project, env, input, encoding: "utf8" });
          expect(run.status, `${command}: ${run.stderr}`).toBe(0);
          const out = JSON.parse(run.stdout) as { argv: string[] };
          expect(out.argv.slice(-2)).toEqual(["--agent", agent]);
        }
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  }

  it("the Codex manifest declares hooks/codex-hooks.json, so Codex never falls back to the Claude hooks/hooks.json", () => {
    // Without a hooks entry Codex loads the plugin's hooks/hooks.json, which runs the gate as claude.
    const m = readJson(codexManifest);
    expect(m.hooks).toBe("./hooks/codex-hooks.json");
    expect(existsSync(at(m.hooks as string))).toBe(true);
    // Claude Code reads .claude-plugin/plugin.json and loads hooks/hooks.json by default; no override there.
    expect(readJson(at(".claude-plugin", "plugin.json")).hooks).toBeUndefined();
  });

  it("ships no project-layer .codex/hooks.json beside the plugin hooks", () => {
    // In a trusted diarchy checkout Codex would run it as well as the plugin hooks, without PLUGIN_ROOT.
    expect(existsSync(at(".codex", "hooks.json"))).toBe(false);
  });

  for (const script of ["session-start.sh", "pre-tool-guard.sh", "stop-gate.sh"]) {
    it(`hooks/${script} is executable and uses strict mode`, () => {
      const path = at("hooks", script);
      expect(statSync(path).mode & 0o111).not.toBe(0);
      const text = readFileSync(path, "utf8");
      expect(text.startsWith("#!/usr/bin/env bash\n")).toBe(true);
      expect(text).toContain("set -euo pipefail");
      expect(text.trimEnd().endsWith("exit 0")).toBe(true);
    });
  }
});

describe("codex-config: skills", () => {
  it(".agents/skills/ equals skills/ byte for byte (run npm run sync-skills to fix)", () => {
    const src = at("skills");
    const dst = at(".agents", "skills");
    const srcFiles = walk(src);
    expect(srcFiles.length).toBeGreaterThan(0);
    expect(walk(dst)).toEqual(srcFiles);
    for (const rel of srcFiles) {
      expect(readFileSync(join(dst, rel)).equals(readFileSync(join(src, rel)))).toBe(true);
    }
  });

  it("ships diarchy-pm, diarchy-kickoff, diarchy-review with name and description frontmatter", () => {
    const dirs = readdirSync(at("skills")).sort();
    expect(dirs).toEqual(["diarchy-kickoff", "diarchy-pm", "diarchy-review"]);
    for (const dir of dirs) {
      const { fields, body } = markdownFrontmatter(at("skills", dir, "SKILL.md"));
      expect(fields.name).toBe(dir);
      expect(fields.description.length).toBeGreaterThan(40);
      expect(body.length).toBeGreaterThan(200);
    }
  });

  it("diarchy-pm is under 900 words", () => {
    const words = readFileSync(at("skills", "diarchy-pm", "SKILL.md"), "utf8").split(/\s+/).filter(Boolean).length;
    expect(words).toBeLessThan(900);
  });

  it("diarchy-pm bounds the lead's wait on a silent challenger and names the basis to DECIDE on", () => {
    const text = readFileSync(at("skills", "diarchy-pm", "SKILL.md"), "utf8");
    const plan = text.slice(text.indexOf("## PLAN phase"), text.indexOf("## EXECUTE phase"));
    // PHASE_GATE decides plan last, so a thread the challenger opened comes first.
    expect(plan).toContain("After two `{ timeout: true }` with none, or once the challenger posts something else, DECIDE any thread it opened, then plan.");
    expect(plan).toContain("`authority` when no CHALLENGE came");
    expect(plan).toContain("the lead decides after two of its `wait_for_reply` timeouts");
  });

  it("diarchy-pm and diarchy-review carry the fix and re-review loop after request_changes", () => {
    const pm = readFileSync(at("skills", "diarchy-pm", "SKILL.md"), "utf8");
    const execute = pm.slice(pm.indexOf("## EXECUTE phase"), pm.indexOf("## Delegation"));
    expect(execute).toContain("On `request_changes`: author fixes, posts STATUS with the `commit`; lead ASSIGNs a re-review.");
    const review = readFileSync(at("skills", "diarchy-review", "SKILL.md"), "utf8");
    expect(review).toContain("After `request_changes`, the author fixes the PR and posts STATUS with the fix `commit`, then the lead ASSIGNs a re-review.");
  });

  it("diarchy-review checks out the PR detached and keeps a request_changes STATUS from marking ACs passing", () => {
    const text = readFileSync(at("skills", "diarchy-review", "SKILL.md"), "utf8");
    expect(text).toContain("git checkout --detach FETCH_HEAD");
    expect(text).toContain("git checkout --detach <branch>");
    expect(text).not.toMatch(/&& git checkout <branch>`/);
    expect(text).toContain("`request_changes`: `re` = only the unmet ACs, each backed by a `test` item with `result: fail`");
    expect(text).toContain("no `pass` items");
  });
});

describe("codex-config: prose", () => {
  it("install docs say to commit AGENTS.md and .codex/agents/ before diarchy start", () => {
    // Each PM runs in a worktree cut from HEAD and Codex reads both only from its own worktree.
    expect(readFileSync(at("docs", "QUICKSTART.md"), "utf8")).toContain("git add AGENTS.md .codex && git commit");
    expect(readFileSync(at("README.md"), "utf8")).toContain("git add AGENTS.md .codex && git commit");
    expect(readFileSync(at("docs", "INSTALL-CODEX.md"), "utf8")).toContain("Commit `AGENTS.md` and `.codex/agents/` before `diarchy start`");
  });

  it("install docs never send Codex to a project-layer .codex/hooks.json or a DIARCHY_ROOT path", () => {
    // Codex hooks ride the plugin (hooks/codex-hooks.json, resolved from PLUGIN_ROOT).
    for (const file of ["README.md", "docs/INSTALL-CODEX.md", "docs/QUICKSTART.md", "docs/ARCHITECTURE.md", "src/cli/init.ts"]) {
      const text = readFileSync(at(file), "utf8");
      expect(text.includes(".codex/hooks.json"), file).toBe(false);
      expect(text.includes("DIARCHY_ROOT"), file).toBe(false);
    }
  });

  it("plugin prose contains no em-dashes", () => {
    const files = [
      ...walk(at("skills")).map((f) => at("skills", f)),
      ...walk(at("agents")).map((f) => at("agents", f)),
      ...walk(at(".codex")).map((f) => at(".codex", f)),
      at(".codex-plugin", "plugin.json"),
      at("mcp.json"),
      at("templates", "AGENTS.md"),
      at("docs", "INSTALL-CLAUDE.md"),
      at("docs", "INSTALL-CODEX.md"),
    ];
    for (const file of files) {
      expect(readFileSync(file, "utf8").includes("\u2014"), relative(root, file)).toBe(false);
    }
  });
});

describe("codex-config: marketplace entry and project settings", () => {
  it(".agents/plugins/marketplace.json gives the entry the policy and category the Codex plugin guide requires", () => {
    const m = readJson(at(".agents", "plugins", "marketplace.json")) as {
      plugins: { policy?: { installation?: string; authentication?: string }; category?: string }[];
    };
    const [entry] = m.plugins;
    expect(["AVAILABLE", "INSTALLED_BY_DEFAULT", "NOT_AVAILABLE"]).toContain(entry.policy?.installation);
    expect(["ON_INSTALL", "ON_USE"]).toContain(entry.policy?.authentication);
    expect(typeof entry.category).toBe("string");
    expect(entry.category?.trim()).not.toBe("");
  });

  it(".claude/settings.json rejects the root .mcp.json as a project server, so only the plugin-scoped server starts in this checkout", () => {
    // The root .mcp.json is the plugin's server file; read as a project config it has no ${CLAUDE_PLUGIN_ROOT}.
    const servers = Object.keys((readJson(at(".mcp.json")) as { mcpServers: Record<string, unknown> }).mcpServers);
    const settings = readJson(at(".claude", "settings.json")) as { disabledMcpjsonServers?: string[]; enableAllProjectMcpServers?: boolean };
    expect(settings.disabledMcpjsonServers).toEqual(servers);
    expect(settings.enableAllProjectMcpServers).not.toBe(true);
  });
});

describe("codex-config: skill and install prose", () => {
  const read = (...parts: string[]): string => readFileSync(at(...parts), "utf8");

  it("INSTALL-CODEX.md installs with codex plugin add instead of saying no one-line install exists", () => {
    const text = read("docs", "INSTALL-CODEX.md");
    expect(text).toContain("codex plugin add diarchy@diarchy");
    expect(text).not.toMatch(/no one-line `codex plugin install`/);
  });

  it("diarchy-kickoff hands an active goal to the role read returns, never assuming challenger", () => {
    const text = read("skills", "diarchy-kickoff", "SKILL.md");
    expect(text).not.toContain("You are the challenger for that goal");
    expect(text).toMatch(/Take the `role` that `read` returns \(lead or challenger\)/);
  });

  it("diarchy-pm's review ASSIGN carries new_task, which the store requires on every ASSIGN", () => {
    const line = read("skills", "diarchy-pm", "SKILL.md")
      .split("\n")
      .find((text) => text.includes("ASSIGN `kind: review`"));
    expect(line).toContain('`new_task: "Review <pr>"`');
  });

  it("the PM prose takes worktree and branch from config or the ASSIGN, never a hard-coded default", () => {
    const pm = read("skills", "diarchy-pm", "SKILL.md");
    expect(pm).not.toContain(".diarchy/worktrees/<agent>");
    expect(pm).not.toContain("`branch: diarchy/");
    expect(pm).toContain("omitting `worktree` and `branch`");
    expect(pm).toContain("`git worktree add <worktree> -b <branch>`");
    expect(read("skills", "diarchy-review", "SKILL.md")).toContain("`<worktrees.root>/<you>` and `<branch_prefix>/<goal-id>/<you>` from `diarchy.config.json`");
    const agents = read("templates", "AGENTS.md");
    expect(agents).toContain("`<worktrees.root>/codex` and `<branch_prefix>/<goal-id>/codex`");
    expect(agents).not.toMatch(/Work only in `\.diarchy\/worktrees\/codex`/);
  });
});
