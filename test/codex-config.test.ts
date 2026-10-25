import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const root = new URL("..", import.meta.url).pathname;
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

  it("root plugin.json (Codex) has name, version, description, skills, mcp", () => {
    const m = readJson(at("plugin.json"));
    expect(m.name).toBe("diarchy");
    expect(m.version).toBe(pkg.version);
    expect(typeof m.description).toBe("string");
    expect(m.skills).toBe("./.agents/skills");
    expect(m.mcp).toBe("./mcp.json");
    expect(existsSync(at(m.skills as string))).toBe(true);
    expect(existsSync(at(m.mcp as string))).toBe(true);
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

  it("mcp.json (Codex) starts the stdio server as agent codex with tool_timeout_sec >= 600", () => {
    const m = readJson(at("mcp.json")) as {
      mcpServers: Record<string, { command: string; args: string[]; tool_timeout_sec: number; startup_timeout_sec: number }>;
    };
    const s = m.mcpServers.diarchy;
    expect(s.command).toBe("node");
    expect(s.args[0]).toMatch(/bin\/diarchy\.js$/);
    expect(s.args.slice(1)).toEqual(["mcp", "--agent", "codex"]);
    expect(s.tool_timeout_sec).toBeGreaterThanOrEqual(600);
    expect(s.startup_timeout_sec).toBeGreaterThan(0);
  });
});

describe("codex-config: hooks", () => {
  type HookEntry = { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] };
  type HooksFile = { hooks: Record<string, HookEntry[]> };

  for (const [path, agent] of [
    ["hooks/hooks.json", "claude"],
    [".codex/hooks.json", "codex"],
  ] as const) {
    it(`${path} wires SessionStart and Stop to the shared wrappers as ${agent}`, () => {
      const h = readJson(at(path)) as unknown as HooksFile;
      expect(Object.keys(h.hooks).sort()).toEqual(["SessionStart", "Stop"]);
      const commands: Record<string, string> = {};
      for (const event of ["SessionStart", "Stop"]) {
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
      expect(h.hooks.SessionStart[0].matcher).toBe("startup|resume|clear|compact");
      expect(commands.SessionStart).toContain("/hooks/session-start.sh");
      expect(commands.Stop).toContain("/hooks/stop-gate.sh");
    });
  }

  for (const script of ["session-start.sh", "stop-gate.sh"]) {
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
    expect(plan).toContain("After two `{ timeout: true }` with none, or once the challenger posts something else, DECIDE.");
    expect(plan).toContain("`authority` when no CHALLENGE came");
    expect(plan).toContain("after 4 quiet minutes the lead decides");
  });
});

describe("codex-config: prose", () => {
  it("plugin prose contains no em-dashes", () => {
    const files = [
      ...walk(at("skills")).map((f) => at("skills", f)),
      ...walk(at("agents")).map((f) => at("agents", f)),
      ...walk(at(".codex")).map((f) => at(".codex", f)),
      at("templates", "AGENTS.md"),
      at("docs", "INSTALL-CLAUDE.md"),
      at("docs", "INSTALL-CODEX.md"),
    ];
    for (const file of files) {
      expect(readFileSync(file, "utf8").includes("\u2014"), relative(root, file)).toBe(false);
    }
  });
});
