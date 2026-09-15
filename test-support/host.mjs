import { registerHooks } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

export async function boot(t) {
    const root = mkdtempSync(join(tmpdir(), "self-learn-host-"));
    const oldConfig = process.env.COPILOT_SELF_LEARN_CONFIG;
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ autoScreen: false, debugLog: join(root, "debug.log") }));
    process.env.COPILOT_SELF_LEARN_CONFIG = configPath;
    const listeners = [];
    const logs = [];
    const host = {
        root, logs,
        session: {
            sessionId: randomUUID(),
            workspacePath: root,
            on(type, handler) {
                const fn = typeof type === "function" ? type : (event) => {
                    if (event.type === type) return handler(event);
                };
                listeners.push(fn);
                return () => listeners.splice(listeners.indexOf(fn), 1);
            },
            log: async (message) => { logs.push(message); },
        },
        emit(event) { for (const listener of listeners) listener(event); },
        tool(action, invocation = {}) {
            return host.options.tools.find((tool) => tool.name === "self_learn_now").handler({ action }, invocation);
        },
    };
    globalThis[Symbol.for("self-learn-test-host")] = host;
    t.after(async () => {
        for (const instanceId of host.openInstances ?? []) {
            await host.options.canvases[0].onClose({ instanceId });
        }
        if (oldConfig === undefined) delete process.env.COPILOT_SELF_LEARN_CONFIG;
        else process.env.COPILOT_SELF_LEARN_CONFIG = oldConfig;
        delete globalThis[Symbol.for("self-learn-test-host")];
        rmSync(root, { recursive: true, force: true });
    });
    await import(`../extension.mjs?test=${randomUUID()}`);
    return host;
}
