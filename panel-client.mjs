export function filteredEntries(entries, kind, query) {
    const text = query.trim().toLocaleLowerCase();
    return entries.filter((entry) => (kind === "all" || entry.kind === kind) &&
        entry.message.toLocaleLowerCase().includes(text)).slice().reverse();
}

export function renderSnapshot(document, snapshot) {
    const set = (id, value) => { document.getElementById(id).textContent = String(value); };
    const showError = (id, value) => {
        const element = document.getElementById(id);
        element.textContent = value || "";
        element.hidden = !value;
    };
    const status = snapshot.status;
    set("phase", status.phase);
    set("configuration", `${status.enabled ? "Enabled" : "Disabled"} | ${status.model} (${status.agentType}) | Automatic screening ${status.autoScreen ? "on" : "off"}`);
    set("screened", status.screenedTurns);
    set("hits", status.hits);
    set("written", status.written);
    set("pending", status.pending
        ? `Pending ${status.pending.mode}: ${status.pending.name} (${status.pending.deferred ? "held until next turn" : "awaiting approval"})`
        : status.reviewQueued ? "Review queued for the end of this turn." : "No pending proposal.");
    set("session", `Session ${snapshot.sessionId} | Retaining up to ${snapshot.historyLimit} activity entries.`);
    showError("storage-error", snapshot.storageError);
    showError("last-error", status.lastError ? `Last operation error: ${status.lastError}` : null);
    const entries = filteredEntries(snapshot.entries, document.getElementById("kind").value,
        document.getElementById("search").value);
    set("count", `${entries.length} of ${snapshot.entries.length}`);
    const list = document.getElementById("entries");
    list.replaceChildren();
    for (const entry of entries) {
        const item = document.createElement("li");
        item.dataset.kind = entry.kind;
        const meta = document.createElement("div");
        meta.className = "entry-meta";
        meta.textContent = `${entry.kind} | ${new Date(entry.at).toLocaleString()}`;
        const message = document.createElement("p");
        message.className = "entry-message";
        message.textContent = entry.message;
        item.append(meta, message);
        list.append(item);
    }
    const empty = document.getElementById("empty");
    empty.hidden = entries.length > 0;
    empty.textContent = snapshot.entries.length ? "No matching activity." : "No activity recorded yet.";
}

if (typeof document !== "undefined") {
    let snapshot;
    let dirty = false;
    let expected;
    let applying = false;
    let outcomeUnknown = false;
    const connection = document.getElementById("connection");
    const error = document.getElementById("error");
    const enabled = document.getElementById("enabled");
    const model = document.getElementById("model");
    const apply = document.getElementById("apply-setting");
    const reset = document.getElementById("reset-setting");
    const resultText = document.getElementById("setting-result");
    const lockForm = () => {
        const locked = !snapshot || applying || outcomeUnknown;
        for (const element of [enabled, model, apply, reset]) element.disabled = locked;
    };
    const resetForm = () => {
        dirty = false;
        reset.hidden = true;
        if (snapshot) {
            expected = { enabled: snapshot.status.enabled, model: snapshot.status.model };
            enabled.checked = expected.enabled;
            model.value = expected.model;
        }
        lockForm();
    };
    const display = (result) => {
        if (result.error) throw new Error(result.error);
        snapshot = result.snapshot;
        renderSnapshot(document, snapshot);
        error.hidden = true;
        if (!dirty && !applying) resetForm();
        lockForm();
    };
    const failed = (message) => {
        error.textContent = message;
        error.hidden = false;
    };
    async function refresh(recoverUnknown = false) {
        const button = document.getElementById("refresh");
        button.disabled = true;
        try {
            const response = await fetch("./state", { cache: "no-store" });
            if (!response.ok) throw new Error(`Status request failed (${response.status})`);
            const result = await response.json();
            if (recoverUnknown && outcomeUnknown && result.snapshot && !result.error) {
                outcomeUnknown = false;
                dirty = false;
                resultText.textContent = "Current settings refreshed. You can apply a new change.";
            }
            display(result);
        } catch (failure) {
            failed(failure.message);
        } finally {
            button.disabled = false;
        }
    }
    document.getElementById("refresh").addEventListener("click", () => refresh(true));
    for (const element of [enabled, model]) {
        element.addEventListener("input", () => {
            dirty = true;
            reset.hidden = false;
            resultText.textContent = "";
        });
    }
    reset.addEventListener("click", () => {
        if (applying || outcomeUnknown) return;
        resetForm();
        resultText.textContent = "Edits reset. No new change applied.";
    });
    document.getElementById("settings").addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!snapshot || applying || outcomeUnknown) return;
        const desired = { enabled: enabled.checked, model: model.value.trim() };
        if (!desired.model || desired.model.length > 200 || /[\s\u0000-\u001f\u007f]/.test(desired.model)) {
            resultText.textContent = "Enter a model identifier without whitespace or control characters (at most 200 characters).";
            return;
        }
        if (desired.enabled === snapshot.status.enabled && desired.model === snapshot.status.model) {
            resetForm();
            resultText.textContent = "These settings already have those values. Nothing changed.";
            return;
        }
        applying = true;
        lockForm();
        resultText.textContent = "Applying...";
        try {
            const response = await fetch("./settings", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ expected, desired }),
            });
            const result = await response.json();
            if (!response.ok || result.applied !== true) {
                if (result.applied === false) {
                    resultText.textContent = `Not applied: ${result.error || "Request rejected"}`;
                    return;
                }
                throw new Error(result.error || `Settings request failed (${response.status})`);
            }
            dirty = false;
            reset.hidden = true;
            expected = desired;
            enabled.checked = desired.enabled;
            model.value = desired.model;
            if (result.snapshot && !result.error) display(result);
            resultText.textContent = result.message + (result.error ? ` Status could not refresh: ${result.error}` : "");
        } catch (failure) {
            outcomeUnknown = true;
            resultText.textContent = `Could not confirm the outcome: ${failure.message}. Refresh before trying again.`;
        } finally {
            applying = false;
            lockForm();
        }
    });
    for (const id of ["kind", "search"]) {
        document.getElementById(id).addEventListener("input", () => {
            if (snapshot) renderSnapshot(document, snapshot);
        });
    }
    const events = new EventSource("./events");
    events.onopen = () => { connection.textContent = "Live updates connected"; };
    events.onmessage = (event) => {
        try {
            display(JSON.parse(event.data));
        } catch (failure) {
            failed(failure.message);
        }
    };
    events.onerror = () => { connection.textContent = "Disconnected - displayed data may be stale. Reconnecting..."; };
    window.addEventListener("pagehide", () => events.close(), { once: true });
    void refresh();
}
