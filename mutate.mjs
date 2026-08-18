// Mutation harness for self-learn's lib.mjs.
//
// Two failure modes this guards against, both of which look identical to a "caught" mutant:
//   1. a `find` string that does not appear in the source -> nothing was mutated, tests pass or
//      fail for unrelated reasons. Every mutation asserts its match count before running.
//   2. an equivalent mutant -> survives with no possible test able to catch it. Survivors are
//      printed with enough detail to be checked by hand rather than tallied.

// Run with `npm run mutate`. Mutants are keyed to exact source strings, so editing lib.mjs will
// make some of them stop matching -- they are reported as UNMATCHED rather than counted, which is
// the signal to update them, not a passing result.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.join(os.tmpdir(), "self-learn-mutation");

const M = [
  // --- evidence rubric: the reason the screener cannot assert its way to "yes" ---
  ["quote-min-len", "quote evidence may be 1 char", "export const MIN_QUOTE_CHARS = 24;", "export const MIN_QUOTE_CHARS = 1;"],
  ["failed-criteria", "failing criteria no longer reject", "if (failed.length > 0) return reject(", "if (failed.length > 99) return reject("],
  ["quote-in-transcript", "quote need not appear in transcript", "if (!normaliseForMatch(transcript).includes(q)) {", "if (false) {"],
  ["quote-required", "expensive may pass with no quote", 'if (typeof quote !== "string") return reject("expensive passed without a quote");', 'if (false) return reject("expensive passed without a quote");'],
  ["pass-is-boolean", "criterion pass need not be boolean", 'if (!c || typeof c.pass !== "boolean") return reject(', "if (!c) return reject("],
  ["target-whitelist", "screener target no longer whitelisted", 'target: ["refine", "extend"].includes(parsed.target) ? parsed.target : "new",', 'target: parsed.target ?? "new",'],
  ["skill-name-required", "verdict may name no skill", 'if (!skill) return reject("no skill name given");', 'if (false) return reject("no skill name given");'],

  // --- sanitize: screener output reaches the main agent's context ---
  ["sanitize-injection", "prompt-injection phrase passes through", 'if (/ignore (all )?(your |the )?(previous|prior|above) instructions/i.test(clean)) return "";', 'if (false) return "";'],
  ["sanitize-tags", "pseudo-tags no longer stripped", 'clean = clean.replace(/<\\/?(system|instructions?|advisor|self-learn)>/gi, "");', "clean = clean;"],
  ["sanitize-limit", "length limit not enforced", "return clean.slice(0, limit);", "return clean;"],
  ["sanitize-nonstring", "non-string coerced instead of dropped", 'if (typeof text !== "string") return "";', 'if (typeof text !== "string") return String(text);'],

  // --- skill file paths: what may be written where ---
  ["abs-path", "absolute paths accepted", 'if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {', "if (false) {"],
  ["segment-re-dot", "segment may start with a dot (enables ..)", "export const SKILL_FILE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;", "export const SKILL_FILE_SEGMENT_RE = /^[A-Za-z0-9.][A-Za-z0-9._-]*$/;"],
  ["skill-md-guard", "files may overwrite SKILL.md", "if (/^SKILL\\.md$/i.test(path)) {", "if (false) {"],
  ["depth-const", "nesting depth unbounded", "export const MAX_SKILL_FILE_DEPTH = 3;", "export const MAX_SKILL_FILE_DEPTH = 99;"],
  ["depth-offbyone", "depth limit off by one", "if (segments.length > MAX_SKILL_FILE_DEPTH) {", "if (segments.length > MAX_SKILL_FILE_DEPTH + 1) {"],
  ["max-files", "file count unbounded", "export const MAX_SKILL_FILES = 10;", "export const MAX_SKILL_FILES = 1000;"],
  ["dup-case", "case-only duplicate paths allowed", "const key = path.toLowerCase();", "const key = path;"],
  ["content-string", "file content need not be a string", 'if (typeof entry.content !== "string") return `"${path}" has no content`;', 'if (false) return `"${path}" has no content`;'],

  // --- byte budgets ---
  ["files-budget", "total budget 10x too generous", "if (total > maxSkillBytes) {", "if (total > maxSkillBytes * 10) {"],
  ["budget-excludes-body", "body bytes excluded from total", 'Buffer.byteLength(p.body ?? "", "utf8"),', "0,"],
  ["body-budget", "body budget 10x too generous", 'if (Buffer.byteLength(p.body, "utf8") > maxSkillBytes) {', 'if (Buffer.byteLength(p.body, "utf8") > maxSkillBytes * 10) {'],

  // --- proposal validation ---
  ["name-re-check", "skill name unchecked", 'if (!SKILL_NAME_RE.test(p.name ?? "")) {', "if (false) {"],
  ["name-re-slash", "skill name may contain a slash", "export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;", "export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-\\/]{0,63}$/;"],
  ["body-required", "body no longer required", 'if (!p.body || typeof p.body !== "string") return "body required";', 'if (false) return "body required";'],
  ["mode-whitelist", "mode no longer whitelisted", 'if (p.mode !== "new" && p.mode !== "refine" && p.mode !== "extend") {', "if (false) {"],
  ["section-required", "extend needs no valid section", 'if (p.mode === "extend" && !SECTION_TITLE_RE.test((p.section ?? "").trim())) {', "if (false) {"],
  ["section-len", "section title length unbounded", "{2,79}$/;", "{2,999}$/;"],

  // --- frontmatter rendering ---
  ["oneline-frontmatter", "newlines survive into frontmatter", 'const oneLine = (s) => s.replace(/\\r?\\n/g, " ").replace(/"/g, "\'").trim();', "const oneLine = (s) => s.trim();"],

  // --- append-only extend ---
  ["dup-heading", "duplicate section headings allowed", "if (existingHeadings.includes(headingKey(p.section))) {", "if (false) {"],
  ["no-frontmatter", "missing frontmatter not rejected", "if (!parts) {", "if (false) {"],
  ["append-trim", "body not trimmed before append", "const body = parts.body.trim();", "const body = parts.body;"],
  ["frontmatter-greedy", "frontmatter regex greedy", "const match = /^---\\r?\\n([\\s\\S]*?)\\r?\\n---\\r?\\n?/.exec(text);", "const match = /^---\\r?\\n([\\s\\S]*)\\r?\\n---\\r?\\n?/.exec(text);"],

  // --- sub-agent recognisers ---
  ["draft-empty-body", "empty body counts as a finished draft", 'if (typeof obj.body === "string" && obj.body.trim()) return true;', 'if (typeof obj.body === "string") return true;'],
  ["verdict-any-object", "any JSON object counts as a verdict", 'if (obj && typeof obj === "object" && obj.criteria) return true;', 'if (obj && typeof obj === "object") return true;'],

  // --- main-agent stop guard ---
  ["stop-prefix", "bg- prefix test instead of equality", "return id === mainSessionId;", 'return !id.startsWith("bg-");'],
  ["stop-empty-id", "empty session id accepted", 'if (typeof id !== "string" || id === "") return false;', 'if (typeof id !== "string") return false;'],

  // --- drafter may not override the screener ---
  ["draft-mode", "drafter overrides screener mode", "mode: verdict.target,", "mode: parsed.mode ?? verdict.target,"],
  ["draft-name", "drafter overrides screener skill name", "name: verdict.skill,", "name: parsed.name ?? verdict.skill,"],

  // --- json scanning ---
  ["json-instring", "braces inside strings break scanning", "if (inString) continue;", "if (false) continue;"],

  // --- skill reference detection ---
  ["ref-bare-substring", "bare substring counts as a reference", 'if (text.includes("`" + name + "`")) {', "if (text.includes(name)) {"],
  ["ref-compound-only", "single-word names matched unbackticked", 'if (!name.includes("-")) continue;', "if (false) continue;"],
];

// The default reporter prints `ℹ fail 0`, not TAP's `# fail 0`, so parse TAP explicitly rather
// than guessing at the format -- an unparsed count silently reads as a crash.
function runTests() {
  const args = ["--test", "--test-reporter", "tap", "test.mjs"];
  let out, ok;
  try {
    out = execFileSync(process.execPath, args, {
      cwd: WORK, encoding: "utf8", timeout: 180000, stdio: ["ignore", "pipe", "pipe"],
    });
    ok = true;
  } catch (e) {
    out = String(e.stdout ?? "") + String(e.stderr ?? "");
    ok = false;
  }
  const num = (re) => { const m = re.exec(out); return m ? Number(m[1]) : null; };
  const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
  return { ok, out, pass: num(/^# pass (\d+)$/m), fails: num(/^# fail (\d+)$/m), failed };
}

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
for (const f of ["test.mjs", "package.json"]) copyFileSync(path.join(SRC, f), path.join(WORK, f));
const original = readFileSync(path.join(SRC, "lib.mjs"), "utf8");

// Control: the unmutated copy must pass, or every "caught" below is meaningless.
writeFileSync(path.join(WORK, "lib.mjs"), original);
const control = runTests();
console.log(`CONTROL: ${control.ok ? "pass" : "FAIL"} (${control.pass} pass, ${control.fails} fail)`);
if (!control.ok || control.pass === null) {
  console.log(control.out.slice(0, 2000));
  process.exit(1);
}

const survived = [];
const unmatched = [];
let caught = 0;

for (const [id, desc, find, replace] of M) {
  const n = original.split(find).length - 1;
  if (n !== 1) {
    unmatched.push([id, n]);
    console.log(`UNMATCHED  ${id.padEnd(22)} matched ${n} times (expected 1) -- NOT A RESULT`);
    continue;
  }
  writeFileSync(path.join(WORK, "lib.mjs"), original.replace(find, replace));
  const r = runTests();
  if (r.ok) {
    survived.push([id, desc, find, replace]);
    console.log(`SURVIVED   ${id.padEnd(22)} ${desc}`);
  } else {
    caught++;
    // A mutant that fails with 0 assertion failures died of a syntax/load error, which proves
    // nothing about the tests. Name the first failing test so a catch can be spot-checked.
    const how = r.fails ? `${r.fails} failing: ${r.failed[0] ?? "?"}` : "NO ASSERTION FAILURE (load error?)";
    console.log(`caught     ${id.padEnd(22)} (${how})`);
  }
}

console.log(`\n=== ${caught} caught / ${M.length - unmatched.length} applied / ${M.length} written ===`);
if (unmatched.length) console.log(`UNMATCHED (harness errors, not passes): ${unmatched.map(([i, n]) => `${i}:${n}`).join(", ")}`);
if (survived.length) {
  console.log(`\nSURVIVORS -- each needs hand-checking for equivalence:`);
  for (const [id, desc, find, replace] of survived) {
    console.log(`\n  ${id}: ${desc}\n    -  ${find}\n    +  ${replace}`);
  }
}
