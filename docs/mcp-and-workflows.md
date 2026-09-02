# MCP servers, skills, commands & workflows

_Extracted from CLAUDE.md; the rationale behind the rules summarised there._

## Built-in MCP servers are library rows

- **The harness's own MCP servers are library rows, not profile toggles.** Web search and
  the knowledge base used to be `webSearch`/`knowledge` opt-ins on the profile (with per-profile
  search overrides); they are `mcp_servers.type = "builtin"` rows now — `BUILTIN_MCP` in
  `library.ts`, fixed ids `builtin:web-search` / `builtin:knowledge` — linked by a project, a
  profile or a thread exactly like any other server. The row is a *handle*: it stores no
  command, env or credentials, and `mcpServersFor` resolves it at spawn to `websearchServer(config)`
  (config.json's backend, live, so a token is never cached in a row) or `knowledgeServer(project)`
  (the thread's project id in env — which is why it could never be a stored command). A linked
  web-search row resolves to *nothing* while search is unconfigured: a tool that cannot answer is
  not advertised. `session.websearchViaMcp` — what makes the bridge disallow Claude Code's own
  WebSearch/WebFetch and what gates usage recording — is now "the resolved list contains it",
  for any agent. **The disallow travels with an allow rule for `mcp__web-search`**
  (`AcpBridge.claudeMeta`): a disallowed tool becomes one of the session's
  `alwaysDenyRules`, which the auto-mode classifier's prompt lists as "User Deny Rules" with
  a standing order to block the same effect reached through another tool — and a web search
  through our MCP server is exactly that, so it was denied as circumvention of a rule the
  harness wrote, and the model told the user to edit their settings. Allow rules resolve
  before the classifier is consulted; verified with the CLI on the same gateway (two denials
  → none). `POST /api/mcp-servers/builtin/:kind` (`mcpServers.ensureBuiltin`) is the
  "Add web search" / "Add knowledge base" button on the MCP page, idempotent by id, and a
  built-in row has no Edit (nothing to edit) but can be deleted. Migration `0021` linked every
  profile that had a toggle on to the injected row before dropping the columns.

## OAuth MCP shim

- **An HTTP MCP server that demands OAuth is fronted by a second shim, and the child never
  holds the token.** The MCP 2025-06-18 auth spec makes such a server an OAuth 2.1
  *protected resource*: 401 with `WWW-Authenticate: Bearer resource_metadata="…"`, RFC 9728
  metadata naming an authorization server, RFC 8414 metadata on that, RFC 7591 dynamic
  registration (there is no out-of-band client id for a personal tool), code + PKCE with the
  RFC 8707 `resource` indicator, and a short-lived bearer to refresh. `server/src/mcp-oauth.ts`
  is the protocol half — discovery, registration, both grants, the store — on the SDK's
  exported primitives (`discoverOAuthProtectedResourceMetadata`,
  `discoverAuthorizationServerMetadata`, `registerClient`, `startAuthorization`,
  `exchangeAuthorization`, `refreshAuthorization`) and deliberately **not** `auth()` or an
  `OAuthClientProvider`: those are written around a transport instance that owns the
  connection, and here the connection belongs to an agent in another process. We want the
  primitives, not the loop. The credential is attached by `server/src/mcp-shim.ts`, the same
  bargain `gateway-shim.ts` already states — *the endpoint and the credential are the shim's,
  not the child's*: the agent is handed `http://127.0.0.1:<port>/mx/<key>/<serverId>` and the
  token is resolved per request. The alternative — writing `Authorization: Bearer …` into the
  row's static headers at spawn — is ten lines and broken, because those headers are fixed at
  `session/new`, an access token lives an hour and a thread lives days: the first refresh
  window that passes mid-turn kills every tool on that server for the rest of the process. A
  credential that expires cannot be delivered as a constant. Proxying instead buys every
  consequence the gateway shim buys: **no agent learns a word about it** (`agent/src/mcp.ts`
  does not change, which is the test of whether this is in the right place), refresh is
  transparent and mid-turn, revocation stops the *next* tool call rather than waiting for
  every thread to respawn, and an upstream 401 is recoverable — refresh once, retry, and only
  a second refusal clears the row and writes `lastError`. Refreshes are **coalesced by an
  in-flight map**, like the option probe's, because a turn opens several tool calls at once
  and a refresh token is frequently single-use — two concurrent refreshes is how an account
  ends up disconnected. `mcp_servers.auth` is a **stored** answer (`probeMcpAuth` sets it,
  from the form's Check and from the probe it runs on save), never a typed one, because a
  spawn must not make a network call to find out what to hand the agent; the tokens are a
  table of their own (`mcp_oauth`, `ON DELETE CASCADE` off the row) so `backup.ts` can blank
  three columns rather than reach into a row of mixed provenance, so connecting is an insert
  rather than an edit that collides with somebody renaming the server, and so deleting the
  server takes the tokens with it. An **unconnected** server is not advertised to the agent
  at all — `mcpServersFor` returns `{servers, skipped}` and the thread's tools read-out marks
  the row, following the rule the built-in web-search row already sets, that a tool which
  cannot answer is worse than an absent one. The browser half is three routes:
  `POST /api/mcp-servers/:id/authorize` (probe, DCR, PKCE, park the flow, answer an
  `authorizeUrl` the settings page opens in a popup), `GET /oauth/mcp/callback` — outside
  `/api` and unauthenticated **by necessity**, since an authorization server redirects a
  browser there and no bearer survives that hop, so **the `state` is the credential**: 32
  random bytes, single-use (deleted on first read), a ten-minute TTL, and it *names* the
  parked flow rather than being reflected into it — and `DELETE …/authorize`, which revokes
  at `revocation_endpoint` best-effort and always forgets locally, or a dead AS would make a
  server permanently un-disconnectable. The redirect URI has to match what was registered
  byte for byte, so it is `config.json`'s `mcpOauthRedirectBase` when set and otherwise
  derived from the request that started the flow — `X-Forwarded-Proto`/`X-Forwarded-Host`,
  then `Host`, and **never `Origin`**, which is the client bundle's origin (5173 in dev)
  where the callback route lives on the API's. A base that has moved **re-registers** rather
  than reuses: DCR is free, and an AS refusing a redirect it never saw is a dead end nobody
  can diagnose. Two things the shim has to get right beyond forwarding: the legacy HTTP+SSE
  transport opens with an `endpoint` event carrying a path for subsequent POSTs, which
  resolved against the proxy's origin misses the `/mx/<key>/<serverId>` prefix and posts into
  nothing (`rewriteEndpointSse`, the only place the shim looks inside a body — the shape
  `renamespaceSse` already has); and the `resource` indicator names the **real** server's
  canonical URL, never the proxy's, since a token minted for the proxy is one the upstream
  rejects. The documented escape hatch for a server this flow cannot handle is still a stdio
  row running `npx mcp-remote <url>` — it works today with no code, at the cost of running
  the flow on the *server's* machine (so a phone can authorize nothing), tokens in
  `~/.mcp-auth` outside the database and outside `backup.ts`, and a node process per server.
  `pnpm test:mcp-oauth` drives the whole of it against a stand-in authorization server and a
  stand-in protected MCP server.

## Workflows

- **Workflows are the harness's where the agent has none.** Codex and OpenCode have
  nothing like a workflow, so `builtin:workflow` is a third library row beside web search
  and the knowledge base — an agent that links it gets the `workflow` MCP server, and the
  server then disallows any native `Workflow` and allows `mcp__workflow`
  (`AcpBridge.claudeMeta`, `workflowViaMcp`), for exactly the classifier reason the
  web-search pair exists.

  **Claude Code keeps its own, by rule and not by configuration** (`ownsWorkflows` in
  `serversFor`): linking the server to it would disallow its native `Workflow`, and those
  are one switch. Enforced at spawn rather than left to whoever edits a profile's links,
  where applying half of it silently costs a tool.

  **There are two engines here now, and the second runs a program the agent wrote.**
  That reverses the rule the first was built on — stated at the top of
  `workflow-schema.ts` and repeated below — and it was reversed on purpose, because the
  rule cost more than it bought. What a script buys is not convenience but *capability*:
  fanning out over a list the run itself discovered, looping until a search goes dry,
  having agents judge each other's findings. A static graph cannot express any of those,
  and Claude Code's own workflows are built almost entirely out of them, so every agent
  without a native workflow tool — the entire reason `builtin:workflow` exists — was being
  handed a strictly weaker instrument.

  What makes it affordable is that the agent writing the script **already runs shell
  commands on this machine**. A script can do nothing a `Bash` call could not, so the
  `node:vm` context in `workflow-script.ts` is not a security boundary and is not asked to
  be one: it keeps an honest script from reaching what it has no business touching, and
  makes the failure legible when it does. The isolation that matters is unchanged — every
  agent a script spawns is a real child session carrying the parent's permission mode.

  **One runner serves both.** A script run's `def` is the very `WorkflowDefinition` the
  declarative engine reads, except that it *grows*: each `agent()` appends the step it
  spawned, so `runStep` — with its repair turn, its clocks, its pause and its cancel — is
  the one path an agent of either engine takes, `workflow_runs` keeps one kind of record,
  and the client card learns nothing new. `meta.phases` is the outline, which is why it
  must be a pure literal: a card draws a run's shape from its first step, and a shape known
  only by running would leave nothing to draw. A phase the script enters that `meta` never
  declared is appended rather than refused — a stage that ran is a stage the reader must
  see.

  The API is Claude Code's, name for name (`agent`, `parallel`, `pipeline`, `phase`,
  `log`, `args`, `budget`), so a script written for one engine runs on the other. That
  includes the awkward part: `Date.now()`, `new Date()` and `Math.random()` all throw. A
  run that reads a clock cannot be replayed, and a harness whose scripts quietly diverge
  from the documented ones would be worse than one with none. They are patched *inside* the
  realm, because that is the only place its own `Math` and `Date` can be reached —
  injecting the host's would be worse than useless, since `{...Math}` copies nothing (its
  methods are non-enumerable) and a script mixing realms gets `instanceof` answers that are
  true in one and false in the other. The return value crosses back through a JSON round
  trip for the same reason: everything the script built has another realm's prototypes.

  **A definition is still the right answer for a pipeline you can write down in full.** It
  is validated before anything spawns — duplicate names, cycles, a template reading a step
  it never waited for — where a script's only pre-flight is that its `meta` parses. Two
  tools, and their descriptions say which is which.

  A definition is **declarative JSON**
  (`server/src/workflow-schema.ts`: named steps, `dependsOn` edges, `{{inputs.x}}` /
  `{{steps.y.output…}}` templates, an optional JSON-schema `output` that buys the step one
  repair turn before it fails) and never a script: the server does not interpret an agent's
  payloads, and it must not start interpreting a *program* an agent wrote — steps, edges and
  templates are data it can validate up front (duplicate names, a cycle, a template that
  reads a step it did not *directly* wait for, a schema `z.fromJSONSchema` cannot compile),
  draw, and replay. **Phases are sugar over those edges, not a second scheduler.** A
  definition is written either as flat `steps` or as `phases: [{name, steps}]` — named stages
  that run one after another, the steps inside one side by side — and the phase form is
  *desugared at parse time*: every step of phase k gains a `dependsOn` on every step of phase
  k-1, so `readySteps`, `dependentsOf`, the cycle check and the skip cascade never learned
  what a phase is. `WorkflowDefinitionSchema` therefore ends in a `.transform`, and the
  engine only ever sees one shape: a flat `steps[]` (each carrying its `phase` tag) plus a
  `phases[]` outline. Two rules come with the barrier. A template may read any step in a
  **strictly earlier phase** without declaring an edge — the barrier is the guarantee a
  direct dependency otherwise provides, and it is the whole ergonomic point, since otherwise
  every stage would have to restate the one before it — while a step in the *same* phase
  still needs the edge, because siblings run together. And a `dependsOn` pointing at a later
  phase is refused by name rather than as a "cycle", which is what `findCycle` would have
  called it. **Every step is a real thread**: `sessions.parent_session_id` names its
  parent, it has its own transcript, is searchable, openable and revivable, and is created
  **on the parent's own profile, agent, model and effort** — a step is the same actor working
  in another thread, never a second identity — with the parent's links, the title
  `<wf> · <step>` and the parent's `captureRestoreState()`, so a step does not ask what the
  parent would not. The parent sees it through **the RFD's own events**: the runner (`workflows.ts`)
  emits `subagent_spawned` on the parent, every `update` the child journals re-addressed
  with the child's `sessionId`, and `subagent_state_update` when it closes — all as ordinary
  journaled `update`s through `SessionManager.emitOn`, so the client learned nothing new
  and replay is free. The spawn's `_meta.daedalus.workflow` names the run (`runId`, workflow
  name, step, index/total, this step's `phase`) — decoded only in `lib/tools/subagents.ts`
  (`workflowInfoOf`), stamped onto the `SubagentItem`, and folded at view time by
  `mergeWorkflowRuns` (`transcript-rows.ts`) into one `workflow-group` row per run, which
  `WorkflowRun` (`thread-items.tsx`) draws as a **compact preview card that opens the run
  in a dialog** — instead of N stray subagent rows, and instead of the phase-banded table
  the card itself used to hold: a run is N whole threads, and a transcript column is the
  wrong room to read one in (the table fought the panel for width, and a step's events
  ended up in a pane inside a card inside a transcript). The card answers the passing
  reader's questions and nothing else: a header (an icon chip in the run's state tint,
  the run's name, its **fact line**, the state as a word in `WorkflowPill`), **one
  progress bar** (`RunProgress`), and a foot line that live says the stage and step being
  written plus `currentActivity` (the newest call still open — `summarise`'s counts
  describe what a working step did a minute ago) and settled-failed names the step that
  failed. The whole card is one button (children are spans — a button holds phrasing
  content), with a standing `Maximize2Icon` hint: hover is not the only way in, just the
  first one discovered. Its `aria-label` carries the state and the count, because the bar
  is presentational inside a button and the fact line is spans. **The bar is one bar.**
  It replaced a segmented track with a slot per stage sized by weighted flex and a
  "frontier pill" floating over the live slot to name the stage — three mechanisms to say
  *2 of 9, one failing*, which is what the fact line beside it already says in words; the
  card is read in passing at the width of a transcript column, and which stage the run is
  on is said on the foot line, where there is room for it. **The fact line is `RunFact[]`,
  derived once and drawn twice** (`RunFactsInline` on the card — spans, one truncating
  row, because the card is a button; `RunFactsBlock` in the dialog header, where there is
  room to label each figure): the figure leads and the noun follows it, where four
  dot-joined phrases of equal weight were a sentence to read rather than a reading to
  take. A failure **count** is one of them, because a run that has moved on from a failure
  still has to admit to it where the foot line no longer can. Every state colour anywhere
  comes from one table (`WF_TONE`/`wfTone`, a `chip` and a `bar`), because surfaces each
  picking their own let a failed step read destructive in one and merely muted in another;
  it carried a `text`, a `fill` and a `border` too until nothing painted them any more,
  and a colour nothing paints is a colour that drifts.
  **The dialog is one scrolling list, top to bottom, and nothing else.** It restates the
  card's header (it covers the transcript, so it must say which run it is showing) over a
  single column: a stage is a heading (`WorkflowPhaseHeading` — the name, a rule filling
  the rest of the line, the elapsed time and its `done/total`), a step is a row
  (`WorkflowStepRow` — state mark in a tinted square, the definition's step name, a live
  `currentActivity`, duration and tokens, a chevron), and a pending step is the same row
  greyed (`WorkflowPendingRow`, trailing `waiting` rather than a blank, since a column of
  blanks reads as missing data rather than as work not yet done). **Opening a step expands
  its transcript underneath its own row** — the very same `SubagentBody` a step draws on
  its own, which is what `SubagentStep` was split around — one at a time, so a run of nine
  steps still costs one mounted transcript. This is the third shape and the reason the
  other two went: a board of columns with an overlay pane came first, then a timeline of
  nodes on a rail with a grid of cards, and both spent the dialog's geometry on *drawing*
  a sequence that a list states for free, and then needed a second surface (a pane, a Back
  button) to show a step, because the first surface had been spent on shape. The list has
  one scroll, one column at every width, one reading order — the order the steps run in,
  where a responsive grid of cards reordered itself as the dialog was resized — and one
  way in and out of a step. Progressive disclosure in place, no layout that reflows under
  the cursor, and a shape that grows as steps arrive are what a CI run view is judged on,
  and they fall out of the list rather than being fought for on top of it. The dialog is
  sized to the run now (`md:h-auto` between a floor and the screen, and 52rem rather than
  72rem): a board had to fill a fixed box or its columns had nothing to stand in, and a
  run of four steps in a box built for twenty reads as a dialog that failed to load.
  **Opening the dialog lands on the list and never on a step** — auto-expanding answers a
  question the reader has not asked and pushes the run off the screen at the moment they
  asked to see it — though a step opened last time stays open. Every row states its state
  as `sr-only` text, since the mark that states it is an icon.
  **The shape is drawn before it happens**: the same stamp carries `plan`,
  the whole outline (phases and the step names in them), repeated on *every* spawn — so
  the bar's denominator and the dialog's list show every step of the definition from the
  first spawn, the ones the runner has not reached yet drawn as `WorkflowPendingRow`s, and
  `phasesOf` is what joins the outline to the steps that have started. Repeating it is
  what keeps it journaled and replayed for free: an outline sent once would have to be an
  event kind of its own, and a view built only from spawns can only ever say what has
  already happened. A flat definition's outline — and every ad-hoc batch — is one phase
  named `null`, and gets **no heading at all**, as does a definition that turned out to
  have exactly one stage: a heading over the whole list is a level with one child, and the
  run's own name is already above it. That is also what a journal written before phases
  existed replays as, since `phasesOf` falls back to the arrived steps when there is no
  plan.
  A settled step's duration is start-to-last-activity (`lastActivityAt`): nothing records
  when a step *ended*, and the reducer never marks one done. Only `update`s are mirrored: a child's
  `turn_started`/`turn_ended` on the parent's log would cut the parent's replay windows at
  turns it never had. The mirror is said twice, so it is counted once — `emitOn` raises
  `emit`'s `mirrored` flag and the web-search usage ledger skips it, and `indexEventRow`
  (`search.ts`) skips any `update` row carrying a `sessionId`, or every search hit inside a
  step came back twice.
  What a step *cost* takes the same route, for the same reason: tokens travel in exactly
  one place on the wire (`turn_ended`), which is not mirrored, so the runner lifts the
  `Usage` out of the child's settled turn and says it again on the parent as
  **`_daedalus/subagent_usage`** — the harness's own update variant, declared beside the
  RFD's in `protocol.ts`, journaled and replayed like the spawn and the state, one per
  settled turn (a repair turn sends a second and the client sums with `addUsage`). It is
  stamped onto `SubagentItem.usage`; the child's `usage_update` — already mirrored, and
  until now dropped as session-level — is stamped onto `SubagentItem.context`, because a
  step *is* a session and its window is not the thread's. Drawn only when the
  **`showTokens`** view option is on, as a bare figure wherever the surface is itself a
  button (`TokenFigure`: the step row, the dialog's step tab, the run card's subtitle,
  which sums its steps) and as the figure with a hover breakdown where it is not
  (`TokenSummary`: the step panel's header, and the turn footer). The turn footer is the
  same slot the Sources strip sits in — `finishedTurns` in `thread-view.tsx` is the one
  anchor both hang off — and reads `ThreadState.turnUsage`, the per-turn readings kept
  unsummed beside the running total and matched to a position by the `turnId` on the
  message that opened the turn. A Task-tool subagent gets no figure at all: its tokens
  are inside the parent turn's own reading, and counting them again would say the same
  tokens twice.
  **Inside a turn the same question is answered by `usage_update`, which is not the
  running context total its name suggests**: both runtimes that send one fill `used` with
  the *last model request's* own token count (claude-agent-acp from the assistant
  message's `message_start`/`message_delta` usage — main loop only, `parent_tool_use_id ===
  null`; codex-acp from `tokenUsage.last`), which is a step's bill — the context that
  request carried plus what it wrote. So the figure is real and only its **owner** has to
  be inferred, which is `markStepUsage` (`lib/store.tsx`, into `ThreadState.stepUsage`
  keyed by item id): a request reports twice, once as it opens with nothing written yet and
  once as it closes with the steps it decided on already in the transcript, so a reading
  whose **tail item has not moved** since the last one is the next request opening and is
  dropped, and one whose tail *has* moved is filed against that tail. One figure per model
  request, on the step it ended with — which is why most rows in a run carry none, and why
  the tail is the last **top-level** item (a reading arriving while a rail fills belongs to
  the Task call that owns the rail, not to the deepest row). Drawn by `StepTokens` — read
  through `StepTokensContext`, provided once in `thread-view.tsx`, since the two rows that
  print it (`ToolStep`, and a settled thought) are memoized per item several layers down —
  and written `~12.4k tokens`, the tilde being the difference between a figure an agent
  *reported* and one matched to a position. A re-fold (`onRewind`) clears the map and the
  cursor with the items, or the widened window's first reading would be measured against a
  position from the last fold.
  ACP's `PromptResponse` carries no text, so a step's answer is
  accumulated from its `agent_message_chunk`s in the same `subscribe` hook (capped at
  `LIMITS.outputBytes`); `whenTurnSettled(sessionId, turnId)` is how the runner waits,
  settled from `hostFor().onTurnSettled` (which gained `turnId` for it) and rejected by
  `processGone`, so a child that dies mid-step fails the step rather than hanging the run.
  `parent_session_id` is **not a foreign key**, and the `sessions` row's own comment says
  why: an SQL cascade would delete the children's rows underneath the manager's in-memory
  map — their journals, FTS rows and processes are the manager's to take down — and a backup
  merge inserts sessions in bundle order, where a child may precede its parent inside the one
  transaction; so `softDelete`/`restore`/`purge` cascade to `childrenOf` by hand, children
- **A native (Claude Code) workflow run is drawn as the same row, from a different
  source.** A harness run's steps are real threads, so they arrive as `subagent_spawned`
  and fold through `mergeWorkflowRuns`. A dynamic workflow's agents live inside the CLI:
  they have no session anyone can open, and no ACP frame carries them. What the runtime
  does emit is a `workflow_progress` array on the SDK's `task_progress` — one entry per
  phase and per agent, with the script's own label, the phase, the state, the model, the
  tokens, the tool count and the tool it is on — **restated in full on every beat**, so it
  is a snapshot and is *replaced* rather than accumulated (`AsyncTaskItem.progress`).

  It is the only live source, and both alternatives were tried and measured before this
  was built. The `journal.jsonl` beside the run — which `tasks.ts` still tails, and which
  was all the harness had — holds nothing but `started`/`result` lines keyed by an agent
  hash, which is why a native run drew as a column of anonymous dots. The full snapshot
  (`<session>/workflows/<runId>.json`) has the whole shape but **is not written until the
  run reaches a terminal state**, verified by watching a live run's directory: during the
  run only `scripts/` exists. A post-mortem file cannot drive a live view.

  **Four things had to be true for the stream to arrive, and only the first was
  obvious.** Each of the other three swallowed the whole run in silence, and each
  was found by driving a live workflow and reading the journal rather than by
  reasoning — which is what `server/scripts/smoke-native-workflow.mjs` exists to
  repeat.

  1. The adapter republishes background work as an AIR async-task lifecycle
     (`async_task_spawned` / `_progress` / `_state_update`) but only to a client
     that advertises the capability, which the harness now does
     (`AIR_ASYNC_TASKS_META`).
  2. It dropped `workflow_progress` on the floor while copying the rest of the
     beat. `pnpm patch:acp` puts it back in two lines
     (`server/scripts/patch-claude-acp.mjs` — idempotent, refuses rather than
     guesses when upstream moves, guarded by `test:acp-workflow` so an adapter
     upgrade cannot quietly undo it).
  3. The SDK's `session/update` router validates every frame against a closed
     union and logs-and-drops anything else, so all three variants died at the
     door. They ride the same detour the subagent RFD already uses
     (`SUBAGENT_UPDATE_KINDS`), which is why that constant is no longer only
     about subagents.
  4. The adapter pins `showInTranscript` to false for **every** task, because the
     SDK sends the `background_tasks_changed` level before `task_started` and a
     level carries no transcript policy. Marking the task panel-only keeps that
     decision monotonic, so a late `skip_transcript` cannot retract a card it had
     already drawn — right for a task whose kind it does not yet know, and always
     wrong for this one, so the reducer does not consult it for a workflow.

  Without step 2 a run still earns its name, its live totals and its terminal
  state — everything except the per-agent tree — so that degradation is a smaller
  card and never a broken one. Without 1, 3 or 4 there is no card at all, which is
  why each of them now has a test standing on it.

  What the run reads by is the runtime's `description` — the model's one-line
  summary of the workflow — and not the script's `meta.name`. That is not a
  choice: the level announces the task before `task_started` carries the name,
  the adapter publishes a name exactly once, and no later frame can correct it.
  The summary is the better label anyway.

  **A step opens into its agent's own transcript, read off disk.** The progress
  array says what an agent is *doing* and never what it did, so a step drawn
  from it alone has nothing under it — which is what a reader notices first.
  The CLI does keep the history: one `agent-<agentId>.jsonl` per agent beside
  the run's journal, in its own record format. `TaskTailer.agentTranscript`
  (`POST /api/tasks/agent`) hands those lines back **unread** — the server does
  not interpret an agent's payloads — and `workflowAgentItems` turns them into
  ordinary `ThreadItem`s in the `lib/tools` quarantine with every other vendor
  shape. They then become rows through the same `buildRows`, so a step's steps
  draw with the same tool views, the same rail and the same nesting as
  everything else, and nothing downstream learns that this worker's history
  arrived as a file rather than as a stream.

  Fetched only when a step is opened, and re-read on a timer only while that
  step is live: a run of thirty agents is thirty files of a few hundred KB, and
  a reader opens one. A settled file does not change, so a settled step reads
  once. The read is bounded and takes the **tail** when an agent has written
  past the ceiling — what it is doing now is what the step was opened for — and
  drops the partial first line rather than mis-parsing it.

  Its safety is one rule, because the route reads absolute paths for a living:
  the path must carry a live thread's ACP session id as a real segment, checked
  before resolution so `..` cannot claim a segment and then climb out of it, and
  again after, so a symlink cannot smuggle the read elsewhere. The agent id
  names a file rather than a path, so it is refused outright unless it is a
  plain identifier rather than sanitised into one — the difference between a
  check and a guess. `test:task-agent` stands on all of it.

  The steps themselves are built **at view time** (`nativeWorkflowRun` in
  `transcript-rows.ts`) and stamped with the very `_meta.daedalus.workflow` shape the
  runner stamps on a spawn. That is the whole trick: from `WorkflowRun` down, a native run
  is not a special case — same phases, same counts, same elapsed, same per-step tokens,
  same row vocabulary, and none of that code learns where the run came from. The run row
  stands **in place of the tool call that launched it**, which is where it happened. Three
  things a synthesized step cannot have are stated rather than faked: its `sessionId` is
  deliberately unresolvable, so `useStepThread` says no and no "Open thread" link is
  offered for an agent that has no thread; its token split is reported as one number by
  the runtime, so the input/output halves are zeroes rather than an invented ratio; and it
  has no rail, so what the runtime previews instead — the brief, the report, the tool it
  is on — rides on the head (`SubagentItem.prompt`/`report`/`activity`) and is drawn by
  `SubagentBody`. Liveness is read off the runtime's own per-agent state and NOT off
  `subagentActive`, because that reads the parent's turn and a dynamic workflow's whole
  nature is to outlive the turn that launched it.

  first on purge. `workflow_runs` is the opposite: one row per run with a `steps` JSON
  column (the only queries are "runs of this thread" and "what was running when the server
  stopped"), and it *does* cascade off the parent, which only a purge deletes. A child is
  **retired the moment its turn settles** — it is a single-purpose process, and its id is
  proven by that turn (`onSessionDurable`), so the thread stays readable from its log and
  revivable through `session/load` like any retired thread. The trigger is the awkward
  half: the `workflow` MCP server (`workflow-mcp.ts`) is a process the *agent* spawns and
  cannot reach the SessionManager, so it drives the engine over HTTP at
  `/wf/<key>/<sessionId>/…` (`routes/workflows.ts`) — outside `/api`, the `/gw`/`/ide`
  key-in-path rule: the key is minted per boot and never stored, and the session id names
  the caller so a server can act for exactly the thread that asked and no other. **One level,
  never a tree**: `serversFor` hands no workflow server to a session with a
  `parentSessionId`, whatever its profile links, and `WorkflowRunner.start` refuses a caller
  that is a step — a step that could start a workflow makes the caps, cancel propagation and
  restart recovery a tree, and a definition that spawns itself the obvious failure. The
  tools answer within their wait budget (`run_workflow` ≤55s, then `wait_workflow`
  long-polls the same route) because an MCP tool timeout is the agent runtime's — codex 60s,
  Claude Code a hard wall clock — and every one of them is shorter than a pipeline. Children
  never push (`hostFor` gates `onTurnEnd`, permission and elicitation on `parentSessionId`:
  a phone told "turn finished" per step is told it five times for one workflow), and the
  idle sweep in the constructor now skips a session mid-turn (`bridge.promptActive`) and
  every child — a parent blocked inside a workflow call with no browser open was being
  retired under it. Nothing survives a restart (every step thread was this process's child):
  `recoverAtBoot` marks the running rows failed and journals `disconnected` on each parent,
  so a reopened thread shows the steps as disconnected rather than forever running.
  `pnpm test:workflow-schema` is the pure half; `pnpm test:workflow` drives the engine
  against the fake agent (`echo:` prompts).

## Pausing a run

- **A run pauses as a state of the run, never as a cancel-and-restart.** The Codex
  app-server issue asking for "non-destructive pause/resume for multi-agent thread trees"
  names the failure exactly: a root held on a question while its collaborators keep
  spending, and the only tool being an interrupt that throws their progress away. ACP has
  nothing better — `session/cancel` is its one interruption — so the engine keeps the hold
  itself. `WorkflowRunner.pause(runId)` moves the run to `status: "paused"`, which is a
  live state like `running` (`terminal()` is false for both, `recoverAtBoot` closes both):
  `pump` starts nothing while paused but still lets a run whose last step just finished
  complete; a step between its prompts (the JSON repair turn) waits on `whenRunning`; every
  running step whose thread's agent advertises the harness's pause (`bridge.canPause` — our
  own runtime, see docs/protocol.md) is told to hold at its next step boundary, and one
  that cannot runs to its end while its dependents wait. **Both clocks stand still**: the
  run's total timeout and each step's own are `PausableTimer`s, which keep the remaining
  time and re-arm once on resume — a deadline that kept advancing through a hold would
  fail the run for the minutes the user spent thinking, which is precisely the wall-clock
  complaint in that issue. `resume` re-arms them, releases the children, and pumps. Cancel
  works on a held run exactly as on a running one: the abort reaches every step's race,
  and a held child's cancel releases its pause with the turn.
  The hold is said on the parent as **`_daedalus/workflow_state {runId, paused}`** — the
  harness's own update variant beside `_daedalus/subagent_usage`, journaled for the same
  reason (the card is drawn from the parent's log alone, and a replayed run has to stand
  where it stood). A run has no item of its own — it is folded at view time from its
  steps — so the reducer stamps `paused` onto the `workflow` info of every step carrying
  the run's id, and `WorkflowRun` reads it off any head, prefixes the caption with
  "paused", and shows the hold toggle (`WorkflowHold`) while the run is live. The toggle
  needs the run's thread, which a row drawn from a log does not have in hand, so the
  spawn's `_meta.daedalus.workflow` also carries the parent `sessionId`; the routes are
  `POST /api/sessions/:id/workflows/:runId/pause|resume` (`statusFor` refuses a run of
  another thread — a run id is not a credential) and, for the agent that started it,
  `/wf/<key>/<sessionId>/runs/:id/pause|resume` behind `pause_workflow`/`resume_workflow`.
  `wait_workflow` must be re-called while the status is `paused` as it is while `running`.

## Two owners: profile and thread

- **MCP servers, skills and commands have two owners, and the agent gets the union.**
  A profile links them (the provider setup: a gateway's own servers, the skills that go with
  a house style), and a thread picks its own on the draft's composer strip
  (`ThreadToolsMenu` in `components/thread-tools.tsx`, where the profile's show checked and
  locked, so the thread's picks are exactly the additions). **That control outlives the
  draft**: the same component, `editable={false}`, sits in the composer's control row beside
  `SessionConfigPopover` for the whole of a started thread and reads the kit back — what the
  agent was spawned with, each entry saying whether it came from the profile or from the
  thread — because the picks were only ever visible while they were still hypothetical, and
  vanished at the moment they started mattering. It is a read-out and not a picker there:
  the links are written once at create and are what a revive spawns with, so there is
  nothing to toggle. A read-out lists only what is linked (a started thread has no use for
  the rest of the library) and draws nothing at all when a thread carries no tools. A
  project links nothing — it is the directory, not the toolset; the `project_*` link tables
  it once had are gone. Both
  owners are join tables with `ON DELETE CASCADE` — `profile_*`, `session_*` — read and
  written through one descriptor-driven helper, `server/src/db/links.ts`
  (`readLinks`/`writeLinks`/`unionLinks`), so a stale id links nothing and nothing filters.
  The thread's picks arrive in `POST /api/sessions` (`mcpServerIds`/`skillIds`/`commandIds`),
  are written once at create, reported back by `list()`, and are what a revive spawns with.
  `SessionManager.effectiveLinks` is the union; `serversFor` passes its MCP servers to
  `session/new`. Skills and commands are the awkward half: they are **materialised into the
  project's cwd**, which every thread of the project shares, and the materialiser sweeps
  whatever it did not write — so `materializeFor` hands `materializeWorkspace` the union
  across *every live thread in that cwd* plus the one spawning, never one thread's set alone
  (that pulled the symlinks out from under the thread next to it). It runs in
  `SessionManager.start`, not in `spawnAgent`, because only the manager knows the other
  threads; the probe materialises the profile's own set itself, which is additive and safe.
