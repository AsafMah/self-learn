import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

// Opt-in, standalone SDK sessions only. Never connect this probe to an app session.
// Dependencies belong in --scratch, not this repository:
// npm install --prefix <scratch> --ignore-scripts --no-audit --no-fund
// (after creating a private manifest pinning @github/copilot-sdk 1.0.17-preview.4
// and @github/copilot 1.0.92-4). --self-test uses no SDK, authentication, or model.
// --verify-report <report.json> rechecks saved runtime evidence without model calls.
// "installed" defaults to the pinned historical CLI fixture below, not runtime
// auto-discovery. Use --installed-cli explicitly when testing an upgraded app.
const INSTALLED_CLI_FIXTURE_VERSION = "1.0.90-0";
const { values: args } = parseArgs({
    options: {
        "self-test": { type: "boolean" },
        "verify-report": { type: "string" },
        live: { type: "boolean" },
        scratch: { type: "string" },
        profile: { type: "string", default: "both" },
        model: { type: "string", default: "gpt-5.6-terra" },
        "installed-sdk": { type: "string" },
        "installed-cli": { type: "string" },
    },
});

function exactSchema(expected) {
    return {
        toJSONSchema: () => ({
            type: "object",
            properties: Object.fromEntries(Object.entries(expected).map(([key, value]) =>
                [key, { type: "string", enum: [value] }])),
            required: Object.keys(expected),
            additionalProperties: false,
        }),
        parse(value) {
            assert.deepEqual(value, expected, "Structured result must have exactly the expected fields and values");
            return value;
        },
    };
}

async function bounded(label, work, milliseconds = 25000) {
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(work),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label}: timeout after ${milliseconds}ms`)), milliseconds);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function cleanupAttempt(cleanup, operation, target, work, milliseconds, redact = String) {
    const attempt = { operation, target, status: "pending" };
    (cleanup.attempts ??= []).push(attempt);
    try {
        const result = await bounded(operation, work, milliseconds);
        // CopilotClient.stop resolves Error[]; resolution alone is not success.
        if (Array.isArray(result) && result.length) {
            attempt.status = "failed";
            attempt.errors = result.map((error) => redact(error?.message ?? error));
        } else {
            attempt.status = "pass";
        }
    } catch (error) {
        attempt.status = "failed";
        attempt.errors = [redact(error?.message ?? error)];
    }
    return attempt.status === "pass";
}

async function stopProbeClient(client, cleanup, target, redact) {
    if (!await cleanupAttempt(cleanup, "client.stop", target, () => client.stop(), 5000, redact)) {
        await cleanupAttempt(cleanup, "client.forceStop", target, () => client.forceStop(), 2000, redact);
    }
}

function verifyCleanup(entry) {
    assert.equal(entry.cleanup?.runtimeExited, true, `${entry.name}: owned runtime exit must be confirmed`);
}

function assertCorrelation(events, prompt, result, schema) {
    const request = events.find((event) =>
        event.type === "user.message" && !event.agentId && event.data.content === prompt);
    assert.ok(request?.data.messageId, "Runtime must expose the request message ID");
    const response = events.findLast((event) =>
        event.type === "assistant.message" && !event.agentId &&
        event.data.originatingMessageId === request.data.messageId && !event.data.toolRequests?.length);
    assert.ok(response, "Result must come from a main-agent response correlated to this request");
    assert.deepEqual(schema.parse(JSON.parse(response.data.content)), result);
    return { messageId: request.data.messageId, originatingMessageId: response.data.originatingMessageId };
}

function verifyHooks(entry) {
    const { starts, stops, mainStops: agentStops, parentResponse } = entry.hookObservations;
    const childName = "capability-probe-child";
    assert.equal(starts.length, 1, "One intended child must start");
    assert.equal(stops.length, 1, "One intended child must stop");
    const parentId = starts[0].invocation.sessionId;
    const childId = stops[0].input.agentId;
    const rawResponse = stops[0].input.response.trim();
    assert.ok(childId && childId !== parentId, "Stop must expose a distinct child identity");
    for (const hook of [...starts, ...stops]) {
        assert.equal(hook.input.agentName, childName);
        assert.equal(hook.input.sessionId, parentId);
        assert.equal(hook.invocation.sessionId, parentId);
    }
    assert.equal(stops[0].input.agentType, childName);
    assert.equal(stops[0].input.stopReason, "end_turn");
    const childEvent = entry.events.find((event) => event.type === "subagent.started" && event.agentId === childId);
    assert.ok(childEvent, "Lifecycle identity must match the actual child event");
    const childPrompt = entry.events.find((event) => event.type === "user.message" && event.agentId === childId);
    assert.ok(childPrompt?.data.transformedContent.includes(`Return exactly ${rawResponse}`),
        "Start-hook context must actually reach this child's prompt");
    assert.ok(entry.events.some((event) => event.type === "assistant.message" && event.agentId === childId &&
        event.data.content.trim() === rawResponse), "Stop hook must contain the actual child response");
    const taskResult = entry.events.find((event) => event.type === "tool.execution_complete" &&
        event.data.toolCallId === childEvent.data.toolCallId);
    assert.equal(taskResult?.data.success, true);
    const rewritten = taskResult.data.result.content.trim();
    assert.notEqual(rewritten, rawResponse, "Parent must receive the rewritten, not raw, child response");
    assert.equal(parentResponse.trim(), `PARENT:${rewritten}`, "Rewrite must target the child, not main");
    if (entry.hookFixture) {
        assert.equal(rawResponse, entry.hookFixture.startMarker);
        assert.equal(rewritten, entry.hookFixture.rewritten);
    }
    // Runtime 1.0.92-4 also calls onAgentStop for children. Invocation identity
    // alone is insufficient; do not weaken production input.sessionId guards.
    const rootStops = agentStops.filter(({ input }) => input.sessionId === parentId);
    const childStops = agentStops.filter(({ input }) => input.sessionId === childId);
    assert.equal(rootStops.length, 1);
    assert.equal(rootStops.length + childStops.length, agentStops.length);
    assert.ok(agentStops.every(({ invocation }) => invocation.sessionId === parentId));
    return { status: "pass", childId, actualResponse: rawResponse, parentResponse, parentSessionId: parentId,
        unfilteredAgentStopCalls: agentStops.length, filteredMainStops: rootStops.length,
        childAgentStopCalls: childStops.length, caveat: "Keep input.sessionId main/child guards; invocation.sessionId identifies the parent." };
}

function verifyTools(entry) {
    const check = entry.checks.setTools;
    const names = (metadata) => metadata.tools.map(({ name }) => name).sort();
    assert.deepEqual(names(entry.toolsBefore), ["probe_neighbor", "probe_obsolete", "probe_read"]);
    assert.deepEqual(names(entry.toolsAfter), ["probe_neighbor", "probe_read"]);
    assert.equal(check.toolCalls.length, 2);
    for (const [name, field] of [["probe_read", "own"], ["probe_neighbor", "neighbor"]]) {
        const value = entry.checks.structured.result[field];
        assert.equal(check.toolCalls.filter((call) => call.name === name && call.value === value).length, 1);
        assert.ok(entry.toolsAfter.tools.find((tool) => tool.name === name).description.includes(value));
    }
    assert.ok(check.toolCalls.every((call) => call.sessionId === entry.sessionId));
    assert.equal(check.sameRuntimePid, entry.runtimePid);
    assert.equal(check.sameSessionId, entry.sessionId);
    return check;
}

async function selfTest() {
    const schema = exactSchema({ marker: "fixture" });
    schema.parse(JSON.parse('{"marker":"fixture"}'));
    for (const invalid of [null, [], {}, { marker: 3 }, { marker: "wrong" }, { marker: "fixture", extra: true }]) {
        assert.throws(() => schema.parse(invalid));
    }
    assert.throws(() => JSON.parse('```json\n{"marker":"fixture"}\n```'));
    const events = [
        { type: "user.message", data: { messageId: "request", content: "fixture prompt" } },
        { type: "assistant.message", data: { originatingMessageId: "unrelated", content: '{"marker":"wrong"}' } },
        { type: "assistant.message", agentId: "child", data: { originatingMessageId: "request", content: '{"marker":"wrong"}' } },
        { type: "assistant.message", data: { originatingMessageId: "request", content: '{"marker":"fixture"}' } },
    ];
    assertCorrelation(events, "fixture prompt", { marker: "fixture" }, schema);
    assert.throws(() => assertCorrelation(events.slice(0, -1), "fixture prompt", { marker: "fixture" }, schema));
    await assert.rejects(bounded("fixture", () => new Promise(() => {}), 5), /timeout/);
    const cleanup = {};
    await stopProbeClient({
        stop: async () => [new Error("resolved stop failure")],
        forceStop: async () => { throw new Error("force-stop failure"); },
    }, cleanup, "fixture-client");
    assert.deepEqual(cleanup.attempts.map(({ operation, status, errors }) => ({ operation, status, errors })), [
        { operation: "client.stop", status: "failed", errors: ["resolved stop failure"] },
        { operation: "client.forceStop", status: "failed", errors: ["force-stop failure"] },
    ]);
    assert.equal(await cleanupAttempt(cleanup, "session.abort", "fixture-session",
        () => new Promise(() => {}), 5), false);
    assert.match(cleanup.attempts.at(-1).errors[0], /timeout/);
    assert.equal(await cleanupAttempt(cleanup, "client.stop", "successful-client", async () => [], 5), true);
    verifyCleanup({ name: "fixture", cleanup: { runtimeExited: true } });
    for (const runtimeExited of [false, undefined]) {
        assert.throws(() => verifyCleanup({ name: "fixture", cleanup: { runtimeExited } }), /exit must be confirmed/);
    }
    return { status: "pass", invalidFixtures: 7, correlationPositiveAndNegative: true, timeout: true,
        cleanupFailureRecordingAndFallback: true, cleanupExitRequired: true };
}

if (args["self-test"]) {
    console.log(JSON.stringify(await selfTest(), null, 2));
} else if (args["verify-report"]) {
    const path = resolve(args["verify-report"]);
    const bytes = await readFile(path);
    const report = JSON.parse(bytes);
    const verification = {
        evidence: path, evidenceSha256: createHash("sha256").update(bytes).digest("hex"),
        command: [process.execPath, ...process.argv.slice(1)], verifiedAt: new Date().toISOString(),
        note: "Revalidates recorded live events; does not rerun models or overwrite the original report.",
        profiles: report.profiles.map((entry) => {
            verifyCleanup(entry);
            const structured = entry.checks.structured;
            assert.equal(structured.status, "pass");
            const request = entry.events.find((event) =>
                event.type === "user.message" && event.data.messageId === structured.messageId);
            assertCorrelation(entry.events, request.data.content, structured.result, exactSchema(structured.result));
            const hooks = entry.hookObservations ? verifyHooks(entry) : entry.checks.subagentHooks;
            if (entry.hookObservations) {
                const invalid = structuredClone(entry);
                invalid.hookObservations.stops[0].input.agentId = invalid.hookObservations.starts[0].invocation.sessionId;
                assert.throws(() => verifyHooks(invalid), /distinct child identity/);
                const wrongResponse = structuredClone(entry);
                wrongResponse.hookObservations.stops[0].input.response = "not-the-child-response";
                assert.throws(() => verifyHooks(wrongResponse), /actually reach/);
                const wrongTarget = structuredClone(entry);
                wrongTarget.hookObservations.parentResponse = "main-was-replaced";
                assert.throws(() => verifyHooks(wrongTarget), /child, not main/);
            }
            if (entry.toolsAfter) {
                const lostNeighbor = structuredClone(entry);
                lostNeighbor.toolsAfter.tools = lostNeighbor.toolsAfter.tools.filter(({ name }) => name !== "probe_neighbor");
                assert.throws(() => verifyTools(lostNeighbor));
            }
            return { name: entry.name, sdkVersion: entry.sdkVersion, runtimeStatus: entry.runtimeStatus,
                structured, setTools: entry.toolsAfter ? verifyTools(entry) : entry.checks.setTools,
                subagentHooks: hooks, cleanup: entry.cleanup };
        }),
    };
    await writeFile(`${path}.verified.json`, `${JSON.stringify(verification, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(verification, null, 2));
} else if (!args.live || !args.scratch || !["both", "installed", "preview"].includes(args.profile)) {
    throw new Error("Use --self-test, or --live --scratch <isolated dependencies/evidence directory> [--profile installed|preview|both]");
} else {
    await run();
}

async function run() {
    assert.equal(process.platform, "win32", "This probe's PID-tree fallback is Windows-specific");
    const scratch = resolve(args.scratch);
    const runDirectory = join(scratch, `run-${Date.now()}-${randomUUID().slice(0, 8)}`);
    await mkdir(runDirectory, { recursive: true });
    const report = {
        startedAt: new Date().toISOString(),
        command: [process.execPath, ...process.argv.slice(1)],
        model: args.model,
        limits: { startupAttempts: 2, startupMs: 25000, modelCaseMs: 90000 },
        fixtures: await selfTest(),
        profiles: [],
        exclusions: ["No app session, production RPC replacement, UI/banner delivery, real extensions, or approval-rubric changes"],
    };
    const reportPath = join(runDirectory, "report.json");
    // Capture the token without printing it, persisting it, or placing it on a command line.
    let token = "";
    const redact = (text) => token ? String(text).split(token).join("[redacted]") : String(text);
    const save = () => writeFile(reportPath, `${redact(JSON.stringify(report, null, 2))}\n`, "utf8");
    try {
        token = execFileSync("gh", ["auth", "token"], {
            encoding: "utf8", timeout: 10000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        }).trim();
        assert.ok(token, "gh auth token returned no credential");
        const installedRoot = resolve(args["installed-sdk"] ??
            join(process.env.LOCALAPPDATA, "Programs", "GitHub Copilot", "copilot-sdk"));
        const profiles = [
            {
                name: "installed",
                sdk: join(installedRoot, "index.js"),
                cli: resolve(args["installed-cli"] ??
                    join(process.env.LOCALAPPDATA, "github-copilot-sdk", "cli", INSTALLED_CLI_FIXTURE_VERSION, "copilot.exe")),
                runtimeSelection: args["installed-cli"] ? "explicit --installed-cli override" :
                    `pinned baseline fixture ${INSTALLED_CLI_FIXTURE_VERSION}; not automatic current-runtime discovery`,
                transport: "stdio",
            },
            {
                name: "preview",
                sdk: join(scratch, "node_modules", "@github", "copilot-sdk", "dist", "index.js"),
                cli: join(scratch, "node_modules", "@github", "copilot-win32-x64", "copilot.exe"),
                transport: "tcp",
            },
        ].filter((profile) => args.profile === "both" || profile.name === args.profile);
        for (const profile of profiles) {
            const entry = { ...profile, checks: {}, cleanup: {}, events: [] };
            report.profiles.push(entry);
            await save();
            await probeProfile(profile, entry, { runDirectory, token, redact, save });
        }
    } catch (error) {
        report.error = redact(error.message);
        process.exitCode = 1;
    } finally {
        report.finishedAt = new Date().toISOString();
        await save();
        console.log(JSON.stringify({
            report: reportPath,
            profiles: report.profiles.map(({ name, checks, cleanup, error }) => ({ name, checks, cleanup, error })),
            error: report.error,
        }, null, 2));
    }
}

async function probeProfile(profile, entry, { runDirectory, token, redact, save }) {
    const clients = [];
    const sessions = [];
    let runtimeProcess;
    const phase = async (name, action) => {
        entry.phase = name;
        await save();
        return bounded(name, action);
    };
    try {
        const sdk = await import(pathToFileURL(profile.sdk).href);
        entry.sdkSha256 = createHash("sha256").update(await readFile(profile.sdk)).digest("hex");
        if (profile.name === "preview") {
            const manifest = JSON.parse(await readFile(join(resolve(args.scratch),
                "node_modules", "@github", "copilot-sdk", "package.json"), "utf8"));
            assert.equal(manifest.version, "1.0.17-preview.4");
            assert.equal(manifest.copilotCliVersion, "1.0.92-4");
            entry.sdkVersion = manifest.version;
        } else {
            entry.sdkVersion = "app-bundled; no package version supplied (identified by SHA-256)";
        }
        entry.cliVersion = execFileSync(profile.cli, ["--version"], {
            encoding: "utf8", timeout: 15000, windowsHide: true,
        }).trim();
        const supportsSetTools = typeof sdk.CopilotSession.prototype.setTools === "function";
        const supportsHooks = sdk.CopilotSession.prototype._handleHooksInvoke.toString().includes("onSubagentStart");
        entry.surface = { setTools: supportsSetTools, subagentHooks: supportsHooks };
        if (!supportsSetTools) entry.checks.setTools = { status: "not_available", evidence: "No setTools method in loaded SDK" };
        if (!supportsHooks) entry.checks.subagentHooks = { status: "not_available", evidence: "Loaded SDK hook dispatcher has no subagent lifecycle mapping" };
        const home = join(runDirectory, profile.name, "home");
        const cwd = join(runDirectory, profile.name, "empty-cwd");
        const temp = join(home, "scratch");
        await Promise.all([mkdir(temp, { recursive: true }), mkdir(cwd, { recursive: true })]);
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
            /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|APPDATA|LOCALAPPDATA|HTTP_PROXY|HTTPS_PROXY|NO_PROXY)$/i.test(key)));
        Object.assign(env, {
            HOME: home, USERPROFILE: home, COPILOT_HOME: home, TMP: temp, TEMP: temp, TMPDIR: temp,
            COPILOT_DISABLE_KEYTAR: "1", COPILOT_TASK_WAIT_TIMEOUT_SECONDS: "80",
        });
        const connectionToken = randomUUID();
        const client = new sdk.CopilotClient({
            connection: profile.transport === "tcp"
                ? sdk.RuntimeConnection.forTcp({ path: profile.cli, connectionToken })
                : sdk.RuntimeConnection.forStdio({ path: profile.cli }),
            mode: "empty", baseDirectory: home, workingDirectory: cwd,
            env, gitHubToken: token, useLoggedInUser: false, logLevel: "error",
        });
        clients.push(client);
        try {
            await phase("client.start", () => client.start());
        } finally {
            // These private fields are used only to clean up our owned child and
            // connect the second test client, never as capability success evidence.
            runtimeProcess = client.cliProcess;
            entry.runtimePid = runtimeProcess?.pid;
        }
        entry.runtimeStatus = await phase("runtime status", () => client.getStatus());
        entry.isolation = { home, cwd, mode: "empty", requestExtensions: false, enableConfigDiscovery: false };
        const events = entry.events;
        const observe = (session) => {
            sessions.push(session);
            session.on((event) => {
                if (["user.message", "assistant.message", "session.error", "subagent.started", "subagent.completed",
                    "tool.execution_start", "tool.execution_complete"].includes(event.type)) {
                    const fields = ["messageId", "originatingMessageId", "content", "transformedContent",
                        "toolRequests", "toolCallId", "toolName", "arguments", "result", "success", "message",
                        "agentName", "agentDisplayName", "agentType", "executionMode", "model"];
                    events.push({ sessionId: session.sessionId, type: event.type, agentId: event.agentId,
                        id: event.id, timestamp: event.timestamp,
                        data: Object.fromEntries(fields.filter((field) => event.data[field] !== undefined)
                            .map((field) => [field, event.data[field]])) });
                }
            });
            return session;
        };
        const config = (availableTools = []) => ({
            clientName: "bounded-sdk-capability-probe", model: args.model, workingDirectory: cwd,
            availableTools, requestExtensions: false, enableConfigDiscovery: false,
            skipCustomInstructions: true, enableSkills: false, enableFileHooks: false,
            enableOnDemandInstructionDiscovery: false, enableHostGitOperations: false,
            customAgentsLocalOnly: true, mcpServers: {}, infiniteSessions: { enabled: false },
            onPermissionRequest: () => ({ kind: "denied-by-permission-request-hook" }),
            systemMessage: { mode: "replace", content: "You are an isolated capability test. Follow the fixture prompt precisely. Do not use any tool except the explicitly requested test tools. No files, shell, network, skills, or external information." },
        });
        const session = observe(await phase("create isolated session", () => client.createSession(config())));
        entry.sessionId = session.sessionId;
        const expected = { marker: `structured-${randomUUID()}` };
        let prompt = `Return the JSON object with marker exactly "${expected.marker}". No other fields.`;
        const toolCalls = [];
        if (supportsSetTools && profile.transport === "tcp") {
            const markerTool = (name, value) => ({
                name, description: `Read-only test marker (${value}). No external effects.`,
                parameters: { type: "object", properties: {}, additionalProperties: false },
                skipPermission: true, defer: "never",
                handler: (_input, invocation) => {
                    toolCalls.push({ name, value, sessionId: invocation.sessionId, toolCallId: invocation.toolCallId });
                    return value;
                },
            });
            // Use a separate SDK connection, not two session wrappers on one client.
            const other = new sdk.CopilotClient({
                connection: sdk.RuntimeConnection.forUri(`127.0.0.1:${client.runtimePort}`, { connectionToken }),
                mode: "empty",
            });
            clients.push(other);
            await phase("second client start", () => other.start());
            await phase("register first owner tools", () => session.setTools([
                markerTool("probe_read", "old-marker"), markerTool("probe_obsolete", "obsolete-marker"),
            ]));
            const neighborMarker = `neighbor-${randomUUID()}`;
            const secondSession = await phase("second client resume isolated session", () => other.resumeSession(
                session.sessionId, { ...config(["probe_read", "probe_obsolete", "probe_neighbor"]),
                    tools: [markerTool("probe_neighbor", neighborMarker)] }));
            sessions.push(secondSession);
            await phase("initialize tools", () => session.rpc.tools.initializeAndValidate());
            entry.toolsBefore = await phase("tools before replacement", () => session.rpc.tools.getCurrentMetadata());
            expected.own = `updated-${randomUUID()}`;
            expected.neighbor = neighborMarker;
            await phase("replace first owner tools", () => session.setTools([markerTool("probe_read", expected.own)]));
            await phase("initialize replaced tools", () => session.rpc.tools.initializeAndValidate());
            entry.toolsAfter = await phase("tools after replacement", () => session.rpc.tools.getCurrentMetadata());
            prompt = `Call probe_read and probe_neighbor once each. Return JSON with marker "${expected.marker}", own equal to the probe_read result, and neighbor equal to the probe_neighbor result. Do not invent tool results.`;
        }
        const schema = exactSchema(expected);
        entry.phase = "structured model case";
        await save();
        const result = await bounded(entry.phase, () => session.sendAndWait({ prompt }, schema, 80000), 90000);
        entry.checks.structured = { status: "pass", result, ...assertCorrelation(events, prompt, result, schema) };
        if (supportsSetTools) {
            assert.equal(toolCalls.filter((call) => call.name === "probe_read" && call.value === expected.own).length, 1);
            assert.equal(toolCalls.filter((call) => call.name === "probe_neighbor" && call.value === expected.neighbor).length, 1);
            assert.ok(toolCalls.every((call) => call.sessionId === session.sessionId));
            assert.ok(toolCalls.every((call) => call.value !== "old-marker" && call.value !== "obsolete-marker"));
            assert.equal(client.cliProcess?.pid, entry.runtimePid, "Runtime must not restart");
            entry.checks.setTools = { status: "pass", sameRuntimePid: entry.runtimePid, sameSessionId: session.sessionId, toolCalls };
            verifyTools(entry);
        }
        if (supportsHooks) {
            const childName = "capability-probe-child";
            const startMarker = `start-${randomUUID()}`;
            const rewritten = `rewritten-${randomUUID()}`;
            const starts = [];
            const stops = [];
            const mainStops = [];
            entry.hookObservations = { starts, stops, mainStops };
            entry.hookFixture = { startMarker, rewritten };
            let delegationCalls = 0;
            const hookSession = observe(await phase("create hook session", () => client.createSession({
                ...config(["task"]),
                systemMessage: { mode: "append", content: "This is an isolated deterministic test. Delegate exactly once to capability-probe-child synchronously, never in the background. No file, shell, network, or other tool use." },
                customAgents: [{
                    name: childName, displayName: childName, description: "Isolated marker-only child.",
                    tools: [], model: args.model,
                    prompt: "Return only the marker specified by the lifecycle hook's additional context. Do not use tools.",
                }],
                hooks: {
                    onPreToolUse(input) {
                        if (input.toolName === "task" && delegationCalls++ === 0 &&
                            input.toolArgs?.agent_type === childName && input.toolArgs?.mode === "sync") {
                            return { permissionDecision: "allow" };
                        }
                        return { permissionDecision: "deny", permissionDecisionReason: "Only one fixture child is permitted" };
                    },
                    onSubagentStart(input, invocation) {
                        starts.push({ input, invocation });
                        if (input.agentName === childName) return { additionalContext: `Return exactly ${startMarker}` };
                    },
                    onSubagentStop(input, invocation) {
                        stops.push({ input, invocation });
                        if (input.agentName === childName && input.response.trim() === startMarker) {
                            return { decision: "allow", modifiedResponse: rewritten };
                        }
                    },
                    onAgentStop(input, invocation) { mainStops.push({ input, invocation }); },
                },
            })));
            entry.phase = "subagent hook model case";
            await save();
            const response = await bounded(entry.phase, () => hookSession.sendAndWait({
                prompt: `Use the task tool once, synchronously, with agent_type "${childName}" and name "${childName}". Ask it to return its lifecycle marker. After it completes, reply with exactly PARENT: followed by the child's returned response. Do not invoke another agent.`,
            }, 80000), 90000);
            entry.hookObservations.parentResponse = response?.data?.content;
            entry.checks.subagentHooks = verifyHooks(entry);
        }
    } catch (error) {
        entry.error = redact(error.message);
        entry.blockedAt = entry.phase;
        for (const check of ["structured", "setTools", "subagentHooks"]) {
            entry.checks[check] ??= { status: "blocked", evidence: entry.error };
        }
        process.exitCode = 1;
    } finally {
        for (let index = sessions.length - 1; index >= 0; index--) {
            const session = sessions[index];
            await cleanupAttempt(entry.cleanup, "session.abort", `${session.sessionId} (handle ${index + 1})`,
                () => session.abort(), 3000, redact);
        }
        for (let index = clients.length - 1; index >= 0; index--) {
            await stopProbeClient(clients[index], entry.cleanup, `client ${index + 1}`, redact);
        }
        if (runtimeProcess?.pid && runtimeProcess.exitCode === null && runtimeProcess.signalCode === null) {
            entry.cleanup.pidTreeFallback = true;
            await cleanupAttempt(entry.cleanup, "PID-tree fallback", String(runtimeProcess.pid), () => {
                execFileSync("taskkill.exe", ["/PID", String(runtimeProcess.pid), "/T", "/F"], {
                    timeout: 5000, windowsHide: true, stdio: "ignore",
                });
            }, 6000, redact);
        }
        if (runtimeProcess && runtimeProcess.exitCode === null && runtimeProcess.signalCode === null) {
            await cleanupAttempt(entry.cleanup, "owned runtime exit", String(runtimeProcess.pid),
                () => new Promise((done) => runtimeProcess.once("exit", done)), 2000, redact);
        }
        entry.cleanup.runtimeExited = !runtimeProcess || runtimeProcess.exitCode !== null || runtimeProcess.signalCode !== null;
        if (!entry.cleanup.runtimeExited) process.exitCode = 1;
        entry.actualModels = [...new Set(entry.events.filter((event) => event.type === "assistant.message")
            .map((event) => event.data.model).filter(Boolean))];
        await save();
    }
}
