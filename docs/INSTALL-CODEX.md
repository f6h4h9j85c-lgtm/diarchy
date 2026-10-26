# Install diarchy into Codex CLI

Codex loads four things from this repository: the skills in `.agents/skills/`
(byte-for-byte copies of `skills/`, refreshed with `npm run sync-skills`), the
`diarchy` MCP server from `mcp.json`, the hooks in `hooks/codex-hooks.json`, and
the custom subagents in `.codex/agents/*.toml`, which `diarchy init` copies into
your project because Codex reads subagents only from there.

Requirements: Node 20.3 or later on `PATH`, Codex CLI with plugin and hook
support (October 2026 or later), and the diarchy CLI installed globally on
`PATH` (section 1).
Linux or macOS: native Windows is untested and `diarchy start --driver real`
refuses to run there; use WSL.

## 1. Install the CLI, add the marketplace, and enable the plugin

```
npm install -g github:f6h4h9j85c-lgtm/diarchy
codex plugin marketplace add f6h4h9j85c-lgtm/diarchy
codex plugin add diarchy@diarchy
```

Install the CLI first. Codex copies the plugin into its cache
(`~/.codex/plugins/cache/`) without installing its dependencies, so the
plugin's `bin/diarchy.js` cannot load `dist/` there and hands every call, from
the MCP server in `mcp.json` and from the three hooks, to the `diarchy` on
`PATH`. Without one the MCP server fails to start and each hook exits 1 with a
line on stderr naming the install command.

`codex plugin add <plugin>@<marketplace>` installs a plugin from a marketplace
you have added. Instead of it you can enable the plugin from the `/plugins`
picker inside Codex, or add this to `~/.codex/config.toml`:

```toml
[plugins."diarchy@diarchy"]
enabled = true
```

The manifest Codex reads is `.codex-plugin/plugin.json`: it names the skills
directory (`./.agents/skills`), the MCP server file (`./mcp.json`), and the
hooks file (`./hooks/codex-hooks.json`). The marketplace file is
`.agents/plugins/marketplace.json`.
Codex reads a root `plugin.json` only when it declares the agent-plugins.org
`$schema`, and that format has no `skills` or `mcp` keys, so diarchy ships no
root manifest; without `.codex-plugin/plugin.json` Codex would fall back to the
Claude manifest and start the Claude `.mcp.json` server with a literal
`${CLAUDE_PLUGIN_ROOT}` in its arguments.

## 2. Register the MCP server

The plugin's `mcp.json` already registers the `diarchy` server. It runs
`node bin/diarchy.js mcp --agent codex` with `cwd = "."`, which Codex rewrites
to the installed plugin root; Codex never rewrites relative `args`, so the
relative script path depends on that `cwd`. This server finds the project only
through `DIARCHY_PROJECT`, which `mcp.json` forwards from the environment
(`env_vars`) and `diarchy start` sets for both PMs. Without that variable the
server falls back to its own working directory, which is always Codex's copy of
the plugin in its cache (`~/.codex/plugins/cache/diarchy/diarchy/<version>`),
never a real project, even when Codex runs inside the diarchy checkout.
In the plugin cache that `bin/diarchy.js` runs the global `diarchy` (section 1).

Every interactive session therefore needs this server in
`~/.codex/config.toml`, including sessions in the diarchy checkout; it runs the
global CLI from section 1 directly:

```toml
[mcp_servers.diarchy]
command = "diarchy"
args = ["mcp", "--agent", "codex"]
env_vars = ["DIARCHY_PROJECT"]
startup_timeout_sec = 60
tool_timeout_sec = 1800
```

A `config.toml` server with the same name overrides the plugin's. Codex starts
an MCP server with only a fixed set of environment variables (`HOME`, `PATH`,
and a few more) plus the names in `env_vars`, so without that line the
`DIARCHY_PROJECT` that `diarchy start` sets never reaches the server. This
server has no `cwd`, so it starts in the session directory, and without
`DIARCHY_PROJECT` it finds the project from there: inside a PM's git worktree
(`<worktrees.root>/<agent>`, wherever `worktrees.root` points) the main
checkout that owns it, else the nearest directory at or above it that holds
`diarchy.config.json`. `--agent codex` is what makes this server post as
`codex`.

Why the raised timeouts: Codex's defaults are 30 seconds to start a server and
300 seconds per tool call. Each `wait_for_reply` call blocks for up to 110
seconds, so the default tool timeout already covers every wait, however many
the PM chains while the other agent works; `tool_timeout_sec = 1800` is
headroom over it, not a fix for a cut-off. Keep it above 110, or Codex cuts
waits off and the PM gets a tool error in place of the reply.
`startup_timeout_sec = 60`
doubles the startup default for a cold `node` start on a slow disk; a value
under 30 would shorten it instead. The plugin's `mcp.json` carries the same two
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
  missing. In the plugin cache that `bin/diarchy.js` runs the global `diarchy`
  (section 1); when it cannot start one, the script prints nothing on stdout
  and exits 1 with the reason on stderr, which Codex reports as a failed hook
  run.

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

The Codex PM still posts that PR's `pr` evidence itself (PROTOCOL.md 9.1). The
first agent to cite a PR as `pr` evidence is its author, the review goes to the
agent that is not the author, and DONE needs a PR introduced by each
implementer (9.2(f)). So the PM that commits or opens the PR for the Codex PM
cites only `commit` and passes the url in its STATUS body, and the Codex PM
then cites that url as `pr`. If the Claude PM cites it as `pr` instead, it
becomes the author, the Codex PM is left to review its own code, and DONE is
rejected. Leave the commit and the PR to the Claude PM: if you open the PR
yourself, the Codex PM learns its url only from a message, and you can send one
only with `diarchy reply` while the goal is BLOCKED.

A sandboxed Codex PM cannot check out a PR head to review it either: the
checkout and the fetch both write to the read-only git directory, and the
fetch needs the network too. The `diarchy-review` skill then has it extract the branch into a
temporary directory (`d=$(mktemp -d) && git archive <branch> | tar -x -C "$d"`),
run the tests there, and read the change with `git diff main...<branch>`.

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
   Once a goal exists it returns the goal text (`goal_text`), every acceptance
   criterion with its status (`acs`), the phase, your role, and unread messages.
5. With a goal active, the session starts with the inbox brief from
   `diarchy inbox-skim --agent codex`. With no active goal nothing is printed.
6. Ask Codex to run `diarchy reply "test" --project /nonexistent` in the
   shell. The PreToolUse hook denies it with a reason naming `wait_for_reply`;
   the human's commands are not for a PM (ANTI-SLOP.md, What this does NOT
   prevent). If Codex is not stopped and the command runs, the hook is not
   live: nothing was posted, because `/nonexistent` holds no goal (the command
   exits 1 with "No goal in this vault"), so go back to section 3 and check
   the global install in section 1.
7. From a shell in the project, run `diarchy doctor`. Its `codex` checks read
   `codex mcp get diarchy --json` (`env_vars` must name `DIARCHY_PROJECT`,
   `tool_timeout_sec` must be above 110), start that server with only the
   environment Codex gives it, run the guard hook of the plugin copy in
   `~/.codex/plugins/cache` (which hands the call to the global `diarchy`),
   and look for hook and project trust in `config.toml`, with no model call;
   each problem gets a `fix:` line. `diarchy doctor --live` adds one real
   `codex exec` turn with the launcher's flags that only calls `read`, which
   proves `DIARCHY_PROJECT` reaches the server and the hooks run headless.

One session per agent: while a goal is active, only one session acts as
`codex`. The first session whose diarchy tools touch the goal holds it until
it exits; a second one gets `AGENT_BUSY` from the diarchy tools (PROTOCOL.md
section 10), and its Stop hook lets it end its turn. Where the hook cannot
tell the two sessions apart (a CLI running as pid 1 in a container, or sessions
in different pid namespaces), it keeps the turn open as usual. Next to
`diarchy start`, an interactive session that comes second is refused. One that
came first holds the goal instead: `diarchy start` logs
`codex waiting: another session (pid <pid>) acts as codex on this goal`,
spawns no `codex` PM and uses up no restart meanwhile, and starts the PM once
that session exits. Close the other session, or let it be the PM.
