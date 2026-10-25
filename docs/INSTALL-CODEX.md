# Install diarchy into Codex CLI

Codex loads four things from this repository: the skills in `.agents/skills/`
(byte-for-byte copies of `skills/`, refreshed with `npm run sync-skills`), the
`diarchy` MCP server from `mcp.json`, the hooks in `.codex/hooks.json`, and the
custom subagents in `.codex/agents/*.toml`.

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
line is the whole step. The manifest Codex reads is `.codex-plugin/plugin.json`:
it names the skills directory (`./.agents/skills`) and the MCP server file
(`./mcp.json`). The marketplace file is `.agents/plugins/marketplace.json`.
Codex reads a root `plugin.json` only when it declares the agent-plugins.org
`$schema`, and that format has no `skills` or `mcp` keys, so diarchy ships no
root manifest; without `.codex-plugin/plugin.json` Codex would fall back to the
Claude manifest and start the Claude `.mcp.json` server with a literal
`${CLAUDE_PLUGIN_ROOT}` in its arguments.

## 2. Register the MCP server

The plugin's `mcp.json` already registers the `diarchy` server. It runs
`node bin/diarchy.js mcp --agent codex` with `cwd = "."`, which Codex rewrites
to the installed plugin root; Codex never rewrites relative `args`, so the
relative script path depends on that `cwd`. The server locates the project
through `DIARCHY_PROJECT`, which `mcp.json` forwards from the environment
(`env_vars`) and the diarchy launcher sets for its children. Without that
variable the server falls back to its own working directory, the plugin root,
which is the right project only when Codex runs inside the diarchy checkout.

For interactive use in any other project, add to `~/.codex/config.toml`,
replacing the path with the absolute path of your diarchy checkout (or of the
installed plugin directory):

```toml
[mcp_servers.diarchy]
command = "node"
args = ["/abs/path/to/diarchy/bin/diarchy.js", "mcp", "--agent", "codex"]
startup_timeout_sec = 20
tool_timeout_sec = 1800
```

A `config.toml` server with the same name overrides the plugin's, and this one
starts in the session directory, so the server finds the project by its working
directory. `--agent codex` is what makes this server post as `codex`.

Why the raised timeouts: `wait_for_reply` blocks for up to 110 seconds per call
and the PM chains several while the other agent works; Codex's default tool
timeout would cut the call off mid-wait and the PM would fall back to polling.
`startup_timeout_sec = 20` covers a cold `node` start on a slow disk. The
plugin's `mcp.json` carries the same two values.

## 3. Trust the project, then trust the hooks

Project-level hooks (`.codex/hooks.json`) and subagents (`.codex/agents/`) load
only in a trusted project. Start `codex` once in the project root and accept the
trust prompt, or add to `~/.codex/config.toml`:

```toml
[projects."/abs/path/to/project"]
trust_level = "trusted"
```

Project trust only lets Codex discover the hooks. Before a non-managed hook
runs, Codex requires you to review and trust its exact definition: start
`codex` in the project, run `/hooks`, and approve the two diarchy hooks
(SessionStart and Stop). Codex records trust against each hook's current hash
in your user configuration, so approve them again after editing the commands in
`.codex/hooks.json` or after a diarchy update changes them. Enabling the plugin
does not trust its hooks, and project-layer config cannot grant hook trust.
Until both hooks are trusted, the session starts without the inbox brief and
the Stop gate never runs.

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
  absolute diarchy directory, or edit the two commands in `.codex/hooks.json`
  to absolute paths and approve them again in `/hooks` (step 3). The wrapper
  scripts then locate `bin/diarchy.js` relative to their own file, or honour
  `DIARCHY_BIN`. They always exit 0 and print nothing when diarchy is missing,
  so a wrong path degrades to no hooks, never to a broken session.

## 5. Headless runs

```
codex exec --sandbox workspace-write --dangerously-bypass-hook-trust "Call the diarchy read tool and act on what it returns."
codex exec --sandbox workspace-write --dangerously-bypass-hook-trust resume <SESSION_ID>
```

Fresh approval prompts fail in headless mode, so trust the project first (step
3) and keep `--sandbox workspace-write`: the PM must write to its worktree under
`.diarchy/worktrees/codex` and run the project's tests.

`codex exec` never shows the `/hooks` review prompt either, and it prints no
warning: hooks that are not yet trusted are skipped silently, so the session
has no inbox brief and the turn ends without the Stop gate. Either approve the
hooks interactively once (step 3) or pass `--dangerously-bypass-hook-trust`,
which runs enabled hooks without persisted trust for that invocation. The
diarchy launcher passes it by default: `diarchy init` writes it into
`agents.codex.args` in `diarchy.config.json`, because a headless run cannot
answer the review prompt and a Codex PM without the Stop gate ends its turn
while it still owes the other PM a reply. The tradeoff: the flag runs every
enabled hook, project and plugin, without review, so use it only in a project
whose hook sources you have read; the diarchy hooks are the two scripts in
`hooks/`. Remove the flag from `agents.codex.args` to require persisted trust
instead.

## 6. Confirm it is connected

1. Inside Codex run `/mcp`; `diarchy` must be listed with the seven tools
   `kickoff`, `post`, `read`, `wait_for_reply`, `decide`, `assign`, `status`.
2. Inside Codex run `/skills` (or ask "which skills do you have"); the three
   `diarchy-*` skills must appear.
3. Inside Codex run `/hooks`; both diarchy hooks must show as trusted, not as
   pending review.
4. Ask Codex to call the diarchy `read` tool. With no goal in the vault it
   answers `{ ok: false, rule: "NO_GOAL", ... }`; that is the server working.
   Once a goal exists it returns the phase, your role, and unread messages.
5. With a goal active, the session starts with the inbox brief from
   `diarchy inbox-skim --agent codex`. With no active goal nothing is printed.
