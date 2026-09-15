import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { boot } from "./test-support/host.mjs";

test("the shipped extension registers its read-only activity canvas and shared status", async (t) => {
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
