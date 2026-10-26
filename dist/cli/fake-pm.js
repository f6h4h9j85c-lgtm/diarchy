/**
 * A scripted PM for `diarchy start --driver fake`: runs the protocol honestly
 * through the store library with no model calls, so launcher, store, and engine
 * are exercised end to end.
 *
 *   node --import tsx src/cli/fake-pm.ts [good|slop|silent]
 *
 * Env from the launcher: DIARCHY_AGENT, DIARCHY_PROJECT, DIARCHY_GOAL,
 * DIARCHY_WORKTREE (when the launcher made one), DIARCHY_FAKE_MODE (overrides
 * the positional mode), DIARCHY_FAKE_DEADLINE_MS (default 90000).
 *
 * The agent is state-driven: every loop it reloads budget.json and the chat,
 * derives the one action its role owes, performs it, and otherwise waits with
 * `waitForReply`. A restart therefore resumes where the goal is. Every
 * rejection is logged to stderr as `rejected <RULE>: <message>` and never
 * retried unchanged.
 *
 * good: lead PROPOSEs a plan with one task per AC, challenger CHALLENGEs with a
 * pending test, lead DECIDEs by authority, ASSIGNs tasks alternately, both do
 * fake work (a commit in their worktree, else a fabricated sha) and post
 * STATUS with commit, test, and pr evidence, lead ASSIGNs cross reviews,
 * reviewers approve, lead posts DONE. 13 messages for two ACs. After a human
 * ruling on plan (`diarchy reply --decision plan`) EXECUTE has no tasks, and
 * the lead ASSIGNs one new_task per AC instead.
 *
 * slop: challenger posts an ack-only PROPOSE (NO_ACK), a CHALLENGE without a
 * test (CHALLENGE_NEEDS_TEST), then a valid CHALLENGE; the lead never DECIDEs
 * and instead opens another thread (D1) and tries a second PROPOSE on it
 * (TWO_ROUNDS); the challenger's STATUS is the second accepted message after
 * the CHALLENGE, the deadlock watch trips, and the store posts ASK_HUMAN.
 *
 * silent: as good, except the challenger posts nothing in PLAN. The lead counts
 * its `waitForReply` timeouts and, after two in a row with no CHALLENGE on its
 * plan PROPOSE, DECIDEs plan by authority (PROPOSE -> DECIDE, PROTOCOL.md
 * section 7), as diarchy-pm and the wait_for_reply description tell it to.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { openThreads, reviewOwed } from "../protocol/index.js";
import { VaultStore, loadConfig } from "../vault/index.js";
import { uncoveredAcs } from "./brief.js";
import { branchName } from "./worktrees.js";
const agent = process.env.DIARCHY_AGENT ?? "";
const projectDir = process.env.DIARCHY_PROJECT ?? process.cwd();
const mode = process.env.DIARCHY_FAKE_MODE ?? process.argv[2] ?? "good";
const worktree = process.env.DIARCHY_WORKTREE;
const deadlineMs = Number(process.env.DIARCHY_FAKE_DEADLINE_MS ?? 90_000);
const WAIT_MS = 2_000;
const FAKE_PR_BASE = "https://github.com/example/diarchy-fake/pull";
if (agent === "") {
    console.error("fake-pm: DIARCHY_AGENT is not set");
    process.exit(2);
}
if (mode !== "good" && mode !== "slop" && mode !== "silent") {
    console.error(`fake-pm: unknown mode "${mode}" (good | slop | silent)`);
    process.exit(2);
}
class UnexpectedRejection extends Error {
}
function log(line) {
    console.log(`${agent}: ${line}`);
}
/** Post once; log a rejection as `rejected <RULE>: <message>`. `expect` names the rule(s) a slop post is meant to hit. */
async function post(store, draft, expect = []) {
    const result = await store.post(draft);
    if (!result.ok) {
        console.error(`rejected ${result.rule}: ${result.message}`);
        if (expect.length === 0)
            throw new UnexpectedRejection(`${draft.type} rejected by ${result.rule}`);
        if (!expect.includes(result.rule))
            console.error(`expected ${expect.join(" or ")} but got ${result.rule}`);
        return result;
    }
    log(`posted ${result.id}${result.decision_id === undefined ? "" : ` (${result.decision_id})`} · phase ${result.phase}`);
    if (expect.length > 0)
        console.error(`expected ${expect.join(" or ")} but the store accepted ${result.id}`);
    return result;
}
// ---------------------------------------------------------------------------
// Fake work
// ---------------------------------------------------------------------------
function git(args) {
    const result = spawnSync("git", ["-c", "user.name=diarchy fake pm", "-c", "user.email=diarchy@example.invalid", ...args], {
        cwd: worktree,
        encoding: "utf8",
    });
    if (result.status !== 0)
        throw new Error((result.stderr ?? "").trim() || `git ${args[0]} failed`);
    return (result.stdout ?? "").trim();
}
/** Write a file and commit it in the worktree; without a worktree, fabricate a 7-hex sha. */
function fakeWork(task) {
    if (worktree !== undefined && existsSync(join(worktree, ".git"))) {
        try {
            writeFileSync(join(worktree, `${task.id}.md`), `# ${task.id}\n\n${task.task}\n\nDone by ${agent} in a diarchy fake run.\n`);
            git(["add", "-A"]);
            git(["commit", "-q", "-m", `${task.id}: ${task.task}`]);
            return { sha: git(["rev-parse", "--short=7", "HEAD"]), note: `committed in ${worktree}` };
        }
        catch (error) {
            log(`git failed (${error instanceof Error ? error.message : String(error)}); fabricating a sha`);
        }
    }
    return { sha: randomBytes(4).toString("hex").slice(0, 7), note: "no worktree, sha fabricated" };
}
function fakePrUrl(state, who) {
    return `${FAKE_PR_BASE}/${state.agents.indexOf(who) + 1}`;
}
function acOfTask(task) {
    return `AC${task.id.slice(1)}`;
}
function proposePlan(ctx) {
    const { acs } = ctx;
    return {
        type: "PROPOSE",
        to: "all",
        re: acs,
        decision_id: "plan",
        claim: `One task per acceptance criterion, each landing as a reviewed PR, satisfies ${acs.join(" and ")}.`,
        body: `Tasks: ${acs.map((ac, index) => `T${index + 1} for ${ac}`).join(", ")}. Each lands as a commit on its own branch with a passing test and a cross review.`,
    };
}
// ---------------------------------------------------------------------------
// good
// ---------------------------------------------------------------------------
function goodAction(ctx) {
    const { store, config, state, messages, lead, other, acs } = ctx;
    if (state.phase === "PLAN") {
        const plan = state.decisions.plan;
        if (plan === undefined || plan.status !== "open")
            return null;
        if (lead) {
            if (plan.messages === 0)
                return async () => void (await post(store, proposePlan(ctx)));
            if (plan.challenge !== null) {
                const challengeId = plan.challenge.id;
                return async () => void (await post(store, {
                    type: "DECIDE",
                    to: "all",
                    re: acs,
                    decision_id: "plan",
                    reply_to: challengeId,
                    basis: "authority",
                    claim: "One task per criterion stands; the integration test runs as part of the last task.",
                    tasks: acs.map((ac) => `${ac}: ${state.acs[ac].criterion}`),
                    body: "The integration test cannot run before either task exists, so it joins the last task's acceptance check. Ruling by authority until then.",
                }));
            }
            return null;
        }
        if (plan.messages === 1 && plan.challenges === 0) {
            const propose = messages.find((message) => message.type === "PROPOSE" && message.decision_id === "plan");
            if (propose === undefined)
                return null;
            return async () => void (await post(store, {
                type: "CHALLENGE",
                to: state.lead,
                re: [acs[0]],
                reply_to: propose.id,
                decision_id: "plan",
                claim: "Splitting the work per criterion hides the integration between the tasks until review.",
                evidence: [{ kind: "test", test: "npm test -- integration", result: "pending" }],
            }));
        }
        return null;
    }
    if (state.phase !== "EXECUTE")
        return null;
    const tasks = Object.values(state.tasks);
    const mine = tasks.filter((task) => task.assignee === agent);
    const implement = mine.find((task) => task.kind === "implement" && (task.status === "assigned" || task.status === "in_progress"));
    if (implement !== undefined) {
        return async () => {
            const work = fakeWork(implement);
            log(`${implement.id} ${work.note}`);
            await post(store, {
                type: "STATUS",
                to: "all",
                re: [acOfTask(implement)],
                task: implement.id,
                task_status: "done",
                evidence: [
                    { kind: "commit", sha: work.sha },
                    { kind: "pr", url: fakePrUrl(state, agent) },
                    { kind: "test", test: `npm test -- ${implement.id}`, result: "pass" },
                ],
                body: `${implement.id} landed on ${implement.branch ?? "its branch"}; the ${acOfTask(implement)} test runs green and the PR is open for review.`,
            });
        };
    }
    const review = mine.find((task) => reviewOwed(state, task));
    if (review !== undefined && review.pr !== null) {
        const url = review.pr;
        const introduced = messages.find((message) => message.type === "STATUS" && (message.evidence ?? []).some((item) => item.kind === "pr" && item.url === url));
        return async () => void (await post(store, {
            type: "STATUS",
            to: "all",
            re: introduced?.re ?? acs,
            evidence: [{ kind: "review", url, verdict: "approve" }],
            body: `Reviewed ${url}: the change does what its task says and its test runs green.`,
        }));
    }
    if (!lead)
        return null;
    const todo = tasks.find((task) => task.status === "todo");
    if (todo !== undefined) {
        const index = Number(todo.id.slice(1)) - 1;
        const assignee = index % 2 === 0 ? other : agent;
        return async () => void (await post(store, {
            type: "ASSIGN",
            to: assignee,
            re: [acOfTask(todo)],
            task: todo.id,
            kind: "implement",
            worktree: posix.join(config.worktrees.root, assignee),
            branch: branchName(config, state.goal, assignee),
            reason: "availability",
        }));
    }
    // EXECUTE opened by a human ruling carries no tasks: one new_task per AC the brief counts as uncovered,
    // in AC order and ahead of any review, so T<n> is AC<n>'s task.
    const ac = uncoveredAcs(state, messages)[0];
    if (ac !== undefined) {
        const assignee = acs.indexOf(ac) % 2 === 0 ? other : agent;
        return async () => void (await post(store, {
            type: "ASSIGN",
            to: assignee,
            re: [ac],
            new_task: `${ac}: ${state.acs[ac].criterion}`,
            kind: "implement",
            worktree: posix.join(config.worktrees.root, assignee),
            branch: branchName(config, state.goal, assignee),
            reason: "availability",
        }));
    }
    for (const [url, pr] of Object.entries(state.prs)) {
        const approved = pr.reviews.some((entry) => entry.verdict === "approve" && entry.by !== pr.author);
        const assigned = tasks.some((task) => task.kind === "review" && task.pr === url);
        if (approved || assigned)
            continue;
        const reviewer = state.agents.find((id) => id !== pr.author) ?? other;
        const introduced = messages.find((message) => message.type === "STATUS" && (message.evidence ?? []).some((item) => item.kind === "pr" && item.url === url));
        return async () => void (await post(store, {
            type: "ASSIGN",
            to: reviewer,
            re: introduced?.re ?? acs,
            new_task: `Review ${url}`,
            kind: "review",
            pr: url,
            reason: "availability",
        }));
    }
    const implementTasks = tasks.filter((task) => task.kind !== "review");
    const allDone = implementTasks.length > 0 && implementTasks.every((task) => task.status === "done");
    const allApproved = Object.values(state.prs).every((pr) => pr.reviews.some((entry) => entry.verdict === "approve" && entry.by !== pr.author));
    const allPassing = acs.every((ac) => state.acs[ac].status === "passing");
    if (allDone && allApproved && allPassing && openThreads(state).length === 0 && state.deadlock_watch === null) {
        const commit = [...messages].reverse().flatMap((message) => message.evidence ?? []).find((item) => item.kind === "commit");
        return async () => void (await post(store, {
            type: "DONE",
            to: "all",
            re: acs,
            evidence: [
                { kind: "commit", sha: commit?.kind === "commit" ? commit.sha : randomBytes(4).toString("hex").slice(0, 7) },
                { kind: "test", test: "npm test", result: "pass" },
            ],
            body: "Every PR is approved by the other agent and every acceptance criterion has a passing test.",
        }));
    }
    return null;
}
// ---------------------------------------------------------------------------
// silent
// ---------------------------------------------------------------------------
/** Two timeouts bound the lead's wait for a CHALLENGE that never comes. */
const SILENT_TIMEOUTS = 2;
function silentAction(ctx) {
    const { store, state, lead, acs, timeouts } = ctx;
    if (state.phase !== "PLAN")
        return goodAction(ctx);
    if (!lead)
        return null;
    const plan = state.decisions.plan;
    if (plan === undefined || plan.status !== "open" || plan.messages !== 1 || plan.challenge !== null)
        return goodAction(ctx);
    if (timeouts < SILENT_TIMEOUTS)
        return null;
    return async () => void (await post(store, {
        type: "DECIDE",
        to: "all",
        re: acs,
        decision_id: "plan",
        basis: "authority",
        claim: "One task per criterion stands as proposed.",
        tasks: acs.map((ac) => `${ac}: ${state.acs[ac].criterion}`),
        body: "No CHALLENGE came after two wait_for_reply timeouts, so there is no test to run.",
    }));
}
// ---------------------------------------------------------------------------
// slop
// ---------------------------------------------------------------------------
function slopAction(ctx) {
    const { store, state, messages, lead, acs, memory } = ctx;
    if (state.phase !== "PLAN")
        return null;
    const plan = state.decisions.plan;
    if (plan === undefined || plan.status !== "open")
        return null;
    const otherThreads = Object.keys(state.decisions).filter((id) => id !== "plan");
    if (lead) {
        if (plan.messages === 0)
            return async () => void (await post(store, proposePlan(ctx)));
        if (plan.challenge !== null && otherThreads.length === 0 && !memory.has("sidetrack")) {
            memory.add("sidetrack");
            return async () => {
                const opened = await post(store, {
                    type: "PROPOSE",
                    to: "all",
                    re: [acs[0]],
                    claim: "The default limit should match the figure nginx already enforces per IP.",
                    body: "Instead of deciding the plan, the lead opens a new matter: ops has one number to reason about if the two match.",
                });
                const id = opened.ok ? (opened.decision_id ?? "D1") : "D1";
                await post(store, {
                    type: "PROPOSE",
                    to: "all",
                    re: [acs[0]],
                    decision_id: id,
                    claim: "The default limit should be twice the nginx figure to leave headroom.",
                    body: "A second proposal on the same open thread, which the two-round rule forbids before a DECIDE.",
                }, ["TWO_ROUNDS", "PHASE_GATE"]);
            };
        }
        return null;
    }
    if (plan.messages === 1 && plan.challenges === 0 && !memory.has("challenge")) {
        memory.add("challenge");
        const propose = messages.find((message) => message.type === "PROPOSE" && message.decision_id === "plan");
        if (propose === undefined)
            return null;
        return async () => {
            await post(store, {
                type: "PROPOSE",
                to: "all",
                re: [acs[0]],
                claim: "The plan is fine as written.",
                body: "Sounds good, agreed.",
            }, ["NO_ACK"]);
            await post(store, {
                type: "CHALLENGE",
                to: state.lead,
                re: [acs[0]],
                reply_to: propose.id,
                decision_id: "plan",
                claim: "An in-process bucket meets the criterion if the API runs as one replica.",
                evidence: [{ kind: "file", path: "docs/deploy.md" }],
                body: "docs/deploy.md says one replica.",
            }, ["CHALLENGE_NEEDS_TEST"]);
            await post(store, {
                type: "CHALLENGE",
                to: state.lead,
                re: [acs[0]],
                reply_to: propose.id,
                decision_id: "plan",
                claim: "An in-process bucket meets the criterion if the API runs as one replica.",
                evidence: [{ kind: "test", test: "kubectl -n prod get deploy api -o jsonpath='{.spec.replicas}' prints 1", result: "pending" }],
            });
        };
    }
    const postedStatus = messages.some((message) => message.from === agent && message.type === "STATUS");
    if (plan.challenge !== null && otherThreads.length > 0 && !postedStatus) {
        return async () => void (await post(store, {
            type: "STATUS",
            to: "all",
            re: [acs[0]],
            evidence: [{ kind: "file", path: "notes/integration-probe.md" }],
            body: "Integration probe queued; results land in notes/integration-probe.md. The replica check is still unanswered.",
        }));
    }
    return null;
}
// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
let interrupted = null;
for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
        interrupted = signal;
    });
}
async function main() {
    const config = loadConfig(projectDir);
    const store = new VaultStore({ projectDir, config, agent, pollIntervalMs: 50 });
    const started = Date.now();
    const memory = new Set();
    let timeouts = 0;
    log(`fake PM in ${mode} mode for ${projectDir}`);
    for (;;) {
        if (interrupted !== null) {
            log(`${interrupted}; exiting`);
            return 0;
        }
        const state = store.state();
        if (state === null) {
            console.error("fake-pm: no goal in the vault");
            return 1;
        }
        if (state.phase === "DONE" || state.phase === "BLOCKED") {
            log(`phase ${state.phase}; exiting`);
            return 0;
        }
        const ctx = {
            store,
            config,
            state,
            messages: store.listMessages(),
            lead: state.lead === agent,
            other: state.agents.find((id) => id !== agent) ?? state.challenger,
            acs: Object.keys(state.acs),
            memory,
            timeouts,
        };
        const action = mode === "slop" ? slopAction(ctx) : mode === "silent" ? silentAction(ctx) : goodAction(ctx);
        if (action !== null) {
            timeouts = 0;
            try {
                await action();
            }
            catch (error) {
                // A post that lost a race with a phase change (DONE, BLOCKED, diarchy stop) is not a script bug.
                const phase = store.state()?.phase;
                if (!(error instanceof UnexpectedRejection) || (phase !== "DONE" && phase !== "BLOCKED"))
                    throw error;
            }
            continue;
        }
        if (Date.now() - started > deadlineMs) {
            console.error(`fake-pm: nothing to do for ${deadlineMs} ms in phase ${state.phase}; giving up`);
            return 1;
        }
        const reply = await store.waitForReply({ timeoutMs: WAIT_MS });
        timeouts = "timeout" in reply ? timeouts + 1 : 0;
    }
}
main().then((code) => process.exit(code), (error) => {
    console.error(`fake-pm: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});
//# sourceMappingURL=fake-pm.js.map