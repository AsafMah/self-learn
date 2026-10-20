import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { boot } from "./test-support/host.mjs";

test("review and status are preloaded without changing scheduling or other tools", async (t) => {
    const host = await boot(t);
    const review = host.options.tools.find((tool) => tool.name === "self_learn_now");
    assert.equal(review.defer, "never");
    assert.equal(host.options.tools.find((tool) => tool.name === "propose_skill").defer, undefined);
    assert.match(await review.handler({ action: "status" }, {}), /queued review: no/);
    assert.match(await review.handler({ action: "review" }, {}), /Review queued/);
    assert.equal(host.options.canvases[0].actions[0].handler().status.reviewQueued, true);
});

test("the shipped extension registers its read-only activity action and shared status", async (t) => {
    const host = await boot(t);
    const canvas = host.options.canvases[0];
    assert.equal(canvas.id, "self-learn-activity");
    assert.equal(canvas.inputSchema.additionalProperties, false);
    assert.deepEqual(canvas.actions.map((action) => action.name), ["refresh"]);
    const status = await host.tool("status");
    await host.options.commands.find((command) => command.name === "learn").handler();
    assert.equal(host.logs.at(-1), `self-learn status\n${status}`);
    const data = canvas.actions[0].handler();
    assert.equal(data.sessionId, host.session.sessionId);
    assert.equal(data.status.screenedTurns, 0);
    assert.ok(data.entries.some((entry) => entry.message.startsWith("self-learn ready")));
    assert.equal(JSON.parse(readFileSync(data.historyPath, "utf8")).sessionId, host.session.sessionId);
    host.openInstances = ["integration"];
    const { url } = await canvas.open({ instanceId: "integration" });
    const response = await fetch(url + "state");
    assert.equal((await response.json()).snapshot.sessionId, host.session.sessionId);
});

test("enable/disable tools share CLI behavior without starting a review", async (t) => {
    const host = await boot(t);
    assert.match(await host.tool("disable"), /disabled/);
    assert.equal(host.confirmations.length, 1);
    assert.match(host.confirmations[0], /Disable self-learn for this session/);
    assert.match(await host.tool("status"), /enabled: false/);
    await host.options.commands.find((command) => command.name === "learn-on").handler();
    assert.match(await host.tool("status"), /enabled: true/);
    assert.equal(host.confirmations.length, 1);
    assert.match(await host.tool("activity"), /self-learn disabled for this session/);
    assert.equal(host.options.canvases[0].actions[0].handler().status.reviewQueued, false);
    assert.equal(host.options.canvases[0].actions[0].handler().status.screenedTurns, 0);
    assert.equal((await host.tool("unexpected")).resultType, "rejected");
    assert.equal(host.options.canvases[0].actions[0].handler().status.reviewQueued, false);
});

test("subagent calls cannot use new control or activity actions", async (t) => {
    const host = await boot(t);
    host.emit({ type: "tool.execution_start", agentId: "child-id", data: { toolCallId: "child-call", toolName: "self_learn_now" } });
    for (const action of ["disable", "enable", "activity"]) {
        assert.equal((await host.tool(action, { toolCallId: "child-call" })).resultType, "rejected");
    }
    assert.equal(host.confirmations.length, 0);
    assert.match(await host.tool("status"), /enabled: true/);
});

test("a tool call carrying a sub-agent id is refused without the event log", async (t) => {
    const host = await boot(t);
    const propose = host.options.tools.find((tool) => tool.name === "propose_skill");
    const child = { toolCallId: "never-seen-call", agentId: "child-agent" };
    for (const action of ["status", "review", "disable"]) {
        assert.equal((await host.tool(action, child)).resultType, "rejected");
    }
    const proposal = { mode: "new", name: "fixture-lesson", description: "Fixture", body: "Fixture body" };
    assert.equal((await propose.handler(proposal, child)).resultType, "rejected");
    assert.equal(host.confirmations.length, 0);
    assert.match(await host.tool("status", { toolCallId: "main-call", agentId: null }), /queued review: no/);
});

const rejectingVerdict = (why) => JSON.stringify({
    criteria: Object.fromEntries(["surprising", "expensive", "undiscoverable", "transferable", "uncovered"]
        .map((name) => [name, { pass: false, why: name === "surprising" ? why : "fixture" }])),
    target: "new", skill: "fixture", rationale: "fixture",
});

async function bootScreening(t, config = {}) {
    const host = await boot(t, { config: { pollIntervalMs: 20, timeoutMs: 2000, ...config } });
    host.events.push({ type: "user.message", data: { content: "Fix the fixture bug" } });
    return host;
}

const startedAgent = (host) => host.rpcCalls.find(([kind]) => kind === "tasks.startAgent")[1];
const taskCalls = (host) => host.rpcCalls.filter(([kind]) => kind !== "tasks.startAgent");

test("an owned screener's stop hook delivers its reply and cancels exactly that task", async (t) => {
    const host = await bootScreening(t);
    const hookResults = [];
    host.onStartAgent = async (agentId) => {
        // The main agent's own task-tool children stop through the same hook.
        hookResults.push(await host.stopSubagent("someone-elses-agent", rejectingVerdict("stranger reply")));
        hookResults.push(await host.stopSubagent(agentId, rejectingVerdict("hook reply")));
    };
    await host.command("learn-now");
    assert.match(host.logs.at(-1), /nothing worth learning \(failed: surprising \(hook reply\)/);
    const agentId = startedAgent(host);
    assert.deepEqual(taskCalls(host), [["tasks.cancel", agentId], ["tasks.remove", agentId]]);
    assert.deepEqual(hookResults, [undefined, undefined]);
    assert.equal(host.tasks.size, 0);
});

test("a stop that cancels the screener while its task list is in flight still delivers the reply", async (t) => {
    const host = await bootScreening(t);
    const list = host.session.rpc.tasks.list;
    let agentId;
    host.onStartAgent = (id) => { agentId = id; };
    host.session.rpc.tasks.list = async () => {
        if (agentId && host.tasks.get(agentId)?.status === "running") {
            await host.stopSubagent(agentId, rejectingVerdict("raced reply"));
        }
        return list();
    };
    await host.command("learn-now");
    assert.match(host.logs.at(-1), /failed: surprising \(raced reply\)/);
    assert.deepEqual(taskCalls(host), [["tasks.cancel", agentId], ["tasks.remove", agentId]]);
});

test("without a stop hook a settled screener's reply is polled and its task left readable", async (t) => {
    const host = await bootScreening(t);
    host.onStartAgent = (agentId) => Object.assign(host.tasks.get(agentId), {
        status: "idle", latestResponse: rejectingVerdict("polled reply"),
    });
    await host.command("learn-now");
    assert.match(host.logs.at(-1), /failed: surprising \(polled reply\)/);
    const agentId = startedAgent(host);
    assert.deepEqual(taskCalls(host), [["tasks.cancel", agentId]]);
    assert.equal(host.tasks.get(agentId).status, "idle");
});

test("without a stop hook or task reply, the event log is read by the owned task id", async (t) => {
    const host = await bootScreening(t);
    host.onStartAgent = (agentId) => {
        host.events.push({ type: "subagent.started", agentId, data: { toolCallId: agentId } });
        host.events.push({ type: "assistant.message", agentId: "someone-elses-agent", data: { content: rejectingVerdict("stranger reply") } });
        host.events.push({ type: "assistant.message", agentId, data: { content: rejectingVerdict("event reply") } });
        host.events.push({ type: "subagent.completed", agentId, data: {} });
        host.tasks.get(agentId).status = "completed";
    };
    await host.command("learn-now");
    assert.match(host.logs.at(-1), /failed: surprising \(event reply\)/);
});

const QUOTE = "the cache key ignored the lockfile hash";

const passingVerdict = (target, skill) => JSON.stringify({
    criteria: Object.fromEntries(["surprising", "expensive", "undiscoverable", "transferable", "uncovered"]
        .map((name) => [name, { pass: true, why: "fixture", ...(name === "expensive" ? { quote: QUOTE } : {}) }])),
    target, skill, rationale: "Cache keys must include the lockfile hash",
});

const draftReply = (over = {}) => JSON.stringify({
    description: "When a restored dependency cache looks stale",
    section: "Lockfile cache keys",
    body: "Key the cache on the lockfile hash.",
    ...over,
});

// Writes a SKILL.md under the host's home for a skill the runtime reports; `dirs` null means the
// runtime reports no path, as it does for bundled skills.
function installSkill(host, name, source, dirs) {
    const entry = { name, description: `${name} guidance`, source, enabled: true };
    if (dirs) {
        const folder = join(host.root, ...dirs, name);
        mkdirSync(folder, { recursive: true });
        entry.path = join(folder, "SKILL.md");
        writeFileSync(entry.path, `---\nname: ${name}\ndescription: ${name} guidance\n---\n\nExisting ${name} guidance.\n`);
    }
    host.skills.push(entry);
    return entry;
}

const REPO_SKILLS = ["repo", ".github", "skills"];
const AGENTS_SKILLS = [".agents", "skills"];

// Answers the screener and then each drafter in start order, returning the prompts each was given.
function scriptAgents(host, replies) {
    const prompts = [];
    host.onStartAgent = async (agentId, request) => {
        prompts.push(request.prompt);
        await host.stopSubagent(agentId, replies[prompts.length - 1]);
    };
    return prompts;
}

async function bootDrafting(t) {
    const host = await bootScreening(t);
    host.events.push({ type: "user.message", data: { content: `The build was stale because ${QUOTE}.` } });
    return host;
}

const savedProposal = (host) =>
    JSON.parse(readFileSync(join(host.root, "files", "self-learn-pending.json"), "utf8")).proposal;

const mainStop = (host) => host.options.hooks.onAgentStop(
    { sessionId: host.session.sessionId }, { sessionId: host.session.sessionId });

test("the screener is told which skills it cannot change", async (t) => {
    const host = await bootScreening(t);
    installSkill(host, "repo-guide", "project", REPO_SKILLS);
    installSkill(host, "plugin-guide", "plugin", ["plugin-cache", "skills"]);
    installSkill(host, "my-guide", "personal-agents", AGENTS_SKILLS);
    installSkill(host, "bundled-guide", "builtin", null);
    const prompts = scriptAgents(host, [rejectingVerdict("fixture")]);
    await host.command("learn-now");
    for (const name of ["repo-guide", "plugin-guide", "bundled-guide"]) {
        assert.match(prompts[0], new RegExp(`^- ${name} \\[READ-ONLY\\]: `, "m"));
    }
    assert.match(prompts[0], /^- my-guide: /m);
});

test("a new skill is written under the personal root even when a repository skill is listed first", async (t) => {
    const host = await boot(t);
    installSkill(host, "repo-guide", "project", REPO_SKILLS);
    installSkill(host, "copilot-guide", "personal-copilot", [".copilot", "skills"]);
    const propose = host.options.tools.find((tool) => tool.name === "propose_skill");
    const result = await propose.handler(
        { mode: "new", name: "fresh-lesson", description: "Fixture lesson", body: "Fixture body" }, {});
    assert.match(result, /Approved and written/);
    assert.ok(existsSync(join(host.root, ".copilot", "skills", "fresh-lesson", "SKILL.md")));
    assert.equal(existsSync(join(host.root, ...REPO_SKILLS, "fresh-lesson")), false);
});

test("with no personal skill installed, new skills go to ~/.agents/skills rather than a repository", async (t) => {
    const host = await boot(t);
    installSkill(host, "repo-guide", "project", REPO_SKILLS);
    const propose = host.options.tools.find((tool) => tool.name === "propose_skill");
    const result = await propose.handler(
        { mode: "new", name: "fresh-lesson", description: "Fixture lesson", body: "Fixture body" }, {});
    assert.match(result, /Approved and written/);
    assert.ok(existsSync(join(host.root, ...AGENTS_SKILLS, "fresh-lesson", "SKILL.md")));
    assert.equal(existsSync(join(host.root, ...REPO_SKILLS, "fresh-lesson")), false);
});

test("an extend aimed at a read-only skill is drafted as a new personal skill the drafter names", async (t) => {
    const host = await bootDrafting(t);
    const repo = installSkill(host, "repo-guide", "project", REPO_SKILLS);
    installSkill(host, "my-guide", "personal-agents", AGENTS_SKILLS);
    const repoBefore = readFileSync(repo.path, "utf8");
    const prompts = scriptAgents(host, [
        passingVerdict("extend", "repo-guide"),
        draftReply({ name: "repo-guide" }),
        draftReply({ name: "lockfile-cache-keys" }),
    ]);
    await host.command("learn-now");

    assert.equal(prompts.length, 3, host.logs.at(-1));
    assert.match(prompts[1], /"repo-guide".*cannot be changed here/s);
    assert.match(prompts[1], /NEW personal skill/);
    assert.match(prompts[1], /Existing repo-guide guidance\./);
    assert.match(prompts[1], /"name":/);
    assert.match(prompts[2], /previous reply was rejected: a skill named "repo-guide" already exists/);

    const proposal = savedProposal(host);
    assert.equal(proposal.mode, "new");
    assert.equal(proposal.name, "lockfile-cache-keys");
    assert.deepEqual(proposal.retargetedFrom, { skill: "repo-guide", target: "extend" });

    await mainStop(host);
    assert.match(host.confirmations.at(-1), /create new skill "lockfile-cache-keys"/);
    assert.match(host.confirmations.at(-1), /"repo-guide" is read-only/);
    assert.ok(existsSync(join(host.root, ...AGENTS_SKILLS, "lockfile-cache-keys", "SKILL.md")));
    assert.equal(readFileSync(repo.path, "utf8"), repoBefore);
});

test("a refine aimed at a bundled skill with no path is re-targeted as a correction", async (t) => {
    const host = await bootDrafting(t);
    installSkill(host, "bundled-guide", "builtin", null);
    const prompts = scriptAgents(host, [
        passingVerdict("refine", "bundled-guide"),
        draftReply({ name: "bundled-guide-correction" }),
    ]);
    await host.command("learn-now");

    assert.equal(prompts.length, 2, host.logs.at(-1));
    assert.match(prompts[1], /stating the correction/);
    const proposal = savedProposal(host);
    assert.equal(proposal.mode, "new");
    assert.equal(proposal.name, "bundled-guide-correction");
    assert.deepEqual(proposal.retargetedFrom, { skill: "bundled-guide", target: "refine" });
});

test("an extend of the user's own skill still extends it in place", async (t) => {
    const host = await bootDrafting(t);
    installSkill(host, "repo-guide", "project", REPO_SKILLS);
    installSkill(host, "my-guide", "personal-agents", AGENTS_SKILLS);
    const prompts = scriptAgents(host, [passingVerdict("extend", "my-guide"), draftReply({ name: "ignored" })]);
    await host.command("learn-now");

    assert.equal(prompts.length, 2, host.logs.at(-1));
    assert.match(prompts[1], /Add to the existing skill "my-guide"/);
    const proposal = savedProposal(host);
    assert.equal(proposal.mode, "extend");
    assert.equal(proposal.name, "my-guide");
    assert.equal(proposal.retargetedFrom, undefined);
});

test("an extend naming no installed skill is still refused rather than re-targeted", async (t) => {
    const host = await bootDrafting(t);
    installSkill(host, "my-guide", "personal-agents", AGENTS_SKILLS);
    const prompts = scriptAgents(host, [passingVerdict("extend", "ghost-skill")]);
    await host.command("learn-now");
    assert.equal(prompts.length, 1);
    assert.match(host.logs.at(-1), /could not draft it \("ghost-skill" could not be read/);
});

const PENDING_LESSON = {
    mode: "new", name: "test-lesson", description: "A fixture lesson description",
    body: "A fixture body with enough detail for the proposal validator.", why: "Fixture evidence",
};

// Each dialog stays open until the test answers it, as an unattended App dialog does.
function holdDialogs(host) {
    const answers = [];
    host.confirmationHandler = () => new Promise((resolve) => answers.push(resolve));
    return answers;
}

async function until(condition, what) {
    for (let i = 0; i < 500 && !condition(); i++) await delay(2);
    assert.ok(condition(), `timed out waiting for ${what}`);
}

const statusOf = (host) => host.options.canvases[0].actions[0].handler().status;
const lessonFile = (host, name) => join(host.root, ...AGENTS_SKILLS, name, "SKILL.md");
const declineLedger = (host) => join(host.root, ".copilot", "self-learn", "declined.json");

// Distinguishes a stop hook that returned from one still waiting on a dialog nobody answers.
const settles = (promise) => Promise.race([promise.then(() => "returned"), delay(2000).then(() => "still waiting")]);

test("a dialog abandoned with its tool call releases the approval and keeps the draft for the next stop", async (t) => {
    const host = await boot(t);
    const answers = holdDialogs(host);
    const propose = host.options.tools.find((tool) => tool.name === "propose_skill");
    const call = new AbortController();
    const result = propose.handler(
        { mode: "new", name: "fresh-lesson", description: "Fixture lesson", body: "Fixture body" },
        { signal: call.signal });
    await until(() => answers.length === 1, "the approval dialog");
    assert.equal(statusOf(host).phase, "Approval in progress");

    call.abort();
    assert.equal(await settles(result), "returned");
    assert.match(await result, /approval could not be completed now \(approval dialog abandoned.*\)\. The user will be asked again/);
    assert.equal(statusOf(host).phase, "Proposal pending");
    assert.equal(savedProposal(host).attempts ?? 0, 0);

    const stop = mainStop(host);
    await until(() => answers.length === 2, "the draft to be offered again at the next stop");
    answers[1](true);
    await stop;
    assert.equal(statusOf(host).written, 1);
    assert.ok(existsSync(lessonFile(host, "fresh-lesson")));

    answers[0](true);
    await delay(20);
    assert.equal(statusOf(host).written, 1, "a late answer to the abandoned dialog writes nothing twice");
});

test("a stop-hook dialog times out; a late No keeps the draft and a late Yes writes it", async (t) => {
    const host = await boot(t, { pendingProposal: PENDING_LESSON, config: { approvalTimeoutMs: 30 } });
    const answers = holdDialogs(host);

    assert.equal(await settles(mainStop(host)), "returned");
    assert.equal(answers.length, 1);
    assert.equal(statusOf(host).phase, "Proposal pending");
    assert.match(statusOf(host).lastError, /approval dialog timed out after 30ms/);
    assert.equal(savedProposal(host).attempts ?? 0, 0);

    answers[0](false);
    await delay(20);
    assert.equal(statusOf(host).pending?.name, "test-lesson", "a late No or dismissal discards nothing");
    assert.equal(existsSync(declineLedger(host)), false, "a late No is not recorded as a decline");

    assert.equal(await settles(mainStop(host)), "returned");
    assert.equal(answers.length, 2, "the next stop offers the draft again");
    answers[1](true);
    await until(() => statusOf(host).written === 1, "the late approval to be written");
    assert.ok(existsSync(lessonFile(host, "test-lesson")));
    assert.equal(statusOf(host).pending, null);
});

test("a late Yes for a superseded draft writes nothing and leaves the newer draft pending", async (t) => {
    const host = await boot(t, { pendingProposal: PENDING_LESSON, config: { approvalTimeoutMs: 30 } });
    const answers = holdDialogs(host);
    assert.equal(await settles(mainStop(host)), "returned");

    const propose = host.options.tools.find((tool) => tool.name === "propose_skill");
    const call = new AbortController();
    const result = propose.handler(
        { mode: "new", name: "newer-lesson", description: "Newer fixture lesson", body: "Newer body" },
        { signal: call.signal });
    await until(() => answers.length === 2, "the newer draft's dialog");
    call.abort();
    await result;

    answers[0](true);
    await delay(20);
    assert.equal(existsSync(lessonFile(host, "test-lesson")), false);
    assert.equal(statusOf(host).written, 0);
    assert.equal(statusOf(host).pending?.name, "newer-lesson");
});

test("a draft submitted while another's dialog is open survives that dialog's approval", async (t) => {
    const host = await boot(t);
    const answers = holdDialogs(host);
    const propose = host.options.tools.find((tool) => tool.name === "propose_skill");
    const first = propose.handler(
        { mode: "new", name: "first-lesson", description: "First fixture lesson", body: "First body" }, {});
    await until(() => answers.length === 1, "the first dialog");
    assert.match(await propose.handler(
        { mode: "new", name: "second-lesson", description: "Second fixture lesson", body: "Second body" }, {}),
    /The user will be asked again/);

    answers[0](true);
    assert.match(await first, /Approved and written/);
    assert.ok(existsSync(lessonFile(host, "first-lesson")));
    assert.equal(statusOf(host).pending?.name, "second-lesson");
    assert.equal(savedProposal(host).name, "second-lesson");
});

test("an approval timeout too long for a timer still waits instead of ending at once", async (t) => {
    // Node runs any delay above 2^31-1 ms after 1 ms, so ~35 days would otherwise mean no wait.
    const host = await boot(t, { pendingProposal: PENDING_LESSON, config: { approvalTimeoutMs: 3e9 } });
    const answers = holdDialogs(host);
    const stop = mainStop(host);
    await until(() => answers.length === 1, "the approval dialog");
    assert.equal(await Promise.race([stop.then(() => "returned"), delay(200).then(() => "still waiting")]),
        "still waiting");
    answers[0](true);
    await stop;
    assert.equal(statusOf(host).written, 1);
});

// The first stop's dialog times out and the second stop offers the same draft again. The timeout is
// long enough for that second dialog to still be open while the first is answered.
async function twoDialogsForOneDraft(t) {
    const host = await boot(t, { pendingProposal: PENDING_LESSON, config: { approvalTimeoutMs: 1000 } });
    const answers = holdDialogs(host);
    assert.equal(await settles(mainStop(host)), "returned");
    const second = mainStop(host);
    await until(() => answers.length === 2, "the second dialog");
    return { host, answers, second };
}

test("a late Yes writes while a newer dialog for the same draft is open, and a No there changes nothing", async (t) => {
    const { host, answers, second } = await twoDialogsForOneDraft(t);
    answers[0](true);
    await until(() => statusOf(host).written === 1, "the late approval to be written");
    assert.ok(existsSync(lessonFile(host, "test-lesson")));
    assert.equal(statusOf(host).pending, null);
    assert.equal(statusOf(host).phase, "Approval in progress", "the open dialog keeps its own latch");

    answers[1](false);
    assert.equal(await settles(second), "returned");
    assert.equal(statusOf(host).written, 1);
    assert.equal(existsSync(declineLedger(host)), false, "a No after the write is not recorded as a decline");
    assert.equal(statusOf(host).phase, "Idle");
});

for (const [when, answer] of [
    ["after the late write", async (answers, host) => {
        answers[0](true);
        await until(() => statusOf(host).written === 1, "the late approval to be written");
        answers[1](true);
    }],
    ["in the same tick, stale dialog first", async (answers) => { answers[0](true); answers[1](true); }],
    ["in the same tick, newer dialog first", async (answers) => { answers[1](true); answers[0](true); }],
]) {
    test(`a Yes on both dialogs for one draft writes it once (${when})`, async (t) => {
        const { host, answers, second } = await twoDialogsForOneDraft(t);
        await answer(answers, host);
        assert.equal(await settles(second), "returned");
        await delay(20);
        assert.equal(statusOf(host).written, 1);
        assert.equal(existsSync(`${lessonFile(host, "test-lesson")}.bak`), false, "nothing wrote over the first write");
        assert.equal(statusOf(host).pending, null);
        assert.equal(existsSync(declineLedger(host)), false);
    });
}

test("a Yes on two expired dialogs for one draft writes it once", async (t) => {
    const host = await boot(t, { pendingProposal: PENDING_LESSON, config: { approvalTimeoutMs: 30 } });
    const answers = holdDialogs(host);
    assert.equal(await settles(mainStop(host)), "returned");
    assert.equal(await settles(mainStop(host)), "returned");
    assert.equal(answers.length, 2);

    answers[0](true);
    answers[1](true);
    await until(() => statusOf(host).written === 1, "the late approval to be written");
    await delay(20);
    assert.equal(statusOf(host).written, 1);
    assert.equal(existsSync(`${lessonFile(host, "test-lesson")}.bak`), false, "nothing wrote over the first write");
    assert.equal(statusOf(host).phase, "Idle");
});

test("a late Yes landing before the newer dialog opens writes the draft and opens no dialog for it", async (t) => {
    const host = await boot(t, { pendingProposal: PENDING_LESSON, config: { approvalTimeoutMs: 1000 } });
    const answers = holdDialogs(host);
    assert.equal(await settles(mainStop(host)), "returned");

    // Holds the second stop's skill-path lookup, which comes before its dialog.
    const list = host.session.rpc.skills.list;
    let release = null;
    host.session.rpc.skills.list = () => release
        ? list()
        : new Promise((resolve) => { release = () => resolve(list()); });
    const second = mainStop(host);
    await until(() => release, "the second stop to look up the skill path");
    answers[0](true);
    await until(() => statusOf(host).written === 1, "the late approval to be written");

    release();
    assert.equal(await settles(second), "returned");
    assert.equal(answers.length, 1, "no dialog is opened for a draft already written");
    assert.equal(statusOf(host).written, 1);
});

test("a late Yes whose write fails leaves the newer dialog to decide", async (t) => {
    const { host, answers, second } = await twoDialogsForOneDraft(t);
    // A directory where SKILL.md belongs makes the write fail.
    const file = lessonFile(host, "test-lesson");
    mkdirSync(file, { recursive: true });
    answers[0](true);
    await until(() => /write failed/.test(statusOf(host).lastError ?? ""), "the late write to fail");
    assert.equal(statusOf(host).pending?.name, "test-lesson");

    rmSync(file, { recursive: true });
    answers[1](true);
    assert.equal(await settles(second), "returned");
    assert.equal(statusOf(host).written, 1);
    assert.ok(existsSync(file));
});

// A directory where a supporting file belongs makes the write fail after SKILL.md is written.
function blockSupportingFile(host, name) {
    const blocker = join(dirname(lessonFile(host, name)), "check.ps1");
    mkdirSync(blocker, { recursive: true });
    return () => rmSync(blocker, { recursive: true });
}

const WITH_FILE = { files: [{ path: "check.ps1", content: "Write-Output 'check'" }] };
const ORIGINAL_SKILL = "---\nname: test-lesson\ndescription: Hand-written\n---\n\nORIGINAL HAND-WRITTEN SKILL\n";

test("retrying a partly failed write keeps the original in SKILL.md.bak", async (t) => {
    const host = await boot(t, { pendingProposal: { ...PENDING_LESSON, ...WITH_FILE } });
    const file = lessonFile(host, "test-lesson");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, ORIGINAL_SKILL);
    const unblock = blockSupportingFile(host, "test-lesson");

    await mainStop(host);
    assert.match(statusOf(host).lastError ?? "", /write failed/);
    assert.equal(readFileSync(`${file}.bak`, "utf8"), ORIGINAL_SKILL);
    assert.equal(typeof savedProposal(host).writes?.["SKILL.md"], "string", "a reload would still recognise the first attempt");

    unblock();
    await mainStop(host);
    assert.equal(statusOf(host).written, 1);
    assert.equal(readFileSync(`${file}.bak`, "utf8"), ORIGINAL_SKILL, "the retry did not back up its own first attempt");
    assert.ok(existsSync(join(dirname(file), "check.ps1")));
});

test("retrying a partly failed write of a new skill leaves no backup of the first attempt", async (t) => {
    const host = await boot(t, { pendingProposal: { ...PENDING_LESSON, ...WITH_FILE } });
    const file = lessonFile(host, "test-lesson");
    const unblock = blockSupportingFile(host, "test-lesson");
    await mainStop(host);
    assert.match(statusOf(host).lastError ?? "", /write failed/);
    unblock();
    await mainStop(host);
    assert.equal(statusOf(host).written, 1);
    assert.equal(existsSync(`${file}.bak`), false);
});

test("retrying a partly failed extend appends the section once and keeps the original in the backup", async (t) => {
    const host = await boot(t, { pendingProposal: {
        mode: "extend", name: "my-guide", section: "Lockfile cache keys",
        description: "When a restored dependency cache looks stale",
        body: "Key the cache on the lockfile hash.", why: "Fixture evidence", ...WITH_FILE,
    } });
    const skill = installSkill(host, "my-guide", "personal-agents", AGENTS_SKILLS);
    const original = readFileSync(skill.path, "utf8");
    const unblock = blockSupportingFile(host, "my-guide");

    await mainStop(host);
    assert.match(statusOf(host).lastError ?? "", /write failed/);
    unblock();
    await mainStop(host);

    assert.equal(statusOf(host).written, 1, statusOf(host).lastError);
    const text = readFileSync(skill.path, "utf8");
    assert.equal(text.match(/^#+ Lockfile cache keys$/gm)?.length, 1);
    assert.match(text, /Existing my-guide guidance\./);
    assert.equal(readFileSync(`${skill.path}.bak`, "utf8"), original);
    assert.ok(existsSync(join(dirname(skill.path), "check.ps1")));
});

test("a skill edited by hand between write attempts is backed up again", async (t) => {
    const host = await boot(t, { pendingProposal: { ...PENDING_LESSON, ...WITH_FILE } });
    const file = lessonFile(host, "test-lesson");
    const unblock = blockSupportingFile(host, "test-lesson");
    await mainStop(host);
    assert.match(statusOf(host).lastError ?? "", /write failed/);

    writeFileSync(file, ORIGINAL_SKILL);
    unblock();
    await mainStop(host);
    assert.equal(statusOf(host).written, 1);
    assert.equal(readFileSync(`${file}.bak`, "utf8"), ORIGINAL_SKILL);
});

test("declined and unavailable control confirmations do not change settings", async (t) => {
    const host = await boot(t);
    host.confirmationResult = false;
    assert.equal((await host.tool("disable")).resultType, "rejected");
    assert.match(await host.tool("status"), /enabled: true/);
    host.confirmationError = new Error("dialog unavailable");
    const failed = await host.tool("disable");
    assert.equal(failed.resultType, "rejected");
    assert.match(failed.textResultForLlm, /Nothing changed/);
    assert.match(await host.tool("status"), /enabled: true/);
    host.confirmationError = null;
    host.confirmationResult = true;
    assert.match(await host.tool("disable"), /disabled/);
    assert.match(await host.tool("enable"), /enabled/);
    assert.match(await host.tool("status"), /enabled: true/);
});

test("only one setting confirmation is open, and no mutation precedes approval", async (t) => {
    const host = await boot(t);
    let finish;
    host.confirmationHandler = () => new Promise((resolve) => { finish = resolve; });
    const request = host.tool("disable");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(host.options.canvases[0].actions[0].handler().status.phase, "Control confirmation");
    assert.match(await host.tool("status"), /enabled: true/);
    assert.equal((await host.tool("enable")).resultType, "rejected");
    assert.equal(host.confirmations.length, 1);
    finish(true);
    assert.match(await request, /disabled/);
    assert.match(await host.tool("status"), /enabled: false/);
});

test("review remains deferred and visible; merely opening a panel never queues one", async (t) => {
    const host = await boot(t);
    const action = host.options.canvases[0].actions[0];
    assert.equal(action.handler().status.reviewQueued, false);
    assert.match(await host.tool("review"), /Review queued/);
    assert.equal(action.handler().status.reviewQueued, true);
    assert.equal(action.handler().status.phase, "Review queued");
    assert.equal(action.handler().status.screenedTurns, 0);
    assert.ok(action.handler().entries.some((entry) => entry.message === "review queued for end of turn"));
    assert.equal(await host.tool("discard"), "No pending proposal.");
});

test("child opening prompts with anonymous hook brackets do not reset main-agent activity", async (t) => {
    const host = await boot(t);
    const status = () => host.options.canvases[0].actions[0].handler().status;
    await host.submitPrompt("Investigate the real request");
    host.emit({ type: "tool.execution_start", data: { toolName: "view", toolCallId: "main-read" } });
    for (const agentId of ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bg-fixture", "toolu_fixture"]) {
        await host.submitPrompt("Only inspect this one file", { agentId, source: `agent-${host.session.sessionId}` });
        assert.equal(status().toolCallsThisTurn, 1);
    }
    await host.submitPrompt("Continue with the next user request");
    assert.equal(status().toolCallsThisTurn, 0);
});

test("only a main prompt releases a held proposal, not the screener's prompt", async (t) => {
    const pendingProposal = {
        mode: "new", name: "test-lesson", description: "A fixture lesson description",
        body: "A fixture body with enough detail for the proposal validator.", why: "Fixture evidence",
        deferred: true,
    };
    const host = await boot(t, { pendingProposal });
    const pending = () => host.options.canvases[0].actions[0].handler().status.pending;
    assert.equal(pending().deferred, true);
    const sameText = "Check the fixture";
    await host.submitPrompt(sameText, { agentId: "reviewer-fixture", source: `agent-${host.session.sessionId}` });
    assert.equal(pending().deferred, true);
    await host.submitPrompt(sameText);
    assert.equal(pending().deferred, false);
    const saved = JSON.parse(readFileSync(join(host.root, "files", "self-learn-pending.json"), "utf8"));
    assert.equal(saved.proposal.deferred, false);
    assert.equal(host.confirmations.length, 0);
});

test("main cross-session prompts remain context and malformed prompt events do not reset counters", async (t) => {
    const host = await boot(t);
    const status = () => host.options.canvases[0].actions[0].handler().status;
    host.emit({ type: "tool.execution_start", data: { toolName: "view" } });
    host.emit({ type: "user.message", data: {} });
    host.emit({ type: "user.message", data: { content: null } });
    assert.equal(status().toolCallsThisTurn, 1);
    await host.submitPrompt("Operator follow-up", { source: "agent-other-session" });
    assert.equal(status().toolCallsThisTurn, 0);
});

test("a child prompt cannot replenish the main agent's rejected-proposal budget", async (t) => {
    const host = await boot(t);
    const propose = host.options.tools.find((tool) => tool.name === "propose_skill");
    const invalid = { mode: "new", name: "../escape", description: "Fixture", body: "Fixture body" };
    await host.submitPrompt("Actual task");
    for (let i = 0; i < 2; i++) {
        const result = await propose.handler(invalid, {});
        assert.equal(result.resultType, "failure");
        assert.doesNotMatch(result.textResultForLlm, /No attempts left/);
    }
    await host.submitPrompt("Child task", { agentId: "child-fixture" });
    assert.match((await propose.handler(invalid, {})).textResultForLlm, /No attempts left/);
    await host.submitPrompt("Next main-agent turn");
    assert.doesNotMatch((await propose.handler(invalid, {})).textResultForLlm, /No attempts left/);
});

test("own canvas queries do not count as work worth auto-screening", async (t) => {
    const host = await boot(t);
    const canvas = host.options.canvases[0];
    host.openInstances = ["counting"];
    await canvas.open({ instanceId: "counting" });
    for (const toolName of ["open_canvas", "list_canvas_capabilities", "invoke_canvas_action"]) {
        host.emit({ type: "tool.execution_start", data: {
            toolName, arguments: { canvasId: canvas.id, instanceId: "counting" },
        } });
    }
    assert.equal(canvas.actions[0].handler().status.toolCallsThisTurn, 0);
    host.emit({ type: "tool.execution_start", data: { toolName: "view", arguments: {} } });
    assert.equal(canvas.actions[0].handler().status.toolCallsThisTurn, 1);
});

test("canvas settings share the session helper but never open an agent dialog or queue a review", async (t) => {
    const host = await boot(t);
    const canvas = host.options.canvases[0];
    host.openInstances = ["settings"];
    const { url } = await canvas.open({ instanceId: "settings" });
    const post = (enabled, expectedEnabled) => fetch(url + "settings", {
        method: "POST", headers: { Origin: new URL(url).origin, "Content-Type": "application/json" },
        body: JSON.stringify({
            expected: { enabled: expectedEnabled, model: canvas.actions[0].handler().status.model },
            desired: { enabled, model: canvas.actions[0].handler().status.model },
        }),
    });
    const result = await post(false, true);
    assert.equal(result.status, 200);
    assert.match(await host.tool("status"), /enabled: false/);
    assert.equal(host.confirmations.length, 0);
    assert.equal(canvas.actions[0].handler().status.reviewQueued, false);
    assert.equal(canvas.actions[0].handler().status.screenedTurns, 0);
    assert.ok(canvas.actions[0].handler().entries.some((entry) => entry.message.endsWith("(canvas)")));
    assert.equal((await post(true, true)).status, 409);
    assert.match(await host.tool("status"), /enabled: false/);
    await host.tool("enable");
    assert.equal(host.confirmations.length, 1);
    assert.match(await host.tool("status"), /enabled: true/);
    let finish;
    host.confirmationHandler = () => new Promise((resolve) => { finish = resolve; });
    const pending = host.tool("disable");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await post(false, true)).status, 409);
    assert.equal(canvas.actions[0].handler().status.enabled, true);
    finish(false);
    assert.equal((await pending).resultType, "rejected");
});

test("canvas model changes are session-local and validated atomically with enabled", async (t) => {
    const host = await boot(t);
    const canvas = host.options.canvases[0];
    const before = canvas.actions[0].handler().status;
    const configFile = join(host.root, "config.json");
    const config = readFileSync(configFile, "utf8");
    host.openInstances = ["model"];
    const { url } = await canvas.open({ instanceId: "model" });
    const post = (model) => fetch(url + "settings", {
        method: "POST", headers: { Origin: new URL(url).origin, "Content-Type": "application/json" },
        body: JSON.stringify({
            expected: { enabled: before.enabled, model: before.model },
            desired: { enabled: false, model },
        }),
    });
    assert.equal((await post("bad model")).status, 400);
    assert.equal(canvas.actions[0].handler().status.enabled, true);
    assert.equal(canvas.actions[0].handler().status.model, before.model);
    assert.equal((await post("fixture-model")).status, 200);
    assert.equal(canvas.actions[0].handler().status.enabled, false);
    assert.equal(canvas.actions[0].handler().status.model, "fixture-model");
    assert.equal(readFileSync(configFile, "utf8"), config);
    assert.equal(host.confirmations.length, 0);
    assert.equal(canvas.actions[0].handler().status.reviewQueued, false);
});
