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
    let expectedEnabled;
    let candidate = null;
    let applying = false;
    let outcomeUnknown = false;
    const connection = document.getElementById("connection");
    const error = document.getElementById("error");
    const enabled = document.getElementById("enabled");
    const review = document.getElementById("review-setting");
    const reset = document.getElementById("reset-setting");
    const confirmation = document.getElementById("setting-confirmation");
    const resultText = document.getElementById("setting-result");
    const resetForm = () => {
        dirty = false;
        candidate = null;
        confirmation.hidden = true;
        reset.hidden = true;
        document.getElementById("apply-setting").disabled = applying || outcomeUnknown;
        if (snapshot) {
            expectedEnabled = snapshot.status.enabled;
            enabled.checked = expectedEnabled;
        }
    };
    const display = (result) => {
        if (result.error) throw new Error(result.error);
        snapshot = result.snapshot;
        renderSnapshot(document, snapshot);
        error.hidden = true;
        if (!dirty && !applying) resetForm();
        enabled.disabled = applying || outcomeUnknown;
        review.disabled = applying || outcomeUnknown;
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
                resetForm();
                resultText.textContent = "Current setting refreshed. Review a new change if needed.";
            }
            display(result);
        } catch (failure) {
            failed(failure.message);
        } finally {
            button.disabled = false;
        }
    }
    document.getElementById("refresh").addEventListener("click", () => refresh(true));
    enabled.addEventListener("change", () => {
        dirty = true;
        candidate = null;
        confirmation.hidden = true;
        reset.hidden = false;
        resultText.textContent = "";
    });
    document.getElementById("settings").addEventListener("submit", (event) => {
        event.preventDefault();
        if (!snapshot || applying || outcomeUnknown) return;
        if (enabled.checked === snapshot.status.enabled) {
            resetForm();
            resultText.textContent = "This setting already has that value. Nothing changed.";
            return;
        }
        candidate = { enabled: enabled.checked, expectedEnabled };
        document.getElementById("setting-summary").textContent =
            `${candidate.enabled ? "Enable" : "Disable"} self-learn for this session? No config file, running review or pending proposal will be changed.`;
        confirmation.hidden = false;
    });
    const cancel = () => {
        if (applying) return;
        if (outcomeUnknown) {
            candidate = null;
            confirmation.hidden = true;
            reset.hidden = true;
            return;
        }
        resetForm();
        resultText.textContent = "Edit cancelled. No new change applied.";
    };
    reset.addEventListener("click", cancel);
    document.getElementById("cancel-setting").addEventListener("click", cancel);
    document.getElementById("apply-setting").addEventListener("click", async () => {
        if (!candidate || applying || outcomeUnknown) return;
        applying = true;
        enabled.disabled = true;
        review.disabled = true;
        document.getElementById("apply-setting").disabled = true;
        document.getElementById("cancel-setting").disabled = true;
        try {
            const response = await fetch("./settings", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify(candidate),
            });
            const result = await response.json();
            if (!response.ok || result.applied !== true) {
                if (result.applied === false) {
                    resultText.textContent = `Not applied: ${result.error || "Request rejected"}`;
                    return;
                }
                throw new Error(result.error || `Settings request failed (${response.status})`);
            }
            const desired = candidate.enabled;
            dirty = false;
            candidate = null;
            confirmation.hidden = true;
            reset.hidden = true;
            expectedEnabled = desired;
            enabled.checked = desired;
            if (result.snapshot && !result.error) display(result);
            resultText.textContent = result.message + (result.error ? ` Status could not refresh: ${result.error}` : "");
        } catch (failure) {
            outcomeUnknown = true;
            resultText.textContent = `Could not confirm the outcome: ${failure.message}. Refresh before trying again.`;
        } finally {
            applying = false;
            enabled.disabled = outcomeUnknown;
            review.disabled = outcomeUnknown;
            document.getElementById("apply-setting").disabled = outcomeUnknown;
            document.getElementById("cancel-setting").disabled = false;
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
