# One `agent` tool for subagents, asks and workflows (design)

Status: proposed. Nothing below is built. Dev phase: the old tool names go from the model's
view outright, but **old journals keep old shapes**, so every client reader for them stays.

## What is wrong today

A thread can hand work to another worker through three surfaces that do almost the same thing
and behave differently in every detail a model has to reason about:

| | `task` (Daedalus agent only) | `ask_agent` (`builtin:agents`) | `run_workflow` / `run_script` (`builtin:workflow`) |
| --- | --- | --- | --- |
| Runs as | a loop inside the agent's own process (`agent/src/turn.ts` `runSubagent`) | a one-step run, a real thread (`WorkflowEngine.ask` -> `launchAsk` -> `launch`) | an N-step run, a real thread per step |
| Pair | the session's, or a `role`/`model` | any (profile, agent); the thread's `ask_profiles` outrank the model | the parent's, `profile`/`agent` per step |
| Waiting | blocks the turn until the report | `waitSec` (max 55), then a `<task-notification>` | background, then a `<task-notification>` |
| Follow-up | `send_message` (agent store, `claimSubagent`) | `continue_agent` (new run, `resumeSession`) | `signal_workflow`, gates |
| Listing | `list_agents` = this session's children | `list_agents` = the (profile, agent) pairs | `list_runs` |
| Survives a restart | no: the in-flight child dies with the turn | yes (journal) | yes (journal) |
| Cap | none | `MAX_ASKS_PER_PARENT` = 4 | `ENGINE_LIMITS.runsPerParent` |
| Offered to | Daedalus agent | every runtime | runtimes without `workflowsVia: "native"` |

The cost shows up in the model's head first. A Daedalus thread linked to `builtin:agents` sees two
tools named `list_agents` that answer different questions, two follow-up verbs, and two waiting
models. It shows up in the code second: the server already treats an ask as a one-step workflow,
so the split between `ask_agent` and `run_workflow` is a *tool* split, not an engine split, while
`task` is the one surface on an engine of its own.

## The rule

**Handing work to another worker is one tool, `agent`, and every call makes a run.** What kind
of run is decided by the arguments, never by which tool was picked: a prompt alone is one step on
your own pair (a subagent), naming a pair makes that step another agent's (an ask), and `steps` or
`script` make it a workflow. Every run has the same id, the same notification, the same follow-up
and the same stop, because there is one engine underneath (`server/src/workflows/`).

## The tools

One MCP server, `agents` (`builtin:agents`), absorbs `builtin:workflow`. The leaf names:

```ts
agent({
  prompt?: string,            // one step: the whole brief
  description?: string,       // 3-8 words; titles the row and the child thread
  agent?: string,             // name or id from agent_list; absent = your own runtime
  profile?: string,           // only when the user named it
  model?: string,             // exact model id; wins over role
  role?: string,              // a model role (docs/model-roles.md), resolved server-side
  effort?: string,
  projectId?: string,         // another project's cwd
  steps?: StepDef[],          // a declarative workflow (today's run_workflow definition)
  script?: string,            // an orchestration script (today's run_script)
  args?: unknown,             // the script's / saved workflow's input
  name?: string,              // run a saved workflow by name
  timeoutSec?: number,        // opt-in cap; an errand has no clock by default
  waitSec?: number,           // 1-55; past it the answer is a <task-notification>
})

agent_status({ id, waitSec? })                  // wait_agent, wait_workflow, workflow_status
agent_message({ id, prompt? })                  // continue_agent, send_message, the default "continue"
agent_control({ id, action: "cancel" | "pause" | "resume" | "signal", event?, value? })
agent_list({ runs?: boolean })                  // the pairs, plus this thread's runs when asked
```

`list_workflows`, `save_workflow` and `delete_workflow` stay as they are, under the same server:
they manage the library, they do not hand work to anybody.

### Validation, not modes

- **The schema is flat and every shape field is optional.** No `mode` enum and no `oneOf`: some
  OpenAI-compatible providers reject union schemas, and a model fills a flat one more reliably.
- **Exactly one of `prompt`, `steps`, `script`, `name`**, checked in the handler and answered
  as a string error the model can act on, never thrown as a crash (the `resolveModel` idiom in
  `agent/src/tools/task.ts`).
- **The top-level pair is the default for every step**: `agent`/`profile`/`model`/`role` on the
  call apply to each step that names none, and a step's own wins. A one-step call is therefore
  not special. It is a workflow whose only step inherits everything.
- **`model` beats `role`, and `role` beats the pair's default**, as `task` does today.

### `steps` and `script` both stay

`steps` compiles to a script (`compileDefinition`), so `script` alone could express every
workflow. Both are offered anyway, on purpose:

- **Dropping `steps` deletes no code.** Routines store definitions (`routines.ts`, `definition`)
  and `/runs` takes one, so `graph.ts` and the compiler stay in the engine either way.
- **A graph is checked before anything spawns.** Cycles, duplicate names, reads of unknown steps
  and the step limit are rejected by `graph.ts` up front. A script fails mid-run, after the
  children it already ran have spent their tokens.
- **A model fills a schema more reliably than it writes code**, and the Daedalus agent runs on
  whatever OpenAI-compatible model a profile names.
- **The outline is always true.** A script may declare `meta.phases`, but nothing holds it to what
  the script then runs, so its outline can be wrong. A graph's outline is the graph itself.

The rule for the model, carried in the description: `steps` when the whole plan can be written
down before starting, `script` when its shape depends on what an earlier step finds. The cost is
schema size on every turn, so `steps` is advertised with a short description, and the full rules
are left to `graph.ts`'s errors, which already name the offending path.

### The schema is generated per thread

Like `rolesClause`, the description and the fields come from what the thread can actually use, so a
capability that is not on offer is not advertised:

- `steps`/`script`/`name`/`args` appear only where `AgentDef.workflowsVia !== "native"`.
  Claude Code keeps its own `Workflow`, by the rule in `docs/mcp-and-workflows.md`. This is read
  off the row, never off the id.
- `role` appears only when the vocabulary is non-empty, and its description lists the roles.
- `agent`/`profile` and the pair list in the description come from `WorkflowEngine.pairs`.

## How each shape runs

All three go through `WorkflowEngine.launch` with an `EngineSpec`. What differs is only what the
spec carries:

| Shape | Spec | Notification | Row drawn as |
| --- | --- | --- | --- |
| own pair, one step | one `agent()` call, no `ask` info | `<task-notification>` worded as a subagent | a plain subagent row |
| other pair, one step | today's `launchAsk` spec, `ask: AskInfo` | worded as an ask (`notification(view, ask)`) | a subagent row with `AskAgentChip` |
| `steps` / `script` / `name` | today's `run_workflow` / `run_script` spec | worded as a run | the workflow run card |

- **Own pair means the parent's profile, agent, model, effort and mode**, as a workflow step
  already inherits them. Persona, rules, links, worktree and project are the parent's for every
  shape, as today.
- **Another pair keeps the ask rules unchanged**: `ask_profiles` outrank the model, a missing
  choice raises the `askAgentPair` elicitation, a declined picker aborts, nothing falls back to a
  different pair, and the parent's model and mode ids never cross to another runtime.
- **`role` is resolved on the server** from the thread's `sessions.helper_models` (role -> model)
  against the vocabulary, the same lookup the agent does today from `DAEDALUS_AGENT_*`. An unknown
  role is an answer naming the known ones. A role is only meaningful on the parent's own profile.
  On another pair it is an error, because the role map names models in the parent's catalog.
- **One level, never a tree**, as both engines already enforce: a child is not handed `agent`.

### Follow-up and stop are one verb each

- **`agent_message` works on any run that is not running.** One-step runs do what `continue_agent`
  does now: a new run whose step carries `resumeSession` on the same child thread. A workflow run is
  continued the same way, by re-launching the step that failed or was stopped with its thread
  resumed, which is what `onRestart: "resume"` already does after a reboot. A running run rejects
  the message instead of racing, as `send_message` does today.
- **`agent_control` is the run's own door**: cancel, pause and resume are the `/runs/:id` routes,
  and `signal` is `signal_workflow`. `approve()` gates stay answerable only by the person in the app.

### Waiting

- **`waitSec` is the only waiting model.** A call returns when the run ends or the wait does,
  whichever is first. A run still going reports back as a `<task-notification>`, and one that ends
  inside a wait is handed to that waiter and is never said twice (`launch`'s `notify`).
- **The model is told not to poll**, in the one description, for every shape.

## The Daedalus agent's own `task`

The in-process `task`, `list_agents` and `send_message` (`agent/src/tools/task.ts`,
`agent-messages.ts`) are **withdrawn when the thread has the `agents` server**, and kept when it
does not:

- **Under the harness they lose to the server's `agent`.** Their children are not real threads:
  they cannot be opened, do not survive a restart, are not counted in any cap and are invisible to
  the inbox. Keeping both would put back the two-`list_agents` problem this design removes.
- **Without the harness they are all the agent has.** The agent is an ordinary ACP binary that
  "knows nothing about the harness" (`agent/docs/standalone.md`), so a session spawned by Zed or a
  script has no server to run a step on. The in-process loop stays there, behind the same
  `subagents: {}` capability it reports through today.
- **The gate is said, not inferred**, by one env key from the spawn, `DAEDALUS_AGENT_SUBAGENTS`:
  `harness` (a top-level thread: the `agents` server is there, so the three are dropped), `off` (a
  workflow step or an ask's child: one level, so neither the server nor `task`), and unset or
  `local` (standalone: the in-process loop). Reading "is the `agents` server among my servers" does
  not work, because a step child has no server either, and it would get the in-process `task` back,
  which makes a tree of the one-level rule.

### Always on for the Daedalus agent

On the Daedalus agent's threads the `agents` server is **on by default and cannot be turned off**.
The agent's only way to delegate is this server, so a thread without it has silently lost the
capability, and the in-process fallback is exactly what this design retires under the harness.

- **It is a column on the agent's registry row, never an id check.** Add
  `AgentDef.requiredMcp?: string[] | null`: the built-in library rows a runtime always gets, seeded
  `["builtin:agents"]` for `daedalus` and null elsewhere. A fork that repoints `command` repoints
  this with it, by the registry rule. Seeding backfills the field like `workflowsVia`. It is a
  descriptive fact, not one of the user's fields.
- **The server adds it to the union; links do not decide it.** `serversFor` folds `requiredMcp`
  into the thread's `effectiveLinks` before `mcpServersFor` filters on `linked`. So no stored link
  set, whether from a profile, a thread pick or an old row, can leave it out, and an unlink sent
  anyway changes nothing. The one-level rule still wins: a thread with `parentSessionId` gets
  nothing, required or not.
- **Workflows ride along with it.** `builtin:workflow` is folded into `agents` (see "The tools"),
  so requiring `agents` requires the workflow fields too, still gated by `workflowsVia`.
- **The pickers draw it on and locked.** `mcp-picker.tsx` already locks a row the profile
  supplies (`locked`, "from profile"). A required row takes the same switch, disabled and on, with
  the subtitle "required by <agent name>". The client reads `requiredMcp` off the agent row it
  already has (`lib/settings.ts`, next to `workspaceLayout`), so it compares no ids. The profile
  editor and the automation form draw it the same way for a profile or routine on that agent.
- **The library row cannot be deleted while a runtime requires it.** Built-in rows are not
  user-deletable today. If that ever changes, a required row is the exception.

## What it costs

- **Spawn latency for own-pair subagents.** An in-process child starts on the next model call.
  As a step, it is a new Daedalus process (the agent is not `sharedProcess`), about 0.4s by the
  installed-binary rule, plus `initialize`. Ten parallel subagents are ten processes. This is the
  main price, and it is paid for durability, an openable thread and a cap.
- **Blocking becomes background.** `task` hands its report back inside the turn. A run longer than
  55 s comes back as a later message. A model that used to delegate and wait now has to keep
  working or end its turn, which is the bargain asks already make.
- **Caps stay split by shape.** One-step runs on another pair count against
  `MAX_ASKS_PER_PARENT`, and everything else counts against `runsPerParent`, so consulting two
  agents still never locks a thread out of a workflow. Own-pair one-step runs need a number of
  their own (proposed: 8, counted apart). Without a cap, a model fanning out ten subagents takes
  every workflow slot.
- **One permission policy for children.** An ask child runs under `ASK_AUTONOMY`. An own-pair
  subagent today shares the parent's prompts. Proposed: every one-step run uses `ASK_AUTONOMY`
  (the call is the go-ahead for its brief), and what still parks is repeated on the parent, as it
  already is for every child (`SessionManager.emit`, `answerChild`).

## Client

- **`agent` is a leaf name the subagent reader already claims.** `extractSubagent`
  (`client/src/lib/tools/subagents.ts`) matches `isOneOf(item, ["task", "agent", "subagent",
  "dispatch_agent"])`, and `toolLeafName("mcp__agents__agent")` is `agent`. So the new call would
  first be read as a *native* subagent launch. The reader for the harness's own tool has to win
  before that one, and it is recognised by what it carries (`_meta.daedalus.ask`, the workflow
  meta, or the run id in its JSON answer), never by adding another name to that list.
- **Drawing does not change.** The three row shapes above already exist: `workflowInfoOf` finds a
  run, `askInfoOf` finds a pair, and neither finds a plain subagent.
- **Old names keep their readers.** `ASK_AGENT`, `run_workflow`, `run_script`, `send_message` and
  the agent's `task` stay recognised for journals written before this.
- **Additive on the wire**: a `FEATURES` entry (`agentTool`) in `server/src/compat.ts`, read with
  `useFeature` where the client has to tell the two tool families apart. No `API` bump.

## Delivery order

1. **Server tool** in `agents-mcp.ts`: `agent`, `agent_status`, `agent_message`, `agent_control`,
   `agent_list`, over the existing loopback routes, plus a route for own-pair one-step runs and for
   continuing a workflow run's step. `builtin:workflow`'s tools move under the same server.
   `ask_agent`/`run_workflow` and friends are no longer registered.
2. **Role resolution** on the server from `helper_models`.
3. **Required server**: `AgentDef.requiredMcp` in `registry.ts` (seeded for `daedalus`,
   backfilled), folded into the union in `serversFor`.
4. **Daedalus agent**: `DAEDALUS_AGENT_SUBAGENTS` from the spawn, and `buildTools` drops
   `task`/`list_agents`/`send_message` on `harness` and `off`.
5. **Client**: reader precedence for the `agent` leaf, the `agentTool` feature, required rows
   drawn on and locked in `mcp-picker.tsx` and the profile/automation forms, and copy that names
   the tool (`library.ts` row descriptions, the `suggest-agents` trailer in `personas.ts`).
6. **Docs**: fold the result into `docs/mcp-and-workflows.md` ("Asking another agent",
   "Workflows") and the rules file. The current rules naming `ask_agent`, `list_agents` and
   `send_message` are rewritten, not appended to.

Tests: `pnpm test:workflow-{engine,routes,step}`, `pnpm test:task-agent` and `pnpm test:acp-workflow`
on the server, `pnpm test:subagents` in the agent. The client has no test for
`extractSubagent` today; the `agent` leaf collision needs one.

## Open questions

1. **Own-pair subagents on runtimes with native ones.** Claude Code and Codex have their own
   in-turn subagents. Offering own-pair `agent` to them gives a durable alternative, and also two
   ways to do one thing. Option: a row column `subagentsVia: "native" | null`, read like
   `workflowsVia`, that hides own-pair runs where the runtime has its own. Default proposal: offer
   it everywhere and let the description say when to prefer which.
2. **The own-pair cap number** (8 is a guess) and whether it should be a setting.
3. **Continuing a workflow run**: whether `agent_message` on a multi-step run re-launches only the
   failed step or replays the whole script with completed steps served from the journal. The second
   is what recovery already does, and probably the right answer.
4. **Hiding the workflow fields by default.** Whether `steps`/`script`/`name`/`args` should be
   advertised only on threads that link workflows, so a thread that only delegates single tasks
   never pays for their schema.
