# Shaping what the agent is told

The agent's system prompt is not a constant — it is **assembled per turn** by
`systemPrompt()` in `src/turn.ts`, from layers that each answer a different
question. Knowing the layers is most of knowing where to put an instruction.

## The layers, in order

1. **Identity.** One paragraph: it is Daedalus Agent, an interactive coding
   agent, it should use tools rather than guess, and it should keep working
   until the task is done. A subagent gets a different first paragraph instead —
   it is on a delegated task and its final message is the whole report the
   caller sees.
2. **Situation.** Working directory, platform and host, today's date. Written
   fresh each turn, so a long conversation never argues about what day it is.
3. **Plan-mode addendum.** Only in `plan` mode: everything that writes is
   disabled, explore and propose, ask before changing anything. It is belt and
   braces — the write tools are genuinely absent in that mode, and this explains
   the absence rather than letting the model discover it by failing.
4. **Persona** — the whole contents of `DAEDALUS_AGENT_PERSONA_FILE`. This is
   the intended door for your own instructions, and it comes *after* the
   project's own files: the repo's rules are the ground, the persona is the
   choice made for this thread on top of them.
5. **Project instructions** — every `AGENTS.md`, `CLAUDE.md` and
   `CLAUDE.local.md` found from the cwd up to the repo root, plus
   `~/.claude/CLAUDE.md`. See below.
6. **Skills index.** One line per `.claude/skills/<name>/SKILL.md` found in the
   cwd: name, description, path, and a standing instruction to read the SKILL.md
   before relying on one. The bodies are not inlined — that is the point.
7. **MCP failures.** Any server that would not start, named, so the model knows
   why a tool it expected is missing instead of inventing a reason.

Nothing is prepended to the user's message. What you type is exactly what is
sent and exactly what is journaled — every instruction here rides in the system
prompt, which is why the transcript never has to be un-doctored on replay.

## Lever 1 — a persona (the main one)

In the harness, **Settings › Personas** is a library of prompt appends, and each
thread names one from its config menu (or the `⌘K` palette). The server writes
the chosen persona to `data/persona-prompts/<sessionId>.md` and passes the path
in `DAEDALUS_AGENT_PERSONA_FILE`; the agent reads it at session start and drops
it into layer 4. Changing a thread's persona respawns the agent, which is why it
lands on the existing conversation rather than a fresh one.

A persona carries three things, and this agent uses two of them:

| Field | Effect here |
| --- | --- |
| **Prompt** | appended to the system prompt — the whole of layer 4 |
| **Effort** | applied when the persona is picked, then it is yours to change |
| **Thinking budget** | **ignored** — it is Claude Code's extended-thinking axis, and this agent has no equivalent; use Effort |

Standalone, the same lever is the env var pointed at any markdown file:

```bash
DAEDALUS_AGENT_PERSONA_FILE=~/.config/daedalus/house-style.md
```

Which makes it a global system-prompt append rather than a per-thread one — the
same text, a different scope.

## Lever 2 — the files the repo already has

`AGENTS.md`, `CLAUDE.md` and `CLAUDE.local.md` are read automatically, so a repo
that already instructs other runtimes instructs this one too, with nothing to
configure. The rules of the scan:

- **The nearest file has the last word.** The walk goes cwd → parents, and the
  blocks are emitted outermost-first, so `packages/app/AGENTS.md` follows the
  monorepo root's.
- **The repo is the ceiling.** It stops at the directory holding `.git`. Above a
  checkout is somebody's home directory, and inheriting instructions from
  `~/src` is a surprise nobody asked for.
- **`~/.claude/CLAUDE.md` is included, first**, which makes it the weakest voice
  in the prompt — it is where "how I like things" lives, and everything the repo
  or the thread says outranks it.
- **Duplicates are read once.** `AGENTS.md → CLAUDE.md` as a symlink is deduped
  by real path; two files with identical content are deduped by content.
- **Each block is labelled with its path**, so a rule can be traced back to the
  file that set it — and so you can tell the agent to go and edit the right one.
- Clipped at 16k characters per file and 32k in total, and **re-read every
  turn**: edit `AGENTS.md` mid-session (or let the agent edit it) and the next
  turn already has it.

Turn the whole layer off with `DAEDALUS_AGENT_PROJECT_INSTRUCTIONS=0`.

## Lever 3 — skills, for instructions that are too long to always send

A persona is paid for on every single request. A skill is paid for only when the
model decides it is relevant: the index line costs a few tokens, the body costs
nothing until it reads the file. Anything over a paragraph or two — a review
checklist, a deploy runbook, the schema of some awkward internal format —
belongs in a skill.

```
<project>/.claude/skills/release/SKILL.md
```

```markdown
---
description: How this repo cuts a release. Use when asked to release, tag or publish.
---

1. …
```

The `description` is the whole basis on which the model decides to open it, so
write it as *when to use this*, not as a title. In the harness these are library
rows linked by a profile or a thread and symlinked into the cwd for you; a
hand-written directory works identically.

## Lever 4 — commands, for instructions you invoke

```
<project>/.claude/commands/review.md
```

Typing `/review src/turn.ts` sends the file's body with `$ARGUMENTS` replaced
(or the arguments appended, when the body names no placeholder). Use this for a
task you want to trigger deliberately; use a skill for knowledge the model
should reach for on its own.

## Lever 5 — the base prompt itself

Layers 1 and 3 are string literals in `systemPrompt()` (`src/turn.ts`). If every
thread on every install should be told something, that is where it goes — but
prefer a persona for anything that is a preference rather than a fact about the
runtime, because source edits are invisible from the UI and survive no upgrade
argument.

The tool descriptions are the other half of the prompt in practice, and they are
where behaviour is most cheaply corrected: they live on each tool's `description`
in `src/tools/*.ts`, and the model reads them every turn. "Don't use `bash cat`
to read files" belongs in `read_file`'s description, not in your persona.

## Writing content that actually lands

- **Name the real tools.** They are `read_file`, `write_file`, `edit_file`,
  `bash`, `glob`, `grep`, `write_todos`, `ask_user`, `task`, and
  `mcp__<server>__<tool>`. An instruction about "the Edit tool" names nothing
  here.
- **Name the real modes.** `default`, `acceptEdits`, `bypassPermissions`,
  `plan`.
- **Say when, not just what.** "Run the tests after editing" is followed;
  "be careful" is not.
- **Don't re-legislate the permission system.** Whether a write is allowed is
  decided by the mode and the user's answer, not by the prompt; telling the
  model it may not edit files while it holds the edit tool only produces
  hedging.
- **Keep it short enough to be read every turn.** Layer 4 is on every request of
  every turn — a thousand-line persona is a tax on the whole conversation and is
  exactly what skills exist to avoid.

## What is still a source edit

The base prompt (layer 1) and the tool descriptions are not editable from the
UI, and deliberately so — they are what the runtime *is*, and a persona can
already say anything a preference needs to say. See [managing.md](./managing.md)
for the rest of what the harness can and cannot change about this agent.
