import type * as acp from "@agentclientprotocol/sdk";

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
  /** Epoch ms when the window rolls over, when the runtime gives a timestamp. */
  resetsAt?: number | null;
  /** The runtime's own already-formatted reset string, when that is all it gave.
      Claude Code prints `Aug 31, 9:59am (Africa/Cairo)` — localized, in the
      *server's* timezone. Re-parsing that into an instant is guesswork nobody
      asked for, so it is carried verbatim; a renderer prefers `resetsAt` when
      both are present. */
  resetsLabel?: string;
  windowMinutes?: number | null;
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
export interface WireError {
  code: number;
  message: string;
  data?: unknown;
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

/** Everything a `session/update` can carry: the SDK's union plus the RFD's. */
export type SessionUpdate =
  | acp.SessionUpdate
  | SubagentSpawned
  | SubagentStateUpdate
  | SubagentUsage
  | AutonomyAnswer;

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
}

/** The answer to `prompt` and `queue_add`. Which shape comes back is the
    server's call: only it knows whether the turn is still open, so a client
    that believed the thread idle can still be told its words were queued. */
export type PromptReply = { turnId: string } | { queued: true; itemId: string };

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
  | { id: number; cmd: "cancel" }
  /* ---- the queue ----
     `queue_add` is `prompt` from a client that already knows the thread is
     busy — on an idle thread it drains at once, so there is one path. The
     three edits work with no agent process at all: a parked queue on an
     archived thread is edited without spawning one to do it. `queue_send_now`
     interrupts the running turn and sends (one item, or everything combined);
     `queue_steer` injects one item into the running turn without stopping it. */
  | { id: number; cmd: "queue_add"; text: string; attachmentIds?: string[] }
  | { id: number; cmd: "queue_update"; itemId: string; text: string; attachmentIds?: string[] }
  | { id: number; cmd: "queue_remove"; itemId: string }
  | { id: number; cmd: "queue_clear" }
  | { id: number; cmd: "queue_send_now"; itemId?: string }
  | { id: number; cmd: "queue_steer"; itemId: string }
  | { id: number; cmd: "set_mode"; modeId: string }
  | { id: number; cmd: "set_config_option"; configId: string; value: string | boolean }
  | { cmd: "answer_permission"; requestId: string; response: acp.RequestPermissionResponse }
  | { cmd: "answer_elicitation"; requestId: string; response: acp.CreateElicitationResponse }
  /** Fetch the page of journaled steps immediately before `before` (the seq of
      the step's `turn_started` — see `attached.from`). Answered with
      `EarlierPage`. Only useful to a client that asked for a windowed attach —
      see `attached.earlier`. */
  | { id: number; cmd: "load_earlier"; before: number }
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

/** The four event kinds that are written to `session_events` and replayed on
    attach. Everything else is fan-out only. */
export type JournaledEvent = Extract<
  ThreadEvent,
  { ev: "update" | "session_config" | "turn_started" | "turn_ended" }
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

/** How many journaled steps one `load_earlier` page returns. A **step** is a
    turn — the log is cut only at `turn_started` boundaries, so a page is always
    a whole number of turns and the client never re-folds one that begins
    mid-way (the old event-counted page landed wherever the count ran out). */
export const EARLIER_PAGE_STEPS = 20;

/** The answer to `load_earlier`: a page of history older than what the client
    has, plus how many older steps are still behind it. */
export interface EarlierPage {
  events: JournaledEvent[];
  /** Steps (turns) before `events[0]` that were not sent. 0 = this is the
      head of the log and there is nothing left to ask for. */
  earlier: number;
}

export const JOURNALED_EVENTS: readonly ThreadEventKind[] = [
  "update",
  "session_config",
  "turn_started",
  "turn_ended",
];

export type ThreadEvent =
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
    }
  /** `queue` rides here because the queue is not journaled (see the `queue`
      event): a peer attaching has to be handed it the way it is handed an
      open permission after the replay. */
  | { ev: "caught_up"; cursor: number; promptActive: boolean; queue?: QueuedMessage[] }
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
  | { ev: "update"; seq: number; update: SessionUpdate; historyReplay: boolean; sessionId?: string }
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
    }
  /** The thread moved to another provider, model or effort *without* being
      restarted (`SessionManager.applyConfig`). Absolute, like `session_config`,
      but live-only and not journaled: it is the session row's own state, and a
      peer attaching later reads it from the row instead. Fanned out to every
      peer including the one that asked — the change may have been rewritten on
      the way (a profile's default model standing in for a cleared one), so the
      answer, not the request, is what every menu should draw. */
  | { ev: "spawn_config"; profileId: string; model: string; effort: string; personaId?: string }
  /** A turn began, and whose words began it. Fanned out to every peer except
      the sender, which already showed its own message. */
  /** `attachments` is journaled, which is the whole point of carrying refs
      rather than bytes: a replayed user bubble still shows what was attached
      with nothing else stored. Absent on every event journaled before
      attachments existed, so their shape is unchanged. */
  | { ev: "turn_started"; seq: number; turnId: string; text: string; attachments?: AttachmentRef[] }
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
    }

  /* ---- fan-out only ----
     Permissions and elicitations are deliberately not journaled: they live in
     `AcpBridge.pending` for as long as the agent is actually blocked on them,
     and a peer attaching later is sent whatever is still open. An answered
     request simply is not in the map, so there is nothing to filter. */
  | { ev: "permission"; requestId: string; request: acp.RequestPermissionRequest }
  | { ev: "elicitation"; requestId: string; request: acp.CreateElicitationRequest }
  | { ev: "request_answered"; requestId: string; toolCallId?: string; auto?: AutoAnswer }
  /** The whole queue, **absolute** — never a delta — to every peer including
      the one whose command changed it: ids are minted server-side, so no peer's
      own picture is authoritative. Not journaled: like a permission it is
      current state rather than history, and `caught_up` carries it on attach. */
  | { ev: "queue"; items: QueuedMessage[] }
  /** Time to first update of a turn, measured server-side — so it no longer
      includes the WebSocket hop to the browser. */
  | { ev: "ttft"; ms: number }
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
