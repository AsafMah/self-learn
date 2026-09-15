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
    const connection = document.getElementById("connection");
    const error = document.getElementById("error");
    const display = (result) => {
        if (result.error) throw new Error(result.error);
        snapshot = result.snapshot;
        renderSnapshot(document, snapshot);
        error.hidden = true;
    };
    const failed = (message) => {
        error.textContent = message;
        error.hidden = false;
    };
    async function refresh() {
        const button = document.getElementById("refresh");
        button.disabled = true;
        try {
            const response = await fetch("./state", { cache: "no-store" });
            if (!response.ok) throw new Error(`Status request failed (${response.status})`);
            display(await response.json());
        } catch (failure) {
            failed(failure.message);
        } finally {
            button.disabled = false;
        }
    }
    document.getElementById("refresh").addEventListener("click", refresh);
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
