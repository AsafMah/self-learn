import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const assets = new Map([
    ["", ["text/html; charset=utf-8", readFileSync(new URL("./panel.html", import.meta.url))]],
    ["panel.css", ["text/css; charset=utf-8", readFileSync(new URL("./panel.css", import.meta.url))]],
    ["panel-client.mjs", ["text/javascript; charset=utf-8", readFileSync(new URL("./panel-client.mjs", import.meta.url))]],
]);

// Adapted from the SDK canvas scaffold: one loopback server per open instance.
export function createActivityPanel({ getSnapshot, onError, intervalMs = 1000 }) {
    const servers = new Map();

    async function startServer() {
        const prefix = `/${randomUUID()}/`;
        const clients = new Map();
        let timer;
        let origin;
        let previous;
        const envelope = () => {
            try {
                return { snapshot: getSnapshot(), error: null };
            } catch (error) {
                onError(error);
                return { snapshot: null, error: `Cannot read activity: ${error.message}` };
            }
        };
        const send = (response, frame) => {
            const client = clients.get(response);
            if (!client) return;
            if (client.waiting) {
                client.pending = frame; // Coalesce to the latest snapshot while bytes are draining.
                return;
            }
            if (response.write(frame)) return;
            // A false write means accepted-but-buffered, not failed. Even a healthy panel hits
            // this for a large snapshot; wait for drain before sending more.
            client.waiting = true;
            client.timeout = setTimeout(() => response.destroy(), 10000);
            client.timeout.unref();
        };
        const tick = () => {
            const body = JSON.stringify(envelope());
            for (const [response, client] of clients) {
                if (body !== previous) send(response, `data: ${body}\n\n`);
                else if (!client.waiting) send(response, ": live\n\n");
            }
            previous = body;
        };
        const server = createServer((request, response) => {
            response.setHeader("Cache-Control", "no-store");
            response.setHeader("Referrer-Policy", "no-referrer");
            response.setHeader("X-Content-Type-Options", "nosniff");
            if (request.headers.host !== new URL(origin).host ||
                (request.headers.origin && request.headers.origin !== origin)) {
                response.writeHead(403).end("Forbidden");
                return;
            }
            if (request.method !== "GET") {
                response.writeHead(405, { Allow: "GET" }).end("Read-only panel");
                return;
            }
            const path = request.url;
            if (!path?.startsWith(prefix)) {
                response.writeHead(404).end("Not found");
                return;
            }
            const route = path.slice(prefix.length);
            if (assets.has(route)) {
                const [type, body] = assets.get(route);
                response.setHeader("Content-Security-Policy",
                    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'");
                response.writeHead(200, { "Content-Type": type }).end(body);
            } else if (route === "state") {
                const result = envelope();
                response.writeHead(result.error ? 503 : 200, { "Content-Type": "application/json" })
                    .end(JSON.stringify(result));
            } else if (route === "events") {
                response.writeHead(200, {
                    "Content-Type": "text/event-stream",
                    Connection: "keep-alive",
                });
                const client = { waiting: false, pending: null, timeout: null };
                clients.set(response, client);
                response.on("drain", () => {
                    clearTimeout(client.timeout);
                    client.waiting = false;
                    if (client.pending) {
                        const frame = client.pending;
                        client.pending = null;
                        send(response, frame);
                    }
                });
                send(response, `data: ${JSON.stringify(envelope())}\n\n`);
                if (!timer && clients.size) {
                    timer = setInterval(tick, intervalMs);
                    timer.unref();
                }
                response.on("close", () => {
                    clearTimeout(client.timeout);
                    clients.delete(response);
                    if (!clients.size) {
                        clearInterval(timer);
                        timer = undefined;
                    }
                });
            } else {
                response.writeHead(404).end("Not found");
            }
        });
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
                server.off("error", reject);
                resolve();
            });
        });
        origin = `http://127.0.0.1:${server.address().port}`;
        server.on("error", onError);
        return {
            url: origin + prefix,
            close: async () => {
                clearInterval(timer);
                for (const [response, client] of clients) {
                    clearTimeout(client.timeout);
                    response.end();
                }
                clients.clear();
                const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
                server.closeAllConnections();
                await closed;
            },
        };
    }

    const close = async ({ instanceId }) => {
        const pending = servers.get(instanceId);
        if (!pending) return;
        servers.delete(instanceId);
        await (await pending).close();
    };
    return {
        declaration: {
            id: "self-learn-activity",
            displayName: "Self-learn activity",
            description: "Live self-learn status, pending-proposal summary and recent activity for this session.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            actions: [{
                name: "refresh",
                description: "Read current self-learn status and retained session activity without starting a review.",
                inputSchema: { type: "object", properties: {}, additionalProperties: false },
                handler: () => {
                    const snapshot = getSnapshot();
                    return { ...snapshot, retainedEntries: snapshot.entries.length, entries: snapshot.entries.slice(-25) };
                },
            }],
            open: async ({ instanceId }) => {
                let pending = servers.get(instanceId);
                if (!pending) {
                    pending = startServer();
                    servers.set(instanceId, pending);
                }
                try {
                    return { title: "Self-learn activity", url: (await pending).url };
                } catch (error) {
                    if (servers.get(instanceId) === pending) servers.delete(instanceId);
                    throw error;
                }
            },
            onClose: close,
        },
        ownsInstance: (instanceId) => servers.has(instanceId),
        dispose: () => Promise.all([...servers.keys()].map((instanceId) => close({ instanceId }))),
    };
}
