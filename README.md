# self-learn

Reflects at every yield to the user and proposes durable lessons as skills.

Inspired by oh-my-pi's auto-learn controller, reimplemented as a GitHub Copilot CLI extension.
Companion to [`advisor`](../advisor).

## How it works

The review runs **on request**, not on a timer: either the user asks, or the agent calls
`self_learn_now` when it judges a substantive piece of work finished. Screening every yield was
tried first and was too aggressive — most yields are mid-conversation, not task boundaries.

It also reviews automatically when the agent calls the built-in `task_complete` tool, which emits
`session.task_complete`. That is the agent's own declaration that a task is done, and so the most
precise trigger available. The tool is not enabled in every mode, so this may never fire; when it
does not, nothing is lost. Disable with `screenOnTaskComplete: false`.

```
review requested  (user asks, or the agent calls self_learn_now at task completion)
      ▼
STAGE 1 — screener sub-agent (cheap model, own context)
  input: main-agent transcript window + inventory of existing skills
  output: {"worthLearning", "target": "new"|"refine"|"extend", "skill", "rationale"}
      │
      ├─ false ──► done. The common case.
      │
      ▼
STAGE 2 — drafter sub-agent (own context)
  input: the same transcript + the screener's verdict + the existing skill, when extending
  output: {"section", "description", "body"} — or {"decline"}
  retried up to DRAFT_ATTEMPTS times, each retry carrying the validator's complaint.
      │
      ▼
STAGE 3 — approval, raised from the `onAgentStop` hook
  session.ui.confirm(), then write + skills.reload()
```

Set `autoScreen: true` to additionally review automatically at every yield with at least
`minToolCalls` tool calls.

**Both stages are sub-agents, and the main agent is not involved in learning at all.** This is a
deliberate reversal of the original design, in which the extension injected a `[self-learn]` message
into the main agent's conversation and asked it to draft the skill. That worked, but the cost was
structural: the main agent's context was spent on reflection, its transcript was polluted with a
message the user never sent, and the injected turn could itself be screened. Because the runtime's
only mechanism for making the main agent act is a user message — the `onAgentStop` block path calls
`enqueueUserMessage` internally — injection could never be made cleaner, only avoided. So it is
avoided.

The tradeoff paid for that: a drafter reading a transcript does not have the main agent's own
reasoning, so drafts may be weaker than they were. The retry loop and the `extend` mode are what
compensate.

Approval is raised from the **`onAgentStop` hook**, which fires while the turn is still live —
measured at 2.6s before `session.idle`. An elicitation raised after the turn has ended leaves the
host UI stuck showing "running"; see "The approval dialog must stay inside a turn" below. A
consequence worth knowing: screening happens after the turn that produced the work, so the dialog
appears at the end of the *following* turn.

### What `onAgentStop` actually does here

Measured against this host rather than assumed, because the documentation and the behaviour differ:

| Question | Result |
|---|---|
| Does the hook fire? | Yes — `stopReason=end_turn`, 2.6s before `session.idle`, turn still live |
| Is the transcript supplied? | Yes, `transcriptPath` — on main-agent stops only |
| Can a sub-agent be started inside it? | **Yes**, 9ms — unlike a tool handler, where it wedges the CLI |
| Can an elicitation be raised inside it? | **Yes**, resolved cleanly, no UI wedge |
| Does it fire for sub-agents too? | **Yes**, despite documenting itself as top-level only |
| Does it survive `extensions_reload` mid-turn? | No — that turn's stop is lost |

The last two matter most. A sub-agent's stop arrives with `input.sessionId` set to that agent's own
`bg-<uuid>` while `invocation.sessionId` stays the main session id, so `isMainAgentStop` compares
against the main id and drops the rest. Without that filter the extension's own screener and drafter
would each trigger a stop, and self-learn would be running against sub-agents — the exact bug this
extension was first written to fix.

## The rubric

The screener does **not** return a verdict. It answers five criteria independently, and the
extension computes the outcome — so it cannot reach "worth learning" by asserting a conclusion.

| Criterion | Test |
| --- | --- |
| `surprising` | Contradicts what a competent engineer would have assumed. |
| `expensive` | Not knowing it demonstrably cost something in this transcript. |
| `undiscoverable` | Could not have been found in the obvious docs or type definitions. |
| `transferable` | Applies to a future session on a different task. |
| `uncovered` | No existing skill already says this. Same subject, new case passes — see below. |

All five must pass. `expensive` additionally requires a **verbatim quote from the transcript**,
at least 24 characters, which the extension checks against the transcript it actually sent. An
invented or paraphrased quote is rejected — that turns "trust me, it cost something" into a
mechanically checkable fact, and it is the criterion that separates real lessons from
plausible-sounding observations.

Anything malformed — a missing criterion, a non-boolean `pass`, no JSON at all — rejects. Failing
safe here is cheap: rejection means no skill, and the review can simply be run again.

Rejections report which criteria failed, e.g. `failed: surprising, expensive, undiscoverable,
uncovered`, which is what makes the bar tunable rather than mysterious.

### Refusals are remembered

Turning a proposal down used to leave no trace. The screener's only sense of what is already
covered is the list of **installed** skills, so a refused lesson stayed invisible, passed
`uncovered` again the next time similar work happened, and could come back indefinitely.

Refusals now go to `~/.copilot/self-learn/declined.json`, which the screener is shown. It lives
outside any workspace deliberately: the case that actually bites is the same lesson resurfacing in
a *different* repo weeks later, which a per-workspace file would never see.

It is context for the screener, not a block in code, because a refusal is ambiguous — it can mean
"bad draft" or "bad subject". A materially different lesson still passes. The two sources are
weighted differently:

| Refused by | Treated as |
| --- | --- |
| the user | binding — raise it again only if it is a genuinely different lesson |
| the agent | a strong prior the transcript can overcome if the lesson is now better supported |

Agent declines are recorded because otherwise the screener reaches the same verdict next time and
spends another unrequested escalation turn on it. Repeat refusals of one name are counted rather
than duplicated, and the count is what the screener weighs.

`self_learn_now action:"declines"` lists the ledger and names the file, so a refusal recorded in
error can be undone.

### Skills that grow: `extend`

A skill is retrieved by its one-line `description` and then loaded **whole**. That single fact
decides the shape of everything here. Splitting one subject across five narrow skills means five
descriptions competing to be matched, five entries in the list every session pays for, and
interlocking lessons that only help if they happen to arrive together. So a lesson about a subject
an existing skill already owns is better added *to* that skill than filed beside it.

Criterion 5 therefore passes when a skill covers the same subject but not yet this case. The
screener returns a `target`:

| `target` | Means |
| --- | --- |
| `new` | nothing covers this subject yet |
| `refine` | an existing skill says something and it is **wrong** |
| `extend` | an existing skill is right, and this is a case it does not cover |

`extend` exists rather than reusing `refine` because of how they differ mechanically, not
stylistically. `refine` requires the model to reproduce the entire body; every reproduction is a
chance to silently drop an earlier lesson, and the only evidence is a `.bak` nobody reads. Over a
dozen growths that erosion is close to certain. Under `extend` **no model ever emits the existing
text**: the agent writes only the new section, and the extension appends it. The prior bytes are
carried across in code, so accumulation cannot erode.

The invariant is tested directly — after repeated growth the previous file is an exact byte prefix
of the new one. (Writing this caught a real defect: the frontmatter parser leaves a leading newline
behind, which was being re-added on every append and would have grown a blank line per extend.)

Two deliberate exceptions:

- **The `description` may broaden.** An umbrella that accretes cases its description never
  mentions stops being retrieved, which would defeat the point. It changes only when explicitly
  supplied, and the dialog shows it as a `from:` / `to:` diff, so widening is something the user
  approves rather than something that happens quietly.
- **A duplicate section heading is refused**, case-insensitively, with nothing written. Two
  sections with one title is how a skill starts contradicting itself; if the existing section is
  wrong, that is what `refine` is for.

The size cap is checked against the **assembled** file, not the new section, so a skill cannot grow
past `maxSkillBytes` one acceptable-looking addition at a time.

### Which skills actually get read

The screener marks skills your instruction files name, and prefers extending those.

This is measured, not assumed. Across 411 recorded skill invocations for one user, every personal
skill with real usage was one their `copilot-instructions.md` named by hand:

| Personal skill | Invocations | Named in instructions |
| --- | --- | --- |
| verification-before-completion | 21 | yes |
| adversarial-code-review | 17 | yes |
| kql-expert | 16 | yes |
| repository-ramp-up | 13 | yes |
| systematic-debugging | 9 | yes |
| architecture-design | 7 | yes |
| safe-secret-fixtures | 0 | yes — narrow trigger, never came up |
| gitignore-anchor-roots | 0 | **no** |
| install-python | 0 | **no** |

The runtime's own skill list is filtered per session, so an unnamed skill is offered only when it is
judged relevant — and a narrow one may never be. That makes a newly written narrow skill close to
write-only. The same lesson appended to a skill the instructions already name is reachable
immediately, which is the strongest argument for `extend` over `new`.

Two honest limits. Being named does not guarantee use — `safe-secret-fixtures` proves that — so the
marker reads `[IN USER'S INSTRUCTIONS]`, not "always loaded". And the unnamed skills are also
narrower, so scope is a confound; the signal is suggestive, not conclusive.

Instruction files scanned: `~/.copilot/copilot-instructions.md`, `~/.github/copilot-instructions.md`,
`<cwd>/.github/copilot-instructions.md`, `<cwd>/AGENTS.md`, plus anything in `instructionFiles`.
A name counts as referenced if it appears backticked, or — for compound names only — as a whole
word. One-word skills like `review` or `commit` need the backticks, since otherwise any prose about
reviewing or committing would mark them.

## Safety

- A skill may ship **supporting files** beside `SKILL.md` — usually a script, since a check that
  can be *run* is worth more than a paragraph describing the check. This is the one path by which
  the extension writes executable content, so it is fenced in on both sides:
  - Paths must be relative and at most three levels deep, and every segment must match
    `^[A-Za-z0-9][A-Za-z0-9._-]*$`. Starting alphanumeric rules out `..`, `.` and dotfiles in one
    test rather than by enumerating cases; drive letters, UNC prefixes, leading `/`, duplicate
    paths and `SKILL.md` itself are rejected separately.
  - The resolved path is re-checked against the skill's own directory immediately before writing,
    because a proposal can be persisted, edited on disk, and restored between validation and use.
  - Body and files share one byte budget, so splitting content across files cannot evade
    `maxSkillBytes`.
  - The approval dialog **shows the file contents**, not just their names, and says plainly that a
    future agent may run them. Truncation is marked so nothing goes silently unseen.
  - Files are added or overwritten; an existing file the proposal does not list is left alone.
    Nothing is ever deleted.
- The agent **cannot write skills itself** — it submits a draft through `propose_skill`, and the
  extension writes only after explicit approval.
- **Writes never leave the personal skills root.** New skills are created under it; a `refine` or
  `extend` resolves the target's actual path from `rpc.skills.list()` and is **rejected** if that
  path lies outside the root. Plugin and bundled skills live in caches and install directories that
  updates overwrite, and are never modified. Resolving a refine against the personal root instead
  would silently create a shadow copy competing with the real skill, so neither shortcut is safe.
- Skill names must match `^[a-z0-9][a-z0-9-]{0,63}$`, which rejects `../`, `..\`, `/`, and `.`;
  the resolved directory is additionally checked to be inside the root.
- A `refine` or `extend` naming a skill that does not exist is rejected, rather than silently
  degrading into creating a new skill under an unexpected name. Both this and the containment check
  run at submission time, so the agent can pick a different name rather than failing at approval.
  `extend` additionally does a dry-run append when the proposal is submitted, so a duplicate
  heading or unparseable frontmatter surfaces while the agent can still fix it.
- Frontmatter values are collapsed to a single line, so a crafted name or description cannot
  inject extra YAML keys or terminate the block.
- Any existing `SKILL.md` is copied to `SKILL.md.bak` before being replaced — keyed on the file
  existing, not on the declared mode, so a `new` proposal colliding with an existing skill is
  still recoverable and is labelled as an overwrite. Supporting files are backed up the same way.
- The approval dialog shows the exact file to be written.
- The user's hand-written `~/.copilot/copilot-instructions.md` is never touched.
- Refining a skill that is **disabled** in settings is detected and surfaced in the approval
  dialog, since the write would otherwise silently have no effect.
- A pending proposal **survives an extension reload**. It is written to the session workspace and
  restored on load, because extensions are re-forked on reload and on `/clear` — and a second
  session editing these files triggers reloads this session does not control. On restore it is
  re-validated (the file is editable on disk) and discarded if older than 12 hours.
- The proposal is **retained until an explicit decline or a successful write**. A confirm
  exception or a failed write keeps it for another attempt rather than destroying the draft;
  after 3 failed attempts it is discarded so it cannot re-prompt forever.
- **The transcript is treated as untrusted input.** Instruction-shaped text inside it is not
  authority. Tool arguments named `prompt` or `message` are redacted — for agent-spawning tools
  (`task`, `write_agent`) their value is literally an instruction to another agent — and the
  screener prompt states that only `USER:` lines carry the user's requirements. Not theoretical:
  the companion `advisor` extension, which lacks this, issued a false `blocker` after reading a
  prompt sent to a probe sub-agent as though it were a user requirement.
- **Nothing runs for a sub-agent task.** Both tools refuse a caller that is a `task`-tool
  sub-agent, a sub-agent's opening prompt does not overwrite the goal or release a held proposal,
  and the per-turn tool-call counter skips sub-agent calls. See the runtime finding below.

**Topical relevance is not enforced in code.** Whether a lesson genuinely belongs in the skill
being refined is a judgement, guided by the screener prompt and checked by the user at approval.
The code enforces only existence, containment, and format. A screener can and does mistarget:
in testing it proposed filing a lesson about extension command surfaces into an unrelated
canvas-authoring skill.


## Install

```powershell
# Windows
New-Item -ItemType Junction `
    -Path "$env:USERPROFILE\.copilot\extensions\self-learn" `
    -Target "C:\src\self-learn"
```

```bash
# macOS / Linux
ln -s ~/src/self-learn ~/.copilot/extensions/self-learn
```

Then `/extensions reload`.

The whole directory has to be linked, not just `extension.mjs`: it imports `./lib.mjs`, which holds
the pure core.

### Tests

```
npm test
```

`node --test`, built into Node — the repo has no dependencies, which matters here because
`node_modules` would otherwise appear inside a directory the CLI loads as an extension.

`extension.mjs` ends with a top-level `await joinSession(...)`, so importing it from a test would
try to connect to the host. Everything worth testing is therefore in `lib.mjs`, which touches no
session, config, or disk: byte budgets are passed in rather than read from config. The tests cover
what has real invariants — that the rubric cannot be talked past, that a quote is checked against
the transcript, that writes cannot escape the skill directory, that frontmatter cannot be broken out
of, and that repeated extends keep the previous file as an exact byte prefix.

### What the tests are worth, measured

A green suite is not evidence that the tests would catch anything. The only way to find out is to
break the code on purpose and see whether they notice, so 42 deliberate regressions were injected
into `lib.mjs` one at a time and the suite run against each.

```
npm run mutate
```

The harness is `mutate.mjs`, committed so these numbers can be re-checked rather than believed.
Mutants are keyed to exact source strings, so a change to `lib.mjs` that stops one matching is
reported as `UNMATCHED` and excluded from the tally instead of quietly counting as a catch.

The first pass caught **32 of 42**. The ten survivors were each checked by hand rather than
tallied, and nine were real gaps, now closed:

- A `toolu_…` sub-agent stop was never tested. `isMainAgentStop` is documented as comparing for
  equality precisely because a `bg-` prefix test would let every `task`-tool sub-agent through —
  and replacing the equality with exactly that prefix test passed the whole suite. The most
  carefully explained invariant in the file was the one nothing checked.
- An over-long body was unbounded when a proposal had no `files`, because `validateSkillFiles`
  returns early in that case and the shared-budget test only ever exercised the path with files.
- A verdict naming no skill, a non-string file content, an unbounded file count, a missing body,
  an unenforced `sanitize` limit, a brace inside a quoted string, and a `---` rule in a body that
  a greedy frontmatter match would swallow.

The tenth is an equivalent mutant: removing the `id === ""` check in `isMainAgentStop` changes no
behaviour, because the only case where it could decide anything requires an empty main session id,
which the next line already refuses. Confirmed against 126 input pairs rather than argued.
The second pass catches **41 of 42**, the exception being that mutant.

Two things make this measurement lie, and both look exactly like success:

- **A mutation that does not apply.** If the text being replaced is not in the source, nothing is
  mutated and the suite passes for the wrong reason. Every mutation here asserts it matched
  exactly once and is reported as `UNMATCHED` rather than counted if it did not.
- **A misparsed result.** The first run of this harness reported every mutant as a crash, because
  it parsed TAP's `# fail 0` while Node's default reporter prints `ℹ fail 0`. The tally was right
  by luck — the exit codes were real — but a harness that cannot read its own output is not
  evidence. It now runs `--test-reporter tap` and names the first failing test for every catch, so
  a claimed kill can be spot-checked against the assertion that made it.

One design note that follows from this: a test must not recompute the limit it is pinning.
`too many files are refused` writes out `11` rather than deriving it from `MAX_SKILL_FILES`,
because a test that derives the bound moves with it and would survive the constant being raised.

That last one is not decoration. The helpers were previously verified by extracting them from the
source with string offsets, and the extraction was fragile enough that a real defect got through:
`appendSection` re-added a leading newline every call, so a skill grew a blank line per extend.

## Configuration

First match wins: `$COPILOT_SELF_LEARN_CONFIG`, `<cwd>/.github/self-learn.json`,
`~/.copilot/self-learn.json`, built-in defaults.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. |
| `write` | `true` | When false, screen and log only — never escalate or write. |
| `autoScreen` | `false` | Also review automatically at every qualifying yield. Off by default. |
| `screenOnTaskComplete` | `true` | Review when the agent calls the built-in `task_complete` tool. |
| `minToolCalls` | `5` | Only used when `autoScreen` is on. |
| `skillsRoot` | `null` | Skills directory. `null` derives it from the runtime's own skill paths. |
| `maxSkillBytes` | `65536` | Rejects oversized drafts. |
| `screenerModel` | `gpt-5.6-terra` | Model for stage 1. Should differ from other extensions' models — see below. |
| `agentType` | `explore` | Built-in agent type. Only `explore`, `task`, `general-purpose`, `rubber-duck`, `code-review`, `research`, `security-review` are dispatchable. **Do not use `rubber-duck`** — see below. |
| `minToolCalls` | `5` | Turns with fewer tool calls are not worth screening. |
| `maxTranscriptChars` | `120000` | Cap on the transcript sent to the screener. When it binds, the head and tail are kept and the middle is elided. |
| `maxToolResultChars` | `1200` | Per-tool-result truncation. |
| `timeoutMs` | `180000` | How long to wait for the screener. |
| `logToTimeline` | `true` | Surface hits in the session timeline. |
| `debugLog` | `~/.copilot/logs/self-learn.log` | Trace file. `null` disables. |
| `instructions` | `""` | Extra project-specific screening instructions. |
| `instructionFiles` | `[]` | Extra instruction files to scan for skill names, beyond the standard locations. |

## Commands and tools

Extension slash commands only surface in the CLI's TUI. **The GitHub Copilot app does not show
them**, so the same functionality is also exposed as a tool the agent can call, which works on
both surfaces.

| Tool | Purpose |
| --- | --- |
| `self_learn_now` (`action: "review"`) | Queue a screening for the end of the turn; escalate on a hit. |
| `self_learn_now` (`action: "status"`) | Counters and pending-proposal state. |
| `self_learn_now` (`action: "discard"`) | Drop the pending proposal without writing it. |
| `self_learn_now` (`action: "events"`) | Which session event types have actually been delivered. |
| `self_learn_now` (`action: "declines"`) | Lessons already refused, and the ledger's path. |
| `propose_skill` | Propose a skill for approval. Usable at any time, by the user's agent directly. |

In the CLI TUI these are also available as slash commands:

| Command | Purpose |
| --- | --- |
| `/learn` | Status: cadence, turns screened, hits, writes, pending proposal. |
| `/learn-now` | Screen recent activity, and escalate if there is something to learn. |
| `/learn-discard` | Drop the pending proposal without writing it. |
| `/learn-events` | Dump which event types are actually delivered to extensions. |
| `/learn-on` / `/learn-off` | Toggle for this session. |

## Runtime findings

These were established empirically and are why the code looks the way it does.

**The screener's agent type biases its verdict.** The first version dispatched the screener as
`rubber-duck`, whose built-in persona is *"a constructive critic… focuses on identifying weak
points… and suggesting substantive improvements"*. That is a reasonable reviewer and a poor
rejection gate: asked whether anything is worth learning, it is disposed to find something.
Measured **5 hits in 7 screenings** before this was changed, against a prompt that explicitly said
false should be the common answer. The screener now runs as `explore`, which carries no critical
persona, and the prompt states a hard rubric rather than soft guidance.

The wider lesson: the `agentType` passed to `startAgent` is not just a tool allowlist. It carries
a system persona that shapes the answer, so pick one whose disposition matches the task.

**An extension's tools are offered to sub-agents, and its tool descriptions read to them as
instructions.** A `task`-tool sub-agent sees `self_learn_now` and `propose_skill` in its own tool
list — confirmed by asking a `code-review` sub-agent to name which of them it could see. Since
`self_learn_now`'s description says to call it "when you have just FINISHED a substantive piece of
work", every sub-agent that finishes work is being told to call it. Observed: a code-review
sub-agent finished its review, called it, and dragged the spawning session into a screening and an
escalated reflection turn.

Nothing here is meant to run for a subtask — the screener reads only main-agent activity, and only
the main agent has the context to draft a skill from its own reasoning — so sub-agent calls are
refused outright.

`ToolInvocation` carries no agent identity (only `sessionId`, `toolCallId`, `toolName`,
`arguments`), so the caller is resolved through the event log instead: `tool.execution_start` and
`external_tool.requested` carry an `agentId` that is present for sub-agents and absent for the main
agent, alongside a `toolCallId` that matches the invocation's.

*The ordering is the trap.* The SDK invokes a tool handler from inside its own dispatch of
`external_tool.requested`, synchronously **before** that event reaches the extension's listeners,
so a naive lookup always misses. Awaiting a single `setTimeout(…, 0)` lets the listener record the
call first, which makes the check ordered rather than racy. Verified with a throwaway
session-scoped extension: a main-agent call resolves to MAIN, a `code-review` sub-agent's call to
SUBAGENT.

One adjacent path had the same blind spot: the `onPostToolUse` /
`onPostToolUseFailure` hooks fire for sub-agent tool calls while carrying no agent identity, so a
turn's tool-call count was inflated by sub-agent activity — enough to push a turn past
`minToolCalls` and auto-screen on its own. The counter now reads `tool.execution_start`, where
`agentId` is available.

*Testing note:* a session-scoped extension whose **directory name** matches an installed user
extension is silently skipped. Give a test copy a distinct directory name and rename its tools, or
it will look like it loaded when the installed version is what actually ran.

**A sub-agent's opening prompt is dispatched to `onUserPromptSubmitted` like the user's own.**
This is the same class of bug as the tool exposure above but a worse one, because it corrupts state
rather than merely wasting a turn. `state.goal` was overwritten by every subtask's brief — including
this extension's *own* screener prompt, since the screener is started as an agent — while
`state.toolCallsThisTurn` was reset mid-turn and a proposal deliberately held back until the user
next spoke was released early. Measured over one real session: 20 `userPromptSubmitted` dispatches,
only 5 of them actually the user.

Hook payloads carry no agent identity, but hook dispatches are still attributable. The event log
brackets each one in `hook.start` / `hook.end` events that **do** carry `agentId`, correlated by
`hookInvocationId`, and `hook.start` reaches the extension before the handler runs (verified with a
throwaway probe: `hook.start` arrived 1.1 s ahead, and the dispatch resolved to SUBAGENT). Since the
main agent and a sub-agent can be inside the same hook type concurrently, the open brackets are
matched on the prompt itself rather than on hook type alone. Attribution deliberately **fails open**
— an unattributable dispatch is treated as the user's, which preserves behaviour instead of silently
disabling the extension.

`session.idle` and `session.task_complete` were checked for the same exposure and do not have it:
across a full session, no event of either type ever carried an `agentId`. See below for the wider
scan of `session.task_complete`.

**`session.task_complete` comes from a built-in tool, not from sub-agents.** `task_complete`
appears in the SDK's `BuiltInTools.Isolated` list alongside `ask_user`, `exit_plan_mode` and
`task`; the event is emitted when the agent calls it. Measured: a full RPC-started sub-agent
lifecycle and a `task`-tool sub-agent both completed without emitting it, across a 42-type
delivered-event tally. It is therefore a genuine "the agent declares itself done" signal, but only
in modes where that tool is enabled.

On the evidence available it does **not** fire per sub-agent, and no observed occurrence carried an
`agentId`. Scanned across every
`events.jsonl` under `~/.copilot/session-state`: 8 `session.task_complete` events in total, none of
which has an `agentId` key on the envelope at all (`keys=type,data,id,timestamp,parentId`). Each
sits immediately before `assistant.turn_end`, with `data.summary` holding the main agent's final
answer. The decisive case is one session with **43 `subagent.started` events and exactly one
`session.task_complete`**, at a main-agent turn end. The handler's `agentId` check is therefore a
no-op rather than a working guard; it is kept only because the tool's availability per agent type is
not a stable guarantee, and it costs nothing. **Do not build a real sub-agent guard on it.**
`subagent.completed` is the event that actually signals sub-agent completion, and it does carry
`agentId`, alongside `toolCallId`, `agentName`, `totalToolCalls`, `totalTokens` and `durationMs`.
(Caveat: 8 events is thin evidence, and most of those logs predate the current CLI. The
43-to-1 session is the strongest single data point, not a proof across SDK versions.)

**`session.idle` is the only correct yield signal.** Measured over one turn: `session.idle` = 1,
`assistant.idle [MAIN]` = 1, `assistant.turn_end [MAIN]` = 10. `turn_end` fires per agentic
round, not per yield. `session.idle` is preferred over `assistant.idle` because it additionally
waits for background work to settle, so the transcript is complete.

*Measurement trap:* idle fires only **after** a yield, so it can never be observed from inside the
turn doing the observing. An earlier probe concluded "`session.idle` never fires" purely as an
artifact of reading the log mid-turn. Any trigger measurement must span a turn boundary.

**Sub-agent replies must be read from `TaskAgentInfo.latestResponse`.** `tasks.list()` reports the
sub-agent as `idle` but leaves `result` permanently `null`. `latestResponse` is keyed by the task
id the extension already owns, making correlation exact.

**Do not correlate sub-agents through the event log.** An observed `subagent.started` payload:

```
agentName=rubber-duck  model=claude-opus-5  toolCallId=bg-1785663120104
agentDescription="A constructive critic for proposals, designs, …"
```

- `agentDescription` is the agent *type's* built-in blurb, **not** the `description` passed to
  `startAgent`.
- `agentName` is the type, identical across extensions using the same type.
- the event's `toolCallId` equals `agentId` (`bg-…`), unrelated to the task's `toolCallId`.

So `model` is the only discriminator available in the event log, which is not enough: the advisor
extension, this extension, and the main agent's own sub-agents all emit the same events. Matching
"the first sub-agent started after my baseline" can silently claim another consumer's reply. The
event-log path is retained only as a fallback and now requires a positive model match rather than
guessing.

## The review hang (CLI regression, worked around)

Starting a screener sub-agent from **inside a tool handler** wedges the CLI. The extension finishes
normally — it computes the verdict and emits `external_tool.completed` — but the CLI then emits
nothing at all: no `postToolUse` hook, no `tool.execution_complete`, no `assistant.turn_end`. The
turn hangs until the user aborts.

Every `self_learn_now action:"review"` call on this machine, reconstructed from
`~/.copilot/session-state/*/events.jsonl` by matching `tool.execution_start` against
`tool.execution_complete` on `toolCallId`:

| Date | Screener spawned? | Calls | CLI processed the result? |
| --- | --- | --- | --- |
| 2026-08-02 ×3, 2026-08-03 ×1 | yes | 4 | yes |
| 2026-08-04 08:52, 2026-08-05 06:22 | no | 2 | yes |
| 2026-08-04 08:56, 13:33; 2026-08-05 06:03, 08:10, 08:26, 09:50 | yes | 6 | **no — hung** |

Two facts make this a CLI regression rather than an extension bug:

- The split is clean, 6 completed against 6 hung, and both conditions are needed to hang: a screener
  sub-agent **and** a date on or after 2026-08-04. Reviews that returned without spawning a screener
  were unaffected.
- The extension source did not change between `ec60ad6` (2026-08-02 15:48) and `e0d992f`
  (2026-08-05 11:11). That interval contains the 2026-08-03 success and all six hangs, so identical
  code both worked and hung. The Copilot SDK under
  `%LOCALAPPDATA%\Programs\GitHub Copilot\copilot-sdk` was reinstalled on 2026-08-04.

A same-window symptom points at the likely mechanism: extension-started sub-agents now surface in
the **main agent's** notification stream ("agent *N* has finished processing and is now idle") while
`read_agent` cannot resolve them. The CLI appears to have begun tracking extension-spawned agents in
the session's background-agent registry, which would plausibly leave the tool call's bookkeeping
waiting on an agent the extension has already disposed of. That last step is inference, not
measurement — the request id never appears in any `~/.copilot/logs/process-*.log`. The
notification half of that symptom is now addressed on its own terms; see *Cancelling the screener*
below.

**Workaround.** `self_learn_now action:"review"` no longer screens. It sets `state.reviewRequested`
and returns immediately; `session.idle` runs the screen once the turn has ended and escalates
through the same deferred `session.send` an automatic screening uses. No sub-agent is ever alive
while a tool call is open. The observable difference is that a forced review's reflection now
arrives on the next turn rather than as the tool's own result.

This should be reverted if the CLI stops wedging, since the in-handler version gave the verdict a
turn earlier.

## Getting text in front of the user

**In the GitHub Copilot app, extension output currently does not render at all — and this is a
regression in the app, which has happened before.** Asaf filed it as
[github/app#2765](https://github.com/github/app/issues/2765), *"Extensions who send `info` or
`warning` level logs are not shown in the app"*, on Aug 11 at 12:57:14 against app `1.1.6`. It was
closed COMPLETED and the release bot confirms it was **fixed in app v1.1.8** on Aug 12. The app here
is now **1.1.10** and the symptom is back.

That issue was filed in the same minute as the advisor concern banner recorded at `12:57:22` in this
session's transcript — i.e. it was filed *because* one of these very messages failed to appear.

Component attribution is **isolated by measurement**, not inferred. The same CLI binary (`1.0.80`)
running this same extension, invoked as `copilot -p "..."` in a plain terminal, prints

```
● self-learn ready — review on request, and automatically after >=5 tool calls
```

to stdout. Same CLI, same extension, same non-ephemeral `session.log` — renders in the terminal,
does not render in the app. So the CLI and this code are both fine and the app is the failing layer.
That test costs one command and no witness; it should have been the *first* thing run, and instead
it came after a fresh-session probe, a live-watched probe, and four wrong hypotheses.

Nothing in the 1.1.9 or 1.1.10 release notes names it; the nearest suspects are 1.1.10's transcript
changes ("background items and queued message management … enabled by default").

Measured, from a probe that parked a line and flushed it from a real main-agent stop, plus a fresh
session created solely to vary the one dimension nobody had varied:

| Emitted from | `ephemeral` | Renders? |
|---|---|---|
| extension load, resumed session | yes | no |
| extension load, resumed session | no | no |
| extension load, **fresh session** | no | no |
| extension load, **user watching live** | no | no |
| extension load, **plain terminal CLI 1.0.80** | no | **yes** |
| `onAgentStop`, live turn | yes | no |
| `onAgentStop`, live turn | no | no |
| `session.idle` | no | no |
| inside an open tool call | no | no |

Every row but one shares a confound worth naming: the witness was asked *after* the fact. The app
has had an "Announcement duration" setting since v1.0.24 that auto-dismisses notifications, so "I
see nothing" and "it appeared and vanished" are the same observation to a witness questioned a
minute later — the error `advisor` caught in its own first test, and then this side repeated it in
every probe above. The fourth row removes it: Asaf watched the window live, was told the reload was
coming, and reported nothing appeared at all, not even a flash.

The first row used to read **yes**, on the assumption that the init banner is what users see. It was
never witnessed. The `advisor` extension broke it by forcing a post-init `report()` (setting
`timelineLevel: "error"`, documented to be coerced back to `info` and reported at startup),
reloading, and asking with no intervening tool call: no banner. This side then created a fresh
session — ruling out "resumed sessions are stale", since this one has been resumed since Aug 5 and
started on CLI `1.0.78-2` — and the banner did not render there either, on `1.0.80`.

Bracketing: `session.info` events are present in transcripts throughout, and Asaf saw them at some
earlier point. The earliest measured *invisible* one here is the non-ephemeral announcement at
`09:21:21` on Aug 18. So the regression predates every fix attempted in this repo.

**The lesson is about attribution, not about logging.** Four hypotheses were burned trying to find
the mistake in this extension's code, and a whole sweep was committed on the fourth, because "the
user cannot see the output" was assumed to mean "the extension emits it wrongly". The host was
never treated as a suspect, even though the transcript had shown all along that the messages were
being emitted and recorded exactly as intended. When output is correct at every layer you control,
suspect the layer you do not.

Consequences while it lasts: a **hit** is announced by the approval dialog (`session.ui`, which does
still work), and a **miss** is not announced. The announcement path is deliberately *kept* rather
than deleted, because the mechanism is correct and worked before app v1.1.10 — it will work again.

### What `ephemeral: true` actually does

Measured directly, with a throwaway extension that emitted one line each way in the same run, under
the terminal CLI where rendering still works:

| | renders in CLI | survives redraw | `session.info` event |
|---|---|---|---|
| `session.log(text)` | yes | yes — present in 10 frames | **yes** |
| `session.log(text, { ephemeral: true })` | yes | no — present in 2 frames | **no** |

So it is not inert and it is not a "don't show this" flag: it means **transient**. The line is drawn
and then dropped, and nothing is written to `events.jsonl`. That is a coherent feature — a status
message you do not want cluttering a transcript — and it is simply the wrong choice here, where the
whole point is a record the user can find afterwards.

An earlier version of this section claimed the flag "does not affect rendering". That was wrong, and
wrong the same way as everything else in this saga: asserted from the app, where *nothing* renders,
so the flag looked inert because its effect was masked by the regression. It took the CLI — the one
host where rendering works — to see what it does at all.

The consequence for this repo is unchanged: **the flag is passed nowhere.** A non-ephemeral
`session.log` writes a `session.info` event with `infoType: "notification"`; an ephemeral one writes
nothing. Measured on this session's own transcript: every user-facing message up to `10:51:12` is
present, and after the sweep added `ephemeral: true` there are none — the `11:13:12` announcement,
which the debug log proves was emitted, left no event behind. Removing the flag brought the record
straight back (`11:34:09`, then `11:41:11` in a fresh session).

So the sweep destroyed the only machine-readable record of what the extension had told the user, and
bought transience nobody wanted. While the app is regressed the transcript is the only read-back
channel there is.

**To check whether the app has been fixed**, rather than trusting this document:

```powershell
# does the extension still emit? (should always be yes)
Select-String -Path "$env:USERPROFILE\.copilot\session-state\<session-id>\events.jsonl" `
  -Pattern '"type":"session\.info"' | Select-Object -Last 5

# does a host still render it? (CLI = yes; app = the thing under test)
copilot -p "Reply with exactly: ok" --allow-all-tools
```

If the event is present and the app shows nothing, github/app#2765 is still broken. Guidance that
says how to check does not rot when the answer changes.

Earlier reasoning error worth keeping, since it is a different one: `ephemeral: true` correlated
perfectly with visibility because the only call passing it was also the only call made during init.
A confounded variable. The advisor extension flagged exactly that risk ("based only on correlation
with the startup message; startup timing is also different") and recommended testing one ephemeral
log from `onAgentStop` before changing anything. That advice was correct and was not taken until
after the sweep.



**Severity must never be carried in `level`.** This one is unrelated to rendering and applies
everywhere. The host turns any `session.error` whose `errorType` is not `model_call` into a
*terminal* fault: it sets `hasError`, stops autopilot with reason "error", and marks the session
failed. Four call sites here logged failed drafts at `level: "error"`, so reporting that a draft
could not be written could end the session it was reporting to. This is the same defect the
companion `advisor` extension found and fixed; severity now lives in the message text.

Note also that this host loads extension **tools and hooks but not slash commands**, so `/learn`
and the other commands below are unreachable from the app and can only be used from the CLI.

## The approval dialog must stay inside a turn

`session.ui.confirm` is an MCP elicitation. Raising one **after** the turn has ended puts the app
into a "running" state it can never leave: the elicitation makes it show activity, but there is no
turn left to end and no event an extension can emit to clear it.

This was measured, not guessed. Approval was originally raised from `session.idle`:

```
07:49:11.384  assistant.turn_end          ← turn already over
07:49:13.216  hook.end sessionEnd         ← session wound down
07:49:13.231  session.usage_checkpoint    ← last event before the gap
    ~5 min    dialog shown; user approves
07:54:11.653  session.info "wrote ...SKILL.md"
              (nothing after — no turn_start, no turn_end)
```

The extension side was provably correct: the approval resolved, the file was written, the pending
proposal was cleared. The UI stayed stuck anyway, and had to be stopped by hand. The same happened
on decline, so it is a property of *when* the dialog is raised, not of the answer given.

**Fix (superseded).** The first fix moved the dialog into `propose_skill`'s own tool call, so it
belonged to a turn the host could finish. That worked and was verified on the same path.

**Fix (current).** The dialog is now raised from the `onAgentStop` hook instead. The rule is
unchanged — the elicitation must resolve while a turn is live — but `onAgentStop` was measured to
fire 2.6s *before* `session.idle`, with the turn still open, so it satisfies the rule without
requiring the main agent to call a tool at all. That is what allowed the main agent to be removed
from the flow entirely.

The original reason for deferring — that `session.idle` fires as the user regains the keyboard, so
a dialog there could land on a reply being typed — is why the `session.idle` approval fallback has
now been removed outright rather than kept as a backstop. A proposal restored from disk after a
reload is therefore shown at the next `onAgentStop`, not immediately.

Note this is the opposite constraint to the review hang above: a **sub-agent** must not be started
inside a tool handler, while an **elicitation** must be raised inside a live turn. `onAgentStop` is
the one place measured to permit both.

## Cancelling the screener to keep it out of the main agent's context

The screener is a real background agent, so the CLI announced each one to the **main** agent as
"agent has finished". The main agent would then call `read_agent` on it and get *read self learn
agent failed*, because `runScreener` had already removed the task. The user saw the error; the
agent, correctly, concluded no such agent existed.

`startAgent` has no way to opt out. `TasksStartAgentRequest` is `{agentType, prompt, name,
description?, model?}` — there is no quiet flag. But the CLI's own completion callback has three
early exits, and one is reachable from an extension:

```js
if (s.status === "cancelled") { ...; return }              // ← no notification
if (s.factoryRunId === void 0 && !s.activeBlockingReads) { sendBackgroundAgentCompletionNotification(s) }
```

`factoryRunId` and `activeBlockingReads` are CLI-internal. Cancellation is not. So the screener is
now cancelled the moment its verdict is parseable, rather than being left to finish and announce
itself. Across 61 recorded runs the verdict message precedes `subagent.completed` by 1.6–4.8 s
(median ~2.0 s), so the window is comfortable rather than a race worth being clever about.

**Every sub-agent needs its own recogniser, and forgetting that reintroduces the bug.** Cancelling
early depends on noticing that the reply has arrived, and "has it arrived" is a question about the
*shape* of the message. The recogniser was originally hard-coded to the verdict shape. When the
drafter was added it inherited none of the suppression: its reply is a draft, not a verdict, so it
was never recognised, never cancelled, and ran to completion — at which point the CLI announced
"Agent self-learn-1 has finished" to the main agent, which then called `read_agent` and got nothing.
Observed live at 08:57:33, one turn after the drafter shipped. `runScreener` now takes a `recognise`
predicate (`looksLikeVerdict` or `looksLikeDraft`), so a new sub-agent cannot silently opt out of
suppression by having a different reply shape.

**Identity is the hard part, and cost two failed runs.** There are two id namespaces:
`startAgent` returns a *task* id derived from `name` (`self-learn-1`), while the event log tags the
same agent `bg-<uuid>`. They are never equal, and `cancel`/`remove` accept only the former.
Correlation therefore has to come from the events, and `subagent.started` turned out to carry the
agent **type's** metadata, not ours:

```
agentName        = explore
agentDisplayName = Explore Agent
agentDescription = Fast codebase exploration and answering questions...
```

The `description` passed to `startAgent` appears nowhere in the event, so matching on
`"Self-learn screening"` could never have worked. (The same dead match exists in
`readReplyFromEventLog`, which has always fallen through to its model check.) What remains —
`agentName` and `model` — is shared with the main agent's own `explore` sub-agents, and latching
onto a stranger would cancel our screener early and read someone else's message as the verdict.

The prompt is the one field only this extension could have produced, so identity comes from the
sub-agent's first `user.message` matching the head of the prompt just sent.

**Losing the race must stay harmless.** If completion wins, cancelling returns `{cancelled: false}`
and removal is skipped, because removal is exactly what invalidated the notification's attached
read in the first place. A lost race degrades to the old behaviour — one stray notification — not
to an error.

Verified live: `screener event id bg-ad286f0f-… (task id self-learn-1)` followed by `screener
cancelled on verdict (notification suppressed)`, and no completion notification reached the main
agent on that turn.

## Known limitations

- **Contention with `advisor`.** `session.idle` is deferred while background work is pending. An
  advisor running at a low cadence spawns sub-agents near-continuously, which could in principle
  defer idle past the point where the user replies, starving this extension's trigger. This is
  **hypothesised, not demonstrated** — an earlier empty log was misread as evidence for it when
  the build in question simply had no instrumentation on the idle path. Every early return now
  logs, so the next empty log will be meaningful.
- Stage 2 escalation calls `session.send`, which starts a **visible agent turn the user did not
  ask for**. Deferring the approval dialog does not hide that.
- `startAgent` accepts a `model` but no reasoning-effort override, so the screener runs at its
  model's default effort.
- A screening whose verdict arrives too late to cancel still emits one "agent finished"
  notification into the main agent's context.
- The extension loads per session, so several sessions screen independently.
- **Extension slash commands do not appear in the GitHub Copilot app**, only in the CLI's TUI.
  The `self_learn_now` tool exists to cover that gap.
