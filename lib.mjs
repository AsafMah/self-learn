// Pure helpers, kept out of extension.mjs so they can be tested.
//
// extension.mjs ends with a top-level `await joinSession(...)`, so importing it from a test would
// try to connect to the CLI host. Everything here is therefore free of session, config, and
// filesystem access: values the extension knows (byte budgets) are passed in as arguments rather
// than read from `cfg`. This is the code with real invariants — what may be written where, and
// what counts as a verdict — so it is the code worth a test.

// The verdict is computed from these in code, not reported by the model, so it cannot shortcut
// to "yes" by asserting a conclusion. Every criterion must pass.
export const RUBRIC_CRITERIA = ["surprising", "expensive", "undiscoverable", "transferable", "uncovered"];

// The `expensive` criterion must cite a verbatim line from the transcript, which is then checked
// against the transcript actually sent. A quote short enough to match by accident proves nothing.
export const MIN_QUOTE_CHARS = 24;

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// A skill may ship supporting files beside SKILL.md — most usefully a script, since a check that
// can be RUN is worth more than a paragraph describing the check. These are written into the
// skill's own directory and nowhere else.
//
// Each segment must start alphanumeric, which rules out `..`, `.`, and dotfiles in one test
// rather than by enumerating the cases to reject.
export const SKILL_FILE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const MAX_SKILL_FILES = 10;
export const MAX_SKILL_FILE_DEPTH = 3;

// A section title becomes a markdown heading and is matched against existing headings to catch a
// lesson being appended twice, so it stays plain text: no newlines, no leading "#".
export const SECTION_TITLE_RE = /^[A-Za-z0-9][A-Za-z0-9 ._'(),:\/-]{2,79}$/;

// Extracts balanced top-level JSON objects, ignoring braces inside strings. The previous
// non-greedy regex could not handle the nested `criteria` object.
export function extractJsonObjects(raw) {
    const text = String(raw).replace(/```(?:json)?/gi, "");
    const found = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === "\\") {
            escaped = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (inString) continue;

        if (ch === "{") {
            if (depth === 0) start = i;
            depth++;
        } else if (ch === "}") {
            depth--;
            if (depth === 0 && start >= 0) {
                found.push(text.slice(start, i + 1));
                start = -1;
            }
        }
    }
    return found;
}

export const normaliseForMatch = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

// Screener output eventually reaches the main agent's context, so treat it as untrusted.
export function sanitize(text, limit) {
    if (typeof text !== "string") return "";
    let clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").trim();
    clean = clean.replace(/<\/?(system|instructions?|advisor|self-learn)>/gi, "");
    if (/ignore (all )?(your |the )?(previous|prior|above) instructions/i.test(clean)) return "";
    return clean.slice(0, limit);
}

// The model reports evidence per criterion; the verdict is computed here. This is the point of
// the design: the screener cannot reach "worth learning" by asserting a conclusion, only by
// passing every criterion, one of which requires a quote that is checked against the transcript.
export function parseVerdict(raw, transcript) {
    const reject = (reason) => ({ worthLearning: false, target: "new", skill: "", rationale: "", reason });

    const candidates = extractJsonObjects(raw);
    if (candidates.length === 0) return reject("no JSON object in screener reply");

    let parsed;
    for (const candidate of candidates.reverse()) {
        try {
            const obj = JSON.parse(candidate);
            if (obj && typeof obj === "object" && obj.criteria) {
                parsed = obj;
                break;
            }
        } catch {
            // Keep looking for a well-formed object.
        }
    }
    if (!parsed) return reject("screener reply had no criteria object");

    const failed = [];
    for (const name of RUBRIC_CRITERIA) {
        const c = parsed.criteria?.[name];
        if (!c || typeof c.pass !== "boolean") return reject(`criterion "${name}" missing or malformed`);
        // The screener's own reason is carried through: a bare list of failed criterion names
        // cannot distinguish a rubric that is working from one that is misjudging, which left an
        // earlier run of rejections uninvestigable. Whitespace is collapsed to keep the debug log
        // one entry per line.
        if (!c.pass) {
            const why = sanitize(c.why, 200).replace(/\s+/g, " ").trim();
            failed.push(`${name} (${why || "no reason given"})`);
        }
    }
    if (failed.length > 0) return reject(`failed: ${failed.join("; ")}`);

    // Every criterion claims to pass, so the quote backing "expensive" must hold up.
    const quote = parsed.criteria.expensive?.quote;
    if (typeof quote !== "string") return reject("expensive passed without a quote");

    const q = normaliseForMatch(quote);
    if (q.length < MIN_QUOTE_CHARS) {
        return reject(`quote too short to be evidence (${q.length} < ${MIN_QUOTE_CHARS} chars)`);
    }
    if (!normaliseForMatch(transcript).includes(q)) {
        return reject("quote does not appear in the transcript");
    }

    const skill = sanitize(parsed.skill, 80);
    if (!skill) return reject("no skill name given");

    return {
        worthLearning: true,
        target: ["refine", "extend"].includes(parsed.target) ? parsed.target : "new",
        skill,
        rationale: sanitize(parsed.rationale, 600),
        reason: "all criteria passed with verified evidence",
    };
}

// Accepts exactly what `parseVerdict` accepts, so the screener is never cut off on a message the
// parser would then reject.
// Whether a sub-agent message is a finished draft, in the same sense `looksLikeVerdict` recognises
// a finished verdict: enough to cancel on, before the host emits a completion event.
//
// This must exist separately. Cancelling early is what suppresses the CLI's "agent has finished"
// notification to the main agent, and a drafter's reply is not verdict-shaped, so recognising only
// verdicts leaves every drafter running to completion and announcing itself.
export function looksLikeDraft(text) {
    if (typeof text !== "string") return false;
    for (const candidate of extractJsonObjects(text)) {
        try {
            const obj = JSON.parse(candidate);
            if (!obj || typeof obj !== "object") continue;
            if (obj.decline === true) return true;
            if (typeof obj.body === "string" && obj.body.trim()) return true;
        } catch {
            // Keep looking for a well-formed object.
        }
    }
    return false;
}

export function looksLikeVerdict(text) {
    if (typeof text !== "string") return false;
    for (const candidate of extractJsonObjects(text)) {
        try {
            const obj = JSON.parse(candidate);
            if (obj && typeof obj === "object" && obj.criteria) return true;
        } catch {
            // Keep looking for a well-formed object.
        }
    }
    return false;
}

// Rejects anything that is not a plain relative path inside the skill directory, and returns the
// path in normalised form. Callers still re-check the resolved path against the directory before
// writing: this is a filter on what the agent may ask for, not the last line of defence.
export function normaliseSkillFilePath(raw) {
    if (typeof raw !== "string" || raw.trim() === "") return { error: "file path missing" };
    const path = raw.trim().replace(/\\/g, "/");

    if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
        return { error: `"${raw}" must be relative to the skill directory` };
    }
    if (/^SKILL\.md$/i.test(path)) {
        return { error: `SKILL.md is written from "body", not from "files"` };
    }

    const segments = path.split("/").filter((s) => s !== "");
    if (segments.length === 0) return { error: `"${raw}" is not a usable path` };
    if (segments.length > MAX_SKILL_FILE_DEPTH) {
        return { error: `"${raw}" is nested deeper than ${MAX_SKILL_FILE_DEPTH} levels` };
    }
    for (const segment of segments) {
        if (!SKILL_FILE_SEGMENT_RE.test(segment)) {
            return { error: `"${raw}" contains an unusable path segment "${segment}"` };
        }
    }
    return { path: segments.join("/") };
}

export function validateSkillFiles(p, maxSkillBytes) {
    if (p.files === undefined || p.files === null) {
        p.files = [];
        return null;
    }
    if (!Array.isArray(p.files)) return "files must be an array";
    if (p.files.length > MAX_SKILL_FILES) {
        return `too many files (${p.files.length} > ${MAX_SKILL_FILES})`;
    }

    const seen = new Set();
    const normalised = [];
    for (const entry of p.files) {
        if (!entry || typeof entry !== "object") return "each file needs a path and content";
        const { path, error } = normaliseSkillFilePath(entry.path);
        if (error) return error;
        if (typeof entry.content !== "string") return `"${path}" has no content`;

        const key = path.toLowerCase();
        if (seen.has(key)) return `"${path}" is listed twice`;
        seen.add(key);
        normalised.push({ path, content: entry.content });
    }

    // Budgeted together with the body: what matters is the total a future session pays to load
    // the skill, not how it was split across files.
    const total = normalised.reduce(
        (n, f) => n + Buffer.byteLength(f.content, "utf8"),
        Buffer.byteLength(p.body ?? "", "utf8"),
    );
    if (total > maxSkillBytes) {
        return `body and files total ${total} bytes, over maxSkillBytes (${maxSkillBytes})`;
    }

    p.files = normalised;
    return null;
}

export function validateProposal(p, maxSkillBytes) {
    if (!p || typeof p !== "object") return "proposal missing";
    if (!SKILL_NAME_RE.test(p.name ?? "")) {
        return `invalid skill name "${p.name}" (expected kebab-case, <=64 chars)`;
    }
    if (p.mode !== "extend" && (!p.description || typeof p.description !== "string")) {
        return "description required";
    }
    if (!p.body || typeof p.body !== "string") return "body required";
    if (Buffer.byteLength(p.body, "utf8") > maxSkillBytes) {
        return `body exceeds maxSkillBytes (${maxSkillBytes})`;
    }
    if (p.mode !== "new" && p.mode !== "refine" && p.mode !== "extend") {
        return `invalid mode "${p.mode}"`;
    }
    if (p.mode === "extend" && !SECTION_TITLE_RE.test((p.section ?? "").trim())) {
        return `mode "extend" needs a plain-text "section" title of 3-80 characters`;
    }
    return validateSkillFiles(p, maxSkillBytes);
}

export function renderSkillFile(p) {
    // Frontmatter values are single-line; strip anything that could break out of them.
    const oneLine = (s) => s.replace(/\r?\n/g, " ").replace(/"/g, "'").trim();
    return `---\nname: ${oneLine(p.name)}\ndescription: ${oneLine(p.description)}\n---\n\n${p.body.trim()}\n`;
}

// Which installed skills the user's own instructions point at.
//
// Measured, not assumed: across 411 recorded skill invocations, every personal skill with real
// usage was one named in the user's instructions, while personal skills that were merely installed
// sat at or near zero. Being named is not a guarantee of use — one named skill in that sample was
// never invoked either, because its trigger simply never came up — but it does mean the agent is
// told the skill exists in every session, whereas an unnamed skill depends on the runtime choosing
// to surface it.
//
// A bare substring match is not enough: a skill called `review` or `commit` would match ordinary
// prose. A backticked mention is how these lists are actually written, and an unbackticked mention
// is trusted only for compound names, which are distinctive enough not to collide with prose.
export function referencedSkillNames(text, names) {
    const found = new Set();
    if (typeof text !== "string" || text === "") return found;

    for (const name of names) {
        if (typeof name !== "string" || name === "") continue;
        if (text.includes("`" + name + "`")) {
            found.add(name);
            continue;
        }
        if (!name.includes("-")) continue;
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`(^|[^\\w-])${escaped}([^\\w-]|$)`).test(text)) found.add(name);
    }
    return found;
}

// Parses the drafter sub-agent's reply into a proposal.
//
// The mode and target skill are deliberately taken from the screener's verdict rather than from
// the drafter's reply: letting the drafter choose them would let it quietly create a new skill
// when the screener had decided to extend an existing one, which is exactly the accumulation of
// narrow write-only skills that extending exists to avoid.
export function parseDraft(raw, verdict) {
    const candidates = extractJsonObjects(raw);
    if (candidates.length === 0) return { error: "no JSON object in drafter reply" };

    let parsed;
    for (const candidate of candidates.reverse()) {
        try {
            const obj = JSON.parse(candidate);
            if (obj && typeof obj === "object" && (typeof obj.body === "string" || obj.decline)) {
                parsed = obj;
                break;
            }
        } catch {
            // Keep looking for a well-formed object.
        }
    }
    if (!parsed) return { error: "drafter reply had no proposal object" };

    if (parsed.decline === true) {
        return { decline: true, reason: sanitize(parsed.reason, 300) || "(no reason)" };
    }

    return {
        proposal: {
            mode: verdict.target,
            name: verdict.skill,
            // Sanitized generously rather than to the validator's limit: truncating to exactly the
            // maximum would turn an over-long title into a silently passing one, where letting it
            // fail validation sends the drafter a correction it can act on.
            section: sanitize(parsed.section, 120),
            description: sanitize(parsed.description, 1000),
            body: typeof parsed.body === "string" ? parsed.body : "",
            files: parsed.files,
            why: verdict.rationale,
        },
    };
}

// Whether an `onAgentStop` hook firing belongs to the main agent.
//
// The hook documents itself as top-level only, but measured behaviour disagrees: a sub-agent's
// stop arrives with `input.sessionId` set to that agent's own `bg-<uuid>` while
// `invocation.sessionId` stays the main session id. Without this guard the extension's own
// screener and drafter would each trigger another stop, and self-learn would once again be
// running against sub-agents.
export function isMainAgentStop(input, mainSessionId) {
    const id = input?.sessionId;
    if (typeof id !== "string" || id === "") return false;
    if (typeof mainSessionId !== "string" || mainSessionId === "") return false;
    return id === mainSessionId;
}

export const headingKey = (s) => s.replace(/^#+\s*/, "").replace(/\s+/g, " ").trim().toLowerCase();

export function splitFrontmatter(text) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
    if (!match) return null;
    return { frontmatter: match[1], body: text.slice(match[0].length) };
}

// Appends a section to an existing skill without any model rewriting what is already there.
//
// This is the whole point of extending rather than refining: a refine asks the agent to reproduce
// the complete body, and every reproduction is a chance to quietly drop or water down an earlier
// lesson. Here the existing bytes are carried across verbatim by the extension, so a skill can
// accumulate cases over time without eroding.
export function appendSection(existingText, p) {
    const parts = splitFrontmatter(existingText);
    if (!parts) {
        throw new Error(`"${p.name}" has no frontmatter block, so it cannot be extended safely.`);
    }

    const existingHeadings = (parts.body.match(/^#{1,6} .*$/gm) ?? []).map(headingKey);
    if (existingHeadings.includes(headingKey(p.section))) {
        throw new Error(
            `"${p.name}" already has a section called "${p.section}". ` +
                `Use mode "refine" to correct it, or pick a title for what is genuinely new.`,
        );
    }

    // Only the description line is reissued, and only when the proposal supplies a new one: as a
    // skill accumulates cases, its one-line description has to broaden or the skill stops being
    // retrieved for the cases it just gained.
    const description = p.description?.trim();
    const frontmatter = description
        ? parts.frontmatter.replace(
              /^description:.*$/m,
              `description: ${description.replace(/\r?\n/g, " ").replace(/"/g, "'")}`,
          )
        : parts.frontmatter;

    // Trimmed, not merely right-trimmed: the frontmatter match leaves a leading newline behind,
    // which would otherwise be re-added on every extend and accumulate blank lines. This also
    // makes the result byte-identical to what renderSkillFile produces for the same body.
    const body = parts.body.trim();
    return `---\n${frontmatter}\n---\n\n${body}\n\n## ${p.section.trim()}\n\n${p.body.trim()}\n`;
}
