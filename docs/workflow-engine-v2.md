# Workflow engine v2 (design)

Status: implemented (see "Delivery order"; P3 parentless Run button and P4 fork/edit-and-resume are still open). Dev phase, so nothing is kept for compatibility: old tables, tools and
the declarative scheduler can be deleted outright. Supersedes the "Workflows" section of
`docs/mcp-and-workflows.md` once built.

## What is wrong with v1

1. **Two schedulers for one runner.** `pump`/`readySteps` (declarative) and `acquireSlot`
   (script) both exist, glued by a `def` that "grows". Every feature is written twice or
   only for one engine (retries, model override, isolation, projectId are script-only).
2. **Nothing is durable.** Run state is in memory plus a `steps` JSON column rewritten on
   every change. `recoverAtBoot` fails every in-flight run. Resume exists only as a manual
   `resumeFromRunId` for scripts.
3. **One 1450-line class** mixes ask, launch, scheduling, step execution, repair turn,
   pause, notification, persistence and bookkeeping.
4. **Few primitives.** No retry/backoff/fallback model, no approval gate, no durable
   sleep/wait-for-event, no map with a concurrency limit, no vote/judge, no loop-until, no
   shared state, no per-step tool limits, no cost budget (output tokens only), 16 steps max.
5. **Duplicated step logic.** `routines.ts` re-implements the JSON repair turn for its
   workflow body; `ask` is a one-step run built by hand; templates are string regex.
6. **No entry points besides an agent.** A person cannot press "Run" on a saved workflow
   with an input form; routines can only embed a raw definition.

## Shape

One engine, one journal, three front doors.

```
 run_workflow (JSON graph) --compile--\
 run_script   (JS)          ----------+--> Flow runtime --> steps (child threads)
 routine / schedule / button --------/         |
                                               +--> workflow_events (append-only journal)
```

- **The script is the only program.** A declarative definition is validated as today
  (dup names, cycles, template reads) and *compiled* into a script that calls the library
  function `graph(def)`. `pump`, `readySteps`, `dependentsOf` and the growing `def` go.
  The static outline (phases, step names) still comes from the definition, so the card
  draws before anything spawns.
- **The journal is the state.** Each await point is one `workflow_events` row
  (`run_id, seq, kind, key, payload`): `step_started`, `step_output`, `step_failed`,
  `approval_asked`, `approval_answered`, `timer_set`, `signal`, `log`, `state_set`.
  A step's key is `hash(call site index, prompt, options)`. Resuming a run replays the
  script from the top and answers every keyed call from the journal. This is exactly what
  `resumeFromRunId` does today, made automatic and total. Determinism (no clock, no
  random) is already enforced by the sandbox.
- **`workflow_runs` keeps the header only** (script, args, status, budget, owner, trigger).
  The `steps` JSON column is dropped; steps are a fold over the journal.

## Primitives

Claude Code's API stays name for name (`agent parallel pipeline phase log args budget
workflow`), so scripts port. Added:

| Primitive | Meaning |
| --- | --- |
| `agent(p, {retry:{max,backoff,fallbackModel}, tools:{allow,deny}, timeoutSec, system, resumeSession})` | retries re-use the same child thread; fallback swaps the model |
| `map(items, fn, {concurrency})` | bounded fan-out; failures become `null` like `parallel` |
| `vote(n, make, {judge})` | n attempts, a judge agent or majority picks one |
| `refine(make, check, {maxRounds})` | evaluator-optimizer loop with a stop rule |
| `route(classifier, {label: fn})` | classify once, run one branch |
| `race(thunks)` | first success wins, the rest are cancelled |
| `approve(text, {options, timeoutSec})` | parks in the inbox (`bridge.pending` path), durable |
| `sleep(sec)`, `until(isoTs)` | durable timers; the run holds no child while waiting |
| `waitFor(signal, {timeoutSec})` + `signal_workflow` tool | external event / webhook / another thread |
| `state.get/set` | small JSON store persisted in the journal, visible in the UI |
| `sh(cmd, {cwd})` | a token-free command run in the project (policy-gated, same permission mode) |
| `artifact(name, data)` | file under the run dir, linked on the card |

Removed limits: 16 steps and 5 parallel become run budgets (below).

## Budgets and flow control

- Per run: `tokens`, `costUsd`, `agents`, `wallSec`. Enforced by the engine, not by an
  honour-system `budget.remaining()`. Hitting one stops *new* agents and ends the run as
  `budget_exceeded` with the partial result.
- Global semaphore (replaces `MAX_LIVE_CHILDREN`) with **priority** and **per-key
  concurrency** (`concurrencyKey`: e.g. one writer per file or per repo).
- `maxRunsPerParent` stays (a model calling `run_workflow` twice by mistake).

## Entry points

- Saved workflows move into a DB table (name, source, `meta.inputs` JSON schema, version =
  source hash) with import/export to `.claude/workflows/` so Claude Code still sees them.
- **Run button + input form** generated from `meta.inputs`, in the project page and the
  palette.
- **Routines and schedules start a workflow by ref + args**; `routines.ts` loses its own
  repair/JSON code and its `kind: "workflow"` raw definition body.
- **Triggers**: schedule, git event (existing trigger), webhook (`/wf/hook/<key>`), signal.
- `ask_agent` becomes `agent(prompt,{profile,agent})` through the same step runner; the
  one-step-run special case (`ask`, `continueAsk`) is deleted. `continue_agent` is
  `resumeSession`.

## Module split (`server/src/workflows/`)

```
engine.ts    run lifecycle, replay, finish, notify
journal.ts   workflow_events read/append, fold to step view
sandbox.ts   vm context + primitives (from workflow-script.ts)
graph.ts     compile a JSON definition to a script; validation (from workflow-schema.ts)
step.ts      spawn child, prompt, JSON repair, retry, timeout, retire
limits.ts    semaphores, priority, per-key concurrency, budgets
gates.ts     approve / sleep / waitFor / signal
saved.ts     DB library + file import/export
routes.ts    /wf and /api/sessions/:id/workflows
mcp.ts       the tool surface
```

## Restart behaviour (the one real decision)

Completed steps are always served from the journal. A step that was **in flight** when the
server stopped has three options:

1. **Resume its own conversation** (`session/load` of the child, prompt "continue where you
   left off"). Cheapest, matches `continue_agent` today. Risk: a tool side effect that ran
   but was not journaled can repeat. **Default.**
2. Re-run the step from its prompt in a fresh thread.
3. Fail the step and the run (v1 behaviour).

Selectable per step (`onRestart: "resume" | "rerun" | "fail"`), default `resume`.

## Protocol and client

- Keep `_meta.daedalus.workflow` and `subagent_*` updates, so the existing card keeps
  drawing during the server rewrite. Add `FEATURES` entries (`workflowJournal`,
  `workflowApprovals`) per `compat.ts`, no `API` bump.
- New events: `_daedalus/workflow_event` for gates (approval, sleeping, waiting) and a
  `state`/`artifact` update. The card learns these four states: `awaiting-approval`,
  `sleeping`, `waiting-signal`, `retrying`.
- Then a run page (Timeline, Board, Graph already exist in `workflow-run.tsx`) gains:
  fork from step, edit-and-resume, artifacts, budget meters.
- Native Claude Code workflows are untouched (`workflowsVia === "native"`).

## Delivery order

1. **P0 engine core**: journal table, split modules, compile JSON to script, durable resume
   at boot, delete `pump`/`readySteps`/growing `def`/`ask` special case. Same tool names.
   Tests: schema, sandbox, a new journal-replay test with a fake step runner.
2. **P1 primitives**: retry/fallback, map, vote, refine, route, race, budgets, per-step tools.
3. **P2 gates**: approve, sleep, waitFor/signal, state, artifacts, `sh`.
4. **P3 entry points**: DB library, input forms, routines/schedules/webhook by ref.
5. **P4 client**: new states, fork/edit-and-resume, meters.

## Docs and rules this changes

- `AGENT.md`: "Nothing survives a restart" (workflows), "A definition is declarative JSON,
  never a script", "One level, never a tree" (kept).
- `docs/mcp-and-workflows.md` "Workflows" and "Pausing a run", `docs/protocol.md` features.
- `CHANGELOG.md` entry under `[Unreleased]` with the commit, not before.
- `pnpm db:push` takes no backup: dump `workflow_runs` first if any run matters.
