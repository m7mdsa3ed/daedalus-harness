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

/** What a respawn has to put back: the agent's configuration minus the two
    settings the profile owns. See AcpBridge.captureRestoreState. */
export interface RestoreState {
  modeId?: string;
  configOptions: acp.SessionConfigOption[];
}

export type HistoryStrategy = "native-revert" | "fork-checkpoint" | "unsupported";

export interface HistoryCheckpointSummary {
  id: string;
  turnId: string;
  promptText: string;
  createdAt: number;
  completedAt: number | null;
  status: string;
}

export interface HistoryBranchSummary {
  id: string;
  label: string;
  sourceCheckpointId: string;
  createdAt: number;
}

export interface HistoryState {
  strategy: HistoryStrategy;
  available: boolean;
  busy: boolean;
  reason?: string;
  conflict?: string;
  checkpoints: HistoryCheckpointSummary[];
  branches: HistoryBranchSummary[];
}

// ---- client -> server ----

/**
 * The four commands carrying `id` get exactly one `reply`. The two answers do
 * not: whether a peer's answer won the race is told by `request_answered`,
 * which every peer needs anyway.
 */
export type ThreadCommand =
  | { id: number; cmd: "prompt"; text: string }
  | { id: number; cmd: "cancel" }
  | { id: number; cmd: "set_mode"; modeId: string }
  | { id: number; cmd: "set_config_option"; configId: string; value: string | boolean }
  | { cmd: "answer_permission"; requestId: string; response: acp.RequestPermissionResponse }
  | { cmd: "answer_elicitation"; requestId: string; response: acp.CreateElicitationResponse }
  | { id: number; cmd: "load_earlier"; before: number }
  | { id: number; cmd: "revert"; checkpointId: string }
  | { id: number; cmd: "recover_branch"; branchId: string };

// ---- server -> client ----

/** The four event kinds that are written to `session_events` and replayed on
    attach. Everything else is fan-out only. */
export type JournaledEvent = Extract<
  ThreadEvent,
  { ev: "update" | "session_config" | "turn_started" | "turn_ended" }
>;

export type ThreadEventKind = JournaledEvent["ev"];

/** How many journaled events ride in one `replay` frame. */
export const REPLAY_CHUNK_SIZE = 500;

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
      from: number;
      acpSessionId: string | null;
      /** Set when this process came up on an empty session because the thread's
          conversation could not be loaded. Absent is the normal case. */
      historyLost?: HistoryLost;
      history: HistoryState;
    }
  | { ev: "caught_up"; cursor: number; promptActive: boolean }
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
      messages. */
  | { ev: "update"; seq: number; update: acp.SessionUpdate; historyReplay: boolean }
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
    }
  /** A turn began, and whose words began it. Fanned out to every peer except
      the sender, which already showed its own message. */
  | { ev: "turn_started"; seq: number; turnId: string; text: string }
  /** `promptText` is what lets a replayed failure still offer Retry. */
  | {
      ev: "turn_ended";
      seq: number;
      turnId: string;
      usage: acp.Usage | null;
      error?: WireError;
      promptText?: string;
    }

  /* ---- fan-out only ----
     Permissions and elicitations are deliberately not journaled: they live in
     `AcpBridge.pending` for as long as the agent is actually blocked on them,
     and a peer attaching later is sent whatever is still open. An answered
     request simply is not in the map, so there is nothing to filter. */
  | { ev: "permission"; requestId: string; request: acp.RequestPermissionRequest }
  | { ev: "elicitation"; requestId: string; request: acp.CreateElicitationRequest }
  | { ev: "request_answered"; requestId: string; toolCallId?: string }
  /** Time to first update of a turn, measured server-side — so it no longer
      includes the WebSocket hop to the browser. */
  | { ev: "ttft"; ms: number }
  | { ev: "task_event"; transcriptDir: string; event: Record<string, unknown> }
  | { ev: "history_state"; history: HistoryState }
  | { ev: "history_reset"; history: HistoryState }
  | { ev: "reply"; id: number; result?: unknown; error?: undefined }
  | { ev: "reply"; id: number; error: WireError; result?: undefined };
