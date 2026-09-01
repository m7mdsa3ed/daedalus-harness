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

Two of those are worth expanding.

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

## What is still not editable

**The base system prompt and the tool descriptions**, which live in the agent's
own `src/turn.ts` and `src/tools/*.ts`. A persona appends to the first; nothing
replaces either. That is the intended line — a persona can say anything a
preference needs to say, and the base prompt is what the runtime *is*.

The natural next addition, if per-thread personas turn out to be the wrong
grain, is a **per-agent default persona**: a nullable `default_persona_id` on
the agent row, resolved in `personaSpawn` when a session names none. Not built.
