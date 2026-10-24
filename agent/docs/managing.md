# Managing the agent from the harness

Short answer: **yes — everything except the base prompt.** How a thread uses the
runtime (profile, model, effort, mode, persona, tools) is managed per thread;
how the runtime is *launched* (command, args, env) is managed on the agent row
itself. What is left in source is the agent's own identity: its base system
prompt and its tool descriptions.

## What you can change from the UI

| What | Where | Costs |
| --- | --- | --- |
| **Credentials, endpoint, model catalog** | Settings › Profiles | live per request |
| **Model** | thread config menu, `⌘K` → Model | live (`session/set_config_option`) |
| **Effort** | thread config menu, `⌘K` → Effort | live |
| **Auto-compact** | thread config menu (Agent options) | live |
| **Permission mode** | thread config menu, `⌘K` → Mode | live (`session/set_mode`) |
| **Persona** (prompt append + effort) | Settings › Personas, then the thread's picker | a respawn, onto the same conversation |
| **MCP servers, skills, commands** | Settings › MCP / Skills / Commands, linked by a profile or picked on a draft | written at thread creation |
| **Working directory** | Settings › Projects | per thread |
| **The spawn command and env** | Settings › Agents → Edit | applies at the thread's next spawn |
| **Who answers permission prompts** | the autonomy policy | live |
| **Pause / resume the turn** | the composer's pause toggle (beside Stop), a workflow's hold toggle | live (`_daedalus/session/pause`) |
| **Continue a turn that failed** | the same toggle, after changing the model | live (`_daedalus/session/resume`) |
| **Continue a stopped subagent** | the parent agent uses `list_agents`, then `send_message` with the child ID or name | saved child conversation, resumed at a complete step |

Three of those are worth expanding.

**Pause is this runtime's, not ACP's.** The protocol's only interruption is
`session/cancel`, which throws the step in flight away; Claude Code and Codex
can be stopped and re-prompted, never held. This agent owns its loop, so the
harness's `_daedalus/session/pause` holds it at the next step boundary — after
the tool calls of the current step have finished, before the next model call —
and `resume` carries on with nothing lost, steering that arrived meanwhile
included. Subagents hold with their parent. A cancel while held ends the turn
as cancelled and drops the pause; a session paused with no turn open holds its
next prompt at its first step. A workflow run pauses the same way one level
up: no further step starts, steps on this runtime hold, and the clocks stop.

**A turn that fails waits instead of ending.** A rate limit, a spent quota or a key that
stopped working used to throw the whole turn away — twenty tool calls included — and leave
a Retry that paid for all of it again. Now the turn holds at the same step boundary a pause
holds it at, keeping every step whose tool calls came back, and says why. Change the model
(live, on the running process) and press the same toggle: the next model step goes out
against the new model and the turn carries on. Nothing recovers by itself — there is no
fallback model and no long backoff, because which model to move to is the one thing the
harness cannot guess. A thread with nobody in front of it — a workflow step, a scheduled
run — never holds; it fails fast, because the run is waiting on the turn to settle.

**Tool failures have a separate diagnostic log.** Every failed tool call is
appended to `~/.daedalus-agent/tool-errors.jsonl` (or the configured
`DAEDALUS_AGENT_HOME`). Each JSONL record includes the timestamp, session and
call IDs, tool name, workspace, model, complete input, and error name, message,
stack and cause when available. This file is separate from the transcript so
replay is unchanged; it is created with owner-only permissions. Inputs and
error details can contain workspace data or secrets, so protect and share the
file accordingly.

**The model list is live and it is not magic.** Because the agent is declared
`liveConfig: "acp"`, the server materializes the union of every profile's
catalog into `<cwd>/.claude/settings.local.json` before each spawn, and the
agent reads that file as the contents of its `model` selector. So a model added
to a profile is offered by a running thread after its next spawn, and switching
between models already in the list costs nothing. Switching *profiles* is live
too, as long as both are behind the gateway shim and the new one has a catalog —
the shim retargets the endpoint and rewrites the credential on the very next
request the child makes. A move to a profile with no catalog hands model choice
back to the agent, which is a different session state, so that one respawns.

**A persona is the supported way to change what it is told.** It is the only
prompt lever with a UI, it is per thread, and it survives the respawn it costs
(the new process ends in `session/load`, so the instructions land on the
conversation you already have). See [prompting.md](./prompting.md).

**Model prompts are the lever for engine-specific guidance.** The model a
thread runs on is a fact about the runtime, and different engines benefit from
different instructions (Qwen from one-call-per-message discipline, Gemini from
lean-answer nudges, and so on). The runtime has built-in family calibrations
that apply by substring on the model id, and a library of user-managed rows in
Settings › Model prompts that beat them whenever one matches. The lever is
deliberately not per thread: a row's `match` is a glob over the model id, so
one assignment covers every thread that runs that engine. The file is re-read
every turn, so a library edit or a live model change lands on the next pass
with no respawn — unlike a persona. See [prompting.md](./prompting.md).

## Editing the agent row

**Settings › Agents → Edit** writes the four fields that are the user's: the
display name, the `command`, its `args` and the `env` templates. That is
deliberately the same four the seed rules already promise never to overwrite —
a release's backfill only ever *adds* a key it introduces — so an edit made here
survives every future upgrade, and a built-in you have edited stays edited.

Everything else on the row stays the server's, because it is not a preference.
`spawnCategories`, `liveConfig`, `personaVia` and `quotaProbe` are statements
about what the protocol on the other end can actually do; telling the harness an
agent accepts a live model change does not make it accept one. **Reset to
default** puts a built-in back the way it ships (an agent someone added by hand
has no default, so it is not offered one).

Two consequences worth stating:

- **Nothing happens to a running thread.** The process it holds was spawned with
  the old command, and the edit reaches it at its next spawn — a respawn, a
  revive, a profile change — exactly like every other change to how an agent is
  launched.
- **The probe cache is evicted for that agent**, server-side (`agent_options`,
  keyed `profileId:agentId:cwd`) and on the device (`dropAgentOptionsFor`). The
  probe's answer is a function of the env that just changed, so a stale row
  would keep describing an agent that no longer exists — the same eviction
  `seedAgents` does after a backfill and `updateProfile` does on save.

Routes: `PUT /api/agents/:id` and `POST /api/agents/:id/reset`. The listing
reports a computed `builtIn` flag, which is only ever the question "is there
something to reset to".

## What a turn reports about tokens

The ACP `usage` a turn ends with says `inputTokens` for the part of the prompt
the provider had to read **fresh**, with `cachedReadTokens` beside it as a
separate figure — that is the convention every surface in the harness draws
from: the prompt is `inputTokens + cachedReadTokens + cachedWriteTokens`, and
the cache rate is the hit divided by that sum (`client/src/lib/tokens.ts`).

OpenAI-compatible `prompt_tokens`, which is the only dialect this runtime
speaks, means the whole prompt with `cached_tokens` counted *inside* it. So
`toAcpUsage` (`src/metering.ts`) subtracts the hit — and a cache write, which a
gateway reports in `prompt_tokens_details` and `normalizeUsage` lifts into the
SDK's standard slot — before reporting. Passed through raw, every cached token
was counted twice and the drawn cache rate was roughly half the real one.

**A turn is metered per model call, as each one answers** (`Meter`, fed by the
SDK's `onLanguageModelCallEnd`, which fires before any tool runs). Reading usage
off a stream's `finish` lost every call of a turn that was cancelled during a
tool, because an aborted stream never finishes; and a prompt that throws
carries its spend on the error (`data.daedalus`) since it has no response to
put it in. The root loop, its retries, its subagents, the compaction summary
and the title call all feed the one meter. A call's output speed is the SDK's
own timing and rides the prompt answer as `_meta.daedalus.generation`; a call
that arrived as one chunk has no decode to divide by and is left out of both
sides.

The context-window reading (`usage_update`'s `used`) is a different number and
deliberately untouched: it is the provider's own total for the last step, cache
hits included, because a cached token still occupies the window. Each step's
`usage_update` also carries the step's own bill (`_meta.daedalus.step`) and the
provider's cache counters (`_meta.cache`), exact.

A subagent's spend is part of the turn's answer: every child folds its total
into the same `usage` the turn ends with. Each Task child also reports settled
usage on the parent as `_daedalus/subagent_usage`, keyed by child session id,
for its own card's cost figure; this is attribution, not spend to add again.
The context-window gauge is the parent's alone.

## What a turn reports about each model call

Every provider request the turn makes is also one **`_daedalus/model_call`**
update (`src/trace.ts`), journaled on the session it belongs to — a subagent's
on the child's session id — and replayed by `session/load` like any other
update. It is the harness's one record of a model call whichever runtime made
it (`server/src/protocol.ts` `ModelCall`); this runtime's say `source: "acp"`.

The same two SDK callbacks feed it at the four places a model is called (the
loop, a subagent, the summarizer, the title call — `traced` in `src/turn.ts`
composes them with the meter's record): `onLanguageModelCallStart` carries the
request **exactly as sent** — instructions, messages and the prepared tool JSON
— and `onLanguageModelCallEnd` the bill, under one `callId`. The record says
`who` (`turn`, `subagent` + `childId`, `compaction`, `title`), its `step` within
the turn, the model, the finish reason, `ms` to the parsed response and the
SDK's time to first output, and three readings:

- **`billed`** — the provider's own counters, `acp.Usage` shaped, exact.
- **`prompt`** — where the prompt went: `system`, `tools`, `mcp` (tools named
  `mcp__…`), `user`, `assistant`, `results`, plus `unknown`. These are
  **estimates, anchored**: each part is counted locally with `gpt-tokenizer`
  (`o200k_base` ranks, so only exactly right when OpenAI's model is serving) and
  the provider's prompt total — fresh + cache read + cache write — is the truth
  the counts are shared out over. Every part seen, they sum to it exactly; a
  part a door could not see is `null`, named in words in `missing`, and its
  share is `unknown`. A fence `~` on the panel means this. Media is not counted
  and lands in the remainder rather than being guessed at.
- **`output`** — text, tool calls and reasoning; reasoning is the provider's own
  figure when it reports one, the other two share what is left.

**`items`** — which system section (or `##` heading) and which tool definition
is the big one, as raw local counts — ride only the first call of a turn and
any call after the prefix changed (a search loaded an MCP tool, a persona
rewrote the prompt; the key is a hash of the instructions text and the tool
names): it is byte-identical between the steps of a turn, and a turn is the
smallest window a reader ever loads. Both `step` and the "already said" memory
are kept per `who` and per child (`Tracer`), so a retried attempt keeps
counting, a second compaction in one turn is its step 2, and each subagent's
first call carries its own `items`.

The counting runs on the call's end, before the step's tools, so the record is
in the journal before anything the step does — and the message counts are
cached by content, so a step pays only for what it added to the history.

On the server the record is filed by the same path every other door's take
(`fileCall`, `server/src/model-calls/index.ts`): the `step` this runtime fills
is kept, the open turn and a `model_calls` ledger row are added, and the
thread's `session_config.callsVia` says `acp`. One request is still outside
it: a Compact asked for from the menu while the thread is idle
(`_daedalus/session/compact`, `src/app.ts`) runs the summarizer with no turn
and no hooks, so that call is neither metered nor recorded.

## What is still not editable

**The base system prompt and the tool descriptions**, which live in the agent's
own `src/turn.ts` and `src/tools/*.ts`. A persona appends to the first; nothing
replaces either. That is the intended line — a persona can say anything a
preference needs to say, and the base prompt is what the runtime *is*.

The natural next addition, if per-thread personas turn out to be the wrong
grain, is a **per-agent default persona**: a nullable `default_persona_id` on
the agent row, resolved in `personaSpawn` when a session names none. Not built.
