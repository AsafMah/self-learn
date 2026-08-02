# self-learn

Reflects at every yield to the user and proposes durable lessons as skills.

Inspired by oh-my-pi's auto-learn controller, reimplemented as a GitHub Copilot CLI extension.
Companion to [`advisor`](../advisor).

## How it works

```
session.idle  (fires exactly once per yield to the user)
      │  gate: not aborted, >= minToolCalls this turn
      ▼
STAGE 1 — screener sub-agent (cheap model, own context)
  input: main-agent transcript delta + inventory of existing skills
  output: {"worthLearning", "target": "new"|"refine", "skill", "rationale"}
      │
      ├─ false ──► done. The common case.
      │
      ▼
STAGE 2 — escalate to the main agent
  session.send(nudge) so it drafts the skill with full context of its own reasoning,
  then submits it by calling the `propose_skill` tool. The agent never writes the file.
      │
      ▼
STAGE 3 — deferred approval
  the proposal is HELD until the user has taken another turn, then confirmed via
  session.ui.confirm() at the following yield, and only then written + skills.reload()
```

The hybrid split exists because screening is cheap and almost always negative, while drafting a
good skill needs the main agent's own reasoning — which a sub-agent reading a transcript does not
have.

Approval is deferred by one user turn on purpose: `session.idle` fires exactly as the user regains
the keyboard, so confirming there would land the dialog on top of the reply they were about to
type.

## Safety

- The agent **cannot write skills itself** — it submits a draft through `propose_skill`, and the
  extension writes only after explicit approval.
- Skill names must match `^[a-z0-9][a-z0-9-]{0,63}$`, which rejects `../`, `..\`, `/`, and `.`;
  the resolved directory is additionally checked to be inside the skills root.
- Frontmatter values are collapsed to a single line, so a crafted name or description cannot
  inject extra YAML keys or terminate the block.
- `mode: refine` copies the previous file to `SKILL.md.bak` before overwriting.
- The user's hand-written `~/.copilot/copilot-instructions.md` is never touched; it is outside the
  skills root and unreachable by construction.
- Refining a skill that is **disabled** in settings is detected and surfaced in the approval
  dialog, since the write would otherwise silently have no effect.


## Install

```powershell
New-Item -ItemType Junction `
    -Path "$env:USERPROFILE\.copilot\extensions\self-learn" `
    -Target "G:\copilot-plugins\self-learn"
```

Then `/extensions reload`.

## Configuration

First match wins: `$COPILOT_SELF_LEARN_CONFIG`, `<cwd>/.github/self-learn.json`,
`~/.copilot/self-learn.json`, built-in defaults.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. |
| `write` | `true` | When false, screen and log only — never escalate or write. |
| `skillsRoot` | `null` | Skills directory. `null` derives it from the runtime's own skill paths. |
| `maxSkillBytes` | `65536` | Rejects oversized drafts. |
| `screenerModel` | `gpt-5.6-terra` | Model for stage 1. Should differ from other extensions' models — see below. |
| `agentType` | `rubber-duck` | Built-in agent type. Only `explore`, `task`, `general-purpose`, `rubber-duck`, `code-review`, `research`, `security-review` are dispatchable. |
| `minToolCalls` | `5` | Turns with fewer tool calls are not worth screening. |
| `maxTranscriptChars` | `24000` | Cap on the transcript slice sent to the screener. |
| `maxToolResultChars` | `1200` | Per-tool-result truncation. |
| `timeoutMs` | `180000` | How long to wait for the screener. |
| `logToTimeline` | `true` | Surface hits in the session timeline. |
| `debugLog` | `~/.copilot/logs/self-learn.log` | Trace file. `null` disables. |
| `instructions` | `""` | Extra project-specific screening instructions. |

## Commands

| Command | Purpose |
| --- | --- |
| `/learn` | Status: cadence, turns screened, hits, writes, pending proposal. |
| `/learn-now` | Force a screening of recent activity. |
| `/learn-discard` | Drop the pending proposal without writing it. |
| `/learn-events` | Dump which event types are actually delivered to extensions. |
| `/learn-on` / `/learn-off` | Toggle for this session. |

## Runtime findings

These were established empirically and are why the code looks the way it does.

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
- Every screening emits an "agent finished" system notification into the main agent's context.
- The extension loads per session, so several sessions screen independently.
