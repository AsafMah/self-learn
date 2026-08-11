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
  output: {"worthLearning", "target": "new"|"refine", "skill", "rationale"}
      │
      ├─ false ──► done. The common case.
      │
      ▼
STAGE 2 — the main agent drafts the skill
  it has full context of its own reasoning, and submits via the `propose_skill` tool.
  The agent never writes the file.
      │
      ▼
STAGE 3 — approval
  session.ui.confirm(), then write + skills.reload()
```

Set `autoScreen: true` to additionally review automatically at every yield with at least
`minToolCalls` tool calls.

Approval happens **inside the `propose_skill` tool call**, not at the next yield. An elicitation
raised after the turn has ended leaves the host UI stuck showing "running" — see "The approval
dialog must stay inside a turn" below.

The hybrid split exists because screening is cheap and almost always negative, while drafting a
good skill needs the main agent's own reasoning — which a sub-agent reading a transcript does not
have.

## The rubric

The screener does **not** return a verdict. It answers five criteria independently, and the
extension computes the outcome — so it cannot reach "worth learning" by asserting a conclusion.

| Criterion | Test |
| --- | --- |
| `surprising` | Contradicts what a competent engineer would have assumed. |
| `expensive` | Not knowing it demonstrably cost something in this transcript. |
| `undiscoverable` | Could not have been found in the obvious docs or type definitions. |
| `transferable` | Applies to a future session on a different task. |
| `uncovered` | No existing skill already addresses the subject. |

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
- **Writes never leave the personal skills root.** New skills are created under it; a `refine`
  resolves the target's actual path from `rpc.skills.list()` and is **rejected** if that path
  lies outside the root. Plugin and bundled skills live in caches and install directories that
  updates overwrite, and are never modified. Resolving a refine against the personal root instead
  would silently create a shadow copy competing with the real skill, so neither shortcut is safe.
- Skill names must match `^[a-z0-9][a-z0-9-]{0,63}$`, which rejects `../`, `..\`, `/`, and `.`;
  the resolved directory is additionally checked to be inside the root.
- A `refine` naming a skill that does not exist is rejected, rather than silently degrading into
  creating a new skill under an unexpected name. Both this and the containment check run at
  submission time, so the agent can pick a different name rather than failing at approval.
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
| `propose_skill` | Used by the agent to submit a draft. Rejected outside a reflection. |

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

**Fix.** `propose_skill` now confirms and writes inside its own tool call, so the dialog belongs to
a turn the host can finish. Verified on the same path: `external_tool.requested` → dialog →
approval → write → `external_tool.completed` → `tool.execution_complete` → `assistant.turn_end`,
and the indicator cleared itself.

The original reason for deferring — that `session.idle` fires as the user regains the keyboard, so
a dialog there could land on a reply being typed — no longer applies, because during an open tool
call the user is already waiting on the agent. `state.forcedReflection` and the one-turn hold it
controlled are gone. `session.idle` still resolves a proposal restored from disk after a reload, or
one whose dialog could not be shown at the time.

Note this is the opposite constraint to the review hang above: a **sub-agent** must not be started
inside a tool handler, while an **elicitation** must be raised inside one.

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
