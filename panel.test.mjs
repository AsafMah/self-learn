import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createActivityPanel } from "./panel.mjs";
import { filteredEntries, renderSnapshot } from "./panel-client.mjs";

function snapshot() {
    return {
        sessionId: "test-session",
        historyLimit: 200,
        storageError: null,
        entries: [],
        status: {
            phase: "Idle", enabled: true, autoScreen: false, model: "fixture",
            agentType: "explore", screenedTurns: 0, hits: 0, written: 0,
            reviewQueued: false, pending: null, lastError: null,
        },
    };
}

async function fixture(t) {
    const state = snapshot();
    const errors = [];
    const changes = [];
    const panel = createActivityPanel({
        getSnapshot: () => state, onError: (error) => errors.push(error), intervalMs: 20,
        applySettings(change) {
            if (change.expectedEnabled !== state.status.enabled) {
                throw Object.assign(new Error("Setting changed elsewhere"), { statusCode: 409 });
            }
            changes.push(change);
            state.status.enabled = change.enabled;
            return "Setting applied";
        },
    });
    t.after(() => panel.dispose());
    const opened = await panel.declaration.open({ instanceId: "one" });
    return { panel, state, errors, changes, url: opened.url };
}

test("open coalesces concurrent calls; panels share data, not lifetimes", async (t) => {
    const { panel, state, url } = await fixture(t);
    const [a, b] = await Promise.all([
        panel.declaration.open({ instanceId: "one" }),
        panel.declaration.open({ instanceId: "one" }),
    ]);
    assert.equal(a.url, b.url);
    assert.equal(a.url, url);
    const second = await panel.declaration.open({ instanceId: "two" });
    state.status.phase = "Reviewing";
    assert.equal((await (await fetch(second.url + "state")).json()).snapshot.status.phase, "Reviewing");
    assert.equal(panel.declaration.actions[0].handler().sessionId, state.sessionId);
    await panel.declaration.onClose({ instanceId: "one" });
    await assert.rejects(fetch(url + "state"));
    assert.equal((await fetch(second.url)).status, 200);
    await panel.declaration.onClose({ instanceId: "one" });
    const reopened = await panel.declaration.open({ instanceId: "one", reason: "rehydrate" });
    assert.notEqual(reopened.url, url);
    assert.equal((await (await fetch(reopened.url + "state")).json()).snapshot.status.phase, "Reviewing");
});

test("HTTP reads are capability-scoped and reject foreign origins/hosts", async (t) => {
    const { url } = await fixture(t);
    const base = new URL(url).origin;
    assert.equal(new URL(url).hostname, "127.0.0.1");
    assert.equal((await fetch(base + "/state")).status, 404);
    assert.equal((await fetch(url + "state", { headers: { Origin: "https://unrelated.example" } })).status, 403);
    assert.equal((await fetch(url + "state", { method: "POST" })).status, 405);
    assert.equal((await fetch(url + "state", { method: "OPTIONS" })).status, 405);
    assert.equal((await fetch(url + "unknown")).status, 404);
    const html = await fetch(url);
    assert.match(html.headers.get("content-security-policy"), /default-src 'none'/);
    assert.equal(html.headers.get("referrer-policy"), "no-referrer");
    assert.equal(html.headers.get("access-control-allow-origin"), null);
    assert.match(await html.text(), /Self-learn activity/);
    for (const asset of ["panel.css", "panel-client.mjs"]) {
        assert.equal((await fetch(url + asset)).status, 200);
    }
    const result = await new Promise((resolve, reject) => {
        const request = http.get(url + "state", { headers: { Host: "unrelated.example" } }, (response) => {
            response.resume();
            resolve(response.statusCode);
        });
        request.on("error", reject);
    });
    assert.equal(result, 403);
});

test("settings writes validate origin, content, byte budget and expected baseline", async (t) => {
    const { url, changes, state } = await fixture(t);
    const origin = new URL(url).origin;
    const body = JSON.stringify({ enabled: false, expectedEnabled: true });
    const send = (text, headers = {}) => fetch(url + "settings", {
        method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...headers }, body: text,
    });
    assert.equal((await fetch(url + "settings", { method: "POST", headers: { "Content-Type": "application/json" }, body })).status, 403);
    assert.equal((await send(body, { Origin: "https://unrelated.example" })).status, 403);
    assert.equal((await send(body, { "Content-Type": "text/plain" })).status, 415);
    for (const invalid of ['{}', 'null', '[]', '{"enabled":"false","expectedEnabled":true}',
        '{"enabled":false,"expectedEnabled":true,"file":"elsewhere"}', 'not json']) {
        assert.equal((await send(invalid)).status, 400);
    }
    assert.equal((await send("x".repeat(4096))).status, 413);
    assert.equal(changes.length, 0);
    const applied = await send(body);
    assert.equal(applied.status, 200);
    assert.equal((await applied.json()).applied, true);
    assert.equal(state.status.enabled, false);
    assert.equal(changes.length, 1);
    const stale = await send(body);
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).applied, false);
    assert.equal(changes.length, 1);
});

test("a failed read after applying a setting is not reported as an unapplied change", async (t) => {
    let changed = false;
    const panel = createActivityPanel({
        getSnapshot() { if (changed) throw new Error("read failed"); return snapshot(); },
        applySettings() { changed = true; return "Setting applied"; }, onError: () => {},
    });
    t.after(() => panel.dispose());
    const { url } = await panel.declaration.open({ instanceId: "outcome" });
    const response = await fetch(url + "settings", {
        method: "POST", headers: { Origin: new URL(url).origin, "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false, expectedEnabled: true }),
    });
    const result = await response.json();
    assert.equal(result.applied, true);
    assert.match(result.error, /read failed/);
});

test("SSE delivers changed activity and close terminates its connections", async (t) => {
    const { panel, state, url } = await fixture(t);
    const response = await fetch(url + "events");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const next = async () => decoder.decode((await reader.read()).value);
    assert.match(await next(), /"phase":"Idle"/);
    state.status.phase = "Drafting";
    const update = await next();
    assert.match(update, /"phase":"Drafting"/);
    await panel.declaration.onClose({ instanceId: "one" });
    let ended = false;
    for (let i = 0; i < 10; i++) {
        if ((await reader.read()).done) { ended = true; break; }
    }
    assert.equal(ended, true);
});

test("snapshot failures are explicit in HTTP and canvas actions", async (t) => {
    const failures = [];
    const panel = createActivityPanel({
        getSnapshot: () => { throw new Error("fixture unavailable"); },
        onError: (error) => failures.push(error),
    });
    t.after(() => panel.dispose());
    const { url } = await panel.declaration.open({ instanceId: "error" });
    const response = await fetch(url + "state");
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { snapshot: null, error: "Cannot read activity: fixture unavailable" });
    assert.equal(failures.length, 1);
    assert.throws(() => panel.declaration.actions[0].handler(), /fixture unavailable/);
});

test("large snapshots survive stream backpressure and reconnect", async (t) => {
    const { panel, state, url } = await fixture(t);
    state.entries = Array.from({ length: 100 }, (_, i) => ({
        id: String(i), at: "2026-01-01T00:00:00Z", kind: "notice", message: "界".repeat(4096),
    }));
    const summary = panel.declaration.actions[0].handler();
    assert.equal(summary.retainedEntries, 100);
    assert.equal(summary.entries.length, 25);
    assert.equal(state.entries.length, 100);
    async function receive(reader) {
        let text = "";
        const decoder = new TextDecoder();
        while (!text.includes("\n\n")) {
            const part = await reader.read();
            assert.equal(part.done, false);
            text += decoder.decode(part.value, { stream: true });
        }
        return JSON.parse(text.split("\n\n").find((frame) => frame.startsWith("data: ")).slice(6));
    }
    for (let attempt = 0; attempt < 2; attempt++) {
        const reader = (await fetch(url + "events")).body.getReader();
        assert.equal((await receive(reader)).snapshot.entries.length, 100);
        state.status.hits++;
        assert.equal((await receive(reader)).snapshot.status.hits, state.status.hits);
        await reader.cancel();
    }
});

test("renderer filters without mutating history or interpreting markup", () => {
    class Element {
        textContent = "";
        value = "";
        hidden = false;
        dataset = {};
        children = [];
        set innerHTML(_) { throw new Error("Untrusted HTML sink used"); }
        append(...children) { this.children.push(...children); }
        replaceChildren(...children) { this.children = children; }
    }
    const elements = new Map();
    const document = {
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, new Element());
            return elements.get(id);
        },
        createElement: () => new Element(),
    };
    document.getElementById("kind").value = "all";
    const state = snapshot();
    state.entries = [
        { id: "1", at: "2026-01-01T00:00:00Z", kind: "review", message: "Routine review" },
        { id: "2", at: "2026-01-01T00:01:00Z", kind: "error", message: "<img src=x onerror=alert(1)>" },
    ];
    state.storageError = "History read failed";
    state.status.pending = { mode: "extend", name: "fixture", deferred: true };
    renderSnapshot(document, state);
    assert.equal(document.getElementById("entries").children[0].children[1].textContent, state.entries[1].message);
    assert.match(document.getElementById("pending").textContent, /held until next turn/);
    assert.equal(document.getElementById("storage-error").hidden, false);
    assert.equal(state.entries[0].id, "1");
    assert.deepEqual(filteredEntries(state.entries, "review", "ROUTINE"), [state.entries[0]]);
    document.getElementById("search").value = "absent";
    renderSnapshot(document, state);
    assert.equal(document.getElementById("empty").textContent, "No matching activity.");
});
