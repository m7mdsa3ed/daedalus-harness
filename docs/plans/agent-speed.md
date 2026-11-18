# Plan: faster, more reliable agent runs (workflows, subagents, the Daedalus agent)

Status: **proposed**. Written from the post-mortem of workflow run
`c2114e15-72a6-4810-80d2-662948f38003` ("Implement browser panel and browser MCP", 2h10m to
its last step) and the diagnosis run `e4d52b83`. Every number below was measured from
`model_calls`, `wf_events` and the steps' transcripts. The 9router RTK filter, the largest
single cause of bad tool output, is already off (user, 2026-11-06), so it is not in this plan.

## What the run measured

| Sink | Critical-path minutes | Where it lives |
|---|---|---|
| Reasoning tokens (382k of 581k output on the path, ~170 tok/s) | ~55 | model / effort |
| mcpClient waited on mcpServer it did not need | ~26 | run design |
| A flaky `page.close()` hunt with no time limit | ~22 | run design |
| Tool output rewritten by RTK | ~20 | environment (**fixed**) |
| Time to first token (2.5-4.9 s per call, 292 calls) | ~19 | prompt size |
| Re-checking edits lost to a race | ~5 | agent runtime |
| Step startup (enqueued -> first model call) | 8.5-14.5 s per step | engine |

Per step, measured: thinking was **17-27%** of output on the light steps (spike, contract, docs)
and **66-72%** on the implementation steps. 31 single calls each produced **more than 5k
thinking tokens** (11 in mcpServer, 9 in mcpClient, 7 in panelServer), one of them 23.9k. Every
step ran on `cc/claude-opus-5-5` at `medium`, inherited from the parent, whatever it was doing.

## Goals

1. A tool call that reports success did what it says (no lost edits, no silent truncation).
2. A step spends thinking where the problem is hard, not on rediscovering what an earlier step
   already decided.
3. The workflow's critical path is the real dependency chain, not the order phases were written in.
4. Every child call carries the prompt it needs and nothing a reader-facing thread needs.

## Part A: correctness of the agent's own tools (agent runtime)

### A1. Serialise file writes per path (the lost-edit bug)

`agent/src/tools/fs-tools.ts`: `edit_file` reads the file (line ~337), **awaits
`checkPermission`**, then writes `newText` computed from the text it read before the wait. Two
`edit_file` calls in one response run in parallel, both read the old file, and the second write
erases the first; both answer "Edited ... at line N". The docs and verify steps hit it (6 batched
same-file edits).

- A per-absolute-path async mutex (a `Map<string, Promise<void>>` in the session's runtime),
  taken by `edit_file`, `write_file` and any other writer, around read -> match -> permission ->
  write -> mtime record.
- Inside the lock, read the file **after** the permission wait (the wait can be minutes long on a
  person's approval), so even a write from outside the agent is seen.
- Different paths still run in parallel; reads take no lock.
- Test (`agent/test/tools.test.ts`): two `edit_file` calls on one file, issued together with a
  permission stub that resolves the first one last; both edits must be on disk. One test for
  `write_file` racing `edit_file`.

### A2. Say when output was cut, every time

RTK hid that output was cut; our own tools must never do the same. Audit `bash.ts` (the
`truncated` flag), `read_file` (2000-line default) and `grep`/`glob` (`search.ts`) so that every
truncation ends with one line saying what was dropped and how to get it (`offset`, a narrower
pattern, `| tail`). Test per tool.

### A3. A write is verified by the tool, not by the model

After `edit_file`/`write_file`, compare the file's bytes on disk with the text written and fail
loudly if they differ. This costs one `readFileSync`, and removes the "grep every edit to check it
landed" habit the steps adopted (verify and docs spent several minutes on it).

## Part B: thinking (the biggest sink)

Thinking is not waste by itself; the waste in this run had three causes, and each has its own fix.

### B1. Effort follows the step, not the parent (run design + engine default)

Steps already accept `effort` and `model` (`server/src/workflows/graph.ts:82`, applied at
`:728`). What is missing is using them, and a sensible default when a brief does not.

- **The engine's default for a step with no `effort`**: keep inheriting the parent's (changing it
  silently would be a behaviour change), but surface it on the run card so a person sees "medium x
  8 steps" before it costs two hours.
- **The `agent` tool's text tells the model to choose** (`server/src/workflows/manual.ts`
  `STEP_RULES`): one line per kind of step: `low` for mechanical or written-down work (docs,
  changelog, renames, a contract the brief spells out, verification that runs commands),
  `medium` for implementation against a fixed contract, `high` only for design or debugging with
  no answer known up front.
- The same guidance for subagents (`subagent` already takes `effort`).

Expected: docs + verify + contract at `low` would have cut ~10-15 min (they produced ~110k output
tokens, ~65% thinking on verify).

### B2. Decide once, then implement (run design)

mcpServer spent ~17 min in ten calls of 6-25k thinking tokens **designing** what it was told to
build: the tab selection rule, the uid format, the settle algorithm. The contract step had
already been given that job but returned prose. The fix is in how a brief is written, and the
`agent` tool's text says it:

- A design/contract step returns a **schema-checked output** (`output: {schema}`) that names exact
  signatures, file paths, the anchors to edit (`file:line`) and the decisions taken. Implementers
  read `{{steps.contract.output.field}}`, not a summary.
- Implementation briefs say "the design is decided: do not re-derive X, Y, Z" for the parts that
  are.
- Long briefs are a reliable source of thinking: a step reconciling a 2k-word brief with the
  code thinks about the brief. Keep each brief to what that step does.

### B3. Cap the thought per call (agent runtime)

A single call with 24k thinking tokens is almost always the model talking itself in circles; a
cap turns that into "act, look, think again".

- `DAEDALUS_AGENT_THINKING_BUDGET` (tokens per call, the literal `"null"` = unset as for every
  other env): for the `anthropic` protocol, sent as the thinking budget in `providerOptions`
  (`agent/src/provider.ts` `stepOptions`, where the adaptive-thinking display is already set); for
  the OpenAI-compatible protocol, the effort level is the only lever and the env is ignored (said
  in `agent/docs/`, not inferred).
- A behaviour switch on the agent row (`AgentDef.behavior`, so Settings > Agents draws it), and a
  workflow step's spawn sets it from the step's effort: `low` -> 4k, `medium` -> 12k, `high` ->
  unset (numbers to be tuned on the next run).
- **Spike first** on `cc/claude-opus-5-5` through 9router: does the gateway pass a budget through,
  and does an Opus-class adaptive model honour it, or only the effort level? If neither works, B3
  drops to B1 alone.

### B4. Measure it where people look (client)

`model_calls` already stores `output_reasoning` per call. The run card shows per-step thinking
share and the largest single thought, so "72% thinking" is seen during a run, not found in a
post-mortem. No new data, only a reading.

## Part C: run shape (engine + the `agent` tool's text)

### C1. Lanes, not barriers

Phases ran one after the other although mcpClient only needed the contract. The `phases` form is
a barrier by definition, so the change is in what the model is told to write:

- `manual.ts`: "a phase is a barrier: every step waits for the slowest step of the phase before
  it. When a step needs only one earlier step, use `steps` with `dependsOn` so it starts the moment
  that one finishes."
- The engine emits a warning on a run whose step waits at a barrier for a step it does not
  reference in its prompt (`{{steps.X}}`) or `dependsOn`. A hint, never an error.

Expected: ~26 min on this run (mcpClient alongside mcpServer).

### C2. Time limits that keep partial work

No step had `timeoutSec`, so a step chasing a 1-in-15 flake had no clock.

- `manual.ts`: give implementation steps a `timeoutSec`, and say in the brief what to do with a
  flake ("guard it, note it in the reply, move on; a flake rarer than 1 in 10 is not this step's
  to fix").
- Engine: on `timeoutSec`, the step's thread is **held, not failed** for a runtime that can pause
  (the existing pause), its partial reply is the output, and its dependents are told. Today a
  timeout fails the step and skips everything after it, which is why nobody sets one.

### C3. Faster step start (engine)

Every step took **8.5-14.5 s** from start to its first model call (spawn, `initialize`,
`session/new`, MCP servers connecting). On 8 steps that is ~1.5 min; on a fan-out of 30 it is
several.

- Use the draft prewarm (`server/src/prewarm.ts`) for a step: the engine warms the next step's
  process when the step before it in the lane starts its last expected turn, or simply when a
  step's dependencies are all running. The spec key rule already decides whether a warm process
  may be claimed.
- Measure where the 10 s goes first (spawn vs `initialize` vs MCP connect); if the MCP children
  dominate, start them in parallel rather than one after another.

## Part D: prompt weight for children (server spawn + agent runtime)

Context was 105-134k tokens per call, well cached (12.46M cached vs 8.3k uncached on one step), so
the cost is time to first token and the model's attention, not money.

### D1. No reader-facing trailers for unattended threads

`server/src/sessions.ts:2218` already computes `unattended` (child or autonomy) and drops the
drawn-UI instructions (`uiGroups: unattended ? [] : ...`), but `suggestKinds`, the
`## Other agents` list and `## Project commands` (~130 command lines in this project) still go to
every child. That is why every step's reply ended in `suggest-*` fences nobody reads.

- Pass `suggestKinds: unattended ? [] : session.suggestKinds` and skip the agents/commands blocks
  for unattended threads. Test in `test:openui-trailer` (or a new one beside it).

### D2. The workflow manual once, not three times

`STEP_RULES` + `SCRIPT_RULES` + `WHICH_SHAPE` are ~4.9k tokens in the `agent` tool's description;
five paragraphs (budgets, flow control, durability, pause, background, ~760 tokens) are written out
in both `STEP_RULES` and `SCRIPT_RULES`. Move them to one shared section. Also consider
`agent_help` (the `harness_help` pattern): the description keeps the shapes and the
one-paragraph rules, and the long manual is answered on request.

### D3. Rules for a child (agent runtime)

`agent/src/instructions.ts` reads `~/.claude/CLAUDE.md` and every `AGENT.md`/`AGENTS.md`/
`CLAUDE.md` up to the repo root, clipped at 48k chars per file and 80k total. Here that is
`AGENT.md` (91k, a stale copy of `CLAUDE.md` with different content), then `CLAUDE.md` (105k),
both clipped at 48k: the model reads the first half of each, ~80k chars of overlapping rules, and
the half of `CLAUDE.md` it never sees includes the sections most edits touch.

- **This repo**: make `AGENT.md` a symlink to `CLAUDE.md` again, as the file itself says it is.
  The loader dedupes by real path, so the rules are read once, and 48k of a single file is read
  instead of two overlapping halves.
- **The loader**: when two instruction files share most of their text (the same first 2k
  characters, say), read only the nearer one and say so.
- **Longer term**: `CLAUDE.md` at 105k chars is past what any loader can hand over whole. Split it
  so the always-read file is the rules index (well under 48k) and each section's detail sits in its
  `docs/` file, which the rule already links. This is the user's document; propose it, do not do it
  in this plan.

## Part E: the browser MCP from the same run

Small items found while it was built, fixed in the same pass:

- `server/src/sessions.ts:2427` calls `locateChrome()` (a filesystem probe) on every spawn that
  links `builtin:browser`; use the 5-minute cached status from `browser-status.ts`.
- `server/src/browser-agent.ts:114`: the snapshot walks the accessibility tree and awaits
  `elementHandle()` once per node, in series (2005 nodes took 217 ms in the spike just for the
  tree). Resolve handles in parallel batches, or lazily: keep the `backendDOMNodeId` per uid and
  resolve only the one an `act` names.
- The tool list was asserted at under 8000 characters, not the plan's 2k tokens; measure it in
  tokens the way the diagnosis measured `chrome-devtools-mcp`, and keep the test.

## Order and size

| # | Item | Lives in | Size | Saves (this run) |
|---|---|---|---|---|
| 1 | A1 edit lock + A3 verify | agent/src/tools | S | lost edits, ~5 min |
| 2 | D1 no trailers for unattended | server/src/sessions.ts | S | prompt + noise |
| 3 | D3 `AGENT.md` -> symlink | repo | XS | rules read once |
| 4 | B1 + B2 + C1 + C2 text in `manual.ts` | server/src/workflows | S | ~50 min |
| 5 | D2 manual dedupe | server/src/workflows | S | ~0.8k tokens per call |
| 6 | E browser fixes | server/src | S | spawn + snapshot latency |
| 7 | A2 truncation notes | agent/src/tools | S | silent cuts |
| 8 | B3 spike, then thinking budget | agent/src/provider.ts | M | long single thoughts |
| 9 | C2 engine: hold on timeout | server/src/workflows | M | makes timeouts usable |
| 10 | C3 prewarm steps | server/src/workflows + prewarm.ts | M | ~10 s per step |
| 11 | B4 run card readings | client | S | visibility |

Items 1-7 are independent and small; 8-10 each need a measurement first. Each item ships with its
test, its docs line (`agent/docs/`, `docs/mcp-and-workflows.md`) and a CHANGELOG line.

**Done means**: the same browser workflow, rewritten with lanes and per-step effort and re-run
on a scratch branch, reaches its last step in about an hour, with zero lost edits and no
`suggest-*` fences in step replies.

## Open questions

1. **B1 default**: keep children inheriting the parent's effort (recommended: no silent change, but
   make it visible), or default unattended steps to `low` unless the brief says otherwise?
2. **B3**: is a hard per-call thinking cap acceptable on implementation steps, or only on
   `low`-effort ones?
3. **D3**: may I turn `AGENT.md` into the symlink now (its 91k chars of different content would be
   replaced by `CLAUDE.md`)? If `AGENT.md` holds anything `CLAUDE.md` does not, that needs merging
   first.
4. **C2**: on a timeout, hold the step for a person (needs someone watching) or end it with its
   partial reply and continue the run (recommended for unattended runs)?
