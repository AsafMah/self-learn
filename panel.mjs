import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const assets = new Map([
    ["", ["text/html; charset=utf-8", readFileSync(new URL("./panel.html", import.meta.url))]],
    ["panel.css", ["text/css; charset=utf-8", readFileSync(new URL("./panel.css", import.meta.url))]],
    ["panel-client.mjs", ["text/javascript; charset=utf-8", readFileSync(new URL("./panel-client.mjs", import.meta.url))]],
]);

function readSettings(request) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        request.on("data", (chunk) => {
            size += chunk.length;
            if (size > 2048) {
                reject(Object.assign(new Error("Settings request is too large"), { statusCode: 413 }));
                return;
            }
            chunks.push(chunk);
        });
        request.once("error", reject);
        request.once("aborted", () => reject(new Error("Settings request aborted")));
        request.once("end", () => {
            if (size > 2048) return;
            try {
                const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                if (!value || Array.isArray(value) ||
                    Object.keys(value).length !== 2 ||
                    typeof value.enabled !== "boolean" || typeof value.expectedEnabled !== "boolean") {
                    throw new Error("Expected only enabled and expectedEnabled boolean values");
                }
                resolve(value);
            } catch (error) {
                reject(Object.assign(error, { statusCode: 400 }));
            }
        });
    });
}

// Adapted from the SDK canvas scaffold: one loopback server per open instance.
export function createActivityPanel({ getSnapshot, applySettings, onError, intervalMs = 1000 }) {
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
            const path = request.url;
            if (!path?.startsWith(prefix)) {
                response.writeHead(404).end("Not found");
                return;
            }
            const route = path.slice(prefix.length);
            if (request.method === "POST" && route === "settings") {
                if (request.headers.origin !== origin) {
                    response.writeHead(403, { "Content-Type": "application/json" })
                        .end(JSON.stringify({ applied: false, error: "An own-origin request is required" }));
                    return;
                }
                if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
                    response.writeHead(415, { "Content-Type": "application/json" })
                        .end(JSON.stringify({ applied: false, error: "Expected application/json" }));
                    return;
                }
                request.setTimeout(10000, () => request.destroy());
                void readSettings(request).then((settings) => {
                    if (!applySettings) throw Object.assign(new Error("Settings changes are unavailable"), { statusCode: 503 });
                    return applySettings(settings);
                }).then((message) => {
                    if (response.destroyed || response.writableEnded) return;
                    response.writeHead(200, { "Content-Type": "application/json" })
                        .end(JSON.stringify({ ...envelope(), applied: true, message }));
                }).catch((error) => {
                    const code = [400, 409, 413, 503].includes(error.statusCode) ? error.statusCode : 500;
                    if (code === 500) onError(error);
                    if (response.destroyed || response.writableEnded) return;
                    response.writeHead(code, { "Content-Type": "application/json" })
                        .end(JSON.stringify({ applied: code === 500 ? null : false, error: error.message }));
                });
                return;
            }
            if (request.method !== "GET") {
                response.writeHead(405, { Allow: "GET" }).end("Method not allowed");
                return;
            }
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
            description: "Live self-learn activity, pending-proposal summary and confirmed session enable/disable settings.",
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
