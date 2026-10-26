# Architecture

diarchy is five components around one directory of markdown files. The vault on disk is the only state, and the only way to change it is a message the protocol engine accepts.

## Components

**Protocol engine** (`src/protocol/`). Pure functions with no filesystem and no clock. `evaluate(message, state, { now, callerAgent })` runs the 25 rules of `docs/ANTI-SLOP.md` in order and returns `{ ok: false, rule, message }` or an acceptance carrying the next `GoalState` and its effects (a phase change, a system ASK_HUMAN to write). `tick(state, now)` fires the time-based transitions: deadlock deadline and wall clock. `schema.ts` holds the shapes, `rules.ts` one function per rule, `state.ts` the queries, `engine.ts` the transition.

**Vault store** (`src/vault/`). One `VaultStore` posts as one agent: `claude`, `codex`, or `human`. It owns the goal lock (`.lock/` by atomic `mkdir`, signed with an owner token and refreshed while held; stale after 30 s or once its owner died, and taken over by one reaper at a time; PROTOCOL.md 2.2) and the vault lock (`goals/.lock/`) that serializes kickoff, id and timestamp assignment, the writer-owned message files under `chat/`, `budget.json`, the inbox cursors, and the renderers in `render/` (spec: `docs/RENDERING.md`). A post is one transaction: lock, move aside any `chat/` file a crash left uncommitted, tick, evaluate, write the message file, apply effects (a system ASK_HUMAN file), persist state, re-render `goal.md`, `chat.md`, and `decisions.md`, unlock. Persisting `budget.json` is the commit point: a transaction that throws before it removes the files it wrote, and reads and renders show only the messages `budget.json` records. Reads take the lock only to apply a due tick.

**MCP server** (`src/mcp/`). `diarchy mcp --agent <id>` serves one store over stdio: seven tools (`kickoff`, `post`, `read`, `wait_for_reply`, `decide`, `assign`, `status`) and two resources (`diarchy://goal`, `diarchy://chat`). A rejection comes back as the tool result with `isError` set, so the model reads `rule` and `message` and does what the message says. `wait_for_reply` blocks for up to 110 s with a progress notification every 15 s and runs the store tick while it waits. One live server per agent acts on a goal (`inbox/<agent>.lock/`); a second one for the same agent answers `AGENT_BUSY`, so two sessions never split one inbox cursor.

**Plugins** (`skills/`, `agents/`, `hooks/`, `.claude-plugin/`, `.codex-plugin/`, `.agents/`, `.codex/`). The same three skills and five subagents are packaged for Claude Code and Codex (`npm run sync-skills` copies the skills; a test keeps the `.toml` agents in step). The SessionStart hook runs `diarchy inbox-skim --agent <id>`, a brief of at most 15 lines. The Stop hook runs `diarchy gate --agent <id>` and keeps the turn open while the agent owes a reply, a decision, or an assignment, up to 12 times per session without a new message. It does not hold a session while another session's server holds the agent's lease, since every diarchy tool would answer that session `AGENT_BUSY`; when it cannot tell whose server holds the lease (a CLI running as pid 1 in a container, another pid namespace), it holds the session as usual. The PreToolUse hook runs `diarchy guard --agent <id>` on each Bash call and denies one that runs `diarchy reply` or `diarchy stop`: those post as the human, an identity any local process can assume (ANTI-SLOP.md, What this does NOT prevent).

**Launcher** (`src/cli/`). `diarchy start` kicks off as `human`, creates the worktrees, spawns one child per agent through a driver, and supervises: restarts a dead child with backoff, holds a PM back while another session holds its agent's lease, watches `budget.json`, exits 0 on DONE and 2 on BLOCKED. The real driver runs `claude -p --permission-mode acceptEdits --permission-prompts none --allowedTools "mcp__plugin_diarchy_diarchy__*,Bash(git *),Bash(npm *),Bash(node *),Bash(gh *)"` and `codex exec --sandbox workspace-write --dangerously-bypass-hook-trust` (headless Codex cannot answer the `/hooks` trust prompt, and untrusted hooks are skipped silently) with a one-line prompt, best-effort session resume, and `DIARCHY_AGENT` and `DIARCHY_PROJECT` in the environment. Headless Claude has no one to answer a permission prompt, so the diarchy tools and the PM's shell commands are allowed up front and anything else is denied; the flags live in `diarchy.config.json` under `agents.<id>.args`. The Codex sandbox stays on, so the Codex PM edits and tests in its worktree but cannot commit, push, or open a PR (the gitdir is read-only, the network is off, and `codex exec` never escalates); the Claude PM commits its work and opens its PR, citing only `commit` with the url in its STATUS body, and the Codex PM posts the `pr` evidence itself, so it stays the PR's author and the Claude PM can review it (PROTOCOL.md 9.1, 9.2(f)); `start` prints a one-line notice saying so. `diarchy init --codex-full-access` opts in to `codex exec --dangerously-bypass-approvals-and-sandbox`, which gives the Codex PM the user's full OS permissions (INSTALL-CODEX.md section 5). The fake driver runs `src/cli/fake-pm.ts`. `reply`, `stop`, `status`, and `watch` are the human's commands.

## Data flow

```
   +---------------------+                 +---------------------+
   | Claude Code         |                 | Codex CLI           |
   | PM "claude"         |                 | PM "codex"          |
   | skills, hooks,      |                 | skills, hooks,      |
   | 5 subagents         |                 | 5 subagents         |
   +----------+----------+                 +----------+----------+
              | stdio MCP                             | stdio MCP
   +----------v----------+                 +----------v----------+
   | diarchy mcp         |                 | diarchy mcp         |
   |   --agent claude    |                 |   --agent codex     |
   | engine + store      |                 | engine + store      |
   +----------+----------+                 +----------+----------+
              |  lock · write own chat/*.md · render  |
              +------------------+--------------------+
                                 v
          <project> brain/diarchy/goals/<goal-id>/
            kickoff.md  chat/  budget.json  inbox/  .lock/
            goal.md  chat.md  decisions.md        (rendered)
                                 ^
   +-----------------------------+----------------------------+
   | diarchy start | watch | status | reply | stop             |
   | launcher: supervisor, drivers, fake PM; posts as "human" |
   +-----------------------------+----------------------------+
                                 ^
                            the human
                 (Obsidian on a phone, or the terminal)

   .diarchy/worktrees/claude  on  diarchy/<goal-id>/claude
   .diarchy/worktrees/codex   on  diarchy/<goal-id>/codex
```

Each CLI talks to its own server over stdio. Each server has its own store and agent id; the two share the goal directory and coordinate only through the lock. The launcher and the human's commands use a third store that posts as `human`. Obsidian reads the rendered files; nobody writes them by hand.

## Design choices

**One file per message, views rendered by the store.** A message file is written once by its author and never edited, so two processes never contend for the same bytes and the filename (`<ts>-<seq>-<agent>-<TYPE>.md`) is the audit record. `goal.md`, `chat.md`, and `decisions.md` are derived from those files and `budget.json` on every accepted message, deterministically, so tests regenerate them and compare bytes.

**MCP as the only door.** The PMs never open the vault. Everything they know arrives through `read` and `wait_for_reply`; everything they say leaves through `post`, `decide`, `assign`, or `status`. That is one choke point where every rule runs, and it makes the system portable: any MCP client that can run a stdio server can be a third agent.

**Enforcement in code.** `docs/ANTI-SLOP.md` explains why prompts are not enough. A rejected message is never written, the rule id is stable, and the error text names the next legal action. Every rule has fixtures in `test/fixtures/protocol/`, so a regression is a failing test, not a transcript someone has to read.

**Evidence-based tiebreak.** A challenge must name a test. The lead adopts it, rejects it on the test's result, or rules by authority and says why; a decided thread reopens only on new evidence. Nothing lets the longer argument win, and when the lead does not decide, the goal blocks and the human rules.

**A worktree per agent.** Each PM commits on its own branch in its own checkout, so the two never edit the same working tree, every change arrives as a PR, and the other model reviews it before merge.

**Why the fake PM exists.** `diarchy start --driver fake` runs the whole path, launcher to rendered files, with a scripted agent and no model calls. `good` mode reaches DONE; `slop` mode posts the classic failures, the protocol rejects them, and the run deadlocks and pages the human. It is the end-to-end test in CI and the way to watch a run before spending tokens.
