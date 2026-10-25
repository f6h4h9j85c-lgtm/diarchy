# Install diarchy into Codex CLI

Codex loads four things from this repository: the skills in `.agents/skills/`
(byte-for-byte copies of `skills/`, refreshed with `npm run sync-skills`), the
`diarchy` MCP server, the hooks in `.codex/hooks.json`, and the custom subagents
in `.codex/agents/*.toml`.

Requirements: Node 20 or later on `PATH`, Codex CLI with plugin and hook support
(October 2026 or later), and `npm ci && npm run build` run in the diarchy
checkout so that `dist/` exists.

## 1. Add the marketplace and enable the plugin

```
codex plugin marketplace add f6h4h9j85c-lgtm/diarchy
```

Then enable it from the `/plugins` picker inside Codex, or add this to
`~/.codex/config.toml`:

```toml
[plugins."diarchy@diarchy"]
enabled = true
```

There is no one-line `codex plugin install`; the marketplace add plus the enable
line is the whole step. The plugin manifest is the root `plugin.json`; the
marketplace file is `.agents/plugins/marketplace.json`.

## 2. Register the MCP server

Add to `~/.codex/config.toml`, replacing the path with the absolute path of your
diarchy checkout (or of the installed plugin directory):

```toml
[mcp_servers.diarchy]
command = "node"
args = ["/abs/path/to/diarchy/bin/diarchy.js", "mcp", "--agent", "codex"]
startup_timeout_sec = 20
tool_timeout_sec = 1800
```

Why the raised timeouts: `wait_for_reply` blocks for up to 110 seconds per call
and the PM chains several while the other agent works; Codex's default tool
timeout would cut the call off mid-wait and the PM would fall back to polling.
`startup_timeout_sec = 20` covers a cold `node` start on a slow disk.

Use an absolute path. The bundled `mcp.json` uses `bin/diarchy.js` relative to
the plugin root, which is what the plugin loader provides; the `config.toml`
entry above is the route that works regardless of how Codex resolves plugin
paths, and `--agent codex` is what makes this server post as `codex`.

## 3. Trust the project

Project-level hooks (`.codex/hooks.json`) and subagents (`.codex/agents/`) run
only in a trusted project. Start `codex` once in the project root and accept the
trust prompt, or add to `~/.codex/config.toml`:

```toml
[projects."/abs/path/to/project"]
trust_level = "trusted"
```

## 4. Project files

- Run `diarchy init` in the project root. It writes `diarchy.config.json`
  (vault path, both agents' launch commands, budgets), creates the vault, and
  adds `.diarchy/` to `.gitignore`.
- Copy `templates/AGENTS.md` to the project root as `AGENTS.md` (or append its
  content to an existing one). Codex reads `AGENTS.md` at session start; the
  template tells the PM to call `read` and load `diarchy-pm`, without
  duplicating the skill.
- Hook path resolution: `.codex/hooks.json` runs
  `bash "${DIARCHY_ROOT:-.}/hooks/stop-gate.sh" codex`. Codex executes hook
  commands through a shell from the project root and offers no plugin-root
  variable (Claude Code's `${CLAUDE_PLUGIN_ROOT}` has no Codex equivalent), and
  `$(dirname "$0")` inside such a command resolves to the shell, not to
  `hooks.json`. So the default `.` works when diarchy is the project itself or
  is checked out at the project root; otherwise export `DIARCHY_ROOT` to the
  absolute diarchy directory, or edit the three commands in `.codex/hooks.json`
  to absolute paths. The wrapper scripts then locate `bin/diarchy.js` relative
  to their own file, or honour `DIARCHY_BIN`. They always exit 0 and print
  nothing when diarchy is missing, so a wrong path degrades to no hooks, never
  to a broken session.

## 5. Headless runs

```
codex exec --sandbox workspace-write "Call the diarchy read tool and act on what it returns."
codex exec resume <SESSION_ID>
```

Fresh approval prompts fail in headless mode, so trust the project first (step
3) and keep `--sandbox workspace-write`: the PM must write to its worktree under
`.diarchy/worktrees/codex` and run the project's tests. The diarchy launcher
uses this form for `agents.codex.command` in `diarchy.config.json`.

## 6. Confirm it is connected

1. Inside Codex run `/mcp`; `diarchy` must be listed with the seven tools
   `kickoff`, `post`, `read`, `wait_for_reply`, `decide`, `assign`, `status`.
2. Inside Codex run `/skills` (or ask "which skills do you have"); the three
   `diarchy-*` skills must appear.
3. Ask Codex to call the diarchy `read` tool. With no goal in the vault it
   answers `{ ok: false, rule: "NO_GOAL", ... }`; that is the server working.
   Once a goal exists it returns the phase, your role, and unread messages.
4. With a goal active, the session starts with the inbox brief from
   `diarchy inbox-skim --agent codex`. With no active goal nothing is printed.
5. Ask Codex to run `diarchy reply "test"` in the shell. The PreToolUse hook
   denies it with a reason naming `wait_for_reply`; the human's commands are
   not for a PM (ANTI-SLOP.md, What this does NOT prevent).
