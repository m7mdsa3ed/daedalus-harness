import type * as acp from "./acp.js";

/** A thread's output-speed readings, folded per turn by `tps.ts`. `min`/`max`
    are generation rates once `decodeMs` is present, throughput rates before. */
export interface TpsStats {
  min: number;
  max: number;
  /** Throughput: output tokens over turn wall clock, summed. */
  outputTokens: number;
  durationMs: number;
  toolDurationMs?: number;
  /** Generation: output tokens over decode time, summed over turns that had one. */
  generatedTokens?: number;
  decodeMs?: number;
  /** Time between the turns' model requests, summed. */
  waits?: TurnWaits;
}

/** The time between a turn's model requests: `totalMs` is the clock no request
    was in flight on, and the rest names the parts the agent could tell apart —
    held (a pause or a failed turn's hold), compacting the history, backing off
    a failed request. What is left is the tools (approvals included) and the
    harness's own work. Only a runtime that meters its calls says any of it. */
export interface TurnWaits {
  totalMs: number;
  heldMs?: number;
  compactMs?: number;
  retryMs?: number;
}

/** What a turn's model calls wrote and how long they spent writing it — the
    span of each call less its time to first token, summed. Calls that overlap
    (parallel subagents) each count their own time, so the ratio is the
    token-weighted speed of a call, not of the turn. */
export interface TurnGeneration {
  outputTokens: number;
  decodeMs: number;
  /** Rides here because it is measured off the same calls and travels the
      same road. A record with no tokens is a turn that has waits and no speed. */
  waits?: TurnWaits;
}

/**
 * The Daedalus thread protocol — what travels over `/ws`.
 *
 * This file is the single definition, imported **type-only** by the client
 * (`@daedalus/protocol`, mapped in client/tsconfig.app.json). Keep it free of
 * runtime code and of any import that is not type-only: nothing here may end up
 * in the browser bundle, and nothing here may reach for a Node built-in.
 *
 * The server is the ACP client now, so this is not ACP. It is derived state:
 * commands the browser can ask for, and events describing what the agent did.
 * The payloads stay ACP-*shaped* (`SessionUpdate`, `RequestPermissionRequest`,
 * `SessionConfigOption[]`, `Usage`) because the browser still renders them, and
 * re-modelling them would buy nothing but a translation layer to keep in step.
 */

/*
 * ---- Subscription quota ----
 *
 * What Claude Code's `/usage` and Codex's `/status` report, normalized. Read by
 * `server/src/quota.ts` (which owns the two adapters) and rendered by the
 * client; declared *here*, with the rest of the wire, because it travels both
 * ways — over the socket when a turn settles, and over `GET /api/quota` — and a
 * second copy of the shape on the browser side is a second thing to keep in
 * step.
 */

/** One limit window — a rolling five hours, a week, whatever the runtime meters. */
export interface QuotaWindow {
  /** Stable per runtime (`five_hour`, `seven_day`, `primary`, …). A key and an
      order; never shown. */
  id: string;
  /** What the runtime calls it, shown as-is. */
  label: string;
  usedPercent: number;
  /** The amounts the percentage was computed from, when the runtime gave them —
      credits, requests, tokens, whatever `unit` names. Optional because one
      adapter only ever prints a percentage: a renderer says the numbers when
      they are there and the bar alone when they are not. */
  used?: number | null;
  cap?: number | null;
  /** What `used`/`cap` are counted in, as a word to put after them. */
  unit?: string | null;
  /** Epoch ms when the window rolls over, when the runtime gives a timestamp. */
  resetsAt?: number | null;
  /** The runtime's own already-formatted reset string, when that is all it gave.
      Claude Code prints `Aug 31, 9:59am (Africa/Cairo)` — localized, in the
      *server's* timezone. Re-parsing that into an instant is guesswork nobody
      asked for, so it is carried verbatim; a renderer prefers `resetsAt` when
      both are present. */
  resetsLabel?: string;
  windowMinutes?: number | null;
  /** A window nothing is counted against — a free tier's metered-but-uncapped
      allowance, a pay-as-you-go spend against no stated budget. It still has a
      reading (`usedPercent` is a figure to show, not a wall to hit) but no bar
      to fill: a renderer draws the number and no track under it, because a bar
      at 0% and a bar at "there is no ceiling" are different statements. */
  unlimited?: boolean;
  /** Which *account* inside this reading the window belongs to, when the reading
      is of more than one — a gateway (9Router) is many subscriptions behind one
      endpoint, and its five-hour window is a different five hours per account.
      The label and the identity at once: a renderer draws a section per distinct
      value, in first-seen order, so an adapter that puts two accounts under one
      string is saying they are one account. Absent on every ordinary plan, where
      the profile *is* the account and the windows are one flat set. */
  group?: string | null;
}

/** One account *inside* a reading that is of more than one.
 *
 * A gateway (9Router) fronts many accounts behind one endpoint, and the reading
 * is therefore not one plan: which accounts there are is read from the gateway's
 * own connection list, before any quota is asked for, and an account the gateway
 * turned off or whose credential no longer answers has no window to carry its
 * name. So the accounts are a list of their own rather than inferred from
 * `QuotaWindow.group`.
 *
 * This is display metadata and only that — which accounts to name, in which
 * order, and what state each is in when it has nothing to draw. `group` stays
 * the joining key: an account that reported windows says one of these names on
 * each of them, so a renderer matches a heading to its bars by string.
 * Absent on every ordinary plan, where the profile *is* the account. */
export interface QuotaAccount {
  /** The gateway's own connection id. A renderer keys on it and otherwise
      ignores it; two accounts the gateway gives one name are still two. */
  id: string;
  /** What to call it — the name the gateway shows, else its login. */
  name: string;
  /** The string its windows carry as `QuotaWindow.group` — which is `name`,
      with the plan appended when the provider reported one, and with the
      `Claude (2)` disambiguator when two accounts share a name. This is the
      join key, and the only reliable one: a renderer matching on `name` would
      find nothing once a plan is in play, and on `id` would be reading one
      field's format out of another's. */
  group: string;
  /** The provider behind it (`claude`, `codex`, `glm`), as a word, for a
      subtitle that says what kind of account this is. Null when unnamed. */
  provider?: string | null;
  /** What to call that provider where it heads a group — `vercel-ai-gateway`
      is `Vercel AI Gateway`. The adapter's word, because a slug is the
      gateway's internal name for a provider and not what a person reads; a
      renderer that title-cased the slug itself would spell `commandcode` as
      one word. Null when the account named no provider. */
  providerLabel?: string | null;
  /** The plan that account is on, when its provider reported one. */
  plan?: string | null;
  /** How many readable windows it contributed. Zero is an account that is
      named but silent — the state below is why. */
  windows: number;
  /** The fullest window's percentage, for a heading that has to summarise. */
  usedPercent?: number | null;
  /** When that window rolls over. */
  resetsAt?: number | null;
  /** Nobody could be asked. The gateway turned it off, so it is not being
      spent and its quota is not this reading's to report. */
  disabled?: boolean;
  /** It answered, but not with quotas — an expired login, a provider with no
      usage API, a free tier that is all `unlimited`. `state` is what it said
      or a stand-in for it; either way there is no bar to draw. */
  state?: string | null;
}

export type QuotaStatus =
  /** A plan with windows to report. */
  | "subscription"
  /** Authenticated, but metered per token — nothing to report. */
  | "api-key"
  /** The runtime is installed but nobody is logged in. */
  | "unauthenticated"
  /** This agent declares no probe: it has no subscription notion. */
  | "unsupported"
  /** The probe could not be run, or could not be understood. */
  | "error";

export interface QuotaSnapshot {
  /** Empty for a `source: "profile"` reading: a provider's plan is one account
      whatever runtime spends it, and the reading is shared across every agent
      the profile serves. */
  agentId: string;
  /** The profile whose resolved env the probe ran under — a virtual
      `default:<agentId>` is the machine's own login, anything else is that
      profile's credentials. Part of the identity of the reading: the same agent
      reports different things under different auth. */
  profileId: string;
  /** Which reader answered: the agent runtime's own CLI (`agent`), or the usage
      API the profile's provider exposes (`profile`). Absent on readings taken
      before providers existed, which were all `agent`. The two answer different
      questions — "how is this machine's `claude login` doing" against "how is
      this gateway plan doing" — so a page listing both has to say which. */
  source?: "agent" | "profile";
  status: QuotaStatus;
  /** The plan the runtime names, when it names one (`pro`, `max`, `plus`). */
  planName?: string | null;
  windows: QuotaWindow[];
  /** Every account a multi-account gateway has, in its own priority order —
      see `QuotaAccount`. Absent where the reading is one account, which is
      everywhere but 9Router. `windows` may hold fewer than are named here and
      never holds one this list does not name. */
  accounts?: QuotaAccount[] | null;
  credits?: { balance: string | null; unlimited: boolean } | null;
  /** What the runtime said, always — one adapter parses prose, and prose moves
      between releases. A wording change then degrades to "here is the report,
      unparsed" instead of to an empty card claiming 0%. */
  raw: string;
  fetchedAt: number;
  /** Set only for `status: "error"`. */
  error?: string;
}

/**
 * An attachment, as everything that is not the bytes sees it.
 *
 * The journal, the queue row and the client store all carry *references*; the
 * bytes live once on disk under `data/attachments/` and are fetched by id (see
 * server/src/attachments.ts). That is the `REPLAY_CHUNK_BYTES` lesson stated
 * ahead of time rather than after: a 6MB base64 image journaled into
 * `session_events` is a frame held whole as a string on both ends of every
 * replay, forever, of a thread whose transcript is otherwise a few hundred
 * bytes per event.
 */
export interface AttachmentRef {
  id: string;
  /** The user's filename — display text and the name the prose uses. */
  name: string;
  mimeType: string;
  size: number;
}

/* Which branch one of these takes is `resolveDelivery` in `delivery.ts`, not
   here: this file is type-only by contract (the client maps it as
   `@daedalus/protocol` and imports nothing but types from it), and that
   decision is a *function* both ends have to run. */

/** A JSON-RPC error flattened for the wire. The shape matters: `lib/errors.ts`
    reads `code` for its title table and `data.stderr` for the agent's own
    output, so carrying prose instead would throw both away. */
/**
 * The hold, as both the `paused` event and `caught_up` state it. One shape,
 * built in one place (`AcpBridge.hold()`), so an attaching reader and a live
 * one can never disagree about whether — or why — a turn is stopped.
 * `reason` and `error` are present only while `paused`.
 */
export interface ThreadHold {
  paused: boolean;
  /** `"user"` is the composer's toggle; `"error"` is a turn that failed and
      is waiting at its step boundary for a model change and a Continue. */
  reason?: "user" | "error";
  error?: WireError;
}

export interface WireError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * A turn that failed and is trying again on its own, as both the `retry` event
 * and `caught_up` state it — one shape, the way the hold has one.
 *
 * The step before a hold, and the reason it exists: a retriable failure used to
 * cost seconds of a thread that looked alive, said nothing, and then either
 * carried on as though nothing had happened or arrived all at once as a held
 * turn quoting an error the reader had no idea had already been met twice.
 * `error` is the failure being retried, in the same shape the hold carries it,
 * so one reader draws both.
 */
export interface ThreadRetry {
  /** Which attempt is about to run, 1-based. */
  attempt: number;
  /** How many retries there are in all, when the runtime says. */
  of?: number;
  /** The backoff before it starts, in ms. The silence this explains. */
  delayMs?: number;
  error?: WireError;
}

/**
 * A spawn-config change asked for and not yet applied — the shape both the
 * `staged_config` event and `caught_up` carry.
 *
 * The harness stages a change instead of taking it whenever the change costs
 * the process: a spawn is what reads these values, so a spawn is what should
 * pay for them, and the next one takes the patch — the revive behind a send,
 * a rewind, the restart route, or the one `prompt` makes happen when a turn
 * finds a patch outstanding. Absent fields are unchanged, exactly as
 * `POST /api/sessions/:id/config` reads them, and the whole object is replaced
 * rather than merged on the wire — two picks made before it lands are one
 * staged change, not two.
 *
 * Never an agent: that is a different runtime rather than a setting on this
 * one, and a respawn onto another binary ends in a `session/load` of an id
 * that lives in the old runtime's store. `applyConfig` refuses to stage one.
 *
 * In memory only, on the server and on the client alike. A server that restarts
 * drops the patch and the thread stays on its old settings; `caught_up`
 * normalises `staged ?? null`, so a reattach clears the banner rather than
 * leaving a ghost of a change that is never going to happen.
 */
export interface StagedConfig {
  profileId?: string;
  model?: string;
  effort?: string;
  suggestKinds?: string[];
  /** Which component groups the drawn-answers lane teaches (`UI_GROUP_IDS`);
      empty = the lane is off. */
  uiGroups?: string[];
  /** The thread's persona; null = none. Spawn text, so taking it costs a respawn. */
  personaId?: string | null;
  /** The thread's role → model assignment (`sessions.helper_models`). Spawn-time
      like model and effort: taking it costs a respawn. */
  helperModels?: { role: string; model: string }[];
  /** The agent's own selectors — the permission mode and every other option
      (its model and effort pickers included) — which no spawn is needed to
      take, only a turn to start or an explicit approval (`approveStaged`). */
  modeId?: string;
  options?: Record<string, string | boolean>;
  mcpServerIds?: string[];
  skillIds?: string[];
  commandIds?: string[];
}

/**
 * A `session/load` the agent refused.
 *
 * The thread is live either way — the bridge falls back to a fresh session —
 * but its conversation is not in it, and saying nothing is how a thread that
 * lost its history looks merely empty. Carried on `attached` rather than
 * journaled because it is a fact about THIS process: the id it failed on is
 * still the thread's (see AcpBridge.loadSession), so the next revive tries the
 * same load again and a transient failure heals itself.
 */
export interface HistoryLost {
  /** The id the load was attempted with. Still recorded against the thread,
      still the only way back — which is the whole point of reporting it rather
      than quietly replacing it. */
  acpSessionId: string;
  error: WireError;
}

/* ---- subagent sessions (draft ACP RFD) ----
   The two update variants of the "Subagent Sessions" RFD
   (agent-client-protocol PR #1992). They are ahead of the SDK — its
   `SessionUpdate` union does not carry them yet — so they are declared here and
   `SessionUpdate` below is what the harness handles, on both ends. The wire
   shape is the RFD's exactly, so the day the SDK ships them these two collapse
   into `acp.SessionUpdate` with nothing else to change.

   A spawn is sent on the *parent* session and names the child; the child's own
   updates then arrive as ordinary `session/update`s whose `sessionId` is the
   child's, and the terminal state arrives on the parent again, after all of
   them. Nesting is a spawn sent on a child session. */
export interface SubagentSpawned {
  sessionUpdate: "subagent_spawned";
  subagentSessionId: string;
  name: string;
  task: string;
  /** The child's full brief, where the runtime sends it (claude-agent-acp's
      native sessions do; `task` is then a one-line description). */
  prompt?: string;
  capabilities: { cancel?: boolean; close?: boolean };
  _meta?: Record<string, unknown> | null;
}

export type SubagentState = "completed" | "failed" | "cancelled" | "disconnected";

export interface SubagentStateUpdate {
  sessionUpdate: "subagent_state_update";
  subagentSessionId: string;
  state: SubagentState;
  _meta?: Record<string, unknown> | null;
}

/**
 * What a subagent's turn cost, on the parent's session.
 *
 * The harness's own, not the RFD's — hence the prefix, which is also what keeps
 * it out of the way of a variant ACP may one day name. Tokens travel in exactly
 * one place on the wire, `turn_ended`, and a child's `turn_ended` is
 * deliberately never mirrored onto the parent (its turns are not the parent's,
 * and a foreign turn boundary would cut the parent's replay windows at a turn
 * it never had). So the runner reads the usage off the child's own settled turn
 * and says it again here, as an ordinary journaled `update` — which is what
 * makes a step's cost replay for free, exactly like its spawn and its state.
 *
 * Per turn, like the `Usage` it carries: a step that takes a repair turn sends
 * two, and the reader adds them up.
 */
/**
 * A harness workflow run was paused or resumed (`WorkflowEngine.pause`). The
 * harness's own, like `_daedalus/subagent_usage`, and journaled for the same
 * reason: the run card is drawn from the parent's log alone, and a replayed
 * run has to say it is standing still. Absolute — `paused` is the state, not a
 * toggle — and addressed by run, since the steps it holds are several.
 */
export interface WorkflowStateUpdate {
  sessionUpdate: "_daedalus/workflow_state";
  runId: string;
  paused: boolean;
  _meta?: Record<string, unknown> | null;
}

/**
 * A warning or error an AIR adapter reports as a typed record rather than as
 * text (`sessionFailure` in `AIR_META`, acp-bridge.ts). Two doors: on a
 * `session_info_update` at `_meta.jetbrains.air.sessionFailure` — an ordinary
 * update the server never reads — and, for a failure that ends the running
 * turn, on the prompt's answer, which the bridge puts on `turn_ended.failure`.
 * One incident is one `id`; a higher `revision` replaces it in place, and the
 * same or a lower one is ignored. `actions` v1 is `retry`, `login` and
 * `new_session`; anything else is ignored, and never inferred from `category`.
 */
export interface SessionFailure {
  id: string;
  revision: number;
  category: string;
  severity: "warning" | "error";
  title: string;
  details?: string;
  actions: string[];
}

/* ── Async background tasks ──
   Work an agent launched that outlives the turn that launched it: a Claude Code
   dynamic workflow, a backgrounded shell command, a monitor. The JetBrains AIR
   extension to ACP models these as their own lifecycle — spawn, progress,
   terminal state — and claude-agent-acp sends them only to a client that
   advertises it (`AIR_META` in acp-bridge.ts).

   Not the harness's own, so no `_daedalus/` prefix: these are the adapter's
   names, spelled exactly as it publishes them, and they pass through the bridge
   as ordinary journaled `update`s — which is what makes a run replay for free,
   the same bargain `SubagentSpawned` makes.

   The subagent RFD does not cover these and cannot: an RFD child is a *session*
   the client can open, while a workflow's agents live inside the CLI and have
   no session of their own — what crosses is a progress array, not a transcript.
   See `WorkflowProgressEntry`. */

export interface AsyncTaskSpawned {
  sessionUpdate: "async_task_spawned";
  asyncTaskId: string;
  /** The workflow's `meta.name` for a workflow; the description otherwise. */
  name: string;
  /** `workflow` | `shell` | `monitor` | `task` — the adapter's friendly word. */
  taskType: string;
  description: string;
  /** False for housekeeping the CLI does not surface as user work. */
  showInTranscript: boolean;
  canStop: boolean;
  /** The tool call that launched it, which is what ties a run to its row. */
  toolCallId?: string;
  outputFilePath?: string;
  _meta?: Record<string, unknown> | null;
}

/**
 * One entry of a dynamic workflow's live shape.
 *
 * A `workflow_phase` names a stage; a `workflow_agent` is one agent in it.
 * Both are keyed by `index` within their type and are **upserted, not
 * appended** — the CLI rewrites an agent's entry in place as it works, so the
 * array is a snapshot of the whole run rather than a log of it. That is why
 * the reducer replaces by `(type, index)` instead of accumulating.
 *
 * Every field past the key is optional because it is: a queued agent has no
 * `startedAt`, a running one no `resultPreview`, and an older CLI may send
 * neither. The one thing that is always true is that an entry names its phase.
 */
export interface WorkflowProgressEntry {
  type: "workflow_phase" | "workflow_agent" | "workflow_log";
  index?: number;
  /** `workflow_phase`: the stage's title. */
  title?: string;
  /** `workflow_agent`: the script's own label for this agent. */
  label?: string;
  phaseIndex?: number;
  phaseTitle?: string;
  /** The CLI's id for the agent — also the name of its transcript file
      (`agent-<agentId>.jsonl`) in the run's transcript directory. */
  agentId?: string;
  model?: string;
  state?: "start" | "queued" | "progress" | "done" | "error" | "blocked";
  startedAt?: number;
  queuedAt?: number;
  lastProgressAt?: number;
  tokens?: number;
  toolCalls?: number;
  lastToolName?: string;
  lastToolSummary?: string;
  promptPreview?: string;
  resultPreview?: string;
  /** The agent's result came from a resumed run rather than a fresh call. */
  cached?: boolean;
  attempt?: number;
  error?: string;
  /** `workflow_log`: a line the script emitted with `log()`. */
  message?: string;
}

export interface AsyncTaskProgress {
  sessionUpdate: "async_task_progress";
  asyncTaskId: string;
  description?: string;
  summary?: string;
  lastToolName?: string;
  usage?: { totalTokens: number; toolUses: number; durationMs: number };
  /** A dynamic workflow's whole shape, resent on every beat. Present only when
      the adapter carries it through (`pnpm patch:acp`); everything else here
      arrives with or without that patch. */
  workflowProgress?: WorkflowProgressEntry[];
  toolCallId?: string;
  outputFilePath?: string;
  _meta?: Record<string, unknown> | null;
}

export type AsyncTaskState = "running" | "paused" | "completed" | "failed" | "stopped";

export interface AsyncTaskStateUpdate {
  sessionUpdate: "async_task_state_update";
  asyncTaskId: string;
  state: AsyncTaskState;
  summary?: string;
  toolCallId?: string;
  outputFilePath?: string;
  _meta?: Record<string, unknown> | null;
}

export interface SubagentUsage {
  sessionUpdate: "_daedalus/subagent_usage";
  subagentSessionId: string;
  usage: acp.Usage;
  _meta?: Record<string, unknown> | null;
}

/**
 * A question the harness answered for the user, said again as an `update` so it
 * is journaled.
 *
 * The harness's own, hence the prefix — the same bargain `_daedalus/subagent_usage`
 * makes, and for the same reason. The live pair (`permission`/`elicitation` then
 * `request_answered` carrying `auto`) is what a watching browser draws and
 * resolves, but neither is in `JOURNALED_EVENTS`, so with nobody attached an
 * auto-granted permission would leave no record anywhere that the question was
 * ever asked. A standing grant that runs unattended and is unauditable
 * afterwards is the one thing this feature must not ship.
 *
 * It is an `update` and NOT a fifth journaled event kind precisely so live and
 * replay stay one code path: the reducer already folds updates, the replay
 * already carries them, and a client that predates this variant ignores an
 * update it does not recognise rather than failing to connect.
 *
 * Emitted only for a question the POLICY answered. A human's answer is not
 * recorded here — the tool call it permitted is journaled either way, and a
 * person answering a card on their own screen is not the thing that needed a
 * paper trail.
 */
export interface AutonomyAnswer {
  sessionUpdate: "_daedalus/autonomy_answer";
  /** Which choke point asked — a permission for a tool, or an elicitation. */
  kind: "permission" | "elicitation";
  /** The tool call the permission was about, when it named one. */
  toolCallId?: string;
  /** The ACP tool kind the stance was keyed on; absent when the agent omitted
      it, which is the protocol saying nothing and falls to `default`. */
  toolKind?: acp.ToolKind;
  /** The agent's own title for the call, so the record reads as something that
      happened rather than as an id. */
  title?: string;
  /** What was sent back, and whether nobody came. */
  answer: AutoAnswer;
  _meta?: Record<string, unknown> | null;
}

/**
 * A `!` line the user ran against this thread's project, and what it printed.
 *
 * The harness's own, hence the prefix — a `_daedalus/` update and not a sixth
 * journaled event kind, for the reason `AutonomyAnswer` gives: the reducer
 * already folds updates, the replay already carries them, and live and replay
 * stay one code path.
 *
 * Journaled, which is the whole point of it: the row is part of the
 * conversation — it sits in the transcript where it was run and comes back on a
 * reload — but it is **not a prompt**. No turn runs, `turnActive` never moves,
 * and the agent is never told the command happened.
 */
export interface ShellCommand {
  sessionUpdate: "_daedalus/shell";
  /** The run's identity, minted by the caller and carried by every update for
      it: the composer draws the row before the server has answered, so the
      updates that follow have to *patch* that row rather than add a second. */
  shellId: string;
  /** `running` when the line starts, `done` when it settles. Two updates per
      run is what lets the row draw — and say it is working — from the first
      moment, instead of appearing only once the command has finished. */
  status: "running" | "done";
  /** The line as it ran — a saved helper's own command when the line named one. */
  command: string;
  /** stdout then stderr, joined the way a terminal would have shown them.
      Absent while `running`. */
  output?: string;
  /** The process's exit code, or null when it could not be started at all.
      Absent while `running`. */
  exitCode?: number | null;
  /** The shell was killed at the timeout. Absent while `running`. */
  timedOut?: boolean;
  _meta?: Record<string, unknown> | null;
}

/**
 * One finished line of a voice conversation held in front of this thread —
 * what the person said, or what the voice model said back.
 *
 * The `!` row's bargain: journaled, so it is part of the conversation and comes
 * back on a reload, but not a prompt — no turn runs and the agent never reads
 * it. What the voice model handed the agent arrived as an ordinary message.
 * One update per line, said once the line is whole; the live caption is the
 * call card's and is never journaled. The audio itself is never kept.
 */
export interface VoiceLine {
  sessionUpdate: "_daedalus/voice";
  /** The caller's id for the line, so the fan-out and the caller's own
      dispatch of the same line are one row. */
  voiceId: string;
  role: "user" | "assistant";
  text: string;
  _meta?: Record<string, unknown> | null;
}

/* ── Model calls ──
 *
 * One record per provider request, whoever observed it (docs/protocol.md
 * "Model calls"). The record is the contract: the journal, the ledger
 * (`model_calls`), the panel and the Spend tab see `ModelCall` and nothing
 * else — `source` and `missing` are drawn, never branched on. The agent's
 * `trace.ts` mirrors this shape because it cannot import it.
 */

/** One named piece of the static prefix: a system prompt section, or one tool's
    definition. Raw local counts — only their proportions mean anything. */
export interface PrefixItem {
  name: string;
  tokens: number;
}

/** ~ Where the prompt went. Present parts sum, with `unknown`, to fresh +
    cacheRead + cacheWrite. A part the door could not see is null and named in
    `ModelCall.missing`. */
export interface PromptParts {
  system: number | null;
  tools: number | null;
  mcp: number | null;
  user: number | null;
  assistant: number | null;
  results: number | null;
  unknown: number;
}

export interface PrefixItems {
  system: PrefixItem[];
  tools: PrefixItem[];
  mcp: PrefixItem[];
}

/** ~ One tool's footprint in a request's conversation: the calls the model made
    to it (`args`, inside `PromptParts.assistant`) and what came back
    (`results`, inside `PromptParts.results`), anchored to those parts so the
    figures are billed tokens, not raw counts. `calls` is how many of its calls
    the history held. */
export interface ToolUse {
  name: string;
  calls: number;
  args: number;
  results: number;
}

export interface ModelCall {
  callId: string;
  /** Epoch ms sent. */
  at: number;
  /** Wall time to the parsed response, when the door saw both ends. */
  ms?: number;
  who: "turn" | "subagent" | "compaction" | "title";
  childId?: string;
  /** 1-based within the turn; the door fills it when the source did not. */
  step: number;
  model: string;
  finishReason?: string;
  /** Which door built it. `usage` is the implicit last door: a runtime's own
      `usage_update`, billed only, never listed in `callsVia`. */
  source: "acp" | "otlp" | "proxy" | "files" | "usage";
  /** Exact — the provider's counters, `acp.Usage` shaped (fresh input, cache
      read/write beside it). */
  billed: acp.Usage;
  /** Only when the runtime says it (Claude Code's `cost_usd`). */
  costUsd?: number;
  timing?: { ttftMs?: number; decodeMs?: number };
  prompt?: PromptParts;
  /** "the system prompt", "tool schemas" — the door's own words. */
  missing?: string[];
  /** ~ What the output was; `reasoning` exact when reported. */
  output?: { text: number; reasoning: number; toolCalls: number };
  /** Which section / which tool definition is the big one. Sent when the
      prefix changes, never every step. */
  items?: PrefixItems;
  /** ~ Which tools' calls and results the conversation carried, biggest first.
      Absent where the door could not see the conversation. */
  toolUse?: ToolUse[];
  /** The tools this response asked to run, in order — one entry per call.
      Absent where the door did not read the reply. */
  called?: string[];
}

/**
 * The one wire event for a model call: a journaled `update` on the session it
 * belongs to (a subagent's on the child's id). The runtime's own (`acp`) and
 * the server-built ones take the same path, so the bridge, the journal and the
 * client cannot tell who built a record. The `_daedalus/` prefix for the reason
 * `AutonomyAnswer` gives.
 */
export interface ModelCallUpdate {
  sessionUpdate: "_daedalus/model_call";
  call: ModelCall;
  _meta?: Record<string, unknown> | null;
}

/**
 * One way a runtime's model calls reach the harness (`AgentDef.callsVia`,
 * ordered). A fifth door is a union member, a file under
 * `model-calls/sources/` and a seed — nothing else.
 */
export type CallDoor =
  /** The runtime sends `_daedalus/model_call` itself. Always attaches. */
  | { kind: "acp" }
  /** OpenTelemetry logs to the harness's receiver. `env` is the runtime's
      switches, templated on `{otlpUrl}`/`{otlpBodies}` — every value resolves
      empty when there is no receiver, so the keys prune. */
  | { kind: "otlp"; dialect: "claude-otlp"; env: Record<string, string> }
  /** The gateway shim reads the request and the response it forwards. Attaches
      only for a thread behind the shim. */
  | { kind: "proxy"; dialect: "anthropic-messages" | "openai-chat" | "openai-responses" }
  /** The runtime's own session store on this machine, read-only. Attaches once
      the ACP session id is earned. */
  | { kind: "files"; format: "claude-jsonl" | "codex-rollout" | "opencode-sqlite" };

/** Which door a thread's records come through, said on `session_config`. */
export type CallsVia = CallDoor["kind"] | "usage";

/** Everything a `session/update` can carry: the SDK's union plus the RFD's. */
export type { ChangedFile } from "./db/schema.js";

/** One turn's footprint on the project's git worktree — see
    `session_turn_changes` in db/schema.ts for what the two trees are. */
export interface TurnChanges {
  turnId: string;
  files: import("./db/schema.js").ChangedFile[];
  /** False while the turn runs (the review reads start → worktree live). */
  ended: boolean;
  /** Neither tree could be taken — the project is not a repository. */
  unavailable: boolean;
  startedAt: number;
  /** The child thread (a workflow step, a subagent run as a thread) that ran
      this turn, when it is not the thread being read. */
  sessionId?: string;
}

export type SessionUpdate =
  | acp.SessionUpdate
  | SessionInfoUpdate
  | SubagentSpawned
  | SubagentStateUpdate
  | SubagentUsage
  | AsyncTaskSpawned
  | AsyncTaskProgress
  | AsyncTaskStateUpdate
  | WorkflowStateUpdate
  | AutonomyAnswer
  | ShellCommand
  | VoiceLine
  | ModelCallUpdate;

export interface SessionInfoUpdate {
  sessionUpdate: "session_info_update";
  title?: string;
  updatedAt?: string;
}

/** What a respawn has to put back: the agent's configuration minus the two
    settings the profile owns. See AcpBridge.captureRestoreState. */
export interface RestoreState {
  modeId?: string;
  configOptions: acp.SessionConfigOption[];
}

/**
 * A question the harness answered for the user, rather than a person answering
 * it (`autonomy.ts`). Rides `request_answered` so a watching browser draws the
 * card and then sees it resolve itself — an auto-granted permission must be
 * visible while it happens and legible afterwards, never silent.
 */
export interface AutoAnswer {
  /** What was sent back, in the harness's own vocabulary rather than the
      agent's: the optionId that carried it is the agent's and means nothing to
      a reader of another thread. */
  answer: "allow" | "deny" | "decline" | "cancel";
  /** True when this was the ask-timeout fallback rather than a stance the
      policy stated outright. The difference is the whole of "the run was
      allowed to do this" versus "nobody came", which is also what makes a run
      `blocked` rather than merely finished. */
  timedOut: boolean;
}

/**
 * One question an agent is blocked on right now, in any thread — a row of the
 * cross-thread inbox (`GET /api/pending`). Read straight off each live
 * bridge's `pending` map, so it is exactly as current as a peer's cards: never
 * journaled, and gone the moment anybody answers. Answered through
 * `POST /api/sessions/:id/pending/:requestId`, which is `bridge.answer` — the
 * same first-answer-wins door the socket's `answer_permission` takes.
 */
/** Which child thread a question repeated on its parent came from. */
export interface RequestFrom {
  sessionId: string;
  title: string;
}

/** A child's request id as its parent's sockets carry it, and back. The child
    id is a UUID and a bridge's own ids are `r<n>`, so the first `:` splits. */
export const childRequestId = (childId: string, requestId: string) => `${childId}:${requestId}`;
export function childRequest(id: string): { childId: string; requestId: string } | null {
  const at = id.indexOf(":");
  return at > 0 ? { childId: id.slice(0, at), requestId: id.slice(at + 1) } : null;
}

export type PendingItem = {
  sessionId: string;
  parentSessionId: string | null;
  projectId: string;
  agentId: string;
  threadTitle: string;
  requestId: string;
  askedAt: number;
} & (
  | { kind: "permission"; request: acp.RequestPermissionRequest }
  | { kind: "elicitation"; request: acp.CreateElicitationRequest }
);

/**
 * One queued prompt — typed while a turn was running, waiting for it to end.
 * `id` is minted by the server; editing and removing go by it.
 */
export interface QueuedMessage {
  id: string;
  text: string;
  /** What this message will carry when it is drained. Absent (rather than
      empty) on a row written before attachments existed, and on every row that
      carries none. */
  attachments?: AttachmentRef[];
  createdAt: number;
  /** A composer steer whose words are on the wire while its transcript bubble
      waits for the current step to finish. It cannot be edited, removed or sent. */
  steer?: true;
}

/** The answer to `prompt` and `queue_add`. Which shape comes back is the
    server's call: only it knows whether the turn is still open, so a client
    that believed the thread idle can still be told its words were queued.

    `deferred` says the words are on the wire but their `turn_started` is being
    held until the running step ends (a steer — see `AcpBridge.prompt`). The
    sender reads it as "do not draw this bubble yourself": the event will come,
    to every peer, at the position the transcript will still have after a
    reload. Absent means the bubble was announced at once, as it always was. */
export type PromptReply =
  | { turnId: string; deferred?: boolean }
  | { queued: true; itemId: string };

/**
 * What `cancel` answers with. `reclaimed` is present only for a `reclaim`
 * cancel that actually took something back — the message is gone from the
 * queue by then, so a caller that asked for one and gets it MUST put the words
 * somewhere (the composer). Absent means there was nothing un-landed to take:
 * an ordinary stop, or a steer whose step boundary arrived first, which is the
 * whole of "unless a new step already read it".
 */
export type CancelReply = { reclaimed?: QueuedMessage };

/** What `compact` answers with. `deferred` means a turn was running and the
    request was booked for its next step boundary — the only place a turn can be
    summarized without losing the step in flight — so the summary is not in place
    yet and the `compaction_update` stream is what says when it is. */
export type CompactReply = {
  compacted: boolean;
  deferred: boolean;
  turnActive: boolean;
};

// ---- client -> server ----

/**
 * Every command carrying `id` gets exactly one `reply`. The two answers do
 * not: whether a peer's answer won the race is told by `request_answered`,
 * which every peer needs anyway.
 */
export type ThreadCommand =
  /** Send a prompt. While a turn is running it is QUEUED (answered
      `{queued, itemId}`) unless `steer` is set, which joins the running turn
      the way every mid-turn prompt used to. */
  | {
      id: number;
      cmd: "prompt";
      text: string;
      steer?: boolean;
      /** Uploaded attachments this prompt carries (`POST /api/attachments`).
          Ids, never bytes — see `AttachmentRef`. Unknown or foreign ids are
          dropped rather than refused: a stale draft id must not fail a send
          whose text is fine. */
      attachmentIds?: string[];
      /** Pin every attachment on this one prompt to the materialise-and-link
          branch whatever the capabilities say. Exactly one caller: the "Retry
          as file paths" action on a turn that died with inline blocks in it. */
      forceLink?: boolean;
    }
  /** Stop the running turn. `reclaim` also takes back the newest message that
      has not landed yet — a queued row, or a steer the running step has not
      reached — and answers with it, so the caller can put the words back in
      the composer. Answered with `CancelReply`. */
  | { id: number; cmd: "cancel"; reclaim?: boolean }
  /** Hold the turn at its next step boundary / let it go on. Only an agent
      whose `session_config` said `canPause` (the harness's own runtime, over
      `_daedalus/session/pause`); ACP itself has only `session/cancel`. Answered
      with the absolute `paused` event to every peer. */
  | { id: number; cmd: "pause" }
  | { id: number; cmd: "resume" }
  /** Summarize the context now. Only an agent whose `session_config` said
      `canCompact` (`_daedalus/session/compact`); ACP reports compaction but
      gives a client no way to ask for one. Nothing is journaled for it and no
      state is held — the summary announces itself as the ordinary
      `compaction_update` / `compaction_summary_chunk` updates every peer
      already receives and replays — so this has only its `reply`. */
  | { id: number; cmd: "compact" }
  /* ---- the queue ----
     `queue_add` is `prompt` from a client that already knows the thread is
     busy — on an idle thread it drains at once, so there is one path. Queue
     edits work with no agent process at all; `queue_send_now` interrupts the
     running turn and sends the picked items (`itemIds`) or the whole queue, while `queue_steer`
     injects one queued item into the running turn without stopping it. */
  | { id: number; cmd: "queue_add"; text: string; attachmentIds?: string[] }
  | { id: number; cmd: "queue_update"; itemId: string; text: string; attachmentIds?: string[] }
  | { id: number; cmd: "queue_remove"; itemId: string }
  | { id: number; cmd: "queue_reorder"; ids: string[] }
  | { id: number; cmd: "queue_clear" }
  | { id: number; cmd: "queue_send_now"; itemId?: string; itemIds?: string[] }
  | { id: number; cmd: "queue_steer"; itemId: string }
  | { id: number; cmd: "set_mode"; modeId: string }
  | { id: number; cmd: "set_config_option"; configId: string; value: string | boolean }
  | { cmd: "answer_permission"; requestId: string; response: acp.RequestPermissionResponse }
  | { cmd: "answer_elicitation"; requestId: string; response: acp.CreateElicitationResponse }
  /** Fetch the page of journaled steps immediately before `before` (the seq of
      the step's `turn_started` — see `attached.from`). Answered with
      `EarlierPage`. Only useful to a client that asked for a windowed attach —
      see `attached.earlier`.

      `steps` is how many turns the page should hold — the reader's pick
      (`earlierPageSteps`, clamped server-side). Absent, the page is
      `EARLIER_PAGE_STEPS`, which is what a client that predates the setting
      still gets. */
  | { id: number; cmd: "load_earlier"; before: number; steps?: number }
  /** Liveness only — answered `{}` by any server that understands it, with no
      agent process required (see `load_earlier` for why that matters). The
      server pings at the frame level, which a browser answers on its own and
      never surfaces to JS; this is the other direction, and the one the client
      can actually observe: a reply proves the socket is still a path to a
      server that is awake, which no amount of silence on an idle thread does. */
  | { id: number; cmd: "ping" }
  /** This peer can no longer draw a notification itself.
      Sent when the page is FROZEN (the Page Lifecycle `freeze` event) and
      cleared on `resume` — not merely when it is hidden. A hidden page still
      runs the handler that raises its own notification, and a client that
      claimed to be in the background there would be told twice: once by itself
      and once by the push the server would then send. Frozen is the case where
      nobody is left to say anything, which on Android is every backgrounded
      PWA — and the server cannot infer it, because the browser answers the
      WebSocket ping from its network stack whether or not the page is running,
      so `peers.size` says "someone is watching" for a page that is not.
      Answerless like the two `answer_*` commands: nothing waits on it, and a
      server that predates it ignores an unknown `cmd` exactly as it always
      has. */
  | { cmd: "background"; background: boolean };

// ---- server -> client ----

/** The five event kinds that are written to `session_events` and replayed on
    attach. Everything else is fan-out only. */
export type JournaledEvent = Extract<
  ThreadEvent,
  { ev: "update" | "session_config" | "config_notice" | "turn_started" | "turn_ended" }
>;

export type ThreadEventKind = JournaledEvent["ev"];

/** The most journaled events that ride in one `replay` frame. A frame is cut on
    whichever limit is reached first, this or `REPLAY_CHUNK_BYTES`. */
export const REPLAY_CHUNK_SIZE = 500;

/**
 * The most payload bytes that ride in one `replay` frame.
 *
 * A count on its own is the wrong budget, because journaled events are not the
 * same size: most `update`s are a few hundred bytes of streamed text, but a
 * codex tool call carries its terminal output in `_meta.terminal_output_delta`,
 * a `MultiEdit` carries every hunk, and a diff carries both sides of the file.
 * Five hundred of those is a multi-megabyte frame — held whole as a string on
 * this end while it is built and on the browser's end while it is parsed, which
 * is exactly the spike bulk replay was introduced to remove.
 */
export const REPLAY_CHUNK_BYTES = 256 * 1024;

/**
 * The most payload bytes an unresumed attach replays before it starts
 * withholding whole turns.
 *
 * The step budget the client names (`REPLAY_WINDOW_STEPS`) bounds the replay in
 * *turns*, which is the unit the transcript is cut in but not the unit the wait
 * is paid in: a turn is anything from one sentence to a build log, so ten of
 * them is unbounded in size and one thread's window is another's whole archive.
 * This is the same budget `REPLAY_CHUNK_BYTES` applies to a single frame, one
 * level up — that one decides how the payload is sliced, and only this one
 * decides how much of it there is.
 *
 * The window is whichever of the two binds first — ten turns, or this many
 * bytes — so an ordinary thread's tail arrives whole while a build-log turn is
 * withheld rather than streamed. What is withheld is not lost — `earlier`
 * counts it and `load_earlier` pages it back exactly as it does for a
 * step-capped window.
 */
export const REPLAY_WINDOW_BYTES = 50 * 1024;

/** How many journaled steps one `load_earlier` page returns when the caller
    does not say. A **step** is a turn — the log is cut only at `turn_started`
    boundaries, so a page is always a whole number of turns and the client never
    re-folds one that begins mid-way (the old event-counted page landed wherever
    the count ran out). The count is the reader's pick now (`earlierPageSteps`
    below); this is the default an older client still gets. */
export const EARLIER_PAGE_STEPS = 20;

/** The most turns one page may be asked for. A page is read, merged and parsed
    before it is sent, so an unbounded count would let one click pull a whole
    archive through the server's heap — the client's own picker stops well below
    this; the cap is for a caller that does not. */
export const MAX_EARLIER_PAGE_STEPS = 500;

/** The page size a `load_earlier` (or `GET …/earlier?steps=`) asked for,
    clamped. Absent means `EARLIER_PAGE_STEPS`: the size used to be the server's
    alone, so a client that predates the setting asks for nothing and must keep
    getting the page it always got. */
export function earlierPageSteps(steps: number | undefined): number {
  if (typeof steps !== "number" || !Number.isFinite(steps)) return EARLIER_PAGE_STEPS;
  return Math.min(MAX_EARLIER_PAGE_STEPS, Math.max(1, Math.floor(steps)));
}

/** Preview-card excerpts on `TurnTick`: the prompt that opened the turn, and
    the start of the answer it drew. Truncation, not content — the full
    messages still come only from the replay. */
export const TURN_TICK_TEXT = 160;
export const TURN_TICK_REPLY = 240;

/** One entry of the thread's table of contents: every turn the journal holds,
    oldest first. The attach bracket carries the whole list (see `attached`),
    so the turn rail can draw every tick — including turns whose messages are
    still on the server behind `earlier` — without paging history in first.
    `text` is the prompt that opened the turn and `reply` the start of what it
    drew back, both truncated for the preview card; the full messages still
    come only from the replay. */
export interface TurnTick {
  turnId: string
  /** The seq of the turn's `turn_started` — what a client paging backwards
      walks towards when jumping to a turn whose messages are still withheld. */
  seq: number
  text: string
  reply: string
}

/** The answer to `load_earlier`: a page of history older than what the client
    has, plus how many older steps are still behind it. */
export interface EarlierPage {
  events: JournaledEvent[];
  /**
   * The seq this page begins at — where the client's window now starts, and
   * what the next page back is asked for.
   *
   * Stated rather than counted. The client used to subtract the page's length
   * from the window it held, which was exact only while one journaled event was
   * one event on the wire; a page whose chunk runs are merged (`coalescedPage`)
   * carries fewer events than the seqs it spans, and subtracting its length
   * left the window short — the next page would then be asked for from inside
   * the one already folded and fold those turns in twice.
   */
  from: number;
  /** Steps (turns) before `from` that were not sent. 0 = this is the head of
      the log and there is nothing left to ask for. */
  earlier: number;
}

export const JOURNALED_EVENTS: readonly ThreadEventKind[] = [
  "update",
  "session_config",
  "config_notice",
  "turn_started",
  "turn_ended",
];

export type ThreadEvent =
  | { ev: "session_title"; title: string }
  /* ---- attach lifecycle ----
     These two bracket the replay. Without the bracket a client cannot tell a
     replayed `turn_ended` from a live one, and every reload would re-fire a
     desktop (and, with nobody watching, a push) notification for a turn that
     finished hours ago. */
  | {
      ev: "attached";
      /** The seq the replay starts at. For a windowed attach this is the
          `turn_started` of the first step in the tail — whole turns only,
          never a cut inside one. */
      from: number;
      /** The seq the replay ends at — the log's length at attach time, the same
          number `caught_up` carries as `cursor`. Said here, before the events,
          because it is the only thing that turns the wait into a quantity: the
          client counts what it unrolls and `to - from` is the denominator. It
          costs nothing to state (`attach` already reads it in this tick for the
          `caught_up` below) and the alternative is a progress readout that
          learns its own total at the moment it stops needing one. */
      to: number;
      /** Whether `from` is the client's OWN cursor — i.e. the replay continues
          the transcript already on screen rather than replacing it.

          This used to be read off `from > 0`, which held only while every
          non-zero `from` came from the client. A windowed attach breaks that:
          the server picks a `from` in the middle of the log for a client that
          has nothing, and the two cases want opposite handling — one appends,
          the other resets. So the server states which it is instead of leaving
          the client to infer it from a number that now has two sources. */
      resumed: boolean;
      /** Steps (turns) before `from` that were NOT sent and are still on the
          server, fetchable with `load_earlier`. 0 for an ordinary attach (the
          replay is the whole log) and for a resume (the client has them). */
      earlier: number;
      /** No agent process behind this thread: the transcript is being served
          from the journal alone. Commands will be refused until it is revived,
          which is what the composer says instead of pretending otherwise. */
      archived: boolean;
      acpSessionId: string | null;
      /** Set when this process came up on an empty session because the thread's
          conversation could not be loaded. Absent is the normal case. */
      historyLost?: HistoryLost;
      /** The thread's whole table of contents — one entry per journaled turn,
          oldest first, including the turns withheld behind `earlier`. The rail
          draws every tick from this without paging history in; a resume omits
          it (absent, not empty — the client already holds the thread through
          its own window and an absent list must not clear that). */
      turns?: TurnTick[];
    }
  /** `queue` rides here because the queue is not journaled (see the `queue`
      event): a peer attaching has to be handed it the way it is handed an
      open permission after the replay. */
  | {
      ev: "caught_up";
      cursor: number;
      promptActive: boolean;
      queue?: QueuedMessage[];
      /** The hold, in exactly the shape the `paused` event carries it — a
          hold is current state, so an attaching peer is told it here rather
          than finding it in a replay that never carried it. Absent means
          not held. */
      hold?: ThreadHold;
      /** A retry the turn is waiting out, in the shape the `retry` event
          carries it — state, like the hold, and the one a late peer is most
          likely to attach in the middle of, since a backoff is seconds long
          and never journaled. Absent means not retrying. */
      retry?: ThreadRetry;
      /** A config change held for this turn's boundary, in the shape the
          `staged_config` event carries it — current state, like the hold and
          the queue, so an attaching peer is told rather than left to find the
          menus moved when the turn ends. Absent means nothing staged. */
      staged?: StagedConfig;
      /** Background work is still running, in the shape the `background` event
          carries it. One of these hand-overs, and the one a replay can never be
          right about: the run's `async_task_*` beats *are* journaled
          (they are ordinary updates), so a transcript folded from the archive
          of a dead run ends on its last `running` and would claim the thread is
          busy forever. Said after the replay, so the server's word is last.
          Absent means nothing is running. */
      background?: true;
      /** How full the agent says its context window is, from the newest
          `usage_update` this thread has ever produced (`Session.context`).
          Rides here for the same reason the three above do — it is state, not
          history — and it lands *after* the replay on purpose: a windowed
          replay may carry no reading at all, and a `load_earlier` page carries
          an older one, so the last word has to be the server's. Absent means
          this runtime has never reported one. */
      context?: acp.UsageUpdate;
      /** Extrema and weighted-average inputs for measured turns. */
      tps?: TpsStats;
    }
  /** The replay, in bulk. A container, not a fifth journaled kind: the events
      inside are the same events a live socket receives and the client unrolls
      them through the same dispatch, so `attached`/`caught_up` still bracket
      the history exactly as before. It exists because a long thread is a few
      thousand frames, and a browser wakes up, parses and re-renders once per
      frame — the replay was the socket's cost, not the database's. Sent only
      to a client that asked for it (`?batch=1` on the socket): a client that
      did not gets the events one by one and must not be handed a shape it
      would drop on the floor, since dropping the replay drops `caught_up`
      with it and the thread would never finish connecting. Chunked at
      `REPLAY_CHUNK_SIZE`, so a very long thread is a handful of frames rather
      than one enormous string held whole on both ends. */
  | { ev: "replay"; events: JournaledEvent[] }

  /* ---- journaled ---- */
  /** `historyReplay` is set for the updates a `session/load` streams back. The
      server knows exactly when that replay starts and ends, so unlike the old
      client-side sniff this flag is authoritative. It becomes the reducer's
      `allowUserChunks`: during a load, user chunks are the only source of user
      messages.
      `sessionId` is set only when the update belongs to a **subagent's**
      session — a child announced by `subagent_spawned` — and names that child.
      Absent means the thread's own session, which keeps the shape of every
      event journaled before subagents existed exactly as it was. The reducer
      files an update carrying it under the child rather than the thread. */
  | {
      ev: "update";
      seq: number;
      update: SessionUpdate;
      historyReplay: boolean;
      /** Original prompt text and refs recovered from the pre-load turn journal. */
      historyText?: string;
      historyAttachments?: AttachmentRef[];
      sessionId?: string;
      /** Epoch ms the journal wrote it. A replay is the reader's reload, not
          the moment a step began, so the client times a step from this and
          falls back to its own clock for a journal that predates it. */
      at?: number;
      /** Epoch ms the journal wrote the **last** row of the run this event
          stands for (`coalescedPage`) — present only where the read merged a
          run, and only on a replay. `at` says when a streamed run began and
          this says when it ended, so a step read back out of the journal is
          *measured* rather than re-derived: without it a replayed thought had
          no end to subtract its start from, and every reloaded transcript
          showed a thought with no duration at all. Live updates never carry
          it — the client times its own live reads off `at` and its clock. */
      endAt?: number;
    }
  /** One event for three sources — the `session/new` response, the
      `session/load` response, and any accepted `set_mode`/`set_config_option`.
      It carries **absolute** state, which is what makes it safe to both journal
      and broadcast: replaying it is idempotent. Never make it a delta. */
  | {
      ev: "session_config";
      seq: number;
      modes?: acp.SessionModeState | null;
      modeId?: string;
      configOptions?: acp.SessionConfigOption[];
      /** What the *runtime* can carry in a prompt, from the `initialize`
          handshake — the agent's half of the attachment decision (see
          delivery.ts). Optional and absolute like everything else here, so an
          event journaled before it existed replays with its shape unchanged.
          The other carrier is the option probe, which is what lets a draft —
          which has no process, by construction — resolve delivery before its
          first send. */
      promptCapabilities?: acp.PromptCapabilities;
      /** Whether the runtime takes `pause`/`resume` — advertised at the
          handshake as `agentCapabilities._meta["daedalus/pause"]`. Same
          carrier and same rules as `promptCapabilities`: absolute, optional,
          a statement of what this session can be asked to do. */
      canPause?: boolean;
      /** Whether the runtime takes a compaction *request* — advertised at the
          handshake as `agentCapabilities._meta["daedalus/compact"]`. Not a
          claim that it compacts: ACP's `compaction_update` is any agent's to
          send, and most send it without ever taking an instruction. Same
          carrier and same rules as `canPause`. */
      canCompact?: boolean;
      /** Whether this session's process can be forked — ACP's own
          `session/fork`, advertised as `agentCapabilities.sessionCapabilities.fork`.
          Same carrier and same rules as `canPause`: absolute, optional, a
          statement of what this session can be asked to do, this time in
          service of rewind rather than pause. */
      canRewind?: boolean;
      /** Which door this process's model calls come through
          (`model-calls/index.ts` `chooseDoor`): the panel says "from its
          telemetry" / "from the gateway" / "from its saved files" / "the
          provider's bill per step" from it. Same carrier and rules as
          `canPause`; absent on an event journaled before it existed. */
      callsVia?: CallsVia;
    }
  /** A mode, model or reasoning-effort change that landed while a turn was
      running (`AcpBridge.setMode`/`setConfigOption` with a prompt in flight).
      Held for the step boundary like a steer and journaled on flush — at the
      latest the turn's own settle — so a late joiner reads it inline where it
      happened rather than finding the menus moved with no account of when,
      and it stays logged after the turn as well as drawn during it. One event
      per accepted change, in arrival order; a change made while idle journals
      only the `session_config` above and draws no row. The client renders it
      as a `notice` rule (`Mode: Plan → Build`). Absolute text, replayed
      verbatim — never a delta to resolve. */
  | { ev: "config_notice"; seq: number; text: string }
  /** The turn is held at a step boundary, or no longer is. Absolute and
      live-only, like `queue`: it is current state rather than history, so
      `caught_up` carries it on attach and a replay never redraws an old hold.
      To every peer including the one that asked.

      Two things hold a turn and they are one wait. `"user"` is the composer's
      toggle. `"error"` is a **turn that failed** — a rate limit, an exhausted
      quota, a key that stopped working — held at the boundary instead of
      ending, with every tool call it has already made intact, while the user
      changes the model or the profile (which the harness can do on the running
      process) and lets it go on. So a held turn is still `turnActive`: it has
      not ended, there is no `turn_ended`, and `error` here is a state to draw,
      never a failure to record. Only a runtime that owns its own loop can do
      this — the same one `canPause` names. */
  | ({ ev: "paused" } & ThreadHold)
  /** The turn failed on something worth trying again, and is waiting out a
      backoff before it does. Absolute and live-only exactly like `paused` —
      `caught_up` carries it, a replay never redraws it, `retry: null` ends it
      — and it is the same failure said one step earlier: if the attempts run
      out, this clears and a `paused` with `reason: "error"` takes its place.
      Only a runtime that owns its own loop can report one. */
  | { ev: "retry"; retry: ThreadRetry | null }
  /** Background work this thread's agent launched is still running, or is not
      (`active: false`). Absolute and live-only, exactly like `paused`: it is
      current state rather than history, so `caught_up` carries it on attach and
      a replay never redraws a run that has long ended. To every peer including
      the one that asked.

      It exists because a turn ending is not the thread being done. Claude Code
      launches a dynamic workflow as a background task and answers its prompt
      `end_turn` at "launched", so `turn_ended` says the truth and nothing else
      about the thread — the run works on for minutes. `turnActive` stays the
      turn's on purpose (Stop, the queue and the turn footers all mean a turn by
      "running"), so this is the other reading: what the thread is doing when no
      turn is. Background work is neither an error nor a hold; it is why a
      thread with nothing in flight is not idle. */
  | { ev: "background"; active: boolean }
  /** The thread moved to another provider, model or effort *without* being
      restarted (`SessionManager.applyConfig`). Absolute, like `session_config`,
      but live-only and not journaled: it is the session row's own state, and a
      peer attaching later reads it from the row instead. Fanned out to every
      peer including the one that asked — the change may have been rewritten on
      the way (a profile's default model standing in for a cleared one), so the
      answer, not the request, is what every menu should draw. */
  | {
      ev: "spawn_config";
      profileId: string;
      model: string;
      effort: string;
      suggestKinds?: string[];
      uiGroups?: string[];
      /** The thread's persona, absolute; null = none. */
      personaId?: string | null;
      /** The thread's helper models, absolute — the row's, so a menu draws the
          answer rather than the request. */
      helperModels?: { role: string; model: string }[];
    }
  /** A config change is waiting for the running turn to end, or is no longer
      (`config: null` — it was applied, cancelled, or the process went away).
      Absolute and live-only, like `queue` and `paused`: it is current state
      rather than history, `caught_up` carries it on attach, and a replay must
      never redraw a change that has long since landed. To every peer including
      the one that asked — a change staged from a phone has to be visible on the
      laptop, or the turn ends and the model moves with no account of why. */
  | { ev: "staged_config"; config: StagedConfig | null }
  /**
   * The agent process is being replaced under this thread, and then: it is up,
   * or it failed.
   *
   * `POST /api/sessions/:id/config` used to hold its HTTP answer open across
   * the whole spawn → `session/load` → restore sequence — seconds, with the
   * browser blocked on a request and nothing to draw but a spinner, and every
   * *other* device learning nothing at all while the journal was cleared and
   * refilled underneath its open socket. So the route answers as soon as it has
   * decided (live or not), the sequence runs on, and this says where it got to.
   *
   * Live-only and never journaled: it describes a process, not a conversation.
   * `failed` carries the reason the way any thread failure is carried, and
   * leaves a thread that needs reviving.
   *
   * **`kept` says whether the journal survived**, and it is what the other two
   * states mean. False is the old bargain: the log was cleared and the
   * conversation reloaded into it, so `started` means "stop folding events into
   * a transcript that is about to be replaced" and `ready` means "reattach from
   * 0", every saved cursor into that log now naming nothing. True — the
   * ordinary case for a setting change on a live thread — means nothing was
   * cleared and nothing restated: the socket carries on where it was, the
   * cursor is still good, and the reader's transcript never moves. Stated on
   * `started` as well, because a peer that goes deaf there would drop the
   * `spawn_config` and `session_config` of the new process and, with no
   * reattach coming, never hear them again. Absent on a server that predates
   * the field, which is the old bargain and reads as false.
   */
  | { ev: "restart"; state: "started" | "ready" | "failed"; kept?: boolean; error?: WireError }
  /** A turn began, and whose words began it. Fanned out to every peer except
      the sender, which already showed its own message. */
  /** `attachments` is journaled, which is the whole point of carrying refs
      rather than bytes: a replayed user bubble still shows what was attached
      with nothing else stored. Absent on every event journaled before
      attachments existed, so their shape is unchanged. */
  | {
      ev: "turn_started";
      seq: number;
      turnId: string;
      text: string;
      attachments?: AttachmentRef[];
      /** Epoch ms the journal wrote it, so a replayed user bubble shows when it
          was sent, not when the page reloaded. Absent on older journals. */
      at?: number;
    }
  /** `promptText` is what lets a replayed failure still offer Retry.
      `continued` says the queue is draining into a new turn right behind this
      one — a "turn finished" notification for it would announce a pause that
      does not exist, so both the toast and the push read it. */
  | {
      ev: "turn_ended";
      seq: number;
      turnId: string;
      usage: acp.Usage | null;
      error?: WireError;
      promptText?: string;
      continued?: boolean;
      /** Wall-clock length of the whole logical turn, ms, measured
          server-side from the prompt that opened it to the settle — the
          denominator output tokens/sec is drawn against. Steering joins a
          turn rather than opening one, so a steered turn's duration covers
          every prompt in it. Absent on turns that ended before this field
          existed, which simply draw no speed. */
      durationMs?: number;
      /** Union wall time spent in the thread's own tool calls; overlapping calls count once. */
      toolDurationMs?: number;
      /** Output speed's own denominator, read off the thread's stream
          (`DecodeClock`). Absent when no generation was timed, or a journal
          from before it was measured — and then the speed falls back to
          throughput over `durationMs`. */
      generation?: TurnGeneration;
      /** The ACP `messageId` of the last content chunk this turn produced —
          absent when the runtime never sent one, or the turn produced no
          assistant chunks at all. Rewind reads this off the turn *before* the
          one being discarded: forking "up to and including" this id is what
          cuts a session cleanly at the boundary between two turns, since ACP
          has no notion of a turn to fork at, only a message. Optional like
          every field added to an event that already had journaled rows. */
      lastMessageId?: string;
      /** The AIR failure record the prompt's answer carried
          (`_meta.jetbrains.air.sessionFailure`) — a turn that failed and still
          answered `end_turn`. Journaled with the event, so a replay draws it
          where the live turn did. Absent on every older row. */
      failure?: SessionFailure;
    }

  /* ---- fan-out only ----
     Permissions and elicitations are deliberately not journaled: they live in
     `AcpBridge.pending` for as long as the agent is actually blocked on them,
     and a peer attaching later is sent whatever is still open. An answered
     request simply is not in the map, so there is nothing to filter. */
  /* `from`: the child thread (an ask, a workflow step) whose question this is,
     repeated on its parent so it is answered where the person is reading — and
     its `requestId` is then `<childId>:<requestId>`, which the parent's socket
     routes back to the child (`childRequest`). Absent on the thread's own. */
  | { ev: "permission"; requestId: string; request: acp.RequestPermissionRequest; from?: RequestFrom }
  | { ev: "elicitation"; requestId: string; request: acp.CreateElicitationRequest; from?: RequestFrom }
  | { ev: "request_answered"; requestId: string; toolCallId?: string; auto?: AutoAnswer }
  /** The whole queue, **absolute** — never a delta — to every peer including
      the one whose command changed it: ids are minted server-side, so no peer's
      own picture is authoritative. Not journaled: like a permission it is
      current state rather than history, and `caught_up` carries it on attach. */
  | { ev: "queue"; items: QueuedMessage[] }
  /** Time to first update of a turn, measured server-side — so it no longer
      includes the WebSocket hop to the browser. */
  | { ev: "ttft"; ms: number }
  /** What a turn did to the worktree, as git measured it (turn-changes.ts).
      Live-only: the row is the server's (`GET /api/sessions/:id/changes`
      answers every turn on attach) and this is only the nudge that it moved.
      Sent once when the turn's start snapshot exists (`files` empty, `ended`
      false) and once more with the diff when it has ended. */
  | { ev: "turn_changes"; turn: TurnChanges }
  /** What is left of the subscription this thread's (profile, agent) pair is
      spending — see quota.ts. Only a profile that names a plan of its own has
      one to report: a thread on an API-key profile is billed per token, and the
      probe's answer would be the machine's login, not that profile's. Sent when
      a turn settles, because the turn is what moved the number.

      Live-only and **absolute**, like `queue`: it is the current state of an
      account, not a thing that happened in this thread, and journaling it would
      make a replay redraw last week's percentages as though they were now. A
      client that wants one before a turn ends asks `GET /api/quota` — the same
      reading, through the same cache. See the QuotaSnapshot block above. */
  | { ev: "quota"; quota: QuotaSnapshot }
  | { ev: "task_event"; transcriptDir: string; event: Record<string, unknown> }
  | { ev: "reply"; id: number; result?: unknown; error?: undefined }
  | { ev: "reply"; id: number; error: WireError; result?: undefined };
