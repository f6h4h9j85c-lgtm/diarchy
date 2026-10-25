# Install diarchy into Codex CLI

Codex loads four things from this repository: the skills in `.agents/skills/`
(byte-for-byte copies of `skills/`, refreshed with `npm run sync-skills`), the
`diarchy` MCP server from `mcp.json`, the hooks in `hooks/codex-hooks.json`, and
the custom subagents in `.codex/agents/*.toml`, which `diarchy init` copies into
your project because Codex reads subagents only from there.

Requirements: Node 20.3 or later on `PATH`, Codex CLI with plugin and hook
support (October 2026 or later), and `npm ci` run in the diarchy checkout so that
`node_modules/` exists (`dist/` is committed, so there is no build step).

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
it names the skills directory (`./.agents/skills`), the MCP server file
(`./mcp.json`), and the hooks file (`./hooks/codex-hooks.json`). The marketplace
file is `.agents/plugins/marketplace.json`.
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
timeout would cut every call off mid-wait, so the PM gets a tool error in place
of each reply and only its next call brings the message in (the server drops a
cut-off wait without moving the inbox cursor, so nothing is lost, but every
wait costs a failed turn). `startup_timeout_sec = 20` covers a cold `node`
start on a slow disk. The plugin's `mcp.json` carries the same two
values.

## 3. Trust the project, then trust the hooks

Project-level subagents (`.codex/agents/`) load only in a trusted project. Start
`codex` once in the project root and accept the trust prompt, or add to
`~/.codex/config.toml`:

```toml
[projects."/abs/path/to/project"]
trust_level = "trusted"
```

The hooks come with the plugin (`hooks/codex-hooks.json`, section 4), not from
the project, and before a non-managed hook runs, Codex requires you to review
and trust its exact definition: start `codex` in the project, run `/hooks`, and
approve the three diarchy hooks (SessionStart, PreToolUse, and Stop). Codex
records trust against each hook's current hash in your user configuration, so
approve them again after a diarchy update changes them. Enabling the plugin
does not trust its hooks, and project-layer config cannot grant hook trust.
Until all three are trusted, the session starts without the inbox brief, the
Stop gate never runs, and nothing denies the PM a shell call to the human's
`diarchy reply` or `diarchy stop`.

## 4. Project files

- Run `diarchy init` in the project root. It writes `diarchy.config.json`
  (vault path, both agents' launch commands, budgets), creates the vault, and
  adds `.diarchy/` to `.gitignore`. When `codex` is one of the agents it also
  copies Codex's two project files from the diarchy package: the five
  subagents into `.codex/agents/` (Codex loads subagents from the project,
  never from a plugin) and `templates/AGENTS.md` to `AGENTS.md`. An existing
  file is kept; if your `AGENTS.md` predates diarchy, append the template to
  it. Codex reads `AGENTS.md` at session start; the template tells the PM to
  call `read` and load `diarchy-pm`, without duplicating the skill.
- Commit `AGENTS.md` and `.codex/agents/` before `diarchy start`. The launcher
  runs each PM in a git worktree cut from HEAD, and Codex looks for
  `AGENTS.md` and `.codex/` from its git root, which in a worktree is the
  worktree itself, so uncommitted copies in the main checkout never reach the
  Codex PM. `diarchy start` prints a note when either is missing from the
  worktrees.
- Hooks come with the plugin; nothing is copied for them. The manifest's
  `hooks` entry names `hooks/codex-hooks.json`, whose three commands run
  `bash "${PLUGIN_ROOT}/hooks/session-start.sh" codex`,
  `bash "${PLUGIN_ROOT}/hooks/pre-tool-guard.sh" codex`, and
  `bash "${PLUGIN_ROOT}/hooks/stop-gate.sh" codex`. Codex runs hook commands in
  the session's working directory and sets `PLUGIN_ROOT` (and
  `CLAUDE_PLUGIN_ROOT`) to the installed plugin for plugin hooks, so the
  scripts resolve the same from any directory. Without that entry Codex would
  load the plugin's `hooks/hooks.json`, the Claude Code file, and run its
  hooks as `claude`. Codex runs a plugin hook only once you approve it: run
  `/hooks` in Codex and trust all three diarchy hooks (step 3). The wrapper
  scripts locate `bin/diarchy.js` relative to their own file, or honour
  `DIARCHY_BIN`, and exit 0 printing nothing when `node` or the binary is
  missing.

## 5. Headless runs

```
codex exec --sandbox workspace-write --dangerously-bypass-hook-trust "Call the diarchy read tool and act on what it returns."
codex exec --sandbox workspace-write --dangerously-bypass-hook-trust resume <SESSION_ID>
```

This is the form the diarchy launcher uses: `diarchy init` writes it to
`agents.codex` in `diarchy.config.json`, and the launcher appends `resume <id>`
on a restart and the prompt last. Fresh approval prompts fail in headless mode,
so trust the project first (step 3).

### The sandbox stays on: the Codex PM cannot commit

With the default the Codex PM edits files and runs tests in its worktree under
`.diarchy/worktrees/codex`, but it cannot commit, push, or open a PR, so its
work is committed by the Claude PM or by you. `codex exec` runs with approvals
set to `never`, so a sandbox denial goes back to the model with nobody to
escalate to, and `--sandbox workspace-write` keeps the worktree's `.git` file
and the git directory it points at (`.git/worktrees/codex` in the main
checkout) read-only and the network off. `git commit` fails with a read-only
file system error on the index lock, and `git push` and `gh pr create` never
reach the network (verified on Codex 0.164.0; turning on `network_access` alone
does not help, the git directory stays read-only). When the Codex PM reports a
finished task, commit and push `.diarchy/worktrees/codex` from outside the
sandbox and open its PR. `diarchy start` prints a one-line notice whenever the
codex args contain `workspace-write`.

### Opt in to full access

```
diarchy init --codex-full-access
```

This writes `["exec", "--dangerously-bypass-approvals-and-sandbox",
"--dangerously-bypass-hook-trust"]` to `agents.codex.args` and prints a
warning. The risk: the Codex PM then runs with your full OS permissions and no
approval prompts. It can read, change, or delete any file your user can,
anywhere on the machine, and reach the network; the worktree becomes a
convention the `diarchy-pm` skill enforces, not a wall. In exchange it can
commit, push, and open PRs itself. Use it only on a machine or container you
are willing to let it change.

Like plain `init`, the flag refuses to touch an existing `diarchy.config.json`
unless you add `--force`, which rewrites the whole file: pass `--vault` again if
your vault is not the default, and reapply any budget or launcher edits. You
can also edit `agents.codex.args` by hand; the array replaces the default
verbatim, so keep `exec` first. Put the default args back to restore the
sandbox.

### Hook trust

`codex exec` never shows the `/hooks` review prompt, and it prints no
warning: hooks that are not yet trusted are skipped silently, so the session
has no inbox brief and the turn ends without the Stop gate. Either approve the
hooks interactively once (step 3) or pass `--dangerously-bypass-hook-trust`,
which runs enabled hooks without persisted trust for that invocation. The
diarchy launcher passes it by default: `diarchy init` writes it into
`agents.codex.args` in `diarchy.config.json`, because a headless run cannot
answer the review prompt and a Codex PM without the Stop gate ends its turn
while it still owes the other PM a reply. The tradeoff: the flag runs every
enabled hook, project and plugin, without review, so use it only in a project
whose hook sources you have read; the diarchy hooks are the three scripts in
`hooks/`. Remove the flag from `agents.codex.args` to require persisted trust
instead.

## 6. Confirm it is connected

1. Inside Codex run `/mcp`; `diarchy` must be listed with the seven tools
   `kickoff`, `post`, `read`, `wait_for_reply`, `decide`, `assign`, `status`.
2. Inside Codex run `/skills` (or ask "which skills do you have"); the three
   `diarchy-*` skills must appear.
3. Inside Codex run `/hooks`; all three diarchy hooks must show as trusted, not
   as pending review.
4. Ask Codex to call the diarchy `read` tool. With no goal in the vault it
   answers `{ ok: false, rule: "NO_GOAL", ... }`; that is the server working.
   Once a goal exists it returns the phase, your role, and unread messages.
5. With a goal active, the session starts with the inbox brief from
   `diarchy inbox-skim --agent codex`. With no active goal nothing is printed.
6. Ask Codex to run `diarchy reply "test"` in the shell. The PreToolUse hook
   denies it with a reason naming `wait_for_reply`; the human's commands are
   not for a PM (ANTI-SLOP.md, What this does NOT prevent).
