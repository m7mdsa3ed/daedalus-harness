# Profiles, models, config & personas

_Extracted from CLAUDE.md; the rationale behind the rules summarised there._

## The profile decides who owns the model

- **The profile decides who owns the model.** A profile that lists `models[]` has
  *overridden* the agent: those ids reach it as `{model}`/`{effort}`/
  `{contextWindow}` in the env template (`server/src/registry.ts`) — at spawn, which is
  no longer the same as *only* at spawn (see the live-reconfiguration note below).
  A profile that lists none defers to the agent, whose
  `category: "model"` / `"thought_level"` selectors apply through
  `session/set_config_option` — one call, safe mid-turn, no restart. The override is scoped
  to exactly those two settings: **every other agent option passes through untouched and
  stays live** in either case. This exists because an agent pointed at a gateway advertises
  its own catalog, which the endpoint does not serve — codex derives its effort list from
  the *current model's* metadata, so an unknown gateway model id yields no effort selector
  at all. **The profile's catalog is therefore written out as the agent's catalog** where an
  agent will read one: codex looks a model up by *slug* in its built-in list and an id it has
  never heard of gets invented metadata (`Model metadata for … not found. Defaulting to
  fallback metadata`) — a made-up context window, so compaction fires at the wrong point.
  `model_context_window` does not silence it; only `model_catalog_json` does, and it takes a
  *path*. So `server/src/model-catalog.ts` writes `data/model-catalogs/<profileId>.json` on
  spawn and `{codexModelCatalog}` in the env template points at it. It buys the metadata and
  **not** the selectors, which is worth stating because it was once assumed to buy both:
  measured against codex-acp 1.7 / codex 0.150, `listModels` ignores the catalog file
  entirely — it answers with codex's own built-ins plus a synthetic entry for whatever
  `CODEX_CONFIG.model` names (a slug invented for the test comes back the same way), that
  entry carries no reasoning levels, and `set_config_option` answers `Invalid params` for
  every catalog model but the spawned one. Which is why codex's live model change is the
  shim's and not the agent's. **Only the catalog itself silences the warning** —
  nothing in one file can stop codex emitting it — so a profile that has already
  given its models their numbers (and has had enough of the nag) can suppress the
  *notice* instead: `suppressModelMetadataWarning` is a profile column that the
  bridge honors by dropping the matching `agent_message_chunk` before it is
  journaled (`isFallbackModelMetadataWarning` in `server/src/acp-bridge.ts`). It
  hides exactly and only codex's fallback-metadata wording; anything else the
  agent warns about, or a codex build that cannot take a catalog at all, still
  surfaces. **A model a profile does not
  name is a model the gateway picks**, and the quietest one is the *second* model Claude
  Code runs its cheap side-jobs on — the Bash permission classifier among them, which is
  what `auto` mode's verdict is. Unnamed, the endpoint maps the built-in Haiku id onto
  whatever it calls cheap; when that is an experimental preview it flaps and the classifier
  fails closed, so an ordinary build is refused while the main model on the same endpoint is
  healthy. `{smallModel}` fills `ANTHROPIC_DEFAULT_HAIKU_MODEL` *and*
  `ANTHROPIC_SMALL_FAST_MODEL` (the var was renamed across releases and the harness does not
  pin the binary), and resolves to the session model — always, with no per-profile cheap
  pick any more: a profile means "run everything on this model", and a second id is one more
  the gateway may not serve. The same rule, for the same reason, pins Claude Code's model
  *aliases* — `ANTHROPIC_DEFAULT_SONNET_MODEL`/`_OPUS_MODEL`/`_FABLE_MODEL` all carry
  `{model}`, because the CLI switches to them on its own (entering plan mode upgrades a
  haiku-alias session to `sonnet`; `opusplan` resolves opus/sonnet across the plan boundary)
  and each names a built-in Anthropic id a gateway does not serve, which killed turns with
  `model_not_found` the moment one fired. A profile with no models at all resolves all of
  these empty and the keys prune away, which hands the choice back to the agent exactly as
  it does for `ANTHROPIC_MODEL`. An entry carries far more than
  numbers (`base_instructions` is codex's whole system prompt), so none is invented: `codex
  debug models` prints the built-in catalog and each entry is its flagship model with the
  identity, context window and efforts swapped. No `codex` on PATH, or a profile with no
  `models[]`, means no file, an empty placeholder and the key pruned away — the agent keeps
  its own catalog. `lib/session-options.ts` does the sorting from the ACP `category` field; unknown
  and missing categories fall through to "Agent options" rather than being dropped, and an
  agent advertising no model selector gets no Model row — the client never invents one.
  **A profile changes the model and the effort, and nothing else.** It is credentials and a
  catalog, not a way of working, so a respawn must not reset how the agent was configured.
  `POST /api/sessions/:id/respawn` is therefore **atomic and server-side**: it captures the
  permission mode and every non-model/effort option from the live bridge, kills the process,
  spawns, `session/load`s, and puts the settings back before it answers, skipping whatever
  the new session already agrees with (`AcpBridge.captureRestoreState` / `applyRestore`).
  Driving that from the browser is what used to leave a half-restored thread when a tab
  closed halfway through. Both menus read Profile → Model → Effort, with mode and the rest
  under "Agent options", because the profile decides what the two lists below it can contain.
  Profile changes always confirm (new credentials, new endpoint, new catalog; the model does
  not carry over). After a live change the server records `session.model`/`effort` itself —
  it knows the option's `category` — so reviving a retired thread rebuilds the right env.

## Live reconfiguration

- **Being env at spawn does not mean being env forever: profile, model and effort all
  change on a running agent now, and `POST /api/sessions/:id/config` is the one door.**
  It answers `{live}`, and a falsy answer means it fell through to the same respawn as
  before — so the client sends every pick the same way and only reconnects when told to
  (`actions.changeThreadConfig`). The decision is `SessionManager.applyConfig`, server-side
  for the reason respawn already is. Two mechanisms underneath, and which one an agent gets
  is `AgentDef.liveConfig`, declared with the agent beside `spawnCategories` (which still
  only ever said which knobs are env):
  **the endpoint and the credential are the shim's, not the child's.** `{gatewayUrl}` now
  resolves to `/gw/<key>/s/<sessionId>/<agentId>` — the *thread*, not the profile — and
  `proxyGatewayRequest` resolves that thread's current profile per request through a
  resolver the SessionManager registers (`setGatewaySessionResolver`). Moving a thread to
  another provider retargets the very next call the child makes, `x-api-key` /
  `Authorization: Bearer` rewritten to the new profile's key in whatever shape they
  arrived. The probe has no thread and keeps the old `/gw/<key>/p/<profileId>/<agentId>`
  form, which is why the path carries a kind at all.
  **The model is the agent's own selector where it will take one (`"acp"`, claude-code) and
  the shim's rewrite where it will not (`"gateway"`, codex).** Claude Code's picker is built
  from `availableModels` in the settings the SDK resolves for the cwd and *only* from there
  — `CLAUDE_MODEL_CONFIG` reaches the SDK query but never the picker, and a value the picker
  does not offer is refused — so `materializeModelAllowlist` merges the ids into
  `<cwd>/.claude/settings.local.json` (the gitignored tier; the user's own keys and entries
  survive, and a `.daedalus-models.json` manifest beside it is what makes the sweep take
  back only what it wrote). Verified end to end against claude-agent-acp 0.70: with the ids
  allowlisted *and* a custom `ANTHROPIC_BASE_URL` set, `set_config_option` moves a live
  session onto a gateway id and `query.setModel` accepts it; without the base URL the SDK
  refuses the id as unrecognized, which is exactly the Default profile, which is exactly the
  case that still respawns. The allowlist is the **union across every profile that serves
  the agent**, not the thread's own: it is read once at `session/new` and a thread outlives
  its profile choice, so a narrower list would put the *next* profile's models out of reach
  and cost the restart this is here to avoid. **A profile with no catalog writes no
  allowlist at all**, which is the one thing the union cannot say: `availableModels` is a
  *replacement*, so a Default-profile thread spawned in a cwd some gateway thread had
  written opened a picker of that gateway's ids and none of the agent's own — a profile that
  overrides nothing must impose nothing, and an empty list drops the key back to whatever
  the user had. Nothing is lost by narrowing it, because a move on or off a catalog-less
  profile is exactly what `applyConfig` refuses to do live, so the respawn that carries the
  thread there writes the next list. The **probe writes it too** (`probe.ts`), for the same
  reason it materializes the profile's skills: its whole job is to answer what a thread on
  this pair would offer, and reading whatever the last spawn in that cwd left behind
  answered for a different profile. It is in the probe's **cache key**, hashed beside the
  cwd — the allowlist changes the answer exactly as the cwd does, and one profile gaining a
  catalog widens (and so invalidates) its siblings', which `updateProfile`'s own eviction
  does not reach. Codex gets none of that; the shim replaces
  `model` and `reasoning.effort` in the request body it is already reading for the namespace
  repair. `rewriteModel` is what says a body is worth reading at all — true for a
  `"gateway"` agent whose thread has a catalog, and true for **any** live-configured agent
  whose profile has changed since it spawned, because its env still spells the old
  provider's ids (for Claude Code that is the side-job and alias vars, which the main
  model's ACP switch does not touch). False otherwise, which is the ordinary turn, which
  still streams straight through. What `applyConfig` refuses to do live, and hands to
  `respawn` instead: a different agent (a different runtime), a thread that is not behind
  the shim or is moving to a profile that would not be, a move to a profile with no catalog
  (that hands model and effort back to the agent, which is a different session state and not
  a value to set), a model the running bridge will not confirm it offers (`offersModel` —
  the alternative to asking is being refused with the thread's record already changed), and
  a thread with no live process, which is a revive. A live change fans out as the
  **`spawn_config`** event: absolute like `session_config`, live-only and *not* journaled
  (it is the session row's state, and a peer attaching later reads the row), and sent to
  every peer *including* the one that asked, because the server is what resolves a cleared
  model into the profile's default. The one thing that does not survive the move: Claude
  Code rebuilds its option list around the new model, and for an id its SDK does not
  recognize that means the permission mode can clamp (`auto` → `default`) and the effort
  selector can disappear — both arrive as ordinary updates, so the menu stays truthful, and
  effort was never in claude-code's env anyway, so a restart would not have placed one
  either.

## What a change costs, and who waits for it

- **A change that costs the process is staged when it is picked; the next spawn takes it.**
  This is the third answer `POST /api/sessions/:id/config` can give — `{live:false, staged}`
  — and it is now the *ordinary* one rather than a mid-turn exception. The reasoning that
  produced it mid-turn holds everywhere: a model or persona pick is a change the next
  **spawn** is what reads, so a spawn is what should pay for it, and taking it at pick time
  bought nothing. Mid-turn it cost somebody's work. Idle on a live thread it restarted an
  agent for a user who was still reading the answer. Idle on a *retired* thread it was worse
  than either — it woke a process up for nobody, and the next message then revived that
  thread a second time. Staged, the pick costs nothing and the send costs one spawn.

  So `applyConfig` puts it in `session.stagedConfig` (in memory, never a column: a server
  that restarts has already lost the process the patch was picked against, and `caught_up`
  normalises `staged ?? null` so a reattach clears the banner rather than leaving a ghost),
  and **two mechanisms take it, no third and no timer**:

    1. **`respawnNow` folds it into any spawn that was happening anyway** — the revive behind
       a send, a rewind's cut, the `/respawn` route, the scheduler's. Callers pass the row's
       own values and get the user's newest ones. It is a **value substitution**, never a
       re-entry: the tempting version calls `flushStagedNow()` at the top of `respawn()`,
       which recurses through `applyConfig(defer:false)` → `restartWith` → `respawn` and
       spends two spawns on one revive. The fold re-validates the patch's profile
       (`profileSupports`) and falls back to the caller's rather than failing — a revive must
       not die because a setting nobody is watching went stale — and emits its own
       `config_notice` rows and `spawn_config`, which `restartWith` never duplicates because
       a patch it folded is one that path had already dropped.
    2. **`prompt` flushes before it starts a turn**, so nothing runs on settings the user has
       moved off. It is the one door every turn comes through — the socket's send, the
       scheduler, routines, autonomy — and the bridge is **re-read after the flush**, because
       the respawn replaced the process and the old `session.bridge` names a killed child.

  A **queue drain never flushes**: it calls `startTurn` directly and never reaches `prompt`,
  which preserves the old `continued` rule — no restart between two messages the user sent
  together. Neither does a **steer**, and `!bridge.promptActive` is the one term that
  expresses both: past the queue branch, a live turn means this prompt is joining one.

  There is **no `turn_ended` flush** any more. It was fire-and-forget (so a failure reached
  nobody) and it restarted the agent the instant a turn ended, for a user who might read for
  ten minutes and never reply.

  Three things are never staged. `defer:false` is the explicit "now, and never mind what it
  costs" — the menu's Apply now, which the route reads as "the staged patch, plus whatever
  this call adds". A **held** turn is stopped *waiting* for exactly this change (see the
  `paused` event), so staging it behind a boundary it will never reach is a change that never
  happens. And an **agent** change is not a setting on this process but a different runtime:
  `StagedConfig` cannot carry one — a mid-turn agent change used to be staged and then
  silently dropped at flush — and it must not learn to, because a respawn onto another binary
  ends in a `session/load` of an id living in the *old* runtime's store. Nothing drives it
  from the UI (a started thread's agent is fixed at draft time, `draft-config.tsx`); the
  guard exists so a script or a workflow cannot either.

  **A flush that fails re-stages and refuses to send.** `applyConfig` drops the patch *before*
  it announces the restart — so a peer reattaching at `ready` cannot be handed a stale one —
  which makes putting it back the flush path's job. It has to go back: otherwise the pick is
  lost by the one failure the user is actually watching. A patch whose profile has been
  edited or deleted since is **dropped with a `config_notice`, never thrown**, and the send
  proceeds on current settings: this code runs inside a prompt.

  The patch travels as **`staged_config`**: absolute, live-only, not journaled, carried on
  `caught_up` beside the queue and the hold, and fanned to every peer including the one that
  asked — a change staged from a phone has to be visible on the laptop.

  **The cost, stated plainly:** the spawn and its `session/load` move onto the critical path
  of Enter, where they used to run in the background while the user read. The journal is kept
  across it (`restart.kept`), so the transcript does not move; the composer stays submittable
  through `reviving`, so the message is already on screen while it happens; and "Apply now" is
  there for anyone who would rather pay it up front.
- **The route answers the decision; the restart reports itself.** `applyConfig` used to hold
  its HTTP answer open across spawn → `session/load` → restore — seconds of a blocked
  request for a decision that took none — while every device that was *not* holding the menu
  was told nothing at all and folded the reload's re-narration into its transcript as though
  it were news. Now the answer is `{live:false, restarting:true}` and the sequence emits
  **`restart`**: `started` (stop folding — what follows is a journal being cleared and
  refilled), then `spawn_config` + `ready` (the row as it ended up, then reattach from 0,
  because every cursor into the old log names nothing), or `failed` carrying the reason. The
  client's gate is `ThreadConnection.restarting`, which drops what the doomed socket is
  handed, and the rebuild is `seamless` — one commit at `caught_up` instead of a frame at a
  time, because the transcript on screen is a correct rendering of this very conversation
  and there is nothing to gain from watching it disappear. **The early answer is conditional
  on the caller saying it can hear the events** (`follow`, true when the client holds an
  attached socket): one that cannot gets the old bargain, the answer waiting for the
  restart, because the alternative is a client racing a respawn by re-reading a journal that
  is being cleared.
- **The client shows the pick before the network has it.** `ThreadState.pendingConfig` is an
  *overlay* on the session row, not a patch of it — the row is the server's and
  `refreshSessions` replaces it wholesale, so a patch would be undone by the next list
  refresh — and `configView(row, thread)` is the one reading every surface draws: the row,
  under what is staged, under what this device just picked. It is cleared by the answer
  (`spawn_config`, or `restart: failed`), and it survives the `thread-reset` an attach
  performs, because the attach *after a restart* is the moment it matters most.
- **Picks are coalesced.** A model and then its effort is two clicks a second apart, and each
  used to be its own POST and its own respawn, the second queued behind the first on
  `respawnChain`. `actions.changeThreadConfig` buffers into a module-level map and
  `flushThreadConfig` sends it — on the menu closing, which is what says the user is done,
  or after `CONFIG_COALESCE_MS` for a menu left open.
- **Nothing asks first.** Persona, profile and the suggestions toggle used to open a
  confirmation before they would move, and the model did too whenever a restart was likely
  mid-turn: four dialogs in front of four menu rows, for changes that are all reversible (the
  conversation comes back through `session/load`). What the dialogs were really protecting
  was the running turn, which is now protected by staging it. What is left is an **Undo on
  the toast that follows a restart** — offered only there, because a live change is instant
  and already drawn in the menu that made it, and a toast per model pick is noise on the one
  path that never surprised anyone.

## The queue

- **A message typed into a running turn is queued, not steered — and the queue is the
  server's.** `session_queue` (`server/src/queue.ts`, storage only) holds it per thread,
  ordered, cascaded with the row, so it survives a tab closing and a server restart and is
  drained with nobody attached. A `prompt` arriving while `bridge.promptActive` is enqueued and
  answered `{queued, itemId}` — only the server knows whether the turn is still open, the
  browser's `turnActive` is a hint (a `{queued}` reply to a prompt the client sent optimistically
  is what `drop-user-message` takes back). Steering is the explicit `prompt {steer:true}` /
  `queue_steer` (⌘⇧Enter), which joins the turn through the old `inflight++` path. The queue
  travels as the `queue` event — **absolute** like `session_config`, never a delta, fanned to
  every peer *including* the origin because the ids are minted here — and is not journaled: it
  is current state, handed over on `caught_up` the way a pending permission is handed over
  after the replay. A drain combines **everything** queued into one blank-line-separated
  prompt and starts one turn on it with no origin peer, so every device draws the user bubble
  from `turn_started`. It hooks `AcpBridge.settleTurn` → `host.onTurnSettled`, after
  `turn_ended` is journaled, and only after a turn that ended **cleanly**: a Stop or a failure
  parks the queue on the shelf (`stopReason: "cancelled"` is a *success* on the wire, which is
  why the bridge reads it now), and nothing drains on revive either — a profile-change respawn
  must not fire a parked queue. The `turn_ended` before a drain carries `continued: true`, so
  neither the toast nor the push says "Turn finished" about a turn that is about to continue.
  "Send now" (one item, or all) is atomic and server-side like respawn — `cancel()` (which now
  also `settleAll()`s the open questions, as ACP asks of a cancelling client), `whenIdle()`,
  prompt — serialised on `session.queueChain`, which also stands the auto-drain down so nothing
  goes twice; rows are deleted only after the prompt is dispatched, so a process dying mid-wait
  leaves the queue as it was. The three edits (`queue_update/remove/clear`) are answered with no
  bridge, like `load_earlier`: a parked queue on an archived thread is the user's words, and
  taking one back must not cost a spawn. The scheduler gets the rule for free: a scheduled
  prompt that lands mid-turn waits its turn. The row is `components/composer-queue.tsx` on the
  strip (summary id `queue`).

- **Escape stops the turn AND takes back the message that has not landed** — `cancel
  {reclaim:true}`, answered `CancelReply {reclaimed?}`, and the words go back in the composer.
  A send made a second ago costs one key to undo, and a cancelled turn no longer leaves a
  queued row parked behind it that nothing will drain.

  Atomic and server-side for `sendNow`'s reason, and the **ordering is the mechanism**: a
  cancel settles the turn, `settleTurn` treats a settle as a step boundary and `flushSteers`
  emits every held steer as the real bubble it was waiting to become — so `SessionQueue.stop`
  takes the message back *before* it cancels. Two round trips from a browser could not
  guarantee that.

  **Exactly one message, the newest by `createdAt`**, because the composer is one box; a steer
  and a queued row are weighed against each other rather than by which list they are in.
  Everything older stays parked with its own Edit and ✕.

  A **queued** row never left this server, so taking it back is total. A **held steer** is the
  one that carries the "unless a new step read it" rule: its words went out at send, but its
  `turn_started` sits in `bridge.pendingSteers` until a step boundary, and while it is there
  `AcpBridge.takeSteer` unwinds it with no bubble and no journal row. Past that boundary
  nothing comes back — the words are in the transcript, which is where they belong — and that
  is an answer, never a reason to reach past it for an older message. (`ponytail`: the runtime
  still has the steer buffered from the `session/prompt`; making the take-back total on its
  side needs a withdraw it participates in, i.e. an `AgentDef` column.)

  **`reclaim` is opt-in, and only a caller with somewhere to put the words may ask**: the
  message is gone from the queue when it is answered, so `actions.stop(id, {onReclaim})` is
  how Escape and the composer's Stop ask, and Retry, the palette and the thread menu leave it
  unset. **Only into an empty box** (`ComposerHandle.isEmpty`) — a reclaimed message must not
  land on top of something typed since. A held `config_notice` is not a message and is never
  handed back.

## The gateway shim

- **Claude Code reaches a profile's gateway through the harness's own shim, because a
  gateway that streams correctly can still answer a non-streaming call in the wrong
  shape.** Every main-loop turn streams, and that is the path a Claude-Code-on-a-gateway
  router is built against; the CLI's *side queries* — the auto-mode permission
  classifier above all, plus titling, memory selection and the rest of `sideQuery` — call
  `messages.create` without `stream` and read `response.content` off the JSON. 9router
  forces streaming towards providers that need it and re-assembles the SSE into JSON for
  the client as an OpenAI `chat.completion` for every client format but Responses, so a
  Claude-format caller gets `choices[]` where it expects `content[]`; the CLI's text
  extractor throws (`undefined is not an object (evaluating 'e.filter')`), the classifier
  reports "<model> is temporarily unavailable" and **fails closed** — a web search or a
  build refused in auto mode while the main model on the same endpoint is healthy. The
  model override cannot touch that (the classifier *is* on the profile's model; the error
  names it), so `server/src/gateway-shim.ts` sits in front: the claude-code seed's
  `ANTHROPIC_BASE_URL` is `{gatewayUrl}` (seed 8; the backfill moves only a key still
  holding the exact seeded `{baseUrl}`), which `resolveSpawn` fills with
  `http://127.0.0.1:<port>/gw/<key>/<profileId>/<agentId>` — or with the raw `{baseUrl}`
  when no shim is configured, and with nothing at all for the Default profile, so the key
  still prunes. `proxyGatewayRequest` resolves `profileBaseUrl(profile, agent)` per request
  and forwards everything byte for byte — streaming replies are piped — and reads a body
  only for one of two repairs. The Claude Code one is on the *response* only: a `2xx`
  `application/json` reply to a path ending in `/messages` that parses as a chat completion
  is rewritten into an Anthropic `message` (`chatCompletionToMessage`: thinking/text/
  tool_use blocks, `stop_reason`, usage with the cache counters split back out), decided on
  the response content type so a multi-megabyte prompt costs the shim nothing. The Codex one
  is on `/responses`, and it is the mirror image: Codex ≥ 0.148 declares every MCP server
  as a `type: "namespace"` tool that no translating gateway keeps (it collapses or drops
  it), so the request's namespaces are flattened into bare member functions
  (`<namespace>__<tool>`) and every `function_call` in the reply is put back under its
  namespace, in the SSE events and in a buffered JSON reply alike. **The flat name can
  outgrow the 64-character function-name cap every OpenAI-compatible provider enforces** —
  Codex 0.150's built-in app servers alone flatten to 66
  (`mcp__codex_apps__codex_document_control___execute_document_command`), declared on the
  very first turn
  whether used or not, so an unshortened flattening is a first turn that dies with
  `name must be at most 64 characters, got 66` before a token streams. An over-long flat
  name is shortened to fit — truncated, with a hash tail of the full name for uniqueness
  (members of one namespace share their prefix) and for determinism (a replayed call must
  flatten to the name the model already called) — and the map travels with the request to
  expand the call back under its real member name on the way home; a function name the
  agent itself wrote over-long is the agent's, not the flattening's, and travels untouched.
  The key in the path is the
  credential, exactly as `/ide/<key>/` — the route is unauthenticated because the CLI
  carries its own `x-api-key` for the gateway, and a bare `/gw/<profileId>/` would be an
  open relay to whatever URL a profile names; it is minted per boot and never stored, since
  its only readers are children this process spawns and a restart kills those anyway.
  `pnpm test:gateway` drives it against a stand-in gateway that answers like 9router.

## A profile is a provider; a thread is a (profile, agent) pair

- **A profile is a provider, not an agent, and a thread is a (profile, agent) pair.**
  `profiles.agents` is a JSON map keyed by agent id (`ProfileAgentLink`), not a single
  `agent_id`: the credentials, catalog and default model on a profile are gateway data,
  and binding them to one runtime meant entering the same key and model list once per
  agent. The key set is the contract — which agents the profile can spawn — and the value
  carries the one thing that genuinely differs per agent on a gateway, an optional
  `baseUrl` override (`profileBaseUrl` in `profiles.ts`: LiteLLM-style routers serve
  Claude Code at an Anthropic-messages path and Codex at an OpenAI-responses path). The
  agent is therefore chosen at draft time and lives on the **session** (`sessions.agent_id`,
  which already existed): `POST /api/sessions` takes `agentId` and `sessions.create`,
  `respawn`, `spawnAgent` and `probeAgentOptions` all take it explicitly; `resolveProfileAgent`
  lets it be omitted only when the profile names exactly one agent (the virtual Default, or an
  older client). A respawn keeps the session's agent unless told otherwise — a profile change
  is new credentials, never a new runtime — and refuses a profile not configured for it, which
  is also why both config menus list only profiles that serve the thread's agent. On the
  client, `Profile.agents` replaces `agentId`, `lib/agent-options.ts` is keyed
  `optionKey(profileId, agentId)` (what codex offers on a gateway is not what Claude Code
  offers on it), `thread-defaults` remembers the agent too and `resolveThreadStart` degrades
  the pair one half at a time (the agent is the stickier habit: a remembered profile that no
  longer serves it loses to the first profile that does). Migration `0019` filled every
  existing row with `{ [agent_id]: {} }`; it was written by hand under `generate --custom`
  because drizzle-kit's rename prompt needs a TTY and its table-rebuild for this diff
  selected a column the old table did not have.

## Personas

- **A persona is how a thread wants to be worked on, and it goes in through each
  runtime's own door.** A thread already said who answers (the agent), on whose
  credentials (the profile) and with which engine (the model); it could not say
  "think this one through", "just chat, don't touch the files" or "smallest
  change that works". Effort is the nearest existing lever and it is a number on
  a dial, not an instruction — and on a gateway profile the agent frequently
  offers no dial at all. So `personas` is a library table (`server/src/personas.ts`,
  Settings › Personas) seeded like `DEFAULT_AGENTS` — the same `since`/`introduced`
  pair, so a persona added in a later release reaches existing installs and one
  the user deleted stays deleted — carrying a **prompt append**, an optional
  **thinking budget** and an optional **effort**. `sessions.persona_id` names it,
  and like the other three ids on that row it is **not** a foreign key: a deleted
  persona reads as none at the next spawn, which is what "deleted" should mean.
  The point of the design is that **nothing is pasted in front of the user's
  message** — the prompt the user typed is exactly the prompt that is journaled —
  because all three runtimes have a real slot for this and `AgentDef.personaVia`
  says which, declared with the agent for the reason `spawnCategories`/`liveConfig`/
  `quotaProbe` are. `"acp-meta"` (claude-code) is `_meta` on `session/new`:
  `systemPrompt` as an **object** is merged over the agent's own
  `{type:"preset", preset:"claude_code"}` with type and preset locked, so
  `{append}` adds to the CLI's prompt where a *string* there would replace it
  wholesale; and `thinking` goes inside `claudeCode.options`, which the adapter
  spreads straight into the Agent SDK's query options. Thinking is a **separate
  axis from effort** — the agent exposes both and they do different things — so
  `null` means "leave the runtime's default alone" and `0` means off, and the two
  must never be conflated. `"env"` (codex, opencode) is a key in the agent's own
  config template, filled from `{personaPrompt}` (inline text — codex's
  `developer_instructions`, which appends, and **not** `base_instructions`, which
  replaces codex's entire system prompt and is not a `ConfigToml` key) or
  `{personaFile}` (a path — opencode's `instructions` is a list of *files*).
  `{personaPrompt}` is **JSON-escaped in `resolveSpawn`** and is only ever correct
  inside a JSON string literal, which is the only place a template names it: a
  persona is prose full of quotes and newlines, and substituted raw it closed the
  string it sat in, leaving CODEX_CONFIG unparseable — which `resolveEnvValue`
  then passes through whole, unpruned. The file goes in `data/persona-prompts/<sessionId>.md`
  beside the generated model catalogs, deliberately **not** in the project's cwd:
  that directory is shared by every thread of the project, which is the hazard
  `materializeFor` exists to manage. It is rewritten — or deleted — on every
  spawn, so a thread that has just had its persona taken away does not leave the
  old text on disk for the next spawn to point at.
  **Changing it always costs a respawn**, and that is not conservatism: `_meta` is
  read at `session/new`/`session/load` and codex's config at spawn, so no runtime
  we ship can be told mid-process. It joins the four cases `applyConfigLive`
  already refuses as a fifth, and the respawn is cheap in the way that matters —
  it ends in `session/load`, which claude-agent-acp forwards `_meta` into, so the
  new instructions land on the *existing* conversation rather than an empty one.
  A persona's **effort applies when it is picked and never again**: otherwise the
  persona wins every argument — drop "Think more" to medium, change model, and
  the respawn silently puts it back on high. A workflow step inherits its
  parent's persona along with everything else, because a step is the same actor
  working in another thread and a parent on "quick fix" must not spawn steps that
  refactor. Named *persona* and not *mode* because `mode` is already ACP's
  permission modes (`current_mode_update`, the palette's `mode` page) and codex's
  collaboration mode. The picker is a row in both config menus above Profile (it
  is the one choice there that does not depend on one), a palette page, and the
  settings library page — which is the only one of the four libraries with **no
  Import**, since nothing in the agents' own configs is a persona to import.

## Rules

- **Rules are the standing layer of instructions, and they ride the persona's
  doors.** A block written once — one global (`app_settings`, Settings › Rules)
  plus one per project (`projects.rules`, edited with the project) — that every
  thread spawns with, instead of being retyped into each persona.
  `spawnRules` composes general to specific (`server/src/rules.ts`) and
  `resolvePersonaSpawn` folds the result into the spawn instructions **beneath**
  the persona text, so each runtime carries it through the door it already
  opens — `_meta.systemPrompt.append`, `{personaPrompt}`, `{personaFile}` — and
  no door learns rules exist. A thread with rules and no persona spawns with
  just the rules. **Spawn-time like a persona**: live threads pick a change up
  on their next respawn, which `session/load` makes cheap. Backup carries the
  table as a `settings` record and imports it **upsert per key, never a
  delete** — a bundle written before the table existed defaults to `{}` and
  must not wipe rules written since.

## The virtual Default profile

- **Every agent gets a virtual "Default" profile**, listed first. `defaultProfileFor`
  synthesizes `default:<agentId>` — no credentials and, deliberately, no `models`, which is
  what hands model and effort back to the agent per the rule above. It is offered for every
  agent, not just unconfigured ones: "run this agent as it ships" is a real choice next to
  "run it on my gateway", and without it the only way back would be deleting the profile.
  Never written to `data/`, cannot be edited or deleted. `profiles.ts` is the single source:
  the same function feeds `GET /api/profiles` and `getProfile` at spawn.

## The option probe

- **A draft cannot ask a process that does not exist**, so `lib/agent-options.ts` (a
  reactive device-local store, same shape as `pins.ts`) holds each profile's option set from
  two sources: whatever a live session last advertised, and — when nothing is known yet — a
  one-shot `POST /api/profiles/:id/options` (body carries `agentId`, since a profile may serve
  several). A pair that has no set of its own borrows the same agent's from a sibling
  profile (Default first) for display — the profile only
  overrides model/effort, everything else is the agent's — while its own probe still runs
  and replaces the borrowed set. The probe spawns the agent, runs the handshake as far as
  `session/new`, and kills it (`server/src/probe.ts`). The answer is cached **in the
  database**, keyed `profileId:agentId:cwd` (cwd is in the key because it changes the answer),
  with an in-flight map so two tabs asking at once spawn one agent, not two — so it is one
  spawn ever, not one per page-load, and `?refresh=1` is the escape hatch for an upgraded
  binary or a changed gateway catalog. Picks are held on the draft, sent as `configChoices`
  in `POST /api/sessions`, and applied by the bridge right after `session/new`. The probe's
  answer also carries the agent's **`modes`** — which daedalus advertises only on that
  channel, so without storing it the one runtime you own would be the one you cannot start
  in plan mode. The store keeps it beside the options, the draft renders a Mode row from it
  (first row of Agent options, like the live menu), and the pick travels as `modeId`, not in
  `configChoices` — a mode goes over `session/set_mode`, not `set_config_option`, and the
  bridge applies it right after `session/new`, guarded on the agent's own advertised list.
  **Which options exist can depend on which model is selected** — opencode reveals `effort`
  only for its reasoning models, in the `set_config_option` *response*, with no
  `config_option_update` notification. So the probe does not just snapshot the current set:
  while it has the process up it walks the model list (capped at `MAX_MODEL_SWEEP`, and it
  logs when it truncates), recording what each model advertises, and the menu reads the
  entry for the model actually chosen. One spawn, the whole map. Still best-effort — a
  different cwd or an upgraded agent invalidates it — and the real set replaces it as soon
  as a session answers.
  **A thread that already exists asks the same question**, and that is not a special case
  of the draft's: `SessionConfigPopover` runs the same `learnAgentOptions` when the thread
  has advertised nothing *and* nothing is remembered — an archived thread with no process,
  a plain reattach (no call in it carries an option set), a device that has never drafted
  on this pair. The draft menu used to be the only writer, so the only way to make an old
  thread's Model/Effort rows appear was to open a new thread first and let it fill the
  store. It is gated on there being nothing to draw, because the answer costs a spawn: a
  live session is already the authority, and a pair borrowing a sibling's set already has
  something true to show. The store is device-local, so **saving a profile drops its
  entries** (`dropAgentOptions`, from the profile form) — the credentials, endpoint and
  catalog are what decide the answer, `learnAgentOptions` refuses to re-ask a pair it has
  a set for, and the server evicts its own probe cache on that same PUT.
  A profile write invalidates the **agent registry along with the profiles**
  (`useInvalidateProfileCatalog`), since every agent's virtual Default is synthesized from
  it — an agent the client last read at boot leaves a Default profile in the list that no
  registry entry answers for. Returning to a hidden tab re-reads both on the query's own
  focus refetch, per slice and only for the slices something is drawing: the client is a
  PWA that stays open for days, and a profile added on another device — or an agent a
  server upgrade started offering — was otherwise invisible until a reload.
