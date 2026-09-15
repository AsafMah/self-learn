import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActivityJournal, activityKind, HISTORY_LIMIT, HISTORY_BYTE_LIMIT } from "./activity.mjs";

function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), "self-learn-activity-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const file = join(root, "history.json");
    const errors = [];
    const options = { file, sessionId: "fixture-session", onError: (error) => errors.push(error) };
    return { file, errors, options, journal: createActivityJournal(options) };
}

test("activity survives reload and is keyed by session, not panel", (t) => {
    const { journal, options } = fixture(t);
    journal.record("review", "verdict: no - a routine lookup");
    journal.record("proposal", "draft held for approval");
    const restored = createActivityJournal(options).snapshot();
    assert.deepEqual(restored.entries, journal.snapshot().entries);
    assert.equal(restored.storageError, null);
});

test("history is bounded and messages disclose truncation", (t) => {
    const { journal, file } = fixture(t);
    for (let i = 0; i <= HISTORY_LIMIT; i++) journal.record("notice", String(i));
    assert.equal(journal.snapshot().entries.length, HISTORY_LIMIT);
    assert.equal(journal.snapshot().entries[0].message, "1");
    journal.record("draft", "x".repeat(6000));
    assert.match(journal.snapshot().entries.at(-1).message, /\[truncated\]$/);
    assert.ok(readFileSync(file).length < 2 * 1024 * 1024);
});

test("corrupt and foreign-session history is surfaced and never overwritten", (t) => {
    const { file, options, errors } = fixture(t);
    for (const source of ["not json", JSON.stringify({ version: 1, sessionId: "another-session", entries: [] })]) {
        writeFileSync(file, source);
        const journal = createActivityJournal(options);
        journal.record("notice", "Only in memory");
        assert.match(journal.snapshot().storageError, /Activity history unavailable/);
        assert.equal(readFileSync(file, "utf8"), source);
        assert.equal(journal.snapshot().entries.length, 1);
    }
    assert.equal(errors.length, 2);
});

test("write failures remain visible and a later successful save clears the storage error", (t) => {
    const { journal, file, errors } = fixture(t);
    mkdirSync(file);
    journal.record("notice", "Cannot replace a directory");
    assert.match(journal.snapshot().storageError, /Activity history unavailable/);
    assert.equal(errors.length, 1);
    rmSync(file, { recursive: true });
    journal.record("notice", "Storage recovered");
    assert.equal(journal.snapshot().storageError, null);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).entries.length, 2);
});

test("snapshots do not leak mutable journal state", (t) => {
    const { journal } = fixture(t);
    journal.record("notice", "Original");
    journal.snapshot().entries[0].message = "Changed";
    assert.equal(journal.snapshot().entries[0].message, "Original");
    assert.throws(() => journal.record("unknown", "text"), /Invalid activity/);
});

test("Unicode and JSON-escaped messages never produce history the reader rejects", (t) => {
    const { journal, file, options } = fixture(t);
    for (let i = 0; i < 200; i++) journal.record("notice", (i % 2 ? "\0" : "界").repeat(4096));
    assert.ok(readFileSync(file).length <= HISTORY_BYTE_LIMIT);
    assert.ok(journal.snapshot().entries.length < HISTORY_LIMIT);
    const restored = createActivityJournal(options).snapshot();
    assert.equal(restored.storageError, null);
    assert.deepEqual(restored.entries, journal.snapshot().entries);
});

test("diagnostic prose is not mistaken for an operational error", () => {
    assert.equal(activityKind("verdict: no - failed: surprising"), "review");
    assert.equal(activityKind("drafting failed: target is unreadable"), "error");
    assert.equal(activityKind("USAGE [MAIN] model=fixture"), null);
    assert.equal(activityKind("ignored userPromptSubmitted from a sub-agent (100 chars)"), null);
    assert.equal(activityKind("Activity history unavailable: write failed"), null);
    assert.equal(activityKind("drafting started: new fixture"), "draft");
    assert.equal(activityKind("wrote a skill"), "saved");
});
