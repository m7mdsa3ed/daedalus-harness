# The `agent` tool, v2: fix what is wrong, then expose what the engine can do (plan)

Follows `docs/plans/agent-tool.md` (v1, shipped). v1 made one tool for every way of handing
work on. This plan does two things:

1. **Fix the gaps the v1 review found.** Several of them return a quiet wrong result.
2. **Make the tool as capable as the engine under it.** A `prompt` run is compiled into
   `agent(prompt, options)` (`launchOneStep`, `engine.ts`), and that call already supports
   schemas, retries, worktrees and budgets. The tool hides most of that.

Each phase ships on its own and leaves the tree green. Phase 0 comes first because Phases 1-5
build on routes it changes.

## Ground rules for every phase

- **Refuse, never drop.** An argument the run cannot honour is an `isError` sentence naming the
  fix, never accepted and ignored. Phase 0 exists because this rule was broken in four places.
- **One resolver per rule.** The "person's choice outranks the model" rule and role resolution
  each get exactly one implementation, on the server. The MCP side becomes a thin client again.
- **Runtime facts are row columns** (`registry.ts`), never id comparisons: enforced tool scopes
  and read-only mode in Phase 4 are new `AgentDef` fields, seeded and backfilled.
- **Client-visible additions are a `FEATURES` entry** in `server/src/compat.ts`, read with
  `useFeature`. No `API` bump is needed anywhere in this plan.
- **Every phase updates `docs/mcp-and-workflows.md` and the rules file**, rewriting the
  sentences it changes rather than appending to them, and every commit carries its
  `CHANGELOG.md` line.

## Phase 0: correctness

| # | Fix | Where | Test |
|---|---|---|---|
| 0.1 | `projectId` on a plain subagent is dropped. Thread it through `StepBody` -> `engine.subagent` -> `launchOneStep` options, validated like `ask` does (`no project "x"`, 404). | `routes.ts` `/steps`, `engine.ts` `subagent()` | workflow-routes: subagent body carries projectId; workflow-engine: child's project is the named one |
| 0.2 | Lost answer after an abandoned wait. **Both halves:** the MCP handler passes `extra.signal` into `fetch`, and the loopback route aborts its `engine.wait` on `c.req.raw.signal`, removing the waiter, so `finalize` sees no waiter and sends the `<task-notification>`. | `agents-mcp.ts` `call()`, `routes.ts` `started` and `GET runs/:id`, `engine.ts` `wait(runId, ms, signal?)` | workflow-engine: a waiter aborted before the end leaves `notify` firing exactly once |
| 0.3 | `script` / `name` drop `totalTimeoutSec` and `maxParallel`. Add both to `ScriptBody` and to `StartInput`, cap them like a definition's, and send them from `flowOf`. | `route-schemas.ts`, `routes.ts` `/scripts`, `engine.ts` `start()`, `agents-mcp.ts` | workflow-routes: script body carries both; workflow-limits: the cap applies |
| 0.4 | Graph steps skip the picker. Top-level `agent` without a saved choice must take the same path as an ask: the MCP side resolves the pair once (`pickPair`) **before** `inherit()`, and `step.ts` stops silently using `parent.profileId` when an `agent` was named without a `profile` and no choice exists (a `StepConfigError` naming the fix). | `agents-mcp.ts` graph branch, `step.ts` resolve | workflow-step: named agent, no choice, no profile -> error, not the parent's profile |
| 0.5 | `profile` without `agent`: the picker filters to the named profile; `engine.ask` never swaps a named profile for a preset of another agent. | `agents-mcp.ts` `pickPair`, `engine.ts` `ask()` | workflow-routes |
| 0.6 | `agent_list`: read the `runs` argument, and offer it on **every** runtime. Asks and subagents are runs on Claude Code too. Delete `RUNS`. | `agents-mcp.ts` | workflow-routes: `runs:false` makes one call; schema lists `runs` with workflows off |
| 0.7 | **One copy of the pair rule.** `resolvePair(parent, {agent, profile, model})` in `workflows/step.ts` (it already has `listPairs` and `matches`) is called by `engine.ask` and the step resolver; `pickPair` asks the loopback for the resolution and only draws the picker when it answers "unchosen". | `step.ts`, `engine.ts`, `routes.ts` (new `POST …/resolve-pair`) | existing ask tests pass unchanged |
| 0.8 | **One copy of role resolution.** The MCP side stops resolving roles and sends `role`; the server's `resolveRole` (already per-thread, already exact) answers. `AGENTS_ROLES` stays, for the description text only. | `agents-mcp.ts`, `routes.ts` `/steps` | the existing role test moves to assert the body carries `role` |
| 0.9 | Stale names: `list_agents shows them` -> `agent_list` (`engine.ts:456`), and the `ask_agent` mentions in comments and schema docs. | grep | none (text) |
| 0.10 | Unnamed graph: use `steps[0].prompt` or `phases[0].steps[0].prompt` for the name, as the comment promises. | `agents-mcp.ts` `stepsName` | workflow-routes |
| 0.11 | Hints: `agent_control` drops `idempotentHint` (signal buffers), `agent_message` waits 0 by default when continuing a workflow run (read `kind` from `agent_status` first, or let the route choose the default when `wait` is absent). | `agents-mcp.ts`, `routes.ts` | workflow-routes |

### 0.12 Effort

The current rule (`step.ts:255`) is `spec.effort ?? (samePair ? parent.effort : undefined)`,
together with model on the line above it.

- **Inherit only when the model can take it.** If the child's effective model is the parent's
  model, inherit as now. If it is another model (a `role`, an explicit `model`), inherit only
  when that model's catalog entry lists the effort in `reasoningEfforts`. Otherwise use that
  model's default and say so in the run's view (`effortNote`). The catalog lookup is the
  profile's `ModelDef`, the same one the composer's effort menu reads.
- **An explicit `effort` the model does not list is refused** before spawning, naming the
  ones it does list. A model with no catalog entry takes any value (we cannot know better).
- **Staged effort: decided, not changed.** A child follows what the parent is running on now,
  not a pick staged for the parent's next turn: the child is part of the current turn. This
  goes in the docs, not the code.
- **Describe the field**: "omit to inherit this thread's effort on its own pair (when the model
  supports it), else the target model's default".

Test: workflow-step. A role onto a model without `xhigh` gets its default and a note; an explicit
unsupported effort is refused.

### 0.13 Loopback key scope (security posture: decision needed)

`/wf` and `/hm` share one global key (`derive("wf")`), and `resolveCaller` trusts the session
id in the path. Anyone holding one thread's `AGENTS_URL` can act as any thread, through the
whole harness API at that.

Fix: `derive("wf", session.id)` per thread, compared in `resolveCaller` against the session
named in the path. `derive` already takes the session id. **Transition:** hosted agents are
adopted across restarts with their MCP children's env intact, so a process spawned before the
change still carries the global key. Two options:

- **A (recommended):** accept the global key only for sessions whose `agent_processes` row
  predates the change (a `keyScope` column, written at spawn), and log each use. It closes
  itself as those processes retire.
- **B:** reject it outright and accept that adopted threads lose `agents`/`harness` tools
  until their next respawn.

Test: loopback-secret and workflow-routes. Thread A's key on thread B's path is a 404.

## Phase 1: expose the engine on a `prompt` run

| # | Feature | How |
|---|---|---|
| 1.1 | **Step options on `prompt`**: `output` (JSON Schema), `retry` (`{max, backoffSec, fallbackModel}`), `isolation: "worktree"`, `agentType`, `system`, `tools`. | Add to `agentFields` and `AskBody`; pass them into `launchOneStep`'s `options`, which already become `agent(prompt, options)`. The sandbox validates option names, so a bad one is its existing error. `answer()` returns the parsed object when `output` was a schema. |
| 1.2 | **Budgets on one-step runs**: `budgets` (`tokens`, `costUsd`, `wallSec`; `agents` refused, it is always one) accepted on `prompt`. | `launchOneStep` sets `spec.budgets` from the input instead of `{}`; the refusal list drops `budgets`. `budget_exceeded` is already a terminal state the notification names. |
| 1.3 | **`dryRun: true`** on `steps`/`phases`: the checked plan and nothing spawned. | `engine.plan(parent, input)` runs `start()`'s validation and compile path and returns the compiled order (phases, steps, resolved pair/model/effort per step, agent count) without `launch`. For `script` it returns the parsed `meta` only, and says so. |
| 1.4 | **`get_workflow(name, scope?)`**: a saved workflow's source and meta. | `GET …/saved/:name` on the loopback, reading what `listSaved` already reads. |

Tests: workflow-routes (schema and bodies), workflow-engine (a schema-shaped subagent answer, a
budget stopping a subagent), workflow-graph (dryRun on a cyclic graph names the cycle and
spawns nothing).

## Phase 2: seeing a run while it works

| # | Feature | How |
|---|---|---|
| 2.1 | **Progress during a wait.** While `agent` / `agent_status` / `agent_message` block, send `notifications/progress` with the current step, its last tool title, tokens and elapsed time. | The handler waits in 5 s slices of `?wait=` (same total) and sends progress between slices when the request carried a `progressToken`. Only the MCP side changes. A runtime that ignores progress loses nothing. Abort (0.2) ends the loop. |
| 2.2 | **`notifyOn: ["gate", "failure", "phase"]`**: opt-in mid-run `<task-notification>`s, for example "your run is waiting on an approval". | Stored on the spec, read where gates open, steps fail and phases advance. Text says it is *not* the end and carries the gate's text. The end notification is unchanged. A gate notice never offers to answer the gate. |
| 2.3 | **Richer `agent_status`**: `steps[].lastActivity` (last tool title, time) and `usage` on one-step runs too. | Fold already has the events; `answer()` stops discarding usage for one-step runs. |

Test: workflow-routes (a progress-token call receives progress, a call without one receives
none), workflow-gates (notifyOn gate fires once per gate).

## Phase 3: context, not retyping

| # | Feature | How |
|---|---|---|
| 3.1 | **`context` on `prompt` and on a step**: `{files?: string[], fromRuns?: string[], recap?: boolean}`. | Assembled **once at launch** into a preamble ahead of the brief and stored in `stepPrompt`, so replay and continue are deterministic. `files` are listed as paths under a "read these first" line (contents are the worker's to read; no size games). `fromRuns` pulls outputs of *this thread's* runs (`statusFor`, so another thread's id is "no such run"). `recap` is `buildRecap(loadThread(parent.id))` (`mentions/thread-recap.ts`, capped at `RECAP_CAP`). An ask gets the same preamble; it is still a brief. |
| 3.2 | **Fork a child**: `agent_message({id, fork: true, prompt})` starts a new child from a copy of the old child's conversation, so attempt A survives trying B. | Uses the existing fork door (`forkedFromSessionId`, the aside path). **Spike first:** confirm which runtimes can load a forked session (`rewindVia` decides it per row). Where none can, `fork` is refused with that sentence. |

Test: workflow-engine (the preamble is in the journaled prompt; a foreign run id in `fromRuns`
is refused), workflow-step (fork leaves the original child untouched).

## Phase 4: safety and results

| # | Feature | How |
|---|---|---|
| 4.1 | **Enforced tool scopes** in place of advisory `tools`. | New `AgentDef.toolScopeVia` (`"acp-meta"` where `builtinTools` already has a door, `"env"` for the Daedalus agent, null where there is none), seeded and backfilled. Where null, `tools` stays advisory **and the answer says so** (`toolsEnforced: false`). Disallowing a built-in keeps the paired MCP allow rule (the auto-mode classifier rule). |
| 4.2 | **`readOnly: true`**: a child that cannot write. | New `AgentDef.readOnlyMode`, the agent's own plan or read-only mode id, applied as the child's `modeId` at create. Where null, refused, not approximated. `ASK_AUTONOMY` does not override it: the mode is the stronger fact. |
| 4.3 | **Worktree results**: a step that ran with `isolation: "worktree"` reports `{branch, base, files: numstat}` on its view. | `git.ts` `parseNumstat` against the base recorded at create. Drawn on the run card as a `ChangeSet` (client, `FEATURES` entry `agentWorktreeResults`). |
| 4.4 | **Merge back behind a human gate**: `agent_control({action: "merge", id, step})`. | Opens an approval the person answers in the app (the existing bearer-gated route), then merges or reports conflicts. The agent can request a merge, never approve one. |

Tests: agent-seeds (columns seeded and backfilled, never overwriting user fields), workflow-step
(readOnly mode reaches the child; null-row refusal), worktree (numstat and merge with a conflict).

## Phase 5: new patterns

| # | Feature | How |
|---|---|---|
| 5.1 | **Ask several pairs at once**: `agents: [{agent, profile?, model?}]` with one brief, optional `judgePrompt`. | Compiled like `launchOneStep`, but N `agent()` calls in `parallel`, plus `vote`'s judge when given. Kind `ask`, counted against the ask cap per pair, so three pairs cost three slots. Each pair goes through `resolvePair` (0.7), so the picker rule holds per agent. Answer: `[{pair, output, error}]` and the judge's pick. |
| 5.2 | **Schedule a saved workflow**: `agent({name, at? \| cron?})`. | Writes a schedule through the same module Settings uses. Refused unless the person's autonomy policy allows scheduling (a new key, off by default): a schedule outlives the turn and the person's attention. |

## Delivery order and size

| Phase | Size | Ships |
|---|---|---|
| 0.1-0.11, 0.12 | M | server only |
| 0.13 | S (+ decision) | server only |
| 1 | M | server only |
| 2 | M | server only |
| 3.1 | S-M | server only |
| 3.2 | spike, then M | server |
| 4.1-4.2 | M | server + seeds |
| 4.3-4.4 | M-L | server + client |
| 5.1 | M | server (+ client row shape) |
| 5.2 | M | server + settings |

Test commands: `pnpm test:workflow-{routes,engine,step,graph,gates,limits}`,
`pnpm test:loopback-secret`, `pnpm test:agent-seeds`, `pnpm test:worktree`; typecheck with
`pnpm exec tsc --noEmit` (server) and `pnpm exec tsc -b` (client, Phase 4.3 onward).

## Open questions

1. **0.13 transition**: option A (accept the legacy key for pre-existing adopted processes, logged)
   or B (reject it; adopted threads lose the tools until respawn).
2. **3.1 file contents**: paths only (proposed), or inline small files up to a cap. Inlining
   saves the worker a read and costs determinism if the file changes before a continue.
3. **5.1 cost**: whether a multi-pair ask needs its own budget default (proposed: none; the
   per-pair cap already bounds it).
4. **4.2 on runtimes without a read-only mode** (Codex today?): refuse (proposed) or fall back to
   an autonomy policy that denies writes. The fallback is weaker, so it is not offered silently.
