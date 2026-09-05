import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { performance } from "node:perf_hooks";
import { Readable, Writable } from "node:stream";
import * as acp from "./acp.js";
import { profileSupports, type Profile } from "./profiles.js";
import type { Project } from "./projects.js";
import { mentionLinks } from "./mentions.js";
import { attachmentBlocks } from "./attachment-blocks.js";
import type { PersonaSpawn } from "./personas.js";
import { getAgent, resolveSpawn } from "./registry.js";
import type {
  AttachmentRef,
  AutoAnswer,
  AutonomyAnswer,
  HistoryLost,
  QueuedMessage,
  RestoreState,
  SessionUpdate,
  ThreadEvent,
  ThreadHold,
  WireError,
} from "./protocol.js";
import { optionFor, stanceFor, type AutonomyPolicy } from "./autonomy.js";
import type { Peer } from "./sessions.js";
import { WEB_SEARCH_SERVER_NAME } from "./websearch.js";
import { CLAUDE_WORKFLOW_TOOL, WORKFLOW_SERVER_NAME } from "./workflow-schema.js";

/**
 * The ACP client, server-side.
 *
 * This is the half of the harness that speaks the protocol. One bridge per agent
 * process: it runs the handshake, owns the session, and turns everything the
 * agent says into the Daedalus events in protocol.ts. Nothing downstream —
 * neither the SessionManager nor the browser — sees a JSON-RPC frame.
 *
 * It used to be in the browser (`client/src/lib/acp.ts`), which forced the
 * server to arbitrate a protocol it did not speak: rewriting request ids so N
 * sockets could impersonate one ACP client. With one client here, N sockets are
 * just subscribers.
 */

/** Long enough for a cold agent to boot and answer `session/new`; short enough
    that a wedged one does not hold an HTTP request open forever. Same ceiling
    the probe uses, for the same reason. */
export const HANDSHAKE_TIMEOUT_MS = 25_000;

/**
 * Start an agent process. Both callers — a thread's bridge and the throwaway
 * one the options probe spawns — build the same child, from the same three
 * inputs, so this is the one place that knows how.
 */
export function spawnAgent(
  profile: Profile,
  agentId: string,
  project: Project,
  model?: string,
  effort?: string,
  /** The thread this process answers for, when there is one. It is what puts
      the child's gateway URL under `/gw/<key>/s/<id>/…`, so the endpoint,
      credentials and model behind it stay the harness's to change while the
      process runs. The probe has no thread and passes nothing. */
  sessionId?: string,
  /** The thread's persona, for an agent whose `personaVia` is `"env"`. An
      `"acp-meta"` agent's persona travels in the handshake instead
      (`sessionMeta`), and the probe has no thread and passes nothing. */
  persona?: PersonaSpawn,
  /** The loopback port and secret an agent with a `subagentFeed` is given so
      the server can read its event bus (`opencode-subagents.ts`). Minted per
      spawn by the SessionManager and never stored; the probe passes nothing
      and gets a process with no bus, which is all a probe needs. Appended to
      the resolved args and env here so the registry's own `args` — the
      user's — are never edited. */
  sidecar?: { port: number; password: string },
  /** No human in front of this thread — a workflow step, a scheduled run. The
      harness's own runtime holds a failed turn at its step boundary and waits
      to be told what model to try instead; with nobody at a config menu that
      wait never ends, and a run that would have failed and reported blocks
      forever instead. Fail fast there. Meaningless to every other runtime,
      which reads none of these vars. */
  unattended?: boolean,
): ChildProcessWithoutNullStreams {
  const agent = getAgent(agentId);
  if (!agent) throw new Error(`unknown agent: ${agentId}`);
  if (!profileSupports(profile, agentId)) {
    throw new Error(`profile "${profile.name}" is not configured for ${agentId}`);
  }
  // Skills/commands are NOT materialized here: what belongs in the cwd is the
  // union across the project's live threads, which only the SessionManager
  // knows (`materializeFor`). The probe writes the project's own set itself.
  const { command, args, env, cwd } = resolveSpawn(
    agent,
    profile,
    project,
    model,
    effort,
    sessionId,
    agent.personaVia === "env" ? persona : undefined,
  );
  if (sidecar && agent.subagentFeed === "opencode-http") {
    args.push("--port", String(sidecar.port), "--hostname", "127.0.0.1");
    env.OPENCODE_SERVER_PASSWORD = sidecar.password;
  }
  if (unattended) env.DAEDALUS_AGENT_HOLD_ON_ERROR = "0";
  return spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
}

/** `acp.SessionNotification` widened to the updates the SDK does not know yet
    (protocol.ts `SessionUpdate`). */
interface SessionNotification {
  sessionId: string;
  update: SessionUpdate;
  _meta?: Record<string, unknown> | null;
}

/** `clientCapabilities.subagents: {}` — the RFD's opt-in, typed as the SDK's
    capabilities so it can be spread into the handshake literal without the
    excess-property check refusing a key the SDK has not learned yet. */
const SUBAGENT_CAPABILITY = { subagents: {} } as unknown as Partial<acp.ClientCapabilities>;

/* The fifth bargain, and the one that decides whether a *dynamic workflow* is
   legible. Claude Code runs one as a background task that outlives the turn,
   and streams its shape — phases, and per agent a label, a state, a model,
   tokens, a tool count and the tool it is on — as `workflow_progress` on the
   SDK's `task_progress`. claude-agent-acp republishes that as the
   `async_task_*` updates below, but its whole async-task runtime is inert
   unless the client advertises this, so unclaimed the harness sees none of it.
   What it saw instead was the run's `journal.jsonl` (tasks.ts still tails it):
   `started`/`result` lines keyed by an agent hash, which is why a native run
   drew as a row of anonymous dots. The terminal snapshot beside the run holds
   the full shape but is not written until the run ends, so the stream is the
   only live source.

   The shape is the JetBrains AIR extension's, spelled exactly as
   `clientSupportsAirCapability` reads it — a version and a list of capability
   names, under `_meta.jetbrains.air`. Declared here as a constant, like
   SUBAGENT_CAPABILITY, because none of it is in the SDK's types.

   Requires the adapter's `workflow_progress` passthrough (`pnpm patch:acp`).
   Without the patch this still earns the run's name, live token and tool
   counts and its terminal state — everything except the per-agent tree. */
const AIR_ASYNC_TASKS_META = {
  jetbrains: { air: { version: 1, capabilities: ["asyncTasks"] } },
} as const;

/* The harness's own pause pair, spelled the same in `agent/src/app.ts`. ACP
   has no pause — `session/cancel` is the one interruption and it throws the
   step away — so this exists only for a runtime that owns its loop and can
   hold at a step boundary. Advertised by the agent at the handshake, under
   the `_meta` the spec reserves for exactly this, and offered to the browser
   through `session_config.canPause`. */
const PAUSE_METHOD = "_daedalus/session/pause";
const RESUME_METHOD = "_daedalus/session/resume";
const PAUSE_CAPABILITY = "daedalus/pause";
/* The one direction the pair never had. A pause is asked for from this end and
   answered in the same reply; a *hold* is taken at the other end — a turn that
   failed and is waiting to be told what model to try instead — so it can only
   arrive as a notification. Same capability, because the same runtimes can do
   both, and the same `paused` event out to the browser, carrying the reason. */
const PAUSED_NOTIFICATION = "_daedalus/session/paused";

interface PausedParams {
  sessionId?: string;
  paused?: boolean;
  reason?: "user" | "error";
  message?: string;
  detail?: string;
}

const parsePausedParams = (params: unknown): PausedParams => (params ?? {}) as PausedParams;

/**
 * The subagent RFD's two updates are ahead of the SDK, and the SDK is not
 * lenient about that: `acp.client()` installs a `session/update` router *ahead
 * of every handler* which validates each frame against a closed union of the
 * variants it knows and throws on anything else — the frame is logged and
 * dropped before a handler registered with its own parser gets a look. So the
 * two are moved to a private method name on the way in (`agentStream`), where
 * the SDK has nothing to say about them, and the bridge listens on both names.
 * Goes away the day the SDK's union carries the RFD. The agent runtime meets
 * the same closed schema from the other side (`agent/src/app.ts`, the identity
 * parser on `initialize`); the one fact behind both is written up once in
 * docs/protocol.md ("The SDK seam").
 *
 * `_daedalus/subagent_usage` rides the same detour. It is ours, not the RFD's
 * — the workflow runner emits it server-side, where no validator ever sees it
 * — and it is listed here so an agent may say it too: the fake agent draws a
 * whole run with it, and a runtime that one day reports what a child spent has
 * somewhere to put it. The bridge forwards it whole either way, as it does
 * every other update.
 */
const SUBAGENT_UPDATE_METHOD = "_daedalus/subagent_update";
const SUBAGENT_UPDATE_KINDS: ReadonlySet<string> = new Set([
  "subagent_spawned",
  "subagent_state_update",
  "_daedalus/subagent_usage",
  /* The AIR async-task lifecycle (protocol.ts `AsyncTaskSpawned` and kin) is
     ahead of the SDK in exactly the same way, and met exactly the same fate:
     the adapter sent every beat of a dynamic workflow, the server logged each
     one as an unknown variant and dropped it, and the client saw nothing —
     found by driving a run end to end after `AIR_ASYNC_TASKS_META` went in.
     Same detour, for as long as the SDK's union lacks them. */
  "async_task_spawned",
  "async_task_progress",
  "async_task_state_update",
]);

/** The structural check the rerouted frames are parsed with: the shape the
    bridge itself relies on. An agent that sends something else is speaking a
    protocol this bridge does not, and the SDK's own answer to that (a logged
    error, the frame dropped) is the right one, so this throws the same way
    its parser would. */
function parseSessionNotification(params: unknown): SessionNotification {
  const p = params as Partial<SessionNotification> | null;
  const tag = (p?.update as { sessionUpdate?: unknown } | undefined)?.sessionUpdate;
  if (!p || typeof p.sessionId !== "string" || typeof tag !== "string") {
    throw acp.RequestError.invalidParams("session/update: expected {sessionId, update.sessionUpdate}");
  }
  return p as SessionNotification;
}

const isSubagentUpdate = (message: acp.AnyMessage): boolean => {
  if (!("method" in message) || message.method !== acp.methods.client.session.update) return false;
  const tag = ((message.params as { update?: { sessionUpdate?: unknown } } | undefined)?.update)?.sessionUpdate;
  return typeof tag === "string" && SUBAGENT_UPDATE_KINDS.has(tag);
};

/**
 * Codex's "Model metadata for `…` not found. Defaulting to fallback metadata"
 * notice, in the shape codex-acp streams it: a text chunk whose content begins
 * "Warning: Model metadata for ". Matched on the wording, not on the
 * particular `sessionUpdate`, because that is what is stable across codex-acp
 * builds and what is meaningful to a human — anything else a gateway agent
 * warns about still gets through, and a chunk that is not a warning is left
 * alone.
 */
function isFallbackModelMetadataWarning(update: { sessionUpdate?: unknown; content?: unknown; text?: unknown }): boolean {
  if (update.sessionUpdate !== "agent_message_chunk") return false;
  let text = "";
  if (update.content && typeof update.content === "object") {
    const content = update.content as Record<string, unknown>;
    if (typeof content.text === "string") text = content.text;
  } else if (typeof update.text === "string") {
    text = update.text;
  }
  return text.includes("not found. Defaulting to fallback metadata");
}

/** The ndJSON stream over a spawned agent's stdio. From here on the SDK owns
    stdout — a stray 'data' listener anywhere else silently steals its bytes.
    Inbound frames pass through one rewrite: a `session/update` carrying an RFD
    subagent variant is re-addressed to `SUBAGENT_UPDATE_METHOD` (see there). */
export function agentStream(
  proc: ChildProcessWithoutNullStreams,
  /** A second source of inbound frames, merged ahead of the rewrite — the
      OpenCode sidecar's synthesized `session/update`s, addressed to a child's
      session id (`opencode-subagents.ts`). The merged stream ends when
      **stdout** ends: the process is the conversation, and a feed that
      outlives it has nothing left to say. */
  extra?: ReadableStream<acp.AnyMessage>,
): acp.Stream {
  const stream = acp.ndJsonStream(
    Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>,
  );
  const reroute = new TransformStream<acp.AnyMessage, acp.AnyMessage>({
    transform(message, controller) {
      controller.enqueue(
        isSubagentUpdate(message) ? { ...message, method: SUBAGENT_UPDATE_METHOD } : message,
      );
    },
  });
  const inbound = extra ? mergeReadables(stream.readable, extra) : stream.readable;
  return { writable: stream.writable, readable: inbound.pipeThrough(reroute) };
}

/** `primary` and `extra` interleaved in arrival order; closes with `primary`.
    Exported for the unit test. */
export function mergeReadables<T>(primary: ReadableStream<T>, extra: ReadableStream<T>): ReadableStream<T> {
  const merged = new TransformStream<T, T>();
  const writer = merged.writable.getWriter();
  const pump = async (source: ReadableStream<T>) => {
    const reader = source.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        await writer.write(value);
      }
    } catch {
      /* the writer closed under us — the primary ended */
    } finally {
      reader.releaseLock();
    }
  };
  void pump(extra);
  void pump(primary).then(() => writer.close().catch(() => {}));
  return merged.readable;
}

/** An agent request the agent is currently blocked on. Held here rather than in
    the journal because it is tied to the process's life, not the thread's: when
    the process goes, so does the question. A peer attaching later is sent
    whatever is still in this map, which is why replay needs no "skip the ones
    somebody already answered" filter — an answered request is simply gone. */
interface PendingRequest {
  requestId: string;
  kind: "permission" | "elicitation";
  /** Which tool call the question belongs to. The permission nests it under
      `toolCall`; the elicitation carries it flat. Either way it is what tells
      the other peers WHICH card the first answer just closed. */
  toolCallId?: string;
  /** The request itself, so a peer that attaches while the agent is still
      blocked can be handed the question rather than a dead thread. */
  payload: acp.RequestPermissionRequest | acp.CreateElicitationRequest;
  settle: (response: never) => void;
  /** The ask-timeout fallback for this request, when a policy armed one. Held
      on the entry rather than in a second map so `settle` — the ONE place a
      question ever leaves `pending`, whoever answered it — is also the one
      place the timer is cleared. A fallback that fired against an already
      answered request would emit a second `request_answered` for it. */
  timer?: ReturnType<typeof setTimeout>;
}

export interface BridgeHost {
  /** Journal (when the event is journaled) and fan out to every peer but
      `except` — which is how a peer avoids being told about its own action. */
  emit(event: ThreadEvent, except?: Peer): void;
  peerCount(): number;
  /** Mark where this turn's stderr starts, so a failure is explained by its own
      output and not the previous turn's. */
  markTurnStderr(): void;
  /** Splice the agent's stderr into an error on its way out. "Internal error"
      is a code, not an explanation, and the explanation was only on stderr. */
  enrichError(error: WireError): WireError;
  /** Push hooks. Fired only when nobody is attached to see the thread. */
  onPermissionRequest(): void;
  onElicitationRequest(): void;
  /** Apply an agent-authored session title to the thread row. */
  onSessionTitle(title: string): void;
  /** How this session answers a permission or an elicitation for the user, or
      null for the ordinary park-and-wait (`autonomy.ts`).

      Read at the top of `park()` on every request rather than captured as a
      BridgeOption at spawn, for two reasons. A policy is a property of the
      RUN, and a run outlives its process: a respawn — a profile change, a
      revive — rebuilds the bridge from the session row, and a policy that
      travelled in the handshake would be silently dropped there, turning an
      unattended run into one parked on a question nobody will answer. And it
      has to be lowerable under a running process: "cancel this run" and the
      dry-run switch both mean stop answering, now, without killing the agent
      mid-tool-call. Nothing about autonomy travels in the handshake at all —
      the agent is never told, which is the point. */
  autonomy(): AutonomyPolicy | null;
  /** The model's half of the attachment decision (delivery.ts) — the modalities
      the thread's current model declares, and whether its profile carries a
      catalog at all. A callback rather than a BridgeOption for the reason
      `autonomy` is one: both the profile and the model change on a running
      agent now, so a value captured at spawn would describe the wrong provider
      by the time a queued message drained. */
  deliveryContext(): { modalities: string[] | undefined; hasCatalog: boolean };
  /** A parked question fell through to `askFallback` — nobody came. Counted on
      the session rather than the bridge (which dies with the process) because
      it is what makes a run `blocked` rather than merely finished: the state a
      person can act on, and deliberately distinct from a run that was refused
      something by policy and carried on to say so. */
  onAutonomyBlocked(): void;
  /** Is there something queued that should follow a turn that ended cleanly?
      Read in the same tick as `turn_ended` is emitted, so the event can say
      `continued` about a drain that has not happened yet. */
  hasQueued(): boolean;
  /** The set of held steers changed (one was taken, or the step let them go),
      so the absolute `queue` event has to be said again — they are listed on
      it, flagged `steer`, until their `turn_started` lands. */
  onHeldSteersChanged(): void;
  /** The logical turn is over and `turn_ended` is journaled. `interrupted` =
      cancelled or failed, after which nothing should auto-follow; `continued`
      = `hasQueued()` said yes and the host is expected to drain now. The push
      hook lives behind this on the host's side, gated on both. */
  onTurnSettled(info: { error?: WireError; interrupted: boolean; continued: boolean; turnId: string }): void;
  /** The agent accepted a `session/new` or a `session/load`: this is the
      session the running process is on. `proven` says which — a load that
      answered is the strongest evidence an id can have (the agent found the
      transcript and read it back), while a fresh `session/new` id is one the
      agent holds in memory and may never flush. */
  onAcpSessionId(acpSessionId: string, proven: boolean): void;
  /** A turn has committed to the current session, so the agent has written it
      to its own store and a later `session/load` can find it.
      Until this fires the id is a promise, not a record: agents create the
      session in memory and flush their transcript lazily, so a process killed
      before its first turn (a server restart, a crash) leaves an id nothing can
      ever load. Such an id is still written down — see `acpSessionProvisional`;
      what this callback buys is the right to keep it against the next one. */
  onSessionDurable(): void;
  /** `session/load` was refused. The thread runs on a fresh session from here,
      but the id it failed on stays the thread's record of itself. */
  onHistoryLost(lost: HistoryLost): void;
  onSpawnStateChange(next: { model?: string; effort?: string; modeId?: string | null }): void;
}

export interface BridgeOptions {
  cwd: string;
  mcpServers: acp.McpServer[];
  /** Restore an existing conversation instead of starting one. */
  load?: { acpSessionId: string };
  /** Settings a respawn has to put back once the new session exists. */
  restore?: RestoreState;
  /** Settings chosen on a draft, against the option set the agent last
      advertised. Applied right after `session/new`. */
  configChoices?: Record<string, string | boolean>;
  /** The permission mode chosen on a draft, out of the agent's probed `modes`.
      Applied after `session/new` through the same `session/set_mode` a live
      change uses — so `captureRestoreState` picks it up from the process and a
      later respawn puts it back, exactly as if the user had clicked it. An
      agent with no modes, or without the one asked for, ignores it. */
  modeId?: string;
  /** The model and effort of a thread whose profile carries no catalog, to be
      put back over ACP rather than through the process env — see
      `applyAgentOwned`. Empty for a profile that owns the catalog: there these
      two ARE the env, and `resolveSpawn` has already placed them. */
  agentOwned?: { model?: string; effort?: string };
  /** The web-search MCP server is replacing claude-code's built-in
      WebSearch/WebFetch. Only that agent declares those as server tools, so
      disallow them or the model keeps calling the originals instead of ours. */
  websearchViaMcp?: boolean;
  /** The harness's workflow MCP server is replacing claude-code's built-in
      Workflow tool, for the same reason and with the same allow rule. */
  workflowViaMcp?: boolean;
  /** The thread's persona, for an agent whose `personaVia` is `"acp-meta"` —
      see `sessionMeta`. Undefined for every other agent and for a thread with
      no persona; an `"env"` agent's persona was placed by `resolveSpawn`
      before this process existed. */
  persona?: PersonaSpawn;
  /** The profile opted out of Codex's fallback-metadata notice. True means the
      bridge drops the matching warning from the stream before it can be
      journaled or rendered — the profile has already pinned the model's
      numbers, and the nag (which only appears when the written catalog did not
      reach the running codex build) is noise the user chose not to see. */
  suppressModelMetadataWarning?: boolean;
}

export class AcpBridge {
  /** Resolves when the session exists and its settings have been applied. */
  readonly ready: Promise<void>;
  acpSessionId: string | null = null;
  modes: acp.SessionModeState | null = null;
  configOptions: acp.SessionConfigOption[] = [];
  agentCapabilities: acp.AgentCapabilities = {};
  /** Held at a step boundary by `pause()`. Cleared by `resume()`, by
      `cancel()` (the agent drops its pause with the turn), and with the
      process. Stated on `caught_up`, so an attaching peer draws the hold. */
  paused = false;
  /** Why it is held. `"user"` is the toggle; `"error"` is a turn that failed
      and is waiting for a model change — the turn is still open, so this is
      not a failure the transcript records, it is a state it draws. Null
      exactly when `paused` is false. */
  pausedReason: "user" | "error" | null = null;
  /** The failure a `"error"` hold is waiting on, in the `turn_ended` shape the
      client already knows how to draw and fold. */
  pausedError: WireError | null = null;
  /** When the current hold began — the clock the idle sweep reads, so a thread
      held with nobody reading it does not pin its process forever. */
  heldSince: number | null = null;
  readonly pending = new Map<string, PendingRequest>();

  private readonly host: BridgeHost;
  private readonly connection: acp.ClientConnection;
  /** The session's working directory — kept because an `@mention` in a prompt
      is resolved against it (see `mentions.ts`). */
  private readonly cwd: string;
  /** The session's MCP servers — kept for the same reason as `cwd`, and for a
      second one: `forkAt` opens a request of its own (`session/fork` is not
      `session/new`, so it cannot read `BridgeOptions` off the call site the
      way `newSession` does) and the forked session needs the same server list
      the original got, since ACP does not say a fork inherits it. */
  private readonly mcpServers: acp.McpServer[];
  /** Prompts the agent has not answered yet. A turn is over when this hits
      zero — NOT when the first prompt returns, or steering (a second prompt
      sent mid-turn) would clear the indicator while the agent is still
      working. */
  private inflight = 0;
  private turnStartedAt: number | null = null;
  private ttftSent = false;
  private nextRequestId = 1;
  /** True while a `session/load` is streaming the conversation back, so the
      updates it produces are journaled as history rather than as news. */
  private historyReplay = false;
  private closed = false;
  /** Prompt texts whose turns are waiting on close() for a reason worth
      reporting — see onPromptRejected. */
  private readonly held: string[] = [];
  /** Id of the logical turn in flight, null between turns. Steering joins it. */
  currentTurnId: string | null = null;
  private currentTurnPrompt: string | null = null;
  /** The `messageId` of the last content chunk seen so far in the turn
      currently in flight — reset to null at `prompt()`'s `currentTurnId`
      assignment and read at `settleTurn` for `turn_ended.lastMessageId`. A
      chunk with no `messageId` (or `null`) leaves the previous value alone,
      so a turn's last REAL id survives chunks that do not carry one, rather
      than being clobbered back to nothing at the end. */
  private lastSeenMessageId: string | null = null;
  /** Tool calls this turn has announced and not yet settled. A steer's bubble
      waits on this being empty — see `announceSteer`. Cleared with the turn,
      because a turn that ended has no step left to finish. */
  private readonly openToolCalls = new Set<string>();
  /** Steers whose `turn_started` has not been emitted yet — and mid-turn
      mode/model/effort notices (`config_notice`, via `holdConfigNotice`): the
      words are already on the wire, but the transcript does not show them
      until the step that was running lets go. Drained by `flushSteers`. */
  private pendingSteers: { id: string; createdAt: number; event: ThreadEvent; origin: Peer | undefined }[] = [];
  /** Callers of `whenIdle()` waiting for `inflight` to reach zero. */
  private idleWaiters: (() => void)[] = [];
  private readonly suppressModelMetadataWarning: boolean;

  /** `stream` is the transport, not the process: `agentStream(proc)` for a
      child on stdio (the only kind today), and whatever carries ndJSON frames
      for anything else — a socket to a sandboxed agent would plug in here
      without the protocol handling above knowing. The caller owns the process
      (stderr, exit, kill); the bridge owns only the conversation on it. */
  constructor(host: BridgeHost, stream: acp.Stream, opts: BridgeOptions) {
    this.host = host;
    this.cwd = opts.cwd;
    this.mcpServers = opts.mcpServers;
    this.suppressModelMetadataWarning = opts.suppressModelMetadataWarning === true;
    this.connection = acp
      .client({ name: "daedalus" })
      .onNotification(acp.methods.client.session.update, (ctx) => this.onUpdate(ctx.params))
      // The RFD's subagent updates, re-addressed by `agentStream` — see
      // SUBAGENT_UPDATE_METHOD. Same handler: they are session updates.
      .onNotification(SUBAGENT_UPDATE_METHOD, parseSessionNotification, (ctx) =>
        this.onUpdate(ctx.params),
      )
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        this.park<acp.RequestPermissionResponse>(
          "permission",
          ctx.params,
          ctx.params.toolCall?.toolCallId,
        ),
      )
      .onRequest(acp.methods.client.elicitation.create, (ctx) =>
        this.park<acp.CreateElicitationResponse>(
          "elicitation",
          ctx.params,
          (ctx.params as { toolCallId?: string }).toolCallId,
        ),
      )
      .onNotification(acp.methods.client.elicitation.complete, (ctx) =>
        this.onElicitationComplete(ctx.params.elicitationId),
      )
      /* A hold the agent took on its own. Nothing is asked of us and nothing
         is answered: the state is absolute, and saying it is the whole of the
         contract. */
      .onNotification(PAUSED_NOTIFICATION, parsePausedParams, (ctx) =>
        this.onAgentPaused(ctx.params),
      )
      .connect(stream);
    this.ready = this.handshake(opts);
  }

  get promptActive(): boolean {
    return this.inflight > 0;
  }

  /**
   * Resolves once no prompt is in flight — immediately if none is. What "send
   * now" waits on between `cancel()` and the prompt it sends in the cancelled
   * turn's place. Also released by `close()`, so a waiter never outlives the
   * process it was waiting on.
   */
  whenIdle(): Promise<void> {
    if (this.inflight === 0 || this.closed) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private releaseIdle(): void {
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  // ---- handshake ----

  private async handshake(opts: BridgeOptions): Promise<void> {
    const deadline = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error("the agent did not finish the handshake in time")),
        HANDSHAKE_TIMEOUT_MS,
      ).unref();
    });
    await Promise.race([this.runHandshake(opts), deadline]);
  }

  private async runHandshake(opts: BridgeOptions): Promise<void> {
    const initialized = await this.connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        // The agent runs beside us with its own filesystem; there is nothing
        // for this end to serve.
        fs: { readTextFile: false, writeTextFile: false },
        // The config menu already renders boolean options; without advertising
        // this, agents are within spec to withhold `type: "boolean"` entries
        // entirely — codex hides its fast-mode toggle on exactly this check.
        // Same bargain, and the one whose absence is invisible: an agent that
        // compacts its context is *required* to keep `compaction_update` and
        // `compaction_summary_chunk` to itself unless the client claims this,
        // so without it a long thread silently loses its history mid-turn and
        // the transcript shows nothing at all. `{}` is the whole contract.
        session: { compaction: {}, configOptions: { boolean: {} } },
        // Same bargain for plans. ACP has two plan channels: the original
        // `plan` notification, and `plan_update`/`plan_removed`, which carry
        // markdown and file-backed plans as well as structured entries. An
        // agent only sends the second pair if the client says it can take
        // them, and `{}` means both — so without this a codex plan arrives as
        // nothing at all rather than as a plan we render badly.
        plan: {},
        // Same bargain a third time, and the highest-stakes one: without
        // form elicitation claude-agent-acp puts AskUserQuestion on the
        // session's disallowedTools — the model can't ask at all, not even
        // badly. Advertising it turns the tool back on and routes it (plus
        // MCP elicitations and codex's question bridge) to `park`.
        elicitation: { form: {}, url: {} },
        // The fourth bargain, and the one that decides whether a subagent's
        // work is visible at all. Nothing in ACP v1 nests; the draft subagent
        // RFD (see protocol.ts `SubagentSpawned`) does, and an agent that
        // implements it — codex-acp from 1.7 — sends a child's transcript as
        // its own session only if the client claimed this. Unclaimed, the
        // same runtime folds the child into one lifecycle tool call with no
        // steps in it. `{}` is the whole contract here too. Spread from a
        // typed constant because the key is not in the SDK's type yet.
        ...SUBAGENT_CAPABILITY,
        // claude-agent-acp's older, `_meta`-only version of the same thing: it
        // stamps every update a subagent produces with
        // `_meta.claudeCode.parentToolUseId`, but withholds the subagent's
        // prose and thinking — the part that says what it concluded — unless
        // the client says it can render a nested transcript.
        _meta: { "subagent-transcript": true, ...AIR_ASYNC_TASKS_META },
      },
    });
    this.agentCapabilities = initialized.agentCapabilities ?? {};

    if (opts.load) {
      await this.loadSession(opts);
    } else {
      await this.newSession(opts);
    }

    // Only now is there something to apply settings to.
    if (opts.restore) await this.applyRestore(opts.restore);
    if (opts.modeId) await this.applyDraftMode(opts.modeId);
    if (opts.agentOwned) await this.applyAgentOwned(opts.agentOwned);
    if (opts.configChoices) await this.applyChoices(opts.configChoices);
  }

  /**
   * The ACP `_meta` block for `session/new` and `session/load` — the two
   * requests that carry claude-code bridge options this client does not model
   * itself. `_meta` is passed through intact (it is the extensibility escape
   * hatch), so dropping `disallowedTools` here is the only way to switch the
   * built-in web tools off. Empty for non-claude-code agents and for sessions
   * with neither the web-search server nor a persona.
   *
   * The **persona** rides here too, for an agent whose `personaVia` is
   * `"acp-meta"`, and it is why this is built once and used by both requests
   * rather than only by `newSession`: claude-agent-acp forwards `_meta` from
   * `session/load` into the same `createSession` path, so a respawn — which is
   * what a persona change costs — reapplies it against the loaded conversation
   * instead of starting an empty one. Two keys, and they are deliberately at
   * different levels of the block:
   *
   *  - `systemPrompt` as an **object** is merged over the agent's own
   *    `{type:"preset", preset:"claude_code"}` with the type and preset locked,
   *    so `{append}` adds to the CLI's system prompt. A *string* there would
   *    replace it wholesale, which is a different feature and not this one — a
   *    persona is a preference about how to work, not a new agent.
   *  - `thinking` goes inside `claudeCode.options`, which the adapter spreads
   *    straight into the Agent SDK's query options. It is a separate axis from
   *    effort (the agent exposes both, and they do different things), so `null`
   *    has to mean "leave the runtime's own default alone" while `0` means off.
   *
   * The allow rule is the other half, and it is not optional. A disallowed
   * tool lands in the session's `alwaysDenyRules`, and the auto-mode
   * classifier's prompt lists those as "User Deny Rules" with one standing
   * instruction: block any action that reaches the same effect through a
   * different tool. Our MCP server is, by construction, exactly that — a web
   * search through a different tool — so in auto mode the classifier denied
   * `mcp__web-search__web_search` as circumvention of a rule the harness itself
   * wrote, and the model told the user to "remove the deny for WebSearch in
   * your settings". `mcp__web-search` (the server, so both its tools) as an
   * allow rule resolves before the classifier is consulted, which is the only
   * place the two can be reconciled: the deny says "not the built-in", the
   * allow says "this one instead". Verified with the CLI: the same prompt on
   * the same gateway went from two denials to none.
   */
  private sessionMeta(opts: BridgeOptions): Record<string, unknown> {
    const meta: Record<string, unknown> = {};
    const options: Record<string, unknown> = {};

    const disallowedTools: string[] = [];
    const allowedTools: string[] = [];
    if (opts.websearchViaMcp) {
      disallowedTools.push("WebSearch", "WebFetch");
      allowedTools.push(`mcp__${WEB_SEARCH_SERVER_NAME}`);
    }
    if (opts.workflowViaMcp) {
      disallowedTools.push(CLAUDE_WORKFLOW_TOOL);
      allowedTools.push(`mcp__${WORKFLOW_SERVER_NAME}`);
    }
    if (disallowedTools.length > 0) Object.assign(options, { disallowedTools, allowedTools });

    if (opts.persona) {
      meta.systemPrompt = { append: opts.persona.prompt };
      const budget = opts.persona.thinking;
      if (budget !== null && budget !== undefined) {
        options.thinking = budget > 0 ? { type: "enabled", budgetTokens: budget } : { type: "disabled" };
      }
    }

    if (Object.keys(options).length > 0) meta.claudeCode = { options };
    return meta;
  }

  private async newSession(opts: BridgeOptions): Promise<void> {
    const response = await this.connection.agent.request(acp.methods.agent.session.new, {
      cwd: opts.cwd,
      mcpServers: opts.mcpServers,
      _meta: this.sessionMeta(opts),
    });
    this.adoptSession(response.sessionId, response.modes ?? null, response.configOptions ?? [], false);
  }

  /**
   * Fresh process, existing conversation. `session/load` streams the whole
   * history back as `session/update` notifications before it responds — which
   * is why `historyReplay` is set around it: those updates are the transcript
   * being restated, not new activity, and the reducer on the other end needs to
   * know that to accept the user messages among them.
   *
   * The failure path is the delicate one. Falling back to a fresh session keeps
   * the thread usable, but the fallback's id must NOT replace the id that was
   * loaded: that id is the only pointer to a transcript which, more often than
   * not, is still sitting in the agent's store — a load can fail because the
   * agent was restarted mid-write, because it is a different agent, or because
   * it had not flushed the rollout yet. Overwriting it turned one transient
   * refusal into a thread that could never find its history again, and worse,
   * into a *chain*: each replacement id was itself unloadable, so the next
   * revive failed and replaced it too. The old id therefore stays on the record
   * until a turn proves the new session durable (see `onSessionDurable`), and
   * the refusal is reported instead of swallowed. The one id the fallback may
   * take over is a *provisional* one — an id no turn ever committed to, which
   * by definition has no transcript behind it to strand.
   */
  private async loadSession(opts: BridgeOptions): Promise<void> {
    const acpSessionId = opts.load!.acpSessionId;
    this.historyReplay = true;
    try {
      const response = await this.connection.agent.request(acp.methods.agent.session.load, {
        sessionId: acpSessionId,
        cwd: opts.cwd,
        mcpServers: opts.mcpServers,
        _meta: this.sessionMeta(opts),
      });
      this.adoptSession(acpSessionId, response?.modes ?? null, response?.configOptions ?? [], true);
    } catch (error) {
      // A deliberate close (respawn, retire) is not a load failure: the bridge
      // was shut on purpose, the fallback would be a `session/new` fired at a
      // dead connection, and the warn would make every normal respawn read
      // like a thread that lost its history. Only a real failure starts fresh.
      if (this.closed) throw error;
      // Agent can't load this session — continue with a fresh one (empty
      // context), and say so: a thread that quietly forgot its conversation
      // looks exactly like a thread that never had one.
      console.warn(`session/load failed for ${acpSessionId}, starting fresh`, error);
      this.host.onHistoryLost({ acpSessionId, error: this.host.enrichError(toWireError(error)) });
      await this.newSession(opts);
    } finally {
      this.historyReplay = false;
    }
  }

  private adoptSession(
    acpSessionId: string,
    modes: acp.SessionModeState | null,
    configOptions: acp.SessionConfigOption[],
    proven: boolean,
  ): void {
    this.acpSessionId = acpSessionId;
    this.modes = modes;
    this.configOptions = configOptions;
    /* What the agent says it is running as — `session/set_mode` (above)
       overwrites this again when a restore or a draft pick is applied next.
       Recorded so the row always names the last mode the agent confirmed,
       which is what a revive with no live process restores from. */
    this.host.onSpawnStateChange({ modeId: modes?.currentModeId ?? null });
    this.host.onAcpSessionId(acpSessionId, proven);
    this.emitConfig();
  }

  /**
   * Put back the settings a restart reset.
   *
   * A profile is credentials and a model catalog — it says nothing about how you
   * like to work, so the permission mode and every other agent switch have to
   * come back exactly as they were. Best-effort throughout: an option the new
   * profile's agent no longer offers is a preference that no longer applies, not
   * a reason to throw a restored thread away.
   */
  private async applyRestore(restore: RestoreState): Promise<void> {
    if (restore.modeId && this.modes && this.modes.currentModeId !== restore.modeId) {
      try {
        await this.setMode(restore.modeId);
      } catch (error) {
        console.warn(`couldn't restore mode ${restore.modeId} after the restart`, error);
      }
    }
    for (const option of restore.configOptions) {
      const current = this.configOptions.find((o) => o.id === option.id);
      if (!current || current.currentValue === option.currentValue) continue;
      try {
        await this.setConfigOption(option.id, option.currentValue);
      } catch (error) {
        console.warn(`couldn't restore ${option.id} after the restart`, error);
      }
    }
  }

  /**
   * Put back the model and effort of a thread whose profile has no catalog.
   *
   * These are the two settings `applyRestore` deliberately drops, because for a
   * profile that owns a catalog they are process env and a respawn has already
   * placed them. A profile with no `models[]` is the opposite case: the agent
   * owns them, the value is an id out of the agent's OWN selector, and the only
   * thing that understands such an id is the selector it came from. Writing one
   * into the env instead is what broke a revived Default-profile thread —
   * claude-code's `opus[1m]` landing in ANTHROPIC_MODEL (and, pinned alongside
   * it, the sonnet/opus/fable alias vars) resolves to nothing the API serves,
   * and every turn died with `model_not_found`.
   *
   * By category, not by id: the record is "this thread runs on this model", and
   * which config id carries the model is the agent's business — it can differ
   * between agents and across upgrades. Best-effort like the rest of restore: a
   * value the agent no longer offers costs the pick, not the thread.
   */
  private async applyAgentOwned(state: { model?: string; effort?: string }): Promise<void> {
    await this.setByCategory(state, "after the restart");
  }

  /** The agent's own selector for a category, if it advertises one. */
  private selectorFor(category: string): acp.SessionConfigOption | undefined {
    return this.configOptions.find((o) => o.type === "select" && o.category === category);
  }

  /**
   * Will this agent take `value` as its model right now?
   *
   * Asked before a live model change is attempted, because the alternative to
   * knowing is finding out by being refused — and by then the thread's record
   * already says it moved. An agent validates a `set_config_option` against the
   * values it advertised, so its own list is the honest answer; a profile whose
   * models reached the allowlist after this process spawned is exactly the case
   * that says no, and falls back to a respawn.
   */
  offersModel(value: string): boolean {
    const option = this.selectorFor("model");
    if (!option || option.type !== "select") return false;
    if (option.currentValue === value) return true;
    return option.options
      .flatMap((entry) => ("options" in entry ? entry.options : [entry]))
      .some((choice) => choice.value === value);
  }

  /**
   * Set the model and/or effort on a running session through the agent's own
   * selectors, and say which of them landed.
   *
   * By category, not by id: the record is "this thread runs on this model", and
   * which config id carries the model is the agent's business — it can differ
   * between agents and across upgrades. Best-effort throughout, which is what
   * the caller's `context` describes: a value the agent no longer offers costs
   * the pick, not the thread. A category the agent does not advertise at all
   * reports `false`, and the caller decides whether that is worth a respawn.
   */
  async setByCategory(
    next: { model?: string; effort?: string },
    context: string,
    origin?: Peer,
  ): Promise<{ model: boolean; effort: boolean }> {
    const placed = { model: false, effort: false };
    const wanted = [
      ["model", "model", next.model],
      ["thought_level", "effort", next.effort],
    ] as const;
    for (const [category, field, value] of wanted) {
      if (!value) continue;
      const option = this.selectorFor(category);
      if (!option || option.type !== "select") continue;
      if (option.currentValue === value) {
        placed[field] = true;
        continue;
      }
      try {
        await this.setConfigOption(option.id, value, origin);
        placed[field] = true;
      } catch (error) {
        console.warn(`couldn't set ${category} to ${value} ${context}`, error);
      }
    }
    return placed;
  }

  /** A draft's mode pick. Guarded on the agent's own advertised list, so a
      stale pick against an agent that renamed its modes costs a warning and
      nothing else — the same bargain `applyChoices` makes for config ids. */
  private async applyDraftMode(modeId: string): Promise<void> {
    if (!this.modes || !this.modes.availableModes.some((m) => m.id === modeId)) return;
    if (this.modes.currentModeId === modeId) return;
    try {
      await this.setMode(modeId);
    } catch (error) {
      console.warn(`couldn't apply the draft's mode ${modeId}`, error);
    }
  }

  private async applyChoices(choices: Record<string, string | boolean>): Promise<void> {
    for (const [configId, value] of Object.entries(choices)) {
      try {
        await this.setConfigOption(configId, value);
      } catch (error) {
        console.warn(`the agent rejected the remembered ${configId} setting`, error);
      }
    }
  }

  /**
   * What a respawn has to put back — everything except the two settings the
   * profile owns, because those are precisely what is being changed.
   *
   * The rule is the client's `partitionSessionOptions` / `isModeTwin`, narrowed
   * to the part a restore needs. Captured while the old process is still up.
   */
  captureRestoreState(): RestoreState {
    const modeIds = new Set(this.modes?.availableModes.map((m) => m.id) ?? []);
    const configOptions = this.configOptions.filter((option) => {
      if (option.type !== "select") return true;
      if (option.category === "model" || option.category === "thought_level") return false;
      return !isModeTwin(option, modeIds);
    });
    return { modeId: this.modes?.currentModeId, configOptions };
  }

  // ---- agent -> us ----

  private onUpdate(notification: SessionNotification): void {
    /* A profile that opted out of the nag never sees it: the model's numbers
       were already given in the profile, so what codex is warning about is
       something the harness could not put back (the catalog file not reaching
       this codex build — see model-catalog.ts), which no user action fixes. */
    if (this.suppressModelMetadataWarning && isFallbackModelMetadataWarning(notification.update)) {
      return;
    }
    /* A subagent's session (RFD) is any id that is not this process's own.
       The id is forwarded, not resolved: which child it is, and under which
       step, is the transcript's business. Strictly "not ours" rather than "one
       we have seen spawned" so an update that outran its `subagent_spawned`
       still lands on the right side of the line — the reducer files it as an
       orphan rather than mixing it into the parent. During the handshake
       `acpSessionId` is still null and every update is the thread's own. */
    const own = this.acpSessionId === null || notification.sessionId === this.acpSessionId;
    const update = notification.update;
    // Session-level updates change what `captureRestoreState` will report, so
    // they are tracked here as well as forwarded. Forwarded either way: the
    // reducer on the other end already handles both variants. A child's
    // mode/config are its own affair and must not overwrite the thread's.
    if (own && update.sessionUpdate === "current_mode_update" && this.modes) {
      this.modes = { ...this.modes, currentModeId: update.currentModeId };
      /* Whoever moved it — the user or the agent itself — this is the last
         confirmed mode, and the row is what a revive with no live process
         restores from. */
      this.host.onSpawnStateChange({ modeId: update.currentModeId });
    } else if (own && update.sessionUpdate === "config_option_update") {
      this.configOptions = update.configOptions;
    }
    if (own && update.sessionUpdate === "session_info_update") {
      const title = (update as { title?: unknown }).title;
      if (typeof title === "string" && title.trim()) this.host.onSessionTitle(title);
    }
    if (this.turnStartedAt !== null && !this.ttftSent) {
      this.ttftSent = true;
      this.host.emit({ ev: "ttft", ms: Math.round(performance.now() - this.turnStartedAt) });
    }
    /* The step boundary a held steer is waiting for. ACP has no "step ended"
       event, and the closest honest reading of one is a tool call reaching a
       terminal status with none left open: the model has stopped streaming and
       stopped calling, so the next thing it does is read its messages — the
       steer among them. That is the one boundary a turn announces mid-flight;
       the other is the turn's own end (`settleTurn`), which is where a steer
       held through a turn that never called a tool comes out.
       Only the thread's OWN calls count: a subagent's run *inside* the
       parent's step and are not what the parent's steer is waiting on. A
       replay is history and moves nothing. */
    const settled = own && !this.historyReplay ? this.trackToolCall(update) : false;
    /* The fork point a rewind to the NEXT turn will cut at (`turn_ended`'s
       `lastMessageId`) is the last messageId this turn actually produced —
       only the two content-chunk variants carry one, and a chunk that omits
       it (or sends it null) is mid-message continuation, not evidence the
       message ended, so the previous id is left standing rather than cleared. */
    if (
      own &&
      !this.historyReplay &&
      (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") &&
      update.messageId
    ) {
      this.lastSeenMessageId = update.messageId;
    }
    this.host.emit({
      ev: "update",
      seq: 0,
      update,
      historyReplay: this.historyReplay,
      ...(own ? {} : { sessionId: notification.sessionId }),
    });
    /* Only a settling tool call is a boundary — `openToolCalls` being empty is
       also true of a turn that has not called anything yet, and flushing there
       would put the bubble back in the middle of the thought it was typed
       into. */
    if (own && !this.historyReplay && settled && this.openToolCalls.size === 0) this.flushSteers();
  }

  /** Follow a tool call from announced to settled, and say whether THIS update
      is one settling. `tool_call` opens one (an agent may announce it already
      finished); `tool_call_update` closes it on a terminal status. An update
      carrying no status is progress and says nothing about whether the call is
      over. */
  private trackToolCall(update: SessionUpdate): boolean {
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
      return false;
    }
    const status = update.sessionUpdate === "tool_call" ? (update.status ?? "pending") : update.status;
    if (status === "completed" || status === "failed") {
      this.openToolCalls.delete(update.toolCallId);
      return true;
    }
    if (status) this.openToolCalls.add(update.toolCallId);
    return false;
  }

  /** Emit every steer whose step has now finished, oldest first. Also called
      when the turn settles: a turn ending is a boundary like any other, and a
      steer still held there must not be lost — it reached the agent, and for
      the runtimes that keep it as context the next turn will answer it. */
  private flushSteers(): void {
    if (this.pendingSteers.length === 0) return;
    for (const { event, origin } of this.pendingSteers.splice(0)) this.host.emit(event, origin);
    this.host.onHeldSteersChanged();
  }

  /** The steers still held for a step boundary, as queue rows: what the user
      said and has not yet seen land. */
  heldSteers(): QueuedMessage[] {
    return this.pendingSteers.map(({ id, createdAt, event }) =>
      event.ev === "turn_started"
        ? {
            id,
            text: event.text,
            ...(event.attachments ? { attachments: event.attachments } : {}),
            createdAt,
            steer: true as const,
          }
        : event.ev === "config_notice"
          ? { id, text: event.text, createdAt, steer: true as const }
          : { id, text: "", createdAt, steer: true as const },
    );
  }

  /**
   * The agent is asking the user something. Hold the promise, tell every peer,
   * and — when nobody is attached — let the push hook say so on a phone.
   *
   * This is also the one choke point every ACP agent's questions pass through,
   * which is why a session's autonomy policy is consulted here and nowhere
   * else (`autonomy.ts`). An answered-by-policy request still goes through the
   * whole of the park/settle machinery — it is entered in `pending`, the
   * `permission`/`elicitation` event is emitted, and only then is it settled,
   * which emits `request_answered` exactly as a human answer does. Resolving
   * the promise directly and skipping the pair would be shorter and would make
   * an automated grant invisible: a watching browser would see nothing, and
   * after the fact there would be no record that the question was ever asked.
   * A standing grant that leaves no trace is the one thing this feature must
   * not ship. So: nothing is silent, and there is one code path.
   */
  private park<R>(
    kind: "permission" | "elicitation",
    request: acp.RequestPermissionRequest | acp.CreateElicitationRequest,
    toolCallId: string | undefined,
  ): Promise<R> {
    const requestId = `r${this.nextRequestId++}`;
    const policy = this.host.autonomy();
    const decided = policy ? this.decide(policy, kind, request) : null;
    return new Promise<R>((resolve) => {
      const entry: PendingRequest = {
        requestId,
        kind,
        toolCallId,
        payload: request,
        settle: resolve as (response: never) => void,
      };
      this.pending.set(requestId, entry);
      this.host.emit(
        kind === "permission"
          ? { ev: "permission", requestId, request: request as acp.RequestPermissionRequest }
          : { ev: "elicitation", requestId, request: request as acp.CreateElicitationRequest },
      );
      if (decided) {
        /* Settled in the same tick, deliberately: a microtask's worth of delay
           would be a window in which `settleAll()` (a cancel, a dying process)
           could answer this request with `cancelled` instead, and the peers
           would be told the policy's answer was something it never was. The
           events still leave in the order a human answer produces them. */
        this.settle(entry, decided.response as never, undefined, decided.auto);
        return;
      }
      /* A real park under an `ask` stance, plus the deadline that keeps it from
         being forever. The park stays a genuine park: a human who gets there
         first wins through the ordinary first-answer-wins path, and `settle`
         clears this timer on the way out. */
      if (policy && policy.askTimeoutSeconds > 0) {
        entry.timer = setTimeout(() => {
          const open = this.pending.get(requestId);
          if (!open) return; // somebody answered; the timer lost the race
          this.host.onAutonomyBlocked();
          const fallback = this.fallback(kind, policy.askFallback, request);
          this.settle(open, fallback.response as never, undefined, fallback.auto);
        }, policy.askTimeoutSeconds * 1000);
        entry.timer.unref();
      }
      if (this.host.peerCount() === 0) {
        if (kind === "permission") this.host.onPermissionRequest();
        else this.host.onElicitationRequest();
      }
    });
  }

  /** What the policy answers this request with, or null to park it for a human.
      Null is the honest outcome in two different cases and they are not worth
      separating here: the stance is `ask`, or the stance is decided but the
      agent advertised no option shaped like it — see `optionFor`. */
  private decide(
    policy: AutonomyPolicy,
    kind: "permission" | "elicitation",
    request: acp.RequestPermissionRequest | acp.CreateElicitationRequest,
  ): { response: unknown; auto: AutoAnswer } | null {
    if (kind === "elicitation") {
      if (policy.elicitations !== "decline") return null;
      /* `decline` and not `cancel`: the bridges read a decline as "the user
         skipped this question" and the turn carries on, where a cancel aborts
         the tool call that asked. An unattended run should get on with it. */
      return { response: { action: "decline" }, auto: { answer: "decline", timedOut: false } };
    }
    const permission = request as acp.RequestPermissionRequest;
    /* `toolCall.kind` is optional and nullable in the protocol, and an agent
       that omits it is saying nothing — which falls to `default`, never to a
       guess made from the tool's name. */
    const stance = stanceFor(policy, permission.toolCall?.kind);
    if (stance === "ask") return null;
    const option = optionFor(permission.options, stance);
    if (!option) return null;
    return {
      response: { outcome: { outcome: "selected", optionId: option.optionId } },
      auto: { answer: stance, timedOut: false },
    };
  }

  /** The answer for a question nobody came to. `deny` still speaks the agent's
      own vocabulary where it offered one; with no reject-shaped option there is
      nothing to select, so it degrades to `cancelled` — which is what an
      unanswerable question has always meant here. */
  private fallback(
    kind: "permission" | "elicitation",
    askFallback: "deny" | "cancel",
    request: acp.RequestPermissionRequest | acp.CreateElicitationRequest,
  ): { response: unknown; auto: AutoAnswer } {
    if (kind === "elicitation") {
      const answer = askFallback === "deny" ? "decline" : "cancel";
      return { response: { action: answer }, auto: { answer, timedOut: true } };
    }
    const option =
      askFallback === "deny"
        ? optionFor((request as acp.RequestPermissionRequest).options, "deny")
        : null;
    if (option) {
      return {
        response: { outcome: { outcome: "selected", optionId: option.optionId } },
        auto: { answer: "deny", timedOut: true },
      };
    }
    return { response: { outcome: { outcome: "cancelled" } }, auto: { answer: "cancel", timedOut: true } };
  }

  /**
   * A URL-mode elicitation finished out of band. Accept it here rather than
   * relaying the notification and waiting for a browser: the flow is already
   * complete, and if nobody is attached there is no browser to wait for — the
   * agent would block on a question that has been answered.
   */
  private onElicitationComplete(elicitationId: string): void {
    for (const entry of this.pending.values()) {
      if (entry.kind !== "elicitation") continue;
      if (entry.requestId !== elicitationId && entry.toolCallId !== elicitationId) continue;
      this.settle(entry, { action: "accept" } as unknown as never);
      return;
    }
  }

  // ---- us -> agent ----

  /**
   * Send a prompt. Returns as soon as it is dispatched: `session/prompt` only
   * answers at turn end, and turn end already reaches every peer as an event —
   * so a prompt that fails is reported once, on `turn_ended`, rather than twice
   * in two shapes.
   */
  prompt(
    text: string,
    origin: Peer | undefined,
    turnId: string,
    opts: { attachments?: AttachmentRef[]; forceLink?: boolean } = {},
  ): { deferred: boolean } {
    const sessionId = this.requireSession();
    const attachments = opts.attachments ?? [];
    /* The other peers never see this command (it goes to the agent, not to
       them), so tell them a turn started and whose words started it — and what
       it carried. The refs are journaled with the event, which is what makes a
       replayed user bubble still draw its chips with nothing else stored.

       A STEER is the one case where this is not said at once. Its words join a
       turn that is mid-step — mid-thought, or with a tool call still running —
       and no runtime reads them until that step ends: ours drains its
       `steerQueue` in `prepareStep`, and the others cannot act on a second
       prompt any sooner either. Announcing it here would draw the bubble in
       the middle of the step it is not part of, and — because the runtimes
       journal the message where they actually take it — a reload would then
       move it. So the event is held and emitted at the boundary, which is the
       position the replay will agree with. */
    const started: ThreadEvent = {
      ev: "turn_started",
      seq: 0,
      turnId,
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
    };
    /* Any prompt joining a turn already in flight. Not "only while a tool is
       running": there is no moment in a running turn that ACP reports as being
       BETWEEN steps, so a steer typed mid-thought is just as mid-step as one
       typed mid-tool — the model is streaming, and it will not read the new
       words until it stops. Deferring on `inflight` alone is the rule that
       covers both; what varies is only which boundary marker releases it. */
    const deferred = this.inflight > 0;
    if (deferred) {
      /* No origin, exactly as a drained queue item has none: the sender is not
         drawing this bubble itself any more (it cannot — it does not know when
         the step ends), so it needs the event as much as every other peer. */
      this.pendingSteers.push({ id: randomUUID(), createdAt: Date.now(), event: started, origin: undefined });
      this.host.onHeldSteersChanged();
    } else this.host.emit(started, origin);
    if (this.inflight === 0) {
      this.currentTurnId = turnId;
      this.currentTurnPrompt = text;
      this.lastSeenMessageId = null;
      this.host.markTurnStderr();
      this.turnStartedAt = performance.now();
      this.ttftSent = false;
    }
    /* Decided here, at send. Reading the files costs a `readFileSync` per
       attachment and the base64 is never held between turns. */
    const attach = attachmentBlocks({
      refs: attachments,
      caps: this.agentCapabilities.promptCapabilities,
      cwd: this.cwd,
      forceLink: opts.forceLink,
      ...this.host.deliveryContext(),
    });
    for (const note of attach.notes) {
      // Logged even on the happy branch: "sent as an image" is the line that
      // makes the degrade below it legible when it appears.
      console.log(`[attachments] ${note.name}: ${note.delivery} — ${note.reason}`);
    }
    const outgoing = text + attach.textSuffix;
    const blocks = attach.blocks;

    this.inflight++;
    void this.connection.agent
      .request(acp.methods.agent.session.prompt, {
        sessionId,
        /* Three kinds of block, and only the first is the prompt.

           The text is what the user typed. The attachment blocks are the bytes
           they attached, each on the branch `resolveDelivery` picks for it
           against this runtime's capabilities and this thread's model — which
           is decided HERE, at send, and never at attach time, because a message
           queued twenty minutes ago must be resolved against the model it is
           actually being sent to. And the links are what an `@path` in the text
           refers to, for an agent that reads the protocol rather than the
           prose; only paths that exist inside the cwd become links — see
           mentions.ts.

           `attachmentBlocks` may append to the text as well (a materialised
           path, or `[attached: shot.png]`), for the reason mentions.ts states:
           the text is what every runtime reads without being taught anything. */
        prompt: [{ type: "text", text: outgoing }, ...blocks, ...mentionLinks(this.cwd, outgoing)],
      })
      .then(
        (response) =>
          this.settleTurn(response.usage ?? null, undefined, text, response.stopReason),
        (error: unknown) => this.onPromptRejected(error, text),
      );
    return { deferred };
  }

  /**
   * A prompt came back an error — or the connection under it went away.
   *
   * The second case is why this is not a one-liner. When the agent dies the SDK
   * rejects instantly with "ACP connection closed", which explains nothing,
   * while the explanation is on stderr and has not finished arriving. So the
   * turn is *held* until `close()`, which the manager calls once the process's
   * pipes have drained and it knows how the process ended. Reporting straight
   * away would tell every peer the turn failed and say nothing about why.
   */
  private onPromptRejected(error: unknown, text: string): void {
    if (this.connection.signal.aborted && !this.closed) {
      this.held.push(text);
      return;
    }
    this.settleTurn(null, this.host.enrichError(toWireError(error)), text);
  }

  private settleTurn(
    usage: acp.Usage | null,
    error: WireError | undefined,
    text: string,
    stopReason?: acp.StopReason,
  ): void {
    // Steering: a second prompt sent mid-turn keeps the turn open. Only the one
    // that empties the set ends it.
    if (--this.inflight > 0) return;
    /* The turn is over, so every step in it is: nothing is still running for a
       held steer to wait on, and its bubble must land before `turn_ended`
       rather than never. Ahead of the emit below for exactly that ordering. */
    this.openToolCalls.clear();
    this.flushSteers();
    /* Server-measured wall clock for the whole logical turn — the denominator
       output tokens/sec is drawn against. Read before clearing: steering joins
       a turn rather than opening one, so this covers every prompt in it. */
    const durationMs =
      this.turnStartedAt !== null ? Math.round(performance.now() - this.turnStartedAt) : undefined;
    this.turnStartedAt = null;
    /* The session has content now, so the agent has written it down and a later
       `session/load` can find it. Before this point its id is unloadable, and
       recording an unloadable id is how a thread loses the transcript it had.
       Reported even for a failed turn: the prompt still reached the agent, and
       what makes the session findable is that it recorded anything at all. */
    if (this.acpSessionId) this.host.onSessionDurable();
    const turnId = this.currentTurnId;
    const promptText = this.currentTurnPrompt ?? text;
    this.currentTurnId = null;
    this.currentTurnPrompt = null;
    if (!turnId) throw new Error("logical turn ended without an id");
    /* A cancelled turn is a SUCCESS on the wire — the agent answers the prompt
       with `stopReason: "cancelled"` — which is why the reason is read here and
       not only the error: a Stop must park the queue, not drain it. */
    const interrupted = error !== undefined || stopReason === "cancelled";
    const continued = !interrupted && !this.closed && this.host.hasQueued();
    this.host.emit({
      ev: "turn_ended",
      seq: 0,
      turnId,
      usage,
      error,
      promptText,
      ...(continued ? { continued: true } : {}),
      ...(this.lastSeenMessageId ? { lastMessageId: this.lastSeenMessageId } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    });
    this.releaseIdle();
    this.host.onTurnSettled({ error, interrupted, continued, turnId });
  }

  async setMode(modeId: string, origin?: Peer): Promise<void> {
    const sessionId = this.requireSession();
    const wasActive = this.promptActive;
    const oldId = this.modes?.currentModeId;
    await this.connection.agent.request(acp.methods.agent.session.setMode, { sessionId, modeId });
    if (this.modes) this.modes = { ...this.modes, currentModeId: modeId };
    /* Model and effort are process env the respawn rebuilds from the session
       record; the mode is the same kind of spawn input — a revive with no live
       process to copy from (idle-retired, pre-restart) puts it back from the
       row instead of coming back on the agent's default. */
    this.host.onSpawnStateChange({ modeId });
    /* A mode switched mid-turn is part of what happened in this thread, so it
       gets a transcript row of its own — held for the step boundary like a
       steer (see `holdConfigNotice`), so the row lands where the replay will
       agree with rather than in the middle of the running step. Idle changes
       stay silent. */
    if (wasActive && oldId !== undefined && oldId !== modeId) {
      this.holdConfigNotice(configNoticeText("Mode", this.modeName(oldId), this.modeName(modeId)));
    }
    this.emitConfig(origin);
  }

  async setConfigOption(
    configId: string,
    value: string | boolean,
    origin?: Peer,
  ): Promise<acp.SessionConfigOption[]> {
    const sessionId = this.requireSession();
    const wasActive = this.promptActive;
    const before = this.configOptions.find((o) => o.id === configId);
    const beforeValue = before?.type === "select" ? before.currentValue : undefined;
    const response = await this.connection.agent.request(
      acp.methods.agent.session.setConfigOption,
      {
        sessionId,
        configId,
        // The request is a discriminated union and only the boolean variant
        // carries its tag: a bare string value IS the default variant, while a
        // bare boolean matches neither and agents reject it.
        ...(typeof value === "boolean" ? { type: "boolean" as const, value } : { value }),
      } as acp.SetSessionConfigOptionRequest,
    );
    if (response.configOptions) this.configOptions = response.configOptions;
    /* Model and reasoning effort are process env: `respawn` rebuilds them from
       the session record every time it revives a retired thread. A change made
       over ACP never touches that record, so without this the thread comes back
       on the model the user switched away from. */
    const after = this.configOptions.find((o) => o.id === configId);
    const category = after?.category ?? before?.category;
    if (typeof value === "string") {
      if (category === "model") this.host.onSpawnStateChange({ model: value });
      else if (category === "thought_level") this.host.onSpawnStateChange({ effort: value });
    }
    /* Like `setMode` above: a model/effort switch that lands mid-turn draws
       its own row (`Model: Fast → Smart`), held for the step boundary;
       anything else — an idle change, a boolean toggle, an uncategorised
       option — stays a silent state update. */
    const newValue =
      after?.type === "select" ? after.currentValue : typeof value === "string" ? value : undefined;
    if (
      wasActive &&
      typeof newValue === "string" &&
      (category === "model" || category === "thought_level") &&
      (beforeValue === undefined || beforeValue !== newValue)
    ) {
      const label = category === "model" ? "Model" : "Effort";
      const picker =
        after?.type === "select" ? after : before?.type === "select" ? before : undefined;
      const from = beforeValue !== undefined ? selectValueName(picker, beforeValue) : undefined;
      const to = selectValueName(picker, newValue);
      this.holdConfigNotice(configNoticeText(label, from, to));
    }
    this.emitConfig(origin);
    return this.configOptions;
  }

  /** Whether the runtime answers `pause`/`resume` at all. */
  get canPause(): boolean {
    const meta = this.agentCapabilities._meta as Record<string, unknown> | null | undefined;
    return Boolean(meta?.[PAUSE_CAPABILITY]);
  }

  /** Whether the runtime answers ACP's own `session/fork` — the spec
      capability, not the jetbrains.air fork-point extension (`AgentDef.rewindVia`
      is what says whether this runtime honors *that*). `forkAt` throws rather
      than asking the agent when this is false, so a caller mistake fails here
      instead of round-tripping to a process that will refuse the request. */
  get canFork(): boolean {
    return Boolean(this.agentCapabilities.sessionCapabilities?.fork);
  }

  /**
   * Fork this session at `messageId` — the jetbrains.air extension both
   * claude-code and codex honor (`AgentDef.rewindVia === "acp-fork-point"`),
   * carried as `_meta` on the spec's own `session/fork` since ACP itself has
   * no notion of a fork *point*, only a fork. Claude Code forks up to and
   * including that message; Codex resolves it to a turn and forks up to and
   * including that turn — either way, the id a caller wants here is the last
   * one the turn *before* the one being discarded produced (`turn_ended.lastMessageId`).
   *
   * Modeled on `newSession`/`loadSession` for how the request is built, but
   * unlike either this is not called from `BridgeOptions` — there is no
   * persona or config choice to fold in, only the session already open on
   * this process, so `cwd` and `mcpServers` are this bridge's own rather than
   * read off a fresh set of options.
   *
   * Returns a new, unloaded, unproven session id on the agent's side — same
   * as any other id this bridge has never itself adopted. The caller (outside
   * this file) owns deciding what happens with it: nothing here calls
   * `adoptSession` or otherwise touches this bridge's state, because the
   * intended use is a fresh bridge against the returned id, exactly like any
   * other fork-and-load.
   */
  async forkAt(messageId: string): Promise<{ sessionId: string }> {
    if (!this.canFork) throw new Error("this agent cannot fork sessions");
    const sessionId = this.requireSession();
    const response = await this.connection.agent.request(acp.methods.agent.session.fork, {
      sessionId,
      cwd: this.cwd,
      mcpServers: this.mcpServers,
      _meta: { jetbrains: { air: { fork: { version: 1, messageId } } } },
    });
    return { sessionId: response.sessionId };
  }

  /**
   * Hold the turn at its next step boundary. The agent answers at once — the
   * hold takes effect when the step in flight ends, and the flag, not the
   * step, is what the peers are told — and a session with no turn open holds
   * its next prompt at its first step. Not a cancel: nothing is thrown away.
   */
  async pause(): Promise<{ paused: boolean }> {
    return this.setPaused(true);
  }

  async resume(): Promise<{ paused: boolean }> {
    return this.setPaused(false);
  }

  private async setPaused(paused: boolean): Promise<{ paused: boolean }> {
    if (!this.canPause) throw new Error("this agent cannot be paused — only cancelled");
    const sessionId = this.requireSession();
    const reply = await this.connection.agent.request<{ paused?: boolean }>(paused ? PAUSE_METHOD : RESUME_METHOD, { sessionId });
    /* A resume lets go of both reasons, so it clears the error with the hold;
       a pause the user asked for never overwrites a failure that is already
       waiting — the reason the turn stopped is the more useful of the two. */
    this.setHold(reply?.paused ?? paused, this.pausedReason ?? "user", this.pausedError);
    return { paused: this.paused };
  }

  /** A hold the agent took on its own — a turn that failed rather than ended.
      The turn is still open (`inflight` is unchanged), so nothing settles and
      nothing is journaled: this is state, like the pause it rides on. */
  private onAgentPaused(params: PausedParams): void {
    const paused = params.paused !== false;
    const error: WireError | null =
      paused && params.reason === "error"
        ? this.host.enrichError({
            code: -32603,
            message: params.message || "the model provider returned an error",
            ...(params.detail ? { data: { details: params.detail } } : {}),
          })
        : null;
    this.setHold(paused, params.reason ?? "user", error);
  }

  private setHold(paused: boolean, reason: "user" | "error", error: WireError | null): void {
    const was = this.paused;
    const nextReason = paused ? reason : null;
    const nextError = paused ? error : null;
    /* Absolute, so saying it twice is harmless — but a release is answered in
       the resume's own reply AND announced by the agent's `paused: false`
       notification, and the second of those used to emit the same event
       again. Nothing changed, nothing to say. */
    if (was === paused && this.pausedReason === nextReason && this.pausedError === nextError) return;
    const wasErrorHold = was && this.pausedReason === "error";
    this.paused = paused;
    this.pausedReason = nextReason;
    this.pausedError = nextError;
    if (paused && !was) this.heldSince = Date.now();
    if (!paused) this.heldSince = null;
    this.host.emit(this.pausedEvent());
    /* A hold taken on a failure IS a step boundary: the step that failed was
       rolled back, and the first thing the released turn does is read its
       messages — the steers typed while it waited among them. Nothing else
       announces that boundary (the tool calls of the dropped step never
       settle), so without this the bubble waited for the NEXT tool call, and
       a text-only answer put the user's words after the reply they shaped.
       Not for a user's pause: that one may lift mid-stream, and its boundary
       is still the tool call that ends the step. */
    if (wasErrorHold && !paused) {
      this.openToolCalls.clear();
      this.flushSteers();
    }
  }

  /** The hold as every peer draws it — the one shape `caught_up` carries and
      the `paused` event is built from, so an attaching reader and a live one
      agree. */
  hold(): ThreadHold {
    return {
      paused: this.paused,
      ...(this.pausedReason ? { reason: this.pausedReason } : {}),
      ...(this.pausedError ? { error: this.pausedError } : {}),
    };
  }

  pausedEvent(): ThreadEvent {
    return { ev: "paused", ...this.hold() };
  }

  async cancel(): Promise<void> {
    if (!this.acpSessionId) return;
    await this.connection.agent.notify(acp.methods.agent.session.cancel, {
      sessionId: this.acpSessionId,
    });
    /* The agent's cancel abandons its pause with the turn (agent/src/session.ts);
       said here too, so the peers' toggle follows. */
    if (this.paused) {
      this.setHold(false, "user", null);
    }
    /* ACP asks the cancelling client to answer whatever it is still being asked
       with `cancelled` — and a question left open here would be handed to every
       later attacher as if the cancelled turn were still waiting on it. */
    this.settleAll();
  }

  /**
   * A peer answering an open question. First answer wins; a slower peer gets
   * `null` back so the caller can still tell it to clear its card — today that
   * only happened if it had received the winner's broadcast first.
   */
  answer(requestId: string, response: unknown, origin?: Peer): { toolCallId?: string } | null {
    const entry = this.pending.get(requestId);
    if (!entry) return null;
    this.settle(entry, response as never, origin);
    return { toolCallId: entry.toolCallId };
  }

  /** The questions the agent is blocked on right now, as the events a peer
      attaching mid-question needs to see. This is what replaces scanning the
      log for still-open requests: the map holds exactly the open ones. */
  pendingEvents(): ThreadEvent[] {
    return [...this.pending.values()].map((entry) =>
      entry.kind === "permission"
        ? {
            ev: "permission",
            requestId: entry.requestId,
            request: entry.payload as acp.RequestPermissionRequest,
          }
        : {
            ev: "elicitation",
            requestId: entry.requestId,
            request: entry.payload as acp.CreateElicitationRequest,
          },
    );
  }

  private settle(entry: PendingRequest, response: never, except?: Peer, auto?: AutoAnswer): void {
    this.pending.delete(entry.requestId);
    /* Whoever won — a peer, the policy, the ask timeout, a dying process — the
       question is gone, so its fallback timer must go with it. Cleared here
       because this is the one exit every one of those paths takes. */
    if (entry.timer) clearTimeout(entry.timer);
    entry.settle(response);
    this.host.emit(
      {
        ev: "request_answered",
        requestId: entry.requestId,
        toolCallId: entry.toolCallId,
        ...(auto ? { auto } : {}),
      },
      except,
    );
    /* And, when the harness answered rather than a person, say it once more as
       an `update` — which IS journaled, where neither of the two events above
       is. The live pair is what a browser draws; this is what survives to be
       read afterwards by someone asking what a routine was allowed to do while
       nobody was watching. Emitted after `request_answered` so the ordering a
       peer sees is unchanged, and only for an auto answer: a human answering
       their own card needs no paper trail, and the tool call the permission
       allowed is journaled regardless. */
    if (auto) this.emitAutonomyAnswer(entry, auto);
  }

  /** The durable half of an auto-answer. Everything it carries is either the
      harness's own vocabulary or a protocol field — never an option name and
      never a vendor tool name, so the record reads the same whichever runtime
      produced it. */
  private emitAutonomyAnswer(entry: PendingRequest, answer: AutoAnswer): void {
    const toolCall =
      entry.kind === "permission" ? (entry.payload as acp.RequestPermissionRequest).toolCall : undefined;
    const update: AutonomyAnswer = {
      sessionUpdate: "_daedalus/autonomy_answer",
      kind: entry.kind,
      ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
      ...(toolCall?.kind ? { toolKind: toolCall.kind } : {}),
      ...(toolCall?.title ? { title: toolCall.title } : {}),
      answer,
    };
    /* `seq: 0` is the placeholder every `update` leaves here; the event log
       assigns the real one on append (see the emit above). `historyReplay` is
       false because this is something that happened now, not a line the agent
       re-narrated out of a loaded session. */
    this.host.emit({ ev: "update", seq: 0, update, historyReplay: false });
  }

  /**
   * Answer every open question so the agent is not left blocked on one nobody
   * can reach any more. Without this a dying or retired process takes its
   * questions with it and the agent hangs on a promise that will never settle.
   */
  settleAll(): void {
    for (const entry of [...this.pending.values()]) {
      this.settle(
        entry,
        (entry.kind === "permission"
          ? { outcome: { outcome: "cancelled" } }
          : { action: "cancel" }) as never,
      );
    }
  }

  close(reason?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    /* Nothing is held by a process that is gone. Said before the turn below is
       settled, so a reader sees the hold lift and then the failure, rather than
       an error row under a card still offering to continue. A turn that was
       held on a failure is remembered past the lift: the row it ends on has to
       say that the restart ended it, not offer the re-send the card existed to
       avoid — its settled steps are in the transcript, and the next message
       goes on from them. */
    const heldTurn = this.pausedReason === "error";
    if (this.paused) this.setHold(false, "user", null);
    /* A steer held for a step boundary that will never come. The words did
       reach the agent, so the transcript has to show them — a dying process
       must not also swallow the last thing the user said. Before `settleAll`,
       so the bubble precedes the failure it ran into. */
    this.openToolCalls.clear();
    this.flushSteers();
    this.settleAll();
    // Whatever was held for want of an explanation now has one.
    if (this.held.length > 0) {
      const error = this.host.enrichError(
        toWireError(
          heldTurn
            ? new Error(
                "The held turn ended with the restart. Every step it finished is kept above; send the next message to go on from there.",
              )
            : (reason ?? new Error("the agent process is gone")),
        ),
      );
      for (const text of this.held.splice(0)) this.settleTurn(null, error, text);
    }
    this.releaseIdle();
    this.connection.close(reason);
  }

  // ---- helpers ----

  /** Human name for a mode id, falling back to the id itself. */
  private modeName(id: string): string {
    return this.modes?.availableModes.find((m) => m.id === id)?.name ?? id;
  }

  /** A mid-turn mode/model/effort change joins `pendingSteers`: like a steered
      prompt it is already in effect, but its transcript row waits for the
      running step to end (`flushSteers`, at the latest the turn's own settle),
      and meanwhile it reads as a held `steer` row in the queue — to every peer
      including the one that asked. Journaled on flush, so it is logged after
      the turn as well as drawn during it.

      **Unless the turn is already held**, which is the whole of the exception:
      the wait exists so a row does not land in the middle of a running step,
      and a held turn is not in the middle of one — it is stopped *at* the
      boundary the wait is waiting for. Held anyway, the row was stranded until
      the user pressed Continue, so changing the model looked like it had done
      nothing; and worse, `heldSteers` renders a pending notice as a `steer`
      row, so the change the user had just made appeared in the queue as a
      message they had not sent. Emit it now: the boundary is here. */
  private holdConfigNotice(text: string): void {
    const event: ThreadEvent = { ev: "config_notice", seq: 0, text };
    if (this.paused) {
      this.host.emit(event);
      return;
    }
    this.pendingSteers.push({ id: randomUUID(), createdAt: Date.now(), event, origin: undefined });
    this.host.onHeldSteersChanged();
  }

  /** A live profile move that landed mid-turn draws its own row, held for the
      step boundary like a mode/model change; an idle move stays silent — the
      menu already says where the thread is. */
  noteProfileChange(from: string | undefined, to: string): void {
    if (this.promptActive) this.holdConfigNotice(configNoticeText("Profile", from, to));
  }

  private emitConfig(except?: Peer): void {
    this.host.emit(
      {
        ev: "session_config",
        seq: 0,
        modes: this.modes,
        modeId: this.modes?.currentModeId,
        configOptions: this.configOptions,
        /* The runtime's half of the attachment decision, on a carrier that
           already exists: absolute, optional and journaled, exactly as
           `update.sessionId` was added for subagents, so every event journaled
           before this replays with its shape unchanged. It travels with the
           config rather than on an event of its own because it is the same kind
           of statement — what this session can be asked to do. */
        ...(this.agentCapabilities.promptCapabilities
          ? { promptCapabilities: this.agentCapabilities.promptCapabilities }
          : {}),
        ...(this.canPause ? { canPause: true } : {}),
        ...(this.canFork ? { canRewind: true } : {}),
      },
      except,
    );
  }

  private requireSession(): string {
    if (this.closed) throw new Error("the agent process is gone");
    if (!this.acpSessionId) throw new Error("the agent never opened a session on this thread");
    return this.acpSessionId;
  }
}

/** One transcript line for a mid-turn setting change (`Mode: Plan → Build`).
    Exported for tests. */
export function configNoticeText(
  label: "Mode" | "Model" | "Effort" | "Profile",
  from: string | undefined,
  to: string,
): string {
  return from !== undefined ? `${label}: ${from} → ${to}` : `${label}: ${to}`;
}

/** Human name for a select-option value, across grouped or flat option
    lists. Falls back to the raw value when the option or the value is
    unknown. */
function selectValueName(
  option: acp.SessionConfigOption | undefined,
  value: string,
): string {
  if (!option || option.type !== "select") return value;
  const flat = option.options.flatMap((entry) => ("options" in entry ? entry.options : [entry]));
  return flat.find((choice) => choice.value === value)?.name ?? value;
}

/** Flatten anything thrown into the wire shape. The code matters: `errors.ts`
    on the other end reads it for the title, and -32800 is how a cancellation
    stays a cancellation instead of becoming a failure. */
export function toWireError(error: unknown): WireError {
  if (error instanceof acp.RequestError) {
    return { code: error.code, message: error.message, data: error.data };
  }
  if (error instanceof Error) return { code: -32603, message: error.message };
  return { code: -32603, message: String(error) };
}

/**
 * Is this option the same knob as the session's permission mode?
 *
 * Agents may advertise the mode twice — once as `modes`, once as a select config
 * option — and claude-agent-acp does exactly that. `category: "mode"` says so
 * outright; for agents that omit the category, an identical value set is the
 * only signal, and two selectors offering the same choices are the same knob.
 */
function isModeTwin(option: acp.SessionConfigOption, modeIds: ReadonlySet<string>): boolean {
  if (modeIds.size === 0 || option.type !== "select") return false;
  if (option.category === "mode") return true;
  const values = option.options
    .flatMap((entry) => ("options" in entry ? entry.options : [entry]))
    .map((choice) => choice.value);
  return values.length === modeIds.size && values.every((value) => modeIds.has(value));
}
