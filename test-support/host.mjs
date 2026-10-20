import { registerHooks } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "@github/copilot-sdk/extension") {
            return { url: new URL("./sdk.mjs", import.meta.url).href, shortCircuit: true };
        }
        return nextResolve(specifier, context);
    },
});

export async function boot(t, { pendingProposal, config = {} } = {}) {
    const root = mkdtempSync(join(tmpdir(), "self-learn-host-"));
    const oldConfig = process.env.COPILOT_SELF_LEARN_CONFIG;
    // The decline ledger and instruction files resolve under the home directory at import time.
    const oldHome = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
    process.env.USERPROFILE = root;
    process.env.HOME = root;
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ autoScreen: false, debugLog: join(root, "debug.log"), ...config }));
    process.env.COPILOT_SELF_LEARN_CONFIG = configPath;
    if (pendingProposal) {
        mkdirSync(join(root, "files"));
        writeFileSync(join(root, "files", "self-learn-pending.json"),
            JSON.stringify({ savedAt: Date.now(), proposal: pendingProposal }));
    }
    const listeners = [];
    const logs = [];
    const host = {
        root, logs, confirmations: [], confirmationResult: true,
        events: [], skills: [], tasks: new Map(), rpcCalls: [], onStartAgent: null,
        session: {
            sessionId: randomUUID(),
            workspacePath: root,
            getEvents: async () => host.events.slice(),
            rpc: {
                skills: {
                    list: async () => ({ skills: host.skills.map((skill) => ({ ...skill })) }),
                    reload: async () => { host.rpcCalls.push(["skills.reload"]); },
                },
                tasks: {
                    async startAgent(request) {
                        const agentId = randomUUID();
                        host.tasks.set(agentId, { id: agentId, status: "running" });
                        host.rpcCalls.push(["tasks.startAgent", agentId, request]);
                        if (host.onStartAgent) setImmediate(() => host.onStartAgent(agentId, request));
                        return { agentId };
                    },
                    list: async () => ({ tasks: [...host.tasks.values()].map((task) => ({ ...task })) }),
                    async cancel({ id }) {
                        host.rpcCalls.push(["tasks.cancel", id]);
                        const task = host.tasks.get(id);
                        if (task?.status !== "running") return { cancelled: false };
                        task.status = "cancelled";
                        return { cancelled: true };
                    },
                    async remove({ id }) {
                        host.rpcCalls.push(["tasks.remove", id]);
                        return { removed: host.tasks.delete(id) };
                    },
                },
            },
            on(type, handler) {
                const fn = typeof type === "function" ? type : (event) => {
                    if (event.type === type) return handler(event);
                };
                listeners.push(fn);
                return () => listeners.splice(listeners.indexOf(fn), 1);
            },
            log: async (message) => { logs.push(message); },
            ui: {
                async confirm(message) {
                    host.confirmations.push(message);
                    if (host.confirmationError) throw host.confirmationError;
                    if (host.confirmationHandler) return host.confirmationHandler(message);
                    return host.confirmationResult;
                },
            },
        },
        emit(event) { for (const listener of listeners) listener(event); },
        async submitPrompt(content, { agentId, source, transformedContent = content } = {}) {
            // Current hosts do not identify child prompts on the opening hook bracket.
            const hookInvocationId = randomUUID();
            host.emit({ type: "hook.start", data: {
                hookInvocationId, hookType: "userPromptSubmitted", input: { prompt: content },
            } });
            await host.options.hooks.onUserPromptSubmitted?.({ prompt: content }, { sessionId: host.session.sessionId });
            host.emit({ type: "hook.end", data: { hookInvocationId } });
            host.emit({ type: "user.message", ...(agentId ? { agentId } : {}),
                data: { content, transformedContent, ...(source ? { source } : {}) } });
        },
        tool(action, invocation = {}) {
            return host.options.tools.find((tool) => tool.name === "self_learn_now").handler({ action }, invocation);
        },
        // Shaped like the measured hook input: ids are the parent's, and the agent id is the task id.
        stopSubagent(agentId, response) {
            const sessionId = host.session.sessionId;
            return host.options.hooks.onSubagentStop?.({
                sessionId, agentId, agentName: "explore", agentType: "explore",
                stopReason: "end_turn", response, timestamp: Date.now(),
            }, { sessionId });
        },
        command(name) {
            return host.options.commands.find((command) => command.name === name).handler();
        },
    };
    globalThis[Symbol.for("self-learn-test-host")] = host;
    t.after(async () => {
        for (const instanceId of host.openInstances ?? []) {
            await host.options.canvases[0].onClose({ instanceId });
        }
        if (oldConfig === undefined) delete process.env.COPILOT_SELF_LEARN_CONFIG;
        else process.env.COPILOT_SELF_LEARN_CONFIG = oldConfig;
        for (const [key, value] of Object.entries(oldHome)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        delete globalThis[Symbol.for("self-learn-test-host")];
        rmSync(root, { recursive: true, force: true });
    });
    await import(`../extension.mjs?test=${randomUUID()}`);
    return host;
}
