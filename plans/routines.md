# Daedalus Harness — Routines (agent-agnostic scheduled/triggered runs)

## Context

Anthropic shipped **routines** in Claude Code (April 2026, research preview): a saved
configuration — a prompt, one or more repositories, a cloud environment, a set of MCP
connectors, a model — that runs **autonomously** on their infrastructure when one of its
triggers fires. Three trigger kinds, combinable on one routine: a **schedule** (presets or
cron, minimum interval one hour, local wall-clock with a per-routine stagger), an **API**
`POST …/routines/<id>/fire` with a per-routine bearer token, and a **GitHub** event
(`pull_request.*` / `release.*`, filtered on author/title/body/branches/labels/draft/merged).
Every fire is a *new isolated session*: repos cloned from the default branch, pushes confined
to `claude/`-prefixed branches, no permission prompts at any point, every tool of every
included connector available including writes. Run history is a list of ordinary sessions you
can open, read and continue. Managed from `claude.ai/code/routines`, the Desktop app, or
`/schedule` in the CLI.

Two details from their design are load-bearing and worth copying exactly:

- **The saved prompt is trusted; the fire payload is not.** The routine's stored prompt is
  delivered as an assigned task, because an authorized session on the account wrote it ahead
  of time. The optional `text` sent at fire time arrives wrapped in a
  `<routine-fire-payload>` block labelled untrusted, and the routine's own prompt has to opt
  in to acting on it ("investigate the alert in the routine-fire-payload block"). Anyone
  holding the token can send `text`; the wrapper is what keeps a leaked token from becoming
  an instruction channel.
- **A green run is not a successful run.** Their own docs say the status only means the
  session exited without an infrastructure error. Blocked network calls, missing tools and
  task-level failure show up in the transcript and nowhere else.

### What the harness already has

Most of the machinery exists. This plan is mostly *composition*, not new subsystems.

| Anthropic's piece | The harness's equivalent | State |
|---|---|---|
| Saved prompt + model | `profileId` + `agentId` + `model` + `effort` on `sessions.create` | exists |
| Repositories, cloned per run | a **project** (a cwd on this machine) | exists |
| Cloud environment / network policy | the machine the server runs on | n/a by design |
| Connectors | `LinkSet` — MCP servers, skills, commands, profile ∪ thread (`db/links.ts`) | exists |
| A run is a real session you can open | `sessions.parentSessionId` + child threads (workflows.ts) | exists |
| Waiting for a run to finish, keeping its answer | `whenTurnSettled` + `agent_message_chunk` accumulation (workflows.ts) | exists |
| Server-owned firing with no browser open | `scheduler.ts` sweep + `manager.respawn` + `manager.prompt` | exists |
| Token-in-path unauthenticated callback route | `/gw/<key>/…`, `/ide/<key>/…`, `/wf/<key>/<sessionId>/…` | exists |
| "Tell me it finished" with nobody watching | `Push` (`onTurnEnd`) | exists |
| (no equivalent) a multi-step body | `WorkflowRunner` + `workflow-schema.ts` | exists |
| (no equivalent) a structured result | a step's `output` JSON schema + one repair turn | exists |
| (no equivalent) spend ceilings | per-turn `Usage`, `quota.ts`'s `QuotaSnapshot` | exists |
| (no equivalent) somewhere for an answer to land | knowledge base, tasks board (`boards.ts`) | exists |
| Cron expressions | — | **missing** |
| Autonomous runs (no permission prompt, ever) | — | **missing, and the crux** |
| A saved config that outlives any one thread | — | **missing** |
| API / event triggers | — | **missing** |

`scheduled_messages` is *not* this. It delivers `text` into **one existing thread**, over and
over, at `nextAt` — a recurring message in a conversation. A routine is the opposite shape: a
saved config with **no thread**, which mints a fresh one per fire. Both are worth having (see
Phase 6), and neither should be bent into the other.

### The crux: autonomy has to be the harness's, not the agent's

Claude Code's routines run on Claude Code, so "no permission prompts" is one internal flag.
Here the routine has to work for claude-agent-acp, codex-acp, opencode and whatever comes
next, and CLAUDE.md's standing rule is that the client never hardcodes per-agent knowledge.

Each runtime spells autonomy differently — Claude Code has permission modes, codex has
sandbox and approval policies — and they reach us only as opaque ACP `session/set_config_option`
entries whose ids we must not enumerate. So **the harness does not ask the agent to be
autonomous. It answers for the user.** Every permission request and every elicitation funnels
through exactly one place, `AcpBridge.park()` (acp-bridge.ts:605), which today parks a promise,
emits to peers and pushes to a phone. A routine run sets a **policy** on the session that
`park` consults *before* it parks. That is one choke point, protocol-level, and it is
identical for every agent that will ever speak ACP — which is the whole reason this works for
all agents at all.

Setting the agent's own mode stays available and stays generic: it is just a `configChoices`
entry the user picked from the agent's advertised selectors, exactly as a draft does today.
It is an optimisation (fewer round trips), never the mechanism.

---

## Design

A **routine** is a saved thread-start plus a set of triggers.

```
routine ──< routine_triggers      (schedule | api | event, several per routine)
        └──< routine_runs ── sessions.id   (one real thread per run)
```

Everything a `POST /api/sessions` body carries, a routine stores: `profileId`, `agentId`,
`projectId`, `model`, `effort`, `configChoices`, `mcpServerIds`/`skillIds`/`commandIds`. A
fire is literally `manager.create(...)` with those values, then one prompt. That is the
design constraint that keeps this small: **a routine must not be able to start a thread the
composer could not start.** If a field is needed by a routine and not by a draft, the draft
is missing it.

### Autonomy policy

```ts
type Stance = "allow" | "deny" | "ask";     // "ask" = today's behaviour: park and wait

type AutonomyPolicy = {
  /** Permission requests, keyed by the ACP tool kind the request is about.
      Deliberately not one verb for everything: "read whatever you like, ask
      before you run a command" is what almost every routine actually wants,
      and a single `allow` is the only alternative on offer if it is. `kind`
      is a protocol field — the same one `toolKindOf` already reads — so
      keying on it hardcodes nothing about any agent. */
  permissions: { default: Stance } & Partial<Record<acp.ToolKind, Stance>>;
  /** Elicitations (AskUserQuestion & friends). `decline` is a real ACP answer that
      the bridges read as "the user skipped" and the turn continues; `cancel` aborts
      the tool call. Declining is right for a routine — the run should carry on. */
  elicitations: "decline" | "ask";
  /** How long an `ask` waits for a human before falling through. A routine
      that parks until the run deadline is a routine that dies half an hour
      later having done nothing and reported nothing; the fallback is what
      turns that into an answer the transcript can explain. */
  askTimeoutSeconds: number;
  askFallback: "deny" | "cancel";
  /** Ceilings. Time is not the only thing a run spends — see below. */
  maxRunSeconds: number;
  maxRunTokens?: number;
  /** Refuse to fire at all when the profile's plan is nearly gone. */
  minQuotaPercent?: number;
};
```

`allow` picks the request's own **allow-shaped** option out of `request.options` (ACP's
`kind: "allow_always" | "allow_once"`, preferring `allow_once` — a routine must not write
standing rules into the agent's own config), `deny` picks the reject-shaped one, and when the
agent offered neither the request is parked as today and the run stalls until the
`askTimeoutSeconds` timer answers it. Nothing is invented; the agent's own options are what
get selected. Vendor names are never read.

Two consequences, and they must be said out loud in the UI: a `default: "allow"` routine is a
standing grant to run any command the agent decides to run in that project's cwd, with no
human in the loop, on this machine — which is strictly more than Anthropic's version, because
there is no sandbox and no network allowlist under us. The default for a new routine is
therefore `{ default: "ask" }`, and the first thing the form offers is not the blanket grant
but the per-kind map, because `{ read: "allow", fetch: "allow", default: "ask" }` is a
sentence a person can actually check. Widening `default` to `allow` is an explicit choice
with a confirm dialog that names the project directory.

**A run spends more than wall-clock.** `maxRunSeconds` bounds a hung turn; it does nothing
about the routine that quietly eats a five-hour plan window overnight, which is the failure
you discover the next morning when your own thread is refused. So the ceiling is three
numbers, all of them read from things that already exist: seconds, the per-turn `Usage` the
transcript already carries (`maxRunTokens`), and `quota.ts`'s normalized `QuotaSnapshot` for
the run's profile (`minQuotaPercent`, checked *before* the fire — a skipped fire is a row
saying why, not an error). A provider with no windows reports `api-key` and the check is
simply not applied, per the existing rule that "no quota" is an answer and not a failure.

### What a routine runs

The body is a prompt **or a workflow**:

```ts
type RoutineBody =
  | { kind: "prompt"; text: string }
  | { kind: "workflow"; definition: WorkflowDefinition };   // workflow-schema.ts, verbatim
```

The second costs almost nothing and is most of the point. `workflows.ts` already runs
declarative phased pipelines against a real thread, with per-step JSON-schema outputs and one
repair turn; a routine that can only ask one question nightly is the weaker half of a machine
that is already built. A workflow-bodied routine fires by creating the run's thread exactly as
a prompt-bodied one does and then starting the run through `WorkflowRunner` on it, which also
means the run's card in the transcript is the `workflow-group` row the client already draws.
The one-level rule stands unchanged: a routine's run is a parent, its steps are children, and
a step still cannot start a workflow.

**And a run may declare what a result looks like.** An optional `output` JSON schema on the
routine, the same field a workflow step takes and compiled the same way, buys the run one
repair turn and then a structured answer — which is what lets `routine_runs.verdict` be
something the run computed rather than a restatement of "the turn ended". Without it the
status stays honest and bare, per the rule above; with it the run list is scannable, which is
the difference between routines you read and routines you accumulate.

### Triggers

- **schedule** — `cron` (5-field, plus `tz`), or a one-off `atMs`. Presets in the UI
  (hourly / daily / weekdays / weekly) write cron expressions; there is no separate preset
  representation to keep in sync. Copy the **stagger**: a per-routine deterministic offset
  added to every fire, so twenty daily routines at 09:00 don't spawn twenty agents in the
  same second on one laptop — but it is `fnv(routine.id) % min(300, intervalSeconds)`, never
  a flat five minutes, because a flat offset is longer than the period of anything scheduled
  more often than every five minutes and would push such a routine permanently past its own
  next slot. Missed slots while the server was down **collapse to one fire**, which is
  `scheduler.ts`'s existing rule and the right one. No one-hour minimum — that is a
  fleet-capacity rule for their infrastructure, not ours — but a floor of one minute, and the
  overlap policy below is what actually protects us.
  A schedule may also carry a **condition**, checked at fire time and not at edit time:
  today only `gitChangedSince: "lastRun"`, one `git.ts` read of the project's HEAD against
  what the last run recorded. It is the difference between a nightly review that reports on
  yesterday and one that reports "nothing happened" thirty times before somebody disables it,
  and it is a fraction of the watcher in Phase 5 — which is why it belongs to Phase 2 while
  the watcher does not. A skipped fire writes a run row with status `skipped` and the reason;
  it is not an error and it does not disturb `nextFireAt`.
- **api** — `POST /rt/<key>/<routineId>/fire`, outside `/api`, key-in-path exactly like
  `/gw`, `/ide` and `/wf`, minted per boot and never stored. Body: `{ "text": "…" }`,
  freeform, never parsed. This is *not* the same as their per-routine long-lived token, and
  the difference is deliberate: a per-boot process key means a caller has to re-read it after
  a restart, which is wrong for an alerting tool. So **two** credentials are accepted — the
  boot key for loopback callers (an MCP server, a future `routine` tool), and a stored
  per-routine token (`routine_triggers.secret`, shown once) for anything outside the process.
  That stored token is the only long-lived credential in this design that **starts a process
  on the machine**, so it is held hashed and compared in constant time — nothing else in the
  harness needs that (a profile's API key has to be replayed verbatim to a provider, and the
  key-in-path routes are per-boot and unstored) — and the fire route is rate-limited per
  trigger. The overlap policy stops two agents in one cwd; it does not stop a loop hammering
  create.
- **event** — the harness has no GitHub App and may not be reachable from GitHub, so the
  event trigger is **local git**: `workspace-watch.ts` already watches a project's tree, and
  `git.ts` already reads status and branches. A `git` trigger fires on "HEAD of branch X
  moved" or "a path matching glob G changed", debounced. A GitHub webhook receiver is the
  same trigger kind with a different source and is left as a later phase — the routine, the
  run and the payload wrapper are identical either way.

### Overlap and caps

`overlap: "skip" | "queue"` per routine, defaulting to `skip` — a nightly review that is
still running when the next hour comes round must not become two agents in one cwd. Global
`MAX_LIVE_ROUTINE_RUNS`, the same shape as `WorkflowRunner.MAX_LIVE_CHILDREN`, and for the
same reason: these are real processes on one machine.

### The fire payload

Verbatim from their design, because the reasoning holds identically here:

```
<routine-fire-payload>
…caller's text, never parsed, never interpolated into the prompt…
</routine-fire-payload>
```

appended after the routine's own prompt, with a fixed preamble stating that content inside
the block is data and not instruction unless the prompt above asked for it. The wrapper text
lives next to the schema, in one exported constant, so it is auditable in one place.

### What a run looks like

Each run creates a real session — its own transcript, searchable, openable, revivable — with
`title = "<routine name> · <when>"`. It is **not** a workflow step: `parentSessionId` stays
null (a routine has no parent thread), and instead `routine_runs` names it. Like a workflow
step it is **retired when its turn settles** (`onSessionDurable`), so the thread stays
readable from its journal with no process held open, and "continue this run manually" is the
ordinary revive path — which is exactly the affordance their run pages have.

The run record keeps `status`, `startedAt`, `endedAt`, `error`, and the run's final prose,
accumulated from `agent_message_chunk`s the way `workflows.ts` already does it, capped. And
the status means what theirs means and no more: **the turn ended**. The UI says so — unless
the routine declared an `output` schema, in which case the run also carries the parsed
`verdict`, and *that* is what the list column shows, because it is the only thing on the row
that is about the work rather than about the process.

Runs are grouped by a **`fire_id`**, minted per fire and shared by every run that fire
produced. Today that is always one run, and the column looks redundant; it is here now
because the moment a routine names more than one project (open question 2) a fire produces N
runs, and adding the grouping afterwards is a data rewrite of the one table this feature
accumulates rows in fastest.

### When a run finishes

A transcript nobody opens is not a result, and a routine whose only outlet is a thread in a
list is one people stop reading within a week. So a routine carries `onFinish` actions,
optional and plural, every one of them built out of something that already exists:

- **push** — the existing `onTurnEnd` hook, given the routine's name (Phase 4 already says this).
- **knowledge** — write the run's answer to the built-in knowledge base for the run's project,
  through `knowledge.ts`, which is how a nightly routine accumulates something the *next*
  thread can read.
- **task** — file a card on the tasks board (`boards.ts`), which is the outlet that actually
  fits "review this repo overnight and tell me what needs doing".
- **routine** — fire another routine, with this run's prose as the `text` payload, which
  arrives wrapped as untrusted exactly like any other fire payload. Chaining is therefore not
  a new mechanism; it is the API trigger pointed at ourselves, and it inherits the wrapper for
  free.

An action's failure is recorded on the run and never fails the run: the work already happened.
Actions run at most once per run, after the turn settles and before the run is retired.

---

## Phases

### Phase 1 — Autonomy at `park()` (server; no routines yet)
The prerequisite, useful on its own (it is also what an unattended `scheduled_messages`
delivery has always needed).
- `Session` gains `autonomy?: AutonomyPolicy` and a `deadline` timer.
- `AcpBridge` takes `autonomy` from its host and consults it at the top of `park()`:
  read the stance for `request.toolCall.kind` (falling back to `default` — an absent or
  unknown kind is the protocol saying nothing, exactly as `toolKindOf` already treats it),
  then resolve immediately with the request's own allow/deny option, or fall through to
  today's park. Elicitations resolve `{ outcome: "declined" }`.
- A parked request under an `ask` stance gets the `askTimeoutSeconds` timer, answered with
  `askFallback` — the park is still a real park, so a human who gets there first still wins
  through the ordinary first-answer-wins path and the timer is dropped.
- Auto-answers are still **emitted** to peers (a watching browser sees the request and its
  answer as a card that resolves itself) and journaled as they are today — a run whose
  permissions were auto-granted must be auditable after the fact. Nothing is silent.
- `maxRunSeconds` cancels the turn through the existing `cancel()` path, which already
  `settleAll()`s open questions. It has to be armed on the *session*, not on one prompt:
  a queue drain starts a second turn on the same run, and a deadline that reset with it
  would not be a deadline.
- Test: `test:autonomy` against `fake-agent.mjs`, extended to request a permission and an
  elicitation on demand — allow / deny / per-kind split / no-suitable-option / ask-timeout /
  run-deadline.

### Phase 2 — Schema + engine
- `db/schema.ts`: `routines`, `routine_triggers` (`ON DELETE CASCADE` off the routine),
  `routine_runs` (cascade off the routine; `session_id` **not** a foreign key, for the same
  reason `parent_session_id` isn't — the manager owns session teardown; plus `fire_id`,
  `verdict`, and the `skipped` status the fire conditions and quota floor write).
  `pnpm db:push`.
- `server/src/routines.ts` — `RoutineEngine`, modelled directly on `WorkflowRunner`: owns its
  key, its live-run count, `fire(routineId, {text, source})`, `recoverAtBoot()` (mark rows
  left `running` as failed — every run was this process's child), `cancelForRun`. A
  workflow-bodied routine hands off to `WorkflowRunner` on the run's own thread rather than
  prompting it, so the engine owns the fire and the run row and nothing else learns a second
  shape; `onFinish` actions dispatch from the same settle hook the run's prose is
  accumulated in.
- `nextFireAt` computation: add **`croner`** (zero-dependency, maintained, timezone-aware).
  Hand rolling a cron parser to save one dependency is the wrong trade for something that
  decides when unattended processes start, and the specific thing being bought is DST: a
  "daily at 09:00 local" routine meets a slot that does not exist each spring and one that
  happens twice each autumn, which is the bug nobody debugs because it fires once a year.
- Fold the sweep into `scheduler.ts` rather than adding a second interval — one loop, both
  kinds of due work, which is what makes "a routine and a scheduled message came due in the
  same second" have one ordering rather than a race.

### Phase 3 — HTTP surface
- `routes/routines.ts`: `GET/POST /api/routines`, `PATCH/DELETE /api/routines/:id`,
  `POST /api/routines/:id/run` (Run now, optional `text`), `GET /api/routines/:id/runs`,
  `POST /api/routines/:id/triggers`, `DELETE /api/routines/triggers/:id`,
  `POST /api/routines/triggers/:id/token` (mint/rotate, returned once).
- `POST /rt/<key>/<routineId>/fire` registered **outside** the `/api` bearer middleware in
  `index.ts`, beside the `/gw` and `/wf` comment that already explains the rule.
- Backup: routines, triggers and runs join `backup.ts`'s table list; trigger secrets follow
  the `secrets=0` blanking rule that profile keys and MCP env values already follow.

### Phase 4 — Client
- `lib/settings.ts`: `Routine`, `RoutineTrigger`, `RoutineRun` + the calls. Store slice and
  a `refreshRoutines`, exactly the `scheduled` shape.
- `components/routines-page.tsx` — list, detail (runs with status and a link into each run's
  thread), and a create/edit form that **reuses the draft config components**
  (`draft-config.tsx`'s profile/agent/model/effort pickers and `DraftToolsMenu`). If a picker
  cannot be reused, that is a signal the routine is storing something a draft cannot, and the
  answer is to fix the routine, not to fork the picker.
- Sidebar: the existing **Scheduled** group becomes **Automations**, with routines above
  scheduled messages. One nav row, two kinds, clearly labelled — a routine starts a new
  thread, a scheduled message speaks into an existing one.
- Autonomy control: a row per ACP tool kind over one three-way selector, with the blanket
  `default` last rather than first, and a confirm dialog naming the cwd on any widening to
  `allow`. The point of drawing it per kind is that the resulting sentence is checkable.
- **Dry run before autonomy.** "Run now" always exists; "Run now, forced to `ask`" is the
  first-class one, and a routine cannot be switched to a blanket `allow` until one run has
  completed. It is the difference between an informed grant and a dismissed dialog, and it
  costs a boolean on the routine.
- **A digest, not an archive.** The run list per routine is table stakes; the surface that
  makes standing autonomy tolerable is the cross-routine "what did these do since you last
  looked" — runs, verdicts, and every permission that was auto-answered, which Phase 1
  journals precisely so this can exist. `search.ts`'s index is most of it.
- Command palette: "New routine", "Run routine…".
- Push: a routine run's `turn_ended` already notifies; give it the routine's name.

### Phase 5 — Git event trigger
`workspace-watch.ts` + `git.ts`, debounced, per project: branch-moved and path-glob. The
routine, the run, the payload wrapper and the UI are unchanged from Phase 2–4; only the
trigger source is new. (A GitHub webhook receiver is the same trigger with a different
front door and is deliberately not in this plan.)

### Phase 6 — Consolidation (optional, deliberate, later)
`scheduled_messages` and a routine's schedule trigger are two cron-ish tables. They could
become one with a `target: "new-thread" | "session:<id>"` field, and the UI is already one
page by Phase 4. Worth doing only when both have settled; it is a data rewrite, which is
precisely the case CLAUDE.md reserves custom migration files for. Until then the two tables
keep two clean meanings, which is cheaper than a half-merged one.

---

## Non-goals

- **No sandbox, no network allowlist.** The harness runs on your machine, in your cwd, with
  your credentials — that is its whole premise. Routines inherit that and the UI says so
  instead of implying an isolation that does not exist.
- **No repo cloning, no `claude/`-prefixed push rule.** A project is a directory that
  already exists. If per-run isolation is wanted later it is a git worktree per run, which is
  a project-level feature, not a routine-level one.
- **No usage caps or billing.** Their daily run cap is a fleet-capacity rule. Ours is
  `MAX_LIVE_ROUTINE_RUNS` and `overlap: "skip"`, which is the local equivalent.
- **No per-agent autonomy flags.** Phase 1 is protocol-level on purpose. An agent's own
  permission mode remains reachable only as an ordinary advertised config option.

## Open questions

1. ~~**`ask` on an unattended run.**~~ *Settled:* `askTimeoutSeconds` + `askFallback` above.
   A run that fell through to the fallback is **`blocked`**, not `failed` — it is the state a
   person can act on, and it is distinct from the run that was refused something and carried
   on to say so, which is an ordinary completion. The fallback exists because the alternative
   was a run that parks at 02:00 and is cancelled at 02:30 having done and said nothing.
2. **Does a routine belong to a project, or does a trigger?** A git trigger names a project
   by construction. Storing the project on the routine and letting a trigger override it
   would allow "run this review in each of these three repos" from one saved config — nice,
   and it doubles the shape of the fire path. Recommend project-on-routine for Phase 2, with
   `fire_id` on `routine_runs` from day one so the fan-out is a later feature and not a later
   migration.
3. **Retire-on-settle vs keep-alive.** Workflow steps retire immediately. A routine run that
   a person is likely to open and continue might be worth keeping warm for a few minutes.
   Cheap to add later; start with retire-on-settle.
