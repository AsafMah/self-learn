import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createActivityPanel } from "../panel.mjs";

// No browser package is required: drive an isolated headless browser over its CDP socket.
const executable = process.env.BROWSER_EXECUTABLE ??
    (process.platform === "win32" ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" : null);
if (!executable) throw new Error("Set BROWSER_EXECUTABLE to an installed Chromium-based browser.");
const profile = await mkdtemp(join(tmpdir(), "self-learn-browser-"));
const screenshotDir = process.argv[2] ? resolve(process.argv[2]) : null;
const state = {
    sessionId: "browser-fixture",
    historyLimit: 200,
    storageError: null,
    entries: [
        { id: "1", at: "2026-01-01T10:00:00Z", kind: "review", message: "Screening completed. The lesson is already covered by an existing skill." },
        { id: "2", at: "2026-01-01T10:02:00Z", kind: "draft", message: "Draft held: extend an existing skill - awaiting approval." },
        { id: "3", at: "2026-01-01T10:03:00Z", kind: "error", message: "<img src=x onerror=\"window.injected=true\"> Untrusted text is displayed, never executed." },
    ],
    status: {
        phase: "Reviewing", enabled: true, autoScreen: true, model: "example-model",
        agentType: "explore", screenedTurns: 2, hits: 1, written: 0, reviewQueued: false,
        pending: { mode: "extend", name: "example-workflow", deferred: false }, lastError: null,
    },
};
const errors = [];
let settingsApplied = 0;
const panel = createActivityPanel({
    getSnapshot: () => state, onError: (error) => errors.push(error), intervalMs: 50,
    applySettings({ expected, desired }) {
        if (state.status.enabled !== expected.enabled || state.status.model !== expected.model) {
            throw Object.assign(new Error("Setting changed elsewhere"), { statusCode: 409 });
        }
        settingsApplied++;
        state.status.enabled = desired.enabled;
        state.status.model = desired.model;
        return "Setting applied for this session";
    },
});
const { url } = await panel.declaration.open({ instanceId: "browser" });
let browser;
let socket;
let send;
let browserSession;
let stderr = "";
let exited;
let launchError;
const pending = new Map();
let sequence = 0;

async function eventually(check, label, timeoutMs = 10000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (await check()) return;
        await delay(50);
    }
    throw new Error(`Timed out: ${label}\n${stderr}`);
}

try {
    browser = spawn(executable, [
        "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
        "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    browser.on("error", (error) => { launchError = error; });
    browser.stderr.on("data", (data) => { stderr = (stderr + data).slice(-8000); });
    exited = new Promise((done) => browser.once("exit", done));
    let endpoint;
    await eventually(async () => {
        if (launchError) throw launchError;
        try {
            const [port, path] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/);
            endpoint = `ws://127.0.0.1:${port}${path}`;
            return true;
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
            if (browser.exitCode !== null) throw new Error(`Browser exited before CDP was ready: ${stderr}`);
            return false;
        }
    }, "browser startup", 20000);
    socket = new WebSocket(endpoint);
    await new Promise((done, reject) => {
        socket.addEventListener("open", done, { once: true });
        socket.addEventListener("error", reject, { once: true });
    });
    socket.addEventListener("message", ({ data }) => {
        const message = JSON.parse(data);
        if (message.id) {
            const call = pending.get(message.id);
            if (!call) return;
            pending.delete(message.id);
            clearTimeout(call.timer);
            if (message.error) call.reject(new Error(JSON.stringify(message.error)));
            else call.resolve(message.result);
        } else if (message.method === "Runtime.exceptionThrown") {
            errors.push(new Error(JSON.stringify(message.params.exceptionDetails)));
        }
    });
    send = (method, params = {}, sessionId) => new Promise((resolveCall, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`CDP request timed out: ${method}`));
        }, 10000);
        pending.set(id, { resolve: resolveCall, reject, timer });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    browserSession = (await send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
    const command = (method, params) => send(method, params, browserSession);
    const evaluate = async (expression) => {
        const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
    };
    await command("Runtime.enable");
    await command("Page.enable");
    await command("Emulation.setDeviceMetricsOverride", { width: 520, height: 1000, deviceScaleFactor: 1, mobile: false });
    await command("Page.navigate", { url });
    await eventually(async () => await evaluate("document.getElementById('phase')?.textContent") === "Reviewing", "initial status render");
    assert.equal(await evaluate("document.getElementById('screened').textContent"), "2");
    assert.equal(await evaluate("document.querySelectorAll('#entries li').length"), 3);
    assert.equal(await evaluate("Boolean(window.injected || document.querySelector('#entries img'))"), false);
    assert.match(await evaluate("document.getElementById('entries').textContent"), /<img src=x/);
    await evaluate("document.getElementById('kind').value='review'; document.getElementById('kind').dispatchEvent(new Event('input'));");
    assert.equal(await evaluate("document.querySelectorAll('#entries li').length"), 1);
    await evaluate("document.getElementById('kind').value='all'; document.getElementById('kind').dispatchEvent(new Event('input'));");
    assert.equal(await evaluate("document.getElementById('model').value"), "example-model");
    assert.equal(await evaluate("document.getElementById('review-setting')"), null);
    await evaluate("document.getElementById('enabled').click(); document.getElementById('model').value='next-model'; document.getElementById('model').dispatchEvent(new Event('input'));");
    assert.equal(settingsApplied, 0);
    await evaluate("document.getElementById('reset-setting').click()");
    assert.equal(await evaluate("document.getElementById('enabled').checked"), true);
    assert.equal(await evaluate("document.getElementById('model').value"), "example-model");
    assert.equal(settingsApplied, 0);
    await evaluate("document.getElementById('enabled').click(); document.getElementById('model').value='next-model'; document.getElementById('model').dispatchEvent(new Event('input')); document.getElementById('apply-setting').click()");
    await eventually(() => settingsApplied === 1, "one-click setting change");
    await eventually(async () => (await evaluate("document.getElementById('setting-result').textContent")).startsWith("Setting applied"), "applied outcome");
    assert.equal(state.status.enabled, false);
    assert.equal(state.status.model, "next-model");
    await evaluate("document.getElementById('enabled').click()");
    state.status.model = "outside-model";
    await delay(100);
    assert.equal(await evaluate("document.getElementById('enabled').checked"), true);
    assert.equal(await evaluate("document.getElementById('model').value"), "next-model");
    await evaluate("document.getElementById('apply-setting').click()");
    await eventually(async () => (await evaluate("document.getElementById('setting-result').textContent")).startsWith("Not applied:"), "stale setting rejection");
    assert.equal(settingsApplied, 1);
    await evaluate("document.getElementById('reset-setting').click()");
    assert.equal(await evaluate("document.getElementById('model').value"), "outside-model");
    await evaluate(`{
        const original = window.fetch;
        window.fetch = async (...args) => {
            const response = await original(...args);
            if (args[0] === './settings') {
                window.fetch = original;
                await response.text();
                throw new Error('Simulated response loss after apply');
            }
            return response;
        };
        document.getElementById('enabled').click();
        document.getElementById('apply-setting').click();
    }`);
    await eventually(async () => (await evaluate("document.getElementById('setting-result').textContent")).startsWith("Could not confirm"), "unknown submitted outcome");
    assert.equal(settingsApplied, 2);
    assert.equal(state.status.enabled, true);
    await evaluate("document.getElementById('reset-setting').click()");
    assert.match(await evaluate("document.getElementById('setting-result').textContent"), /Could not confirm/);
    assert.equal(await evaluate("document.getElementById('enabled').disabled"), true);
    await evaluate("document.getElementById('refresh').click()");
    await eventually(async () => await evaluate("document.getElementById('enabled').disabled") === false, "unknown outcome recovery");
    assert.equal(await evaluate("document.getElementById('enabled').checked"), true);
    await evaluate("document.getElementById('model').value='recovered-model'; document.getElementById('model').dispatchEvent(new Event('input')); document.getElementById('apply-setting').click()");
    await eventually(() => settingsApplied === 3, "settings usable after outcome recovery");
    assert.equal(state.status.enabled, true);
    assert.equal(state.status.model, "recovered-model");
    state.status.phase = "Idle";
    state.entries.push({ id: "4", at: "2026-01-01T10:04:00Z", kind: "notice", message: "A new entry arrived over the live connection." });
    await eventually(async () => await evaluate("document.getElementById('phase').textContent") === "Idle", "live state update");
    await eventually(async () => await evaluate("document.querySelectorAll('#entries li').length") === 4, "live activity update");
    await evaluate("document.getElementById('refresh').click()");
    await eventually(async () => await evaluate("document.getElementById('refresh').disabled") === false, "manual refresh");
    if (screenshotDir) {
        await mkdir(screenshotDir, { recursive: true });
        const { data } = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
        await writeFile(join(screenshotDir, "self-learn-light.png"), Buffer.from(data, "base64"));
    }
    await command("Emulation.setDeviceMetricsOverride", { width: 320, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    assert.equal(await evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth"), true);
    assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('button,input,select,header,.metrics'))
        .map(element => ({name: element.id || element.tagName, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right}))
        .filter(box => box.left < 0 || box.right > document.documentElement.clientWidth + 1)`), []);
    await command("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    if (screenshotDir) {
        const { data } = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
        await writeFile(join(screenshotDir, "self-learn-dark-narrow.png"), Buffer.from(data, "base64"));
    }
    await panel.declaration.onClose({ instanceId: "browser" });
    await eventually(async () => (await evaluate("document.getElementById('connection').textContent")).startsWith("Disconnected"), "disconnection notice");
    const reopened = await panel.declaration.open({ instanceId: "browser", reason: "rehydrate" });
    await command("Page.navigate", { url: reopened.url });
    await eventually(async () => await evaluate("document.querySelectorAll('#entries li').length") === 4, "reopen with retained state");
    assert.deepEqual(errors, []);
    console.log("Browser checks passed: render, live update, filtering, literal text, one-click enabled/model Apply, reset, stale rejection, response-loss recovery, 320px layout, disconnect and reopen.");
    if (screenshotDir) console.log(`Screenshots: ${screenshotDir}`);
} finally {
    if (socket?.readyState === WebSocket.OPEN) {
        try {
            await send("Browser.close");
        } catch (error) {
            console.error(`Browser cleanup: ${error.message}`);
        }
        socket.close();
    }
    for (const call of pending.values()) clearTimeout(call.timer);
    if (browser?.pid) {
        const ended = await Promise.race([exited.then(() => true), delay(5000).then(() => false)]);
        if (!ended) {
            browser.kill();
            await exited;
        }
    }
    await panel.dispose();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
