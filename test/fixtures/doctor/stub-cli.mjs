// A stand-in for the claude and codex CLIs in test/doctor.test.ts, run as
// `node stub-cli.mjs <claude|codex> <args...>` by a wrapper named after the CLI.
//
// $DOCTOR_STUB names a JSON file. Its `claude` and `codex` maps answer the
// offline queries `diarchy doctor` makes, keyed by the args joined with a
// space: { stdout, stderr, code }, plus `touch` (a file to create first) and
// `sleepMs` (a pause before answering). A call ending in `live.prompt` is a
// live turn, acted out the way the real CLI would run one: record the args,
// run the SessionStart hook, start the diarchy MCP server (Codex: only its
// environment allowlist plus env_vars, from outside the project), call read,
// print the goal id, run the Stop hook, and leave a resumable session id
// behind. `live.<flavor>` picks a failure: "not-logged-in" exits 1 at once,
// "drop-env" starts the server without DIARCHY_PROJECT (Codex from "/", so read answers NO_GOAL;
// Claude from the project, so the server finds it by walking up),
// "no-hooks" runs neither hook, and "slow" pauses `live.slowMs` first.
// Anything else exits 1. No model is called.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [flavor, ...args] = process.argv.slice(2);
const stub = JSON.parse(readFileSync(process.env.DOCTOR_STUB, "utf8"));
const answer = stub[flavor]?.[args.join(" ")];
if (answer !== undefined) {
  if (answer.touch !== undefined) writeFileSync(answer.touch, "");
  if (answer.sleepMs !== undefined) await new Promise((resolve) => setTimeout(resolve, answer.sleepMs));
  if (answer.stdout !== undefined) process.stdout.write(answer.stdout);
  if (answer.stderr !== undefined) process.stderr.write(answer.stderr);
  process.exit(answer.code ?? 0);
}
const live = stub.live;
if (args.at(-1) !== live.prompt) {
  process.stderr.write(`error: unknown command '${args.join(" ")}'\n`);
  process.exit(1);
}
const mode = live[flavor] ?? "ok";
const agent = process.env.DIARCHY_AGENT ?? flavor;
writeFileSync(join(live.record, `${flavor}.args.json`), `${JSON.stringify(args)}\n`);
if (mode === "not-logged-in") {
  process.stdout.write("Not logged in · Please run /login\n");
  process.exit(1);
}
if (mode === "slow") await new Promise((resolve) => setTimeout(resolve, live.slowMs));

const [diarchy, ...diarchyArgs] = live.diarchy;
const hook = (sub, input) => {
  if (mode !== "no-hooks") spawnSync(diarchy, [...diarchyArgs, ...sub, "--agent", agent], { env: process.env, input, encoding: "utf8" });
};
hook(["inbox-skim"], "");

const allowlist = ["HOME", "LOGNAME", "PATH", "SHELL", "USER", "LANG", "LC_ALL", "TERM", "TMPDIR", "TZ"];
const serverEnv = {};
for (const [name, value] of Object.entries(process.env)) {
  if (value === undefined) continue;
  if (name === "DIARCHY_PROJECT" ? mode !== "drop-env" : flavor === "claude" || allowlist.includes(name)) serverEnv[name] = value;
}
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
const transport = new StdioClientTransport({
  command: diarchy,
  args: [...diarchyArgs, "mcp", "--agent", agent],
  env: serverEnv,
  cwd: flavor === "codex" ? "/" : process.cwd(),
  stderr: "ignore",
});
const client = new Client({ name: `stub-${flavor}`, version: "0.0.0" });
await client.connect(transport);
const read = await client.callTool({ name: "read", arguments: {} });
await client.close();
const content = read.structuredContent ?? {};
process.stdout.write(typeof content.goal === "string" ? `${content.goal}\n` : `${JSON.stringify(content)}\n`);

hook(["gate"], JSON.stringify({ session_id: "stub-session" }));
if (flavor === "codex") process.stderr.write(`session id: ${randomUUID()}\n`);
if (flavor === "claude") {
  const id = args[args.indexOf("--session-id") + 1];
  const dir = join(live.projectsDirectory, process.cwd().replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), "{}\n");
}
process.exit(0);
