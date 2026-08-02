// self-learn — reflects at every yield and proposes durable lessons as skills.
//
// Phase 2: screening only. A cheap sub-agent decides whether the turn produced something worth
// learning; verdicts are logged and nothing is written. Escalation and approval come next.
//
// Companion to the `advisor` extension. See README.md.

import { joinSession } from "@github/copilot-sdk/extension";
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULTS = {
    enabled: true,
    screenerModel: "gpt-5.6-terra",
    agentType: "rubber-duck",
    minToolCalls: 5,
    maxTranscriptChars: 24000,
    maxToolResultChars: 1200,
    timeoutMs: 180000,
    pollIntervalMs: 2000,
    logToTimeline: true,
    debugLog: join(homedir(), ".copilot", "logs", "self-learn.log"),
    instructions: "",
};

// Absorbs the lag between a sub-agent reporting idle and its reply appearing in the event log.
const SETTLED_EMPTY_POLL_LIMIT = 8;
const SCREENER_DESCRIPTION = "Self-learn screening";

function loadConfig(workingDirectory) {
    const candidates = [
        process.env.COPILOT_SELF_LEARN_CONFIG,
        workingDirectory ? join(workingDirectory, ".github", "self-learn.json") : undefined,
        join(homedir(), ".copilot", "self-learn.json"),
    ].filter(Boolean);

    for (const path of candidates) {
        try {
            if (!existsSync(path)) continue;
            return { ...DEFAULTS, ...JSON.parse(readFileSync(path, "utf8")), _configPath: path };
        } catch {
            // A malformed config must not take the extension down.
        }
    }
    return { ...DEFAULTS, _configPath: null };
}

let config = loadConfig(process.cwd());

const state = {
    goal: "",
    toolCallsThisTurn: 0,
    lastEventIndex: 0,
    screeningInFlight: false,
    reflecting: false,
    screenedTurns: 0,
    hits: 0,
    lastVerdict: null,
    lastError: null,
    sessionOverrides: {},
};

const cfg = (key) => state.sessionOverrides[key] ?? config[key];

function debug(message) {
    const path = cfg("debugLog");
    if (!path) return;
    try {
        appendFileSync(path, `${new Date().toISOString()} ${message}\n`);
    } catch {
        // Logging must never break the reflection loop.
    }
}

function truncate(text, limit) {
    const str = typeof text === "string" ? text : JSON.stringify(text ?? "");
    return str.length <= limit ? str : `${str.slice(0, limit)}\n…[truncated ${str.length - limit} chars]`;
}

function renderEvent(event) {
    const d = event?.data ?? {};
    switch (event?.type) {
        case "user.message":
            return d.content ? `USER: ${truncate(d.content, 2000)}` : null;
        case "assistant.message":
            return d.content ? `AGENT: ${truncate(d.content, 2000)}` : null;
        case "tool.execution_start":
            return `TOOL_CALL ${d.toolName}: ${truncate(d.arguments, 600)}`;
        case "tool.execution_complete": {
            const status = d.success === false ? "FAILED" : "ok";
            const body = d.success === false ? d.error : d.result;
            return `TOOL_RESULT ${d.toolName} [${status}]: ${truncate(body, cfg("maxToolResultChars"))}`;
        }
        default:
            return null;
    }
}

async function buildTranscriptDelta(session) {
    let events = [];
    try {
        events = await session.getEvents();
    } catch (err) {
        state.lastError = `getEvents failed: ${err?.message ?? err}`;
        return null;
    }

    // Only main-agent activity; sub-agent chatter is noise for this purpose.
    const delta = events.slice(state.lastEventIndex).filter((e) => !e?.agentId);
    state.lastEventIndex = events.length;

    const lines = delta.map(renderEvent).filter(Boolean);
    if (lines.length === 0) return null;

    let text = lines.join("\n\n");
    const limit = cfg("maxTranscriptChars");
    if (text.length > limit) text = `…[earlier activity omitted]\n\n${text.slice(-limit)}`;
    return text;
}

async function listSkills(session) {
    try {
        const { skills } = await session.rpc.skills.list();
        return skills.map((s) => ({ name: s.name, description: s.description }));
    } catch (err) {
        debug(`skills.list failed: ${err?.message ?? err}`);
        return [];
    }
}

function buildScreenerPrompt(transcript, skills) {
    const inventory =
        skills.length > 0
            ? skills.map((s) => `- ${s.name}: ${truncate(s.description ?? "", 200)}`).join("\n")
            : "(no skills installed)";

    return `You are a LEARNING SCREENER. Another AI coding agent just finished a turn for a user. \
Your only job is to decide whether that turn produced a DURABLE, REUSABLE lesson worth writing \
down as a skill. You do not write the skill yourself.

<user_goal>
${state.goal || "(not captured — infer it from the transcript)"}
</user_goal>

<what_happened>
${transcript}
</what_happened>

<existing_skills>
${inventory}
</existing_skills>

A lesson is worth capturing ONLY if it would change how the agent behaves in a FUTURE, DIFFERENT \
session. Good candidates:
- a non-obvious API/tool behaviour discovered the hard way (e.g. a field that is always null, an \
  event that must be used instead of another)
- a corrected false assumption that cost real effort
- a repeatable procedure for this environment that was worked out through trial and error
- a measurement or debugging technique that avoided a wrong conclusion

NOT worth capturing:
- anything specific to this one task, file, or bug
- restatements of what the agent already does correctly
- general programming advice, style, or things any competent agent knows
- facts already covered by an existing skill above, unless the turn materially CORRECTS or \
  EXTENDS that skill

Strongly prefer refining an existing skill over creating a new one. The user curates their skill \
set tightly; near-duplicates are harmful. Most turns produce nothing. "false" is the correct \
answer the large majority of the time.

Respond with EXACTLY ONE JSON object and nothing else:
{"worthLearning": true|false, "target": "new"|"refine", "skill": "...", "rationale": "..."}

- "target": "refine" to amend an existing skill, "new" to create one.
- "skill": for "refine", the exact existing skill name. For "new", a short kebab-case name.
- "rationale": under 400 chars, stating the concrete lesson and the evidence for it.
- When worthLearning is false, set target to "new", skill to "", rationale to "".\
${cfg("instructions") ? `\n\nAdditional instructions:\n${cfg("instructions")}` : ""}`;
}

function parseVerdict(raw) {
    if (!raw || typeof raw !== "string") return null;
    const matches = raw.match(/\{[\s\S]*?\}/g);
    if (!matches) return null;

    for (const candidate of matches.reverse()) {
        try {
            const parsed = JSON.parse(candidate);
            if (typeof parsed?.worthLearning !== "boolean") continue;
            return {
                worthLearning: parsed.worthLearning,
                target: parsed.target === "refine" ? "refine" : "new",
                skill: sanitize(parsed.skill, 80),
                rationale: sanitize(parsed.rationale, 600),
            };
        } catch {
            // Keep looking for a well-formed object.
        }
    }
    return null;
}

// Screener output eventually reaches the main agent's context, so treat it as untrusted.
function sanitize(text, limit) {
    if (typeof text !== "string") return "";
    let clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").trim();
    clean = clean.replace(/<\/?(system|instructions?|advisor|self-learn)>/gi, "");
    if (/ignore (all )?(your |the )?(previous|prior|above) instructions/i.test(clean)) return "";
    return clean.slice(0, limit);
}

// Mirrors the advisor's recovery path: `tasks.list()` never populates `result` for a sub-agent
// that parks in "idle", and the reported toolCallId is a stub for RPC-started agents, so the
// reply is correlated through `subagent.started` after a pre-recorded event baseline.
async function runScreener(session, prompt) {
    const rpc = session.rpc;
    if (!rpc?.tasks?.startAgent) throw new Error("session.rpc.tasks.startAgent unavailable");

    let baseline = 0;
    try {
        baseline = (await session.getEvents()).length;
    } catch {
        baseline = 0;
    }

    const { agentId } = await rpc.tasks.startAgent({
        agentType: cfg("agentType"),
        prompt,
        name: "self-learn",
        description: SCREENER_DESCRIPTION,
        model: cfg("screenerModel"),
    });
    debug(`screener ${agentId} started on ${cfg("screenerModel")} (baseline ${baseline})`);

    const deadline = Date.now() + cfg("timeoutMs");
    let seen = false;
    let emptySettledPolls = 0;

    try {
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, cfg("pollIntervalMs")));

            let tasks = [];
            try {
                ({ tasks } = await rpc.tasks.list());
            } catch (err) {
                throw new Error(`tasks.list failed: ${err?.message ?? err}`);
            }

            const task = tasks.find((t) => t.id === agentId);
            if (!task) {
                if (seen) return "";
                continue;
            }
            seen = true;

            if (task.status === "failed") throw new Error(task.error || "screener failed");
            if (task.status === "cancelled") return "";

            // Exact correlation: these are keyed by the task id we own, so unlike event-log
            // matching they cannot pick up another extension's or the main agent's sub-agent.
            if (task.result) {
                debug(`reply via task.result`);
                return task.result;
            }
            if (task.latestResponse) {
                debug(`reply via task.latestResponse`);
                return task.latestResponse;
            }

            const { status, reply } = await readReplyFromEventLog(session, baseline);
            if (status === "failed") throw new Error(reply);
            if (status === "done") {
                debug(`reply via event log (fallback)`);
                return reply;
            }

            if (task.status === "completed" || task.status === "idle") {
                if (++emptySettledPolls >= SETTLED_EMPTY_POLL_LIMIT) {
                    debug(`screener ${agentId} settled with no reply`);
                    return "";
                }
            } else {
                emptySettledPolls = 0;
            }
        }
        throw new Error(`screener timed out after ${cfg("timeoutMs")}ms`);
    } finally {
        await disposeTask(rpc, agentId);
    }
}

async function readReplyFromEventLog(session, baseline) {
    let events = [];
    try {
        events = await session.getEvents();
    } catch {
        return { status: "pending", reply: "" };
    }

    const recent = events.slice(baseline);
    const candidates = recent.filter((e) => e?.type === "subagent.started" && e?.agentId);

    // Never fall back to "first sub-agent seen": the advisor extension and the main agent both
    // spawn sub-agents concurrently, and claiming a stranger's reply would silently cross-wire
    // them. Require a positive identity match, or keep waiting.
    const started =
        candidates.find((e) => e?.data?.agentDescription === SCREENER_DESCRIPTION) ??
        candidates.find((e) => e?.data?.model && e.data.model === cfg("screenerModel"));
    if (!started) return { status: "pending", reply: "" };

    const mine = (e) => e?.agentId === started.agentId;

    const failed = recent.find((e) => e?.type === "subagent.failed" && mine(e));
    if (failed) return { status: "failed", reply: failed?.data?.error ?? "screener failed" };

    if (!recent.some((e) => e?.type === "subagent.completed" && mine(e))) {
        return { status: "pending", reply: "" };
    }

    const replies = recent
        .filter((e) => e?.type === "assistant.message" && mine(e))
        .map((e) => e?.data?.content)
        .filter((c) => typeof c === "string" && c.trim());

    return { status: "done", reply: replies[replies.length - 1] ?? "" };
}

async function disposeTask(rpc, agentId) {
    try {
        await rpc.tasks.cancel({ id: agentId });
    } catch {
        // Already settled.
    }
    try {
        await rpc.tasks.remove({ id: agentId });
    } catch {
        // Not removable.
    }
}

async function screen(session, { force = false } = {}) {
    if (state.screeningInFlight) return { skipped: "already screening" };

    const toolCalls = state.toolCallsThisTurn;
    state.toolCallsThisTurn = 0;

    if (!force) {
        if (!cfg("enabled")) return { skipped: "disabled" };
        if (toolCalls < cfg("minToolCalls")) {
            debug(`skip: ${toolCalls} tool calls < ${cfg("minToolCalls")}`);
            return { skipped: "too few tool calls" };
        }
    }

    state.screeningInFlight = true;
    try {
        const transcript = await buildTranscriptDelta(session);
        if (!transcript) return { skipped: "no new activity" };

        const skills = await listSkills(session);
        state.screenedTurns++;
        debug(`screening turn (${toolCalls} tool calls, ${skills.length} known skills)`);

        const raw = await runScreener(session, buildScreenerPrompt(transcript, skills));
        const verdict = parseVerdict(raw);

        if (!verdict) {
            debug(`unparseable screener reply: ${truncate(raw, 300)}`);
            return { skipped: "unparseable" };
        }

        state.lastVerdict = verdict;
        if (!verdict.worthLearning) {
            debug("verdict: nothing worth learning");
            return verdict;
        }

        state.hits++;
        debug(`verdict: LEARN ${verdict.target} "${verdict.skill}" — ${verdict.rationale}`);
        if (cfg("logToTimeline")) {
            await session.log(
                `self-learn: would ${verdict.target} skill "${verdict.skill}" — ${verdict.rationale}`,
            );
        }
        return verdict;
    } catch (err) {
        state.lastError = err?.message ?? String(err);
        debug(`ERROR: ${state.lastError}`);
        return { error: state.lastError };
    } finally {
        state.screeningInFlight = false;
    }
}

const session = await joinSession({
    hooks: {
        onUserPromptSubmitted: async (input) => {
            state.goal = input.prompt ?? "";
            state.toolCallsThisTurn = 0;
        },
        onPostToolUse: async (input) => countToolCall(input?.toolName),
        onPostToolUseFailure: async (input) => countToolCall(input?.toolName),
    },

    commands: [
        {
            name: "learn",
            description: "Show self-learn status",
            handler: async () => {
                const v = state.lastVerdict;
                await session.log(
                    [
                        "self-learn status",
                        `enabled:        ${cfg("enabled")}`,
                        `screener:       ${cfg("screenerModel")} (${cfg("agentType")})`,
                        `min tools:      ${cfg("minToolCalls")} per turn`,
                        `config:         ${config._configPath ?? "built-in defaults"}`,
                        `turns screened: ${state.screenedTurns}`,
                        `hits:           ${state.hits}`,
                        `last verdict:   ${v ? (v.worthLearning ? `${v.target} ${v.skill}` : "nothing") : "none"}`,
                        `last error:     ${state.lastError ?? "none"}`,
                    ].join("\n"),
                );
            },
        },
        {
            name: "learn-now",
            description: "Force a self-learn screening of recent activity",
            handler: async () => {
                await session.log("self-learn: screening…", { ephemeral: true });
                await screen(session, { force: true });
            },
        },
        {
            name: "learn-off",
            description: "Disable self-learn for this session",
            handler: async () => {
                state.sessionOverrides.enabled = false;
                await session.log("self-learn: disabled");
            },
        },
        {
            name: "learn-on",
            description: "Enable self-learn for this session",
            handler: async () => {
                state.sessionOverrides.enabled = true;
                await session.log("self-learn: enabled");
            },
        },
    ],
});

function countToolCall(toolName) {
    if (typeof toolName === "string" && toolName.startsWith("learn")) return;
    state.toolCallsThisTurn++;
}

// `session.idle` fires exactly once per yield to the user, and unlike `assistant.idle` it also
// guarantees background work has settled — so the transcript is complete rather than mid-flight.
session.on("session.idle", (event) => {
    debug(`session.idle fired (aborted=${event?.data?.aborted === true}, toolCalls=${state.toolCallsThisTurn})`);
    if (event?.data?.aborted) {
        debug("skip: turn was aborted");
        state.toolCallsThisTurn = 0;
        return;
    }
    if (state.reflecting) return;
    void screen(session).catch((err) => debug(`screen threw: ${err?.message ?? err}`));
});

await session.log(
    `self-learn ready — screening with ${cfg("screenerModel")} after >=${cfg("minToolCalls")} tool calls`,
    { ephemeral: true },
);
