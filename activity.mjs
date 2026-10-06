import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export const HISTORY_LIMIT = 200;
const MESSAGE_LIMIT = 4096;
export const HISTORY_BYTE_LIMIT = 2 * 1024 * 1024;
const KINDS = new Set(["notice", "review", "draft", "proposal", "saved", "error"]);

export function activityKind(message) {
    if (/^(ERROR:|transcript: getEvents failed|drafting failed:|could not read existing skill|confirm failed:|write failed:|skills\.(list|reload) failed|failed to (persist|restore) proposal|idle handler threw:|task_complete screening threw:)/.test(message)) return "error";
    if (/^(screening turn|verdict:|review queued|skip:)/.test(message)) return "review";
    if (/^(draft ready|draft attempt|draft held|drafter declined|drafting started)/.test(message)) return "draft";
    if (/^(proposal |proposal captured:|restored proposal|discarding .*proposal|rejected proposal:|recorded decline)/.test(message)) return "proposal";
    if (/^wrote /.test(message)) return "saved";
    if (/^self-learn (enabled|disabled)/.test(message)) return "notice";
    return null;
}

function validEntry(entry) {
    return entry && typeof entry.id === "string" && typeof entry.at === "string" &&
        Number.isFinite(Date.parse(entry.at)) && KINDS.has(entry.kind) &&
        typeof entry.message === "string" && entry.message.length <= MESSAGE_LIMIT;
}

// Only this session's bounded activity is stored here, never its transcript or draft body.
export function createActivityJournal({ file, sessionId, onError = () => {} }) {
    let entries = [];
    let storageError = null;
    let canWrite = true;
    const report = (error) => {
        storageError = `Activity history unavailable: ${error.message}`;
        onError(storageError);
    };
    try {
        if (statSync(file).size > HISTORY_BYTE_LIMIT) throw new Error("history exceeds the size limit");
        const saved = JSON.parse(readFileSync(file, "utf8"));
        if (saved.version !== 1 || saved.sessionId !== sessionId ||
            !Array.isArray(saved.entries) || saved.entries.length > HISTORY_LIMIT ||
            !saved.entries.every(validEntry)) {
            throw new Error("invalid or mismatched session history");
        }
        entries = saved.entries;
    } catch (error) {
        if (error.code !== "ENOENT") {
            canWrite = false; // Preserve corrupt/unreadable evidence instead of overwriting it.
            report(error);
        }
    }
    return {
        record(kind, message) {
            if (!KINDS.has(kind) || typeof message !== "string") throw new Error("Invalid activity entry");
            const text = message.length > MESSAGE_LIMIT
                ? `${message.slice(0, MESSAGE_LIMIT - 15)}\n[truncated]`
                : message;
            entries.push({ id: randomUUID(), at: new Date().toISOString(), kind, message: text });
            entries = entries.slice(-HISTORY_LIMIT);
            let saved = JSON.stringify({ version: 1, sessionId, entries });
            while (Buffer.byteLength(saved, "utf8") > HISTORY_BYTE_LIMIT && entries.length > 1) {
                entries.shift();
                saved = JSON.stringify({ version: 1, sessionId, entries });
            }
            if (!canWrite) return;
            const temporary = `${file}.${randomUUID()}.tmp`;
            try {
                mkdirSync(dirname(file), { recursive: true });
                writeFileSync(temporary, saved, { mode: 0o600 });
                renameSync(temporary, file);
                storageError = null;
            } catch (error) {
                report(error);
            } finally {
                try {
                    rmSync(temporary, { force: true });
                } catch (error) {
                    report(error);
                }
            }
        },
        snapshot() {
            return { entries: entries.map((entry) => ({ ...entry })), storageError, historyPath: file };
        },
    };
}
