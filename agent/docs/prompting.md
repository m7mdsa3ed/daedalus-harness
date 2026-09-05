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

`AGENT.md`, `AGENTS.md`, `CLAUDE.md` and `CLAUDE.local.md` are read
automatically, so a repo that already instructs other runtimes instructs this
one too, with nothing to configure. The singular `AGENT.md` is opencode's
spelling and is listed for the same reason the plural is — this harness's own
rules file is one, and a name the scan does not know is a file the agent alone
cannot see. The rules of the scan:

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
- Clipped at 48k characters per file and 80k in total — generous because a
  repo that wrote its rules down at length meant them, and cheap because the
  blocks sit ahead of the system prompt's one volatile line and are therefore
  cached after the first step. A clip is **announced** in the block, naming the
  file and how much is missing, so a truncated rulebook does not read as a
  complete one.
- **Re-read every turn**: edit `AGENTS.md` mid-session (or let the agent edit
  it) and the next turn already has it.

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

## Why the base prompt talks about not re-reading

Layer 1 carries a "Working from what you already have" section, and it earns its
place because the cost of ignoring it compounds. Every step of a turn re-sends
the whole conversation; a file read a second time is not only paid for twice,
it is *new* text at the tail of the prompt, which is exactly the part no prefix
cache can serve. A loop that re-reads what it already has both spends more and
caches less, and the effect grows with the session.

So the rule is stated where it is cheapest to follow — in the prompt as "the
conversation is your memory, don't fetch twice", and again on `read_file`'s own
description, which the model reads next to the call it is about to make. Both
say the same thing and both name the escape hatch: a file you edited, or a file
compacted out of view, is read again. "Don't fetch twice" is never "answer from
a memory you do not have".

## What the tools recover from, so the prompt need not

A failed tool call costs a whole round trip: the model reads an error, re-reads
the schema and guesses again, and the guess is often the same one. The runtime
therefore fixes deterministically everything that has exactly one right answer,
and only reports what is genuinely ambiguous.

- **A tool call is repaired before it is emitted** (`src/tools/repair.ts`, wired
  as `streamText`'s `repairToolCall` in both loops). Four shapes are fixed
  without asking the model: another harness's tool name (`Read`, `Edit`,
  `functions.Bash`, an MCP tool named by a leaf that is unique), another
  harness's parameter name (`file_path`, `old_str`, `cmd`, `regex`), arguments
  encoded twice or wrapped in `{input: …}` or a markdown fence, and a scalar
  where the schema wants a number, a boolean or an array. A repair that cannot
  satisfy the schema returns null and stays an ordinary tool error — never a
  silent guess at a *missing* argument.
- **Two calls merged into one arguments buffer keep the first.** A provider
  that streams a second tool call into the first one's argument deltas produces
  `{"path":"a"}{"path":"b"}` — valid JSON followed by more valid JSON, which
  `JSON.parse` rejects whole and which used to cost an `AI_InvalidToolInputError`
  per occurrence. The parse is a string-aware scan for the *first* complete
  value, so trailing prose or a second object is dropped rather than fatal, and
  what was dropped is written to stderr. The second call is the model's to
  reissue: it sees only the first one answered.
- **`read_file` numbers its lines** (`cat -n`), states the range it showed and
  the offset to continue from, and answers a binary or empty file in a sentence
  rather than with nothing. The numbering is what makes an edit copyable; the
  prefix is stripped again by `edit_file`, which is cheaper than trusting the
  model not to paste it.
- **`edit_file` matches with tolerance, and explains itself when it cannot.**
  An `old_string` still carrying line-number prefixes, differing only in
  trailing whitespace, or re-typed at a different indentation is matched
  anyway — but only when the recovered match is *unique*, and the result says
  which tolerance was used. A real miss reports whether the file was never read
  or has changed since it was, and prints the closest lines with their numbers;
  an ambiguous one names the lines it found rather than only counting them.
- **`write_file` refuses to overwrite a non-empty file this session never
  read.** One read is the whole cost of not losing a file's worth of work.
- **A search that found nothing says why it might have.** A mistyped `glob`
  root and an unreadable `grep` path are errors, not empty answers; a pattern
  with no slash is matched against the basename too, because `*.ts` never means
  "only at the root" to a model.
- **Session state backs all of this**: `Session.readFiles` (path → mtime at
  read) is what tells "written from memory" from "someone else changed it".

Everything above lives in the tools, not in the prompt, because the prompt is
advice and the tool is the thing that happens.

## What is still a source edit

The base prompt (layer 1) and the tool descriptions are not editable from the
UI, and deliberately so — they are what the runtime *is*, and a persona can
already say anything a preference needs to say. See [managing.md](./managing.md)
for the rest of what the harness can and cannot change about this agent.
