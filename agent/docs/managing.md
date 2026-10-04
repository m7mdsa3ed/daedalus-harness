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
`toAcpUsage` (`src/turn.ts`) subtracts the hit before reporting. Passed through
raw, every cached token was counted twice and the drawn cache rate was roughly
half the real one — a turn hitting cache on 89% of its prompt read as 47%, and
no amount of caching could have moved the figure past 50%.

The context-window reading (`usage_update`'s `used`) is a different number and
deliberately untouched: it is the provider's own total for the last step, cache
hits included, because a cached token still occupies the window.

The thread's Tokens panel is the only place a token figure is *estimated*, and
each `usage_update` carries what it needs in `_meta.breakdown`: the system prompt,
the built-in tool schemas and the MCP tool schemas, tokenized locally
(`src/token-breakdown.ts`), and the history by who wrote it — the user's
messages, the assistant's replies, the tools' results — counted locally by role
and then given **the provider's remainder in proportion** (`prompt_tokens` less
the static parts). Every part sums to the provider's prompt total. Message counts
are cached per message object, so a request counts only what is new. The first
step of each attempt, and any step after a tool search changed the set, also
carries `items`: the system prompt by named section (`systemSections` in
`src/turn.ts`, split again at each `##` heading) and each built-in and MCP tool's
definition, as raw local counts the panel scales to the part's figure. Non-text
media is not counted. Other runtimes do not send this breakdown, and the panel
infers one from the transcript instead (`client/src/lib/token-breakdown.ts`),
alongside the billed figures (fresh input, cache read and write, output, of which
reasoning), which are the provider's own. Nothing else — the context
popover, the step and turn popovers — reads `_meta.breakdown`.

A subagent's spend is part of the turn's answer: every child folds its total
into the same `usage` the turn ends with, so a turn that spent most of its
budget in three subagents no longer reports only the root's tokens. Each Task
child also reports settled usage on the parent as `_daedalus/subagent_usage`,
keyed by child session id, for its own card's cost figure; this is attribution,
not spend to add again to the parent's total. The context-window gauge is the
parent's alone — a child's steps measure the child's own, smaller window, and
writing them onto the parent made compaction threshold against a context the
parent never had.

## Tracing

The agent advertises `daedalus/trace` in `initialize`'s `agentCapabilities._meta`
and sends its OpenTelemetry spans up as the `_daedalus/trace` notification
(`{ sessionId, spans }`, epoch-ms times, attributes flattened to OTel's value
types, strings capped at 256 KB). A `session/prompt` (and `new`/`load`/`resume`)
carrying `_meta.traceparent` runs inside that context, so the agent's spans are
children of the harness's. The prompt answers only after its spans are flushed.

What comes up (`src/tracing.ts`): an `agent turn` span per prompt
(`daedalus.kind: "turn"`, carrying `retry` and `paused` events); the AI SDK's
GenAI spans from `@ai-sdk/otel` — `invoke_agent <model>` (`gen_ai.agent.name` is
`daedalus.turn`, `daedalus.subagent`, `daedalus.compaction` or
`daedalus.sampling`), `step N`, `chat <model>` and `execute_tool <tool>`, with
inputs and outputs recorded; a `compaction` span (`daedalus.kind: "step"`); and an
`mcp connect <server>` span per MCP server (`daedalus.kind: "process"`). A
subagent's run nests under its `execute_tool task` span. Every span carries
`daedalus.acp_session_id`; one without it is not sent.

Standard `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
(and the rest of the OTLP env) additionally export every span over OTLP/HTTP.

## What is still not editable

**The base system prompt and the tool descriptions**, which live in the agent's
own `src/turn.ts` and `src/tools/*.ts`. A persona appends to the first; nothing
replaces either. That is the intended line — a persona can say anything a
preference needs to say, and the base prompt is what the runtime *is*.

The natural next addition, if per-thread personas turn out to be the wrong
grain, is a **per-agent default persona**: a nullable `default_persona_id` on
the agent row, resolved in `personaSpawn` when a session names none. Not built.
