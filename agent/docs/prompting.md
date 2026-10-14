# Shaping what the agent is told

The agent's system prompt is not a constant — it is **assembled per turn** by
`systemPrompt()` in `src/turn.ts`, from layers that each answer a different
question. Knowing the layers is most of knowing where to put an instruction.

## The layers, in order

1. **Identity and the base prompt.** One opening line — it is Daedalus Agent, a
   coding agent running in the Daedalus harness — followed by the sections that
   shape a turn, written in the Codex idiom: short `##` sections of terse
   bullets rather than shouted `IMPORTANT:` paragraphs. In order: *General*,
   *Personality*, *Responsiveness* (a one-line preamble before a batch of tool
   calls, which is not the same thing as preamble on a final answer),
   *Planning*, *Task execution*, *Code quality*, *Working efficiently*, *Testing
   your work*, *Reviews*, *Ambition vs. precision*, *Working from what you already
   have*, *Tool usage*, *Editing constraints* and *Git and workspace hygiene*,
   *Frontend tasks*, *Sharing progress updates*, *Presenting your work and final
   message*, and *Final answer structure and style guidelines*. A subagent gets a different
   first paragraph and none of this — it is on a delegated task and its final
   message is the whole report the caller sees.

   Two of those sections are calibrations rather than rules, and they are the
   ones to read before editing. **Planning** says to *skip* the todo list for
   the easiest quarter of tasks and never to write a single-step plan, where the
   text it replaced asked for one "VERY frequently"; a plan drawn for a
   one-line fix is noise in the transcript. **Ambition vs. precision** is the
   split between a greenfield task, where the agent should build the whole
   thing, and an existing codebase, where a drive-by refactor is a cost the
   user has to review.

   **Code quality** and **Reviews** are the pair taken from OpenAI's current
   Codex prompting guide (the starter prompt behind gpt-5.1-codex-max and
   gpt-5.3-codex). *Code quality* is the "deliver working code, not a plan" half:
   root cause over symptom, the repo's own conventions, no silent-failure error
   handling, honest types, DRY-by-search. *Reviews* is the review mindset that
   both upstream prompts carry — findings first and worst-first with file/line
   references, summary last, an explicit "no findings" when there are none — and
   which this prompt previously left to the model to improvise. The autonomy half
   of the same guide is folded into *Task execution* (bias to action, persist to
   the end, no turn that ends on a clarification unless truly blocked) and into
   *Planning* (reconcile the plan before finishing; a plan is a guide, not the
   deliverable). What was deliberately *not* taken is the guide's instruction to
   suppress all mid-turn narration: this harness draws progress in a live
   transcript, so *Responsiveness* and *Sharing progress updates* stand.

   **Working efficiently** is the "smart and fast" half of the base prompt, and
   every line in it is a cost the transcript measured: a step is a full round
   trip, so the section asks the agent to begin at the *decisive* read or search
   rather than a survey, to read the range a decision needs rather than the whole
   file, to batch independent calls into one message so their round trips
   overlap, to read a failure before repeating the call, and to add no helper it
   was not asked for. It is deliberately behavioural — it names no tool, since
   the two tool-shaped facts in it (prefer the native tool over its shell
   equivalent, and stop when a failed call repeats) are already carried by the
   *Tool usage* section and by the model family calibration, where a missing tool
   is a conditional rather than a lie. It is not one of the two *calibrations*
   above: nothing in it depends on the task being greenfield or small, so unlike
   **Planning** it is always in force.
2. **The engine under this agent.** Which model the thread is running on, and
   how that model is best driven — an assigned row from the model-prompt
   library, or the built-in family calibration, whichever applies. See below.
3. **The tool inventory and the rules for calling one.** The names of the
   tools this turn actually built, stated as exhaustive, followed by the four
   rules the transcripts say are worth stating: one complete arguments object
   per call, every required argument every time (`path` above all), prefer a
   path you have seen over one you reconstruct, and re-issue a call whose
   arguments came back unparseable rather than assuming it half-ran. The list
   is `Object.keys(tools)` at the call site, never a literal — see below.
4. **Plan-mode addendum.** Only in `plan` mode: everything that writes is
   *absent*, and the addendum names what is left rather than forbidding uses of
   what is gone. This is not belt and braces. The prompt this replaced listed
   read-only *policy* over a tool set with no shell in it — "use Bash ONLY for
   ls, git status, cat" — and the model that followed it called a tool that was
   never built and got a `NoSuchToolError` for its trouble.
5. **Persona** — the client's instructions: AIR's
   `_meta.jetbrains.air.customInstructions` on `session/new`/`load`/`resume`
   (the harness's rules and trailers), else the contents of
   `DAEDALUS_AGENT_PERSONA_FILE`. This is the intended door for your own
   instructions, and it comes *after* the project's own files: the repo's rules
   are the ground, this is the choice made for this thread on top of them.
6. **Project instructions** — every `AGENTS.md`, `CLAUDE.md` and
   `CLAUDE.local.md` found from the cwd up to the repo root, plus
   `~/.claude/CLAUDE.md`. See below.
7. **Skills index.** One line per `.claude/skills/<name>/SKILL.md` found in the
   cwd: name, description, path, and a standing instruction to read the SKILL.md
   before relying on one. The bodies are not inlined — that is the point.
8. **MCP instructions and failures.** Each connected server's `instructions`
   (how it wants its tools used), then any server that would not start, named, so
   the model knows why a tool it expected is missing instead of inventing a reason.
9. **Situation.** Working directory, platform and host, today's date. Written
   fresh each turn and pinned to the end so the volatile line is the one that
   breaks the prefix cache — everything above it is byte-identical across steps.

**The prompt may not name a tool the turn did not build.** `buildTools` is the
only thing that decides what exists — plan mode strips everything that writes,
a subagent loop strips `task`, a client that never claimed `elicitation.form`
strips `ask_user` — so `systemPrompt` is handed `Object.keys(tools)` and every
sentence that sends the model to a specific tool is written against it. That is
why the shell advice, the "run lint and typecheck" line, the editing
constraints and the "delegate the search" example are all conditional: a prompt
that recommends an absent tool is a `NoSuchToolError` the model cannot see
coming, and it was one of the failures this agent's own transcripts recorded.

Nothing is prepended to the user's message. What you type is exactly what is
sent and exactly what is journaled — every instruction here rides in the system
prompt, which is why the transcript never has to be un-doctored on replay.

## The model layer (auto-detect + assigned rows)

Layer 2 tells the agent what engine is under it and how to work with that
engine. Two halves, in precedence order:

**Assigned rows** — the model-prompt library (`model_prompts` in the harness,
materialized to one JSON file and handed to the runtime through
`DAEDALUS_AGENT_MODEL_PROMPTS_FILE`). A row matches by glob over the model id
(`gemini-2.5-pro` exact, `qwen*` family); this is the "this text, for that
model" surface the harness offers in Settings › Model prompts. The file is
re-read every turn, which is how a live model change swaps the guidance with
no respawn — and why a library edit reaches a running thread on its next pass.

The harness **seeds four built-in rows** (`server/src/model-prompts.ts`,
`SEED_MODEL_PROMPTS`) — DeepSeek, Google Gemini, Meta Muse Spark and Zhipu GLM —
under the same two-version rules as the built-in personas and agents: never over
a row you have edited, and never back after you delete one. Their `match` is
wrapped in `*` on both sides (`*deepseek*`) because the same engine arrives both
as `deepseek-v4-pro` and as `deepseek/deepseek-v4-pro` through a gateway; your
own longer pattern still wins, since the longest glob is the most specific.

**Built-in family calibrations** — the table in `src/model-prompts.ts`,
matched by substring when no row matches. Short, honest defaults about how a
family behaves through an OpenAI-compatible endpoint (e.g. Qwen: one tool call
per message; Gemini: lean answers; GPT: watch verbosity). The four families the
seeded rows cover are here too, as the answer for an install that deleted or
disabled a row. A row beats them,
always, and every family text here is something you can override with a library
row, which is the point of the rows.

The layer header always names the model id. A session whose model is empty
(a spawn that has not been told one yet) is told nothing, and the layer is
included for subagents as well as root turns — same engine, same calibration.

## Lever 1 — rules (the main one)

In the harness, **Settings › Rules** (global and per project) is this lever.
The server joins the rules with the thread's trailers and sends them as AIR's
`customInstructions` in the `_meta` of every `session/new`, `session/load` and
`session/resume` — the same key claude-agent-acp reads — and the agent
advertises `customInstructions` at `initialize` to say it will. A rules change
lands on the thread's next respawn, against the existing conversation.

Standalone (or from any ACP client that does not send the key), the same lever
is the env var pointed at any markdown file — the request's key outranks it:

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
  satisfy the schema returns null and stays an ordinary tool error.
- **Merged arguments are one failure with two halves, and salvage is scoped to
  the step.** A provider that streams parallel tool calls into one argument
  buffer produces two symptoms at once: a call that arrives as
  `{"path":"a"}{"path":"b"}` — valid JSON followed by more valid JSON, which
  `JSON.parse` rejects whole — and a *sibling* that arrives as `{}` or as a
  tail with its head missing. Together they were the largest single class of
  failed tool call in this agent's threads. So the buffer is **drained, not
  parsed**: every complete value comes out, this call takes the first one that
  satisfies its schema, and **what is left is held for the sibling that is
  about to ask for it**. A value is never carried across a step boundary — the
  calls whose arguments were merged were emitted together, and the step is
  identified by the message list it was prepared from.
- **A missing `path` is placed by evidence, never guessed.** `path` is the
  argument a model actually drops: it is writing the two long strings for an
  `edit_file` and forgets the short one, and the round trip that costs buys
  nothing, because the transcript already says which file. Resolution is
  ordered by how much it proves. Exactly one candidate — from the paths this
  attempt has named, or the session's read set — whose text *holds*
  `old_string` is not a guess but the only file the edit could have meant.
  Several hold it and it stays a plain error, because an edit landing in the
  wrong file is damage. None hold it and the most recently named file is used
  for `edit_file` and `read_file` only, where a wrong answer cannot succeed
  quietly: the edit refuses and says which file it looked in, which is the
  answer the model needed and the schema dump was not. `write_file` is never
  given a path it did not name.
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

The base prompt (the identity layer) and the tool descriptions are not editable from the
UI, and deliberately so — they are what the runtime *is*, and a persona can
already say anything a preference needs to say. See [managing.md](./managing.md)
for the rest of what the harness can and cannot change about this agent.
