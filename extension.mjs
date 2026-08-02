// self-learn — reflects at every yield and proposes durable lessons as skills.
//
// Phase 2: screening only. A cheap sub-agent decides whether the turn produced something worth
// learning; verdicts are logged and nothing is written. Escalation and approval come next.
//
// Companion to the `advisor` extension. See README.md.

import { joinSession } from "@github/copilot-sdk/extension";
import {
    readFileSync,
    existsSync,
    appendFileSync,
    writeFileSync,
    mkdirSync,
    copyFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve, sep } from "node:path";

const DEFAULTS = {
    enabled: true,
    write: true,
    screenerModel: "gpt-5.6-terra",
    agentType: "rubber-duck",
    minToolCalls: 5,
    // null = derive from the runtime's own skill paths rather than hardcoding a location.
    skillsRoot: null,
    maxSkillBytes: 65536,
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
    forcedReflection: false,
    screenedTurns: 0,
    hits: 0,
    written: 0,
    lastVerdict: null,
    lastError: null,
    pendingProposal: null,
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

async function buildTranscriptDelta(session, { lookback = 0 } = {}) {
    let events = [];
    try {
        events = await session.getEvents();
    } catch (err) {
        state.lastError = `getEvents failed: ${err?.message ?? err}`;
        debug(`transcript: ${state.lastError}`);
        return null;
    }

    // A forced screening looks back over a window instead of only since the last screening,
    // which would otherwise be empty or trivially thin when invoked on demand.
    const from = lookback > 0 ? Math.max(0, events.length - lookback) : state.lastEventIndex;

    // Only main-agent activity; sub-agent chatter is noise for this purpose.
    const delta = events.slice(from).filter((e) => !e?.agentId);
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

async function screen(session, { force = false, lookback = 0 } = {}) {
    // Every early return logs: an unlogged exit is indistinguishable from the trigger never
    // firing, which has already caused one wrong diagnosis.
    if (state.screeningInFlight) {
        debug("skip: a screening is already in flight");
        return { skipped: "already screening" };
    }

    const toolCalls = state.toolCallsThisTurn;
    state.toolCallsThisTurn = 0;

    if (!force) {
        if (!cfg("enabled")) {
            debug("skip: disabled");
            return { skipped: "disabled" };
        }
        if (toolCalls < cfg("minToolCalls")) {
            debug(`skip: ${toolCalls} tool calls < ${cfg("minToolCalls")}`);
            return { skipped: "too few tool calls" };
        }
    }

    state.screeningInFlight = true;
    try {
        const transcript = await buildTranscriptDelta(session, { lookback });
        if (!transcript) {
            debug(`skip: no new main-agent activity (lastEventIndex=${state.lastEventIndex})`);
            return { skipped: "no new activity" };
        }

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

// ---------------------------------------------------------------------------
// Stage 2/3: escalation, approval, and writing
// ---------------------------------------------------------------------------

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Derive the skills directory from the runtime's own reported paths rather than hardcoding it,
// falling back to the documented personal location.
async function resolveSkillsRoot(session) {
    const configured = cfg("skillsRoot");
    if (configured) return resolve(configured);

    try {
        const { skills } = await session.rpc.skills.list();
        const sample = skills.find((s) => s.path && s.source !== "plugin");
        if (sample) return resolve(dirname(dirname(sample.path)));
    } catch {
        // Fall through to the default.
    }
    return join(homedir(), ".agents", "skills");
}

function validateProposal(p) {
    if (!p || typeof p !== "object") return "proposal missing";
    if (!SKILL_NAME_RE.test(p.name ?? "")) {
        return `invalid skill name "${p.name}" (expected kebab-case, <=64 chars)`;
    }
    if (!p.description || typeof p.description !== "string") return "description required";
    if (!p.body || typeof p.body !== "string") return "body required";
    if (Buffer.byteLength(p.body, "utf8") > cfg("maxSkillBytes")) {
        return `body exceeds maxSkillBytes (${cfg("maxSkillBytes")})`;
    }
    if (p.mode !== "new" && p.mode !== "refine") return `invalid mode "${p.mode}"`;
    return null;
}

function renderSkillFile(p) {
    // Frontmatter values are single-line; strip anything that could break out of them.
    const oneLine = (s) => s.replace(/\r?\n/g, " ").replace(/"/g, "'").trim();
    return `---\nname: ${oneLine(p.name)}\ndescription: ${oneLine(p.description)}\n---\n\n${p.body.trim()}\n`;
}

// Resolves a skill's file path, enforcing that it stays inside the skills root.
async function resolveSkillFile(session, name) {
    const root = await resolveSkillsRoot(session);
    const dir = resolve(join(root, name));

    // Containment check: a crafted name must never escape the skills directory and reach, for
    // example, the user's hand-written copilot-instructions.md.
    const rootWithSep = root.endsWith(sep) ? root : root + sep;
    if (!dir.startsWith(rootWithSep)) {
        throw new Error(`refusing to write outside skills root: ${dir}`);
    }
    return { dir, file: join(dir, "SKILL.md") };
}

async function writeSkill(session, p) {
    const { dir, file } = await resolveSkillFile(session, p.name);
    const existed = existsSync(file);

    // Keyed on existence, not on the declared mode: a proposal claiming mode "new" whose name
    // collides with an existing skill would otherwise destroy a hand-written file with no backup.
    if (existed) {
        copyFileSync(file, `${file}.bak`);
        debug(`backed up ${file} -> ${file}.bak`);
    }

    mkdirSync(dir, { recursive: true });
    writeFileSync(file, renderSkillFile(p), "utf8");
    debug(`wrote ${file} (mode=${p.mode}, existed=${existed})`);

    try {
        await session.rpc.skills.reload();
    } catch (err) {
        debug(`skills.reload failed: ${err?.message ?? err}`);
    }
    return file;
}

function buildReflectionNudge(verdict) {
    const target =
        verdict.target === "refine"
            ? `Refine the existing skill "${verdict.skill}". Read its current SKILL.md first and \
produce the COMPLETE updated body, preserving what is still correct.`
            : `Create a new skill named "${verdict.skill}".`;

    return `[self-learn] A reviewer model watching this session judged that the work just \
completed contains a durable, reusable lesson.

Its rationale: ${verdict.rationale}

${target}

Write the lesson so it will be useful in a FUTURE, UNRELATED session: state the trap and the \
reliable technique, not the specifics of this task. Be concise and concrete.

When the draft is ready, call the \`propose_skill\` tool with it. Do NOT write any file yourself — \
the extension handles writing after the user approves. Then stop; a one-line summary is enough. \
If on reflection there is no genuinely durable lesson here, call \`propose_skill\` with \
\`decline: true\` and a brief reason instead.`;
}

function escalate(session, verdict, { forced = false } = {}) {
    if (state.pendingProposal) {
        debug("escalation skipped: a proposal is already pending");
        return;
    }
    state.reflecting = true;
    // An explicitly forced reflection confirms at the end of that same turn: the user just asked
    // for it, so the dialog cannot be colliding with a reply they were composing.
    state.forcedReflection = forced;
    debug(`escalating to main agent: ${verdict.target} "${verdict.skill}" (forced=${forced})`);

    // Deferred: sending from inside an event handler risks re-entering the agent loop.
    setTimeout(() => {
        session.send({ prompt: buildReflectionNudge(verdict) }).catch((err) => {
            state.reflecting = false;
            state.lastError = `escalation failed: ${err?.message ?? err}`;
            debug(state.lastError);
        });
    }, 0);
}

// Approval is deliberately deferred by one user turn: `session.idle` fires exactly as the user
// regains the keyboard, so confirming there would collide with the reply they were about to type.
async function resolvePendingProposal(session) {
    const p = state.pendingProposal;
    if (!p || p.deferred) return false;

    state.pendingProposal = null;

    // Label from what is actually on disk, not from the declared mode, so a "new" proposal that
    // collides with an existing skill is presented as the overwrite it really is.
    let exists = false;
    try {
        exists = existsSync((await resolveSkillFile(session, p.name)).file);
    } catch (err) {
        state.lastError = `path check failed: ${err?.message ?? err}`;
        debug(state.lastError);
        await session.log(`self-learn: rejected proposal — ${state.lastError}`, { level: "error" });
        return true;
    }

    const where = exists ? `OVERWRITE the existing skill "${p.name}"` : `create new skill "${p.name}"`;
    const disabledNote = p.targetDisabled
        ? `\n\nNote: "${p.name}" is currently DISABLED in your settings, so this change will not \
take effect until you re-enable it.`
        : "";
    const backupNote = exists ? "\nThe previous version is kept as SKILL.md.bak." : "";

    const message = `self-learn wants to ${where}.\n\n${p.description}\n\n${truncate(p.body, 800)}\
${backupNote}${disabledNote}\n\nWrite it?`;

    let approved = false;
    try {
        approved = await session.ui.confirm(message);
    } catch (err) {
        state.lastError = `confirm failed: ${err?.message ?? err}`;
        debug(state.lastError);
        return false;
    }

    if (!approved) {
        debug(`proposal "${p.name}" declined by user`);
        await session.log(`self-learn: discarded proposal for "${p.name}"`);
        return true;
    }

    try {
        const file = await writeSkill(session, p);
        state.written++;
        await session.log(`self-learn: wrote ${file}`);
    } catch (err) {
        state.lastError = `write failed: ${err?.message ?? err}`;
        debug(state.lastError);
        await session.log(`self-learn: write failed — ${state.lastError}`, { level: "error" });
    }
    return true;
}

const session = await joinSession({
    tools: [
        {
            name: "propose_skill",
            description:
                "Submit a drafted skill for the self-learn extension to write after user " +
                "approval. Only call this when self-learn has explicitly asked you to reflect. " +
                "Do not write skill files yourself.",
            parameters: {
                type: "object",
                properties: {
                    decline: {
                        type: "boolean",
                        description: "True if on reflection there is no durable lesson worth saving.",
                    },
                    reason: { type: "string", description: "Why you declined, when decline is true." },
                    mode: { type: "string", enum: ["new", "refine"], description: "Create or update." },
                    name: { type: "string", description: "Kebab-case skill name." },
                    description: {
                        type: "string",
                        description: "One-line frontmatter description: when this skill applies.",
                    },
                    body: {
                        type: "string",
                        description:
                            "Complete markdown body, without frontmatter. For mode=refine this " +
                            "must be the full updated content, not a fragment.",
                    },
                },
                required: [],
            },
            skipPermission: true,
            handler: async (args) => {
                if (!state.reflecting) {
                    return {
                        textResultForLlm:
                            "propose_skill is only valid during a self-learn reflection. Ignoring.",
                        resultType: "rejected",
                    };
                }
                state.reflecting = false;

                if (args?.decline) {
                    debug(`agent declined to propose: ${args?.reason ?? "(no reason)"}`);
                    return "Noted — nothing recorded.";
                }

                const proposal = {
                    mode: args?.mode === "refine" ? "refine" : "new",
                    name: (args?.name ?? "").trim(),
                    description: (args?.description ?? "").trim(),
                    body: args?.body ?? "",
                };

                const problem = validateProposal(proposal);
                if (problem) {
                    debug(`rejected proposal: ${problem}`);
                    return { textResultForLlm: `Proposal rejected: ${problem}`, resultType: "failure" };
                }

                // Refining a disabled skill would silently have no effect; surface it at approval.
                try {
                    const { skills } = await session.rpc.skills.list();
                    const existing = skills.find((s) => s.name === proposal.name);
                    proposal.targetDisabled = existing ? existing.enabled === false : false;
                } catch {
                    proposal.targetDisabled = false;
                }

                // Held until after the user's next turn so the dialog never lands on the moment
                // they regain the keyboard — unless the user forced this reflection themselves.
                proposal.deferred = !state.forcedReflection;
                state.forcedReflection = false;
                state.pendingProposal = proposal;
                debug(`proposal captured: ${proposal.mode} "${proposal.name}" (deferred=${proposal.deferred})`);

                return `Recorded. The user will be asked to approve "${proposal.name}" after your next turn.`;
            },
        },
    ],

    hooks: {
        onUserPromptSubmitted: async (input) => {
            state.goal = input.prompt ?? "";
            state.toolCallsThisTurn = 0;
            // A held proposal becomes eligible once the user has taken their next turn.
            if (state.pendingProposal?.deferred) {
                state.pendingProposal.deferred = false;
                debug(`proposal "${state.pendingProposal.name}" is now eligible for approval`);
            }
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
                        `skills written: ${state.written}`,
                        `pending:        ${state.pendingProposal ? `${state.pendingProposal.mode} "${state.pendingProposal.name}"${state.pendingProposal.deferred ? " (held)" : " (awaiting approval)"}` : "none"}`,
                        `write enabled:  ${cfg("write")}`,
                        `last verdict:   ${v ? (v.worthLearning ? `${v.target} ${v.skill}` : "nothing") : "none"}`,
                        `last error:     ${state.lastError ?? "none"}`,
                    ].join("\n"),
                );
            },
        },
        {
            name: "learn-now",
            description: "Screen recent activity now, and escalate if there is something to learn",
            handler: async () => {
                await session.log("self-learn: screening recent activity…", { ephemeral: true });
                const verdict = await screen(session, { force: true, lookback: 600 });

                if (verdict?.error) {
                    await session.log(`self-learn: ${verdict.error}`, { level: "error" });
                    return;
                }
                if (!verdict?.worthLearning) {
                    await session.log(
                        `self-learn: nothing worth learning${verdict?.skipped ? ` (${verdict.skipped})` : ""}`,
                    );
                    return;
                }
                if (!cfg("write")) {
                    await session.log("self-learn: write is disabled; not escalating");
                    return;
                }
                // Forced screening escalates too; otherwise a forced run could never lead to a
                // write, since escalation normally happens only in the idle handler.
                await session.log(
                    `self-learn: drafting ${verdict.target} "${verdict.skill}" — you will be asked to approve it`,
                );
                escalate(session, verdict, { forced: true });
            },
        },
        {
            name: "learn-events",
            description: "Dump which session event types are actually delivered to extensions",
            handler: async () => {
                dumpDeliveredTypes();
                const rows = [...deliveredTypes.entries()].sort((a, b) => b[1] - a[1]);
                await session.log(
                    `delivered event types (${rows.length}):\n` +
                        rows.map(([k, n]) => `  ${k} = ${n}`).join("\n"),
                );
            },
        },
        {
            name: "learn-discard",
            description: "Discard the pending self-learn proposal without writing it",
            handler: async () => {
                if (!state.pendingProposal) {
                    await session.log("self-learn: no pending proposal");
                    return;
                }
                const name = state.pendingProposal.name;
                state.pendingProposal = null;
                await session.log(`self-learn: discarded pending proposal "${name}"`);
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

// `assistant.usage` reports the effort actually used for each model call. Sub-agent usage is
// tagged with an agentId, which makes it possible to verify empirically whether
// `subagents.agents[<type>].effortLevel` reaches an agent started over RPC — the open question
// behind "the advisor's reasoning effort cannot be pinned".
// Diagnostic: tally every event type actually delivered to an extension subscriber. Verifies the
// instrument before any conclusion is drawn from a specific event's absence.
const deliveredTypes = new Map();
session.on((event) => {
    const key = `${event?.type}${event?.agentId ? "@sub" : ""}`;
    deliveredTypes.set(key, (deliveredTypes.get(key) ?? 0) + 1);
    if (event?.type === "assistant.usage") {
        const d = event?.data ?? {};
        debug(
            `USAGE [${event?.agentId ?? "MAIN"}] model=${d.model ?? "?"} ` +
                `effort=${d.reasoningEffort ?? "ABSENT"} reasoningTokens=${d.reasoningTokens ?? "?"}`,
        );
    }
});

function dumpDeliveredTypes() {
    const rows = [...deliveredTypes.entries()].sort((a, b) => b[1] - a[1]);
    debug(`DELIVERED EVENT TYPES (${rows.length}): ${rows.map(([k, n]) => `${k}=${n}`).join(", ")}`);
}

// `session.idle` fires exactly once per yield to the user, and unlike `assistant.idle` it also
// guarantees background work has settled — so the transcript is complete rather than mid-flight.
session.on("session.idle", (event) => {
    debug(
        `session.idle fired (aborted=${event?.data?.aborted === true}, toolCalls=${state.toolCallsThisTurn}, ` +
            `reflecting=${state.reflecting}, pending=${state.pendingProposal?.name ?? "none"})`,
    );
    if (event?.data?.aborted) {
        debug("skip: turn was aborted");
        state.toolCallsThisTurn = 0;
        return;
    }

    void (async () => {
        // The escalated reflection turn has now ended, whether or not the agent actually called
        // propose_skill. Clearing here prevents a silent agent from wedging the flag true and
        // suppressing all further screening for the rest of the session.
        if (state.reflecting) {
            state.reflecting = false;
            state.forcedReflection = false;
            state.toolCallsThisTurn = 0;
            debug(
                state.pendingProposal
                    ? "reflection turn ended; proposal captured"
                    : "reflection turn ended without a proposal — clearing flag",
            );
            return;
        }

        // Approval next: a held proposal is resolved before any new screening starts, so at most
        // one proposal is ever in flight.
        if (await resolvePendingProposal(session)) {
            state.toolCallsThisTurn = 0;
            return;
        }

        if (state.pendingProposal) {
            debug("skip: a proposal is still pending approval");
            state.toolCallsThisTurn = 0;
            return;
        }

        const verdict = await screen(session);
        if (verdict?.worthLearning && cfg("write")) escalate(session, verdict);
    })().catch((err) => debug(`idle handler threw: ${err?.message ?? err}`));
});

await session.log(
    `self-learn ready — screening with ${cfg("screenerModel")} after >=${cfg("minToolCalls")} tool calls`,
    { ephemeral: true },
);
