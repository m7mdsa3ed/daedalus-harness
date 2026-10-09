import { TRACE_NOTIFICATION, type TraceNotificationParams } from "./protocol.js";
import * as acp from "./acp.js";
import {
  CLIENT_CAPABILITIES,
  PAUSED_NOTIFICATION,
  RETRY_NOTIFICATION,
  parseTraceParams,
  SUBAGENT_UPDATE_METHOD,
  agentStream,
  parsePausedParams,
  parseRetryParams,
  parseSessionNotification,
  type PausedParams,
  type RetryParams,
  type SessionNotification,
  type SpawnSpec,
} from "./acp-bridge.js";
import { durable, type Handle } from "./sandbox/index.js";
import {
  dropProcessState,
  saveProcessProgress,
  saveProcessState,
  WireLedger,
  type ProcessState,
} from "./adopt-state.js";

/**
 * One agent process and the one ACP connection over its stdio.
 *
 * A process used to be a thread's: spawned for it, killed with it, and every
 * spawn paid the runtime's whole cold start (claude-agent-acp: ~5 s to answer
 * `initialize`) before `session/new` even began. ACP was always many sessions
 * over one connection — Zed, acpx and goose run it that way — so the process
 * is now this object's, `initialize` is said once per process, and each
 * thread's `AcpBridge` is one *session* on it.
 *
 * Whether two threads may share one is the runtime's to say
 * (`AgentDef.sharedProcess`); a runtime that cannot take a thread's env per
 * session gets a connection of its own (`shared: false`) and behaves exactly
 * as before — the bridge closing is the connection closing and the process
 * dying.
 *
 * Everything the agent sends is routed by `sessionId` to the bridge that owns
 * it (`ConnectionRoute.ownsSession`). The one thing no id can route is a frame
 * about a session whose id nobody has been told yet — a `session/new` still in
 * flight — so creations on a shared connection are serialised (`create`) and
 * such a frame belongs to whoever is creating.
 */

/** What a connection hands inbound frames to: an `AcpBridge`, or the probe's
    sink. */
export interface ConnectionRoute {
  /** This session's id, a child of it (subagent RFD), or the id a
      load/resume is being asked for. */
  ownsSession(sessionId: string): boolean;
  onUpdate(notification: SessionNotification): void;
  park<R>(
    kind: "permission" | "elicitation",
    params: acp.RequestPermissionRequest | acp.CreateElicitationRequest,
    toolCallId: string | undefined,
  ): Promise<R>;
  onElicitationComplete(elicitationId: string): void;
  onAgentPaused(params: PausedParams): void;
  onAgentRetry(params: RetryParams): void;
  onTrace(params: TraceNotificationParams): void;
}

/** A route that drops everything — the options probe's, which opens a session
    only to read what it offers. */
export const SINK: ConnectionRoute = {
  ownsSession: () => false,
  onUpdate: () => {},
  park: async <R>(kind: "permission" | "elicitation") =>
    (kind === "permission" ? { outcome: { outcome: "cancelled" } } : { action: "cancel" }) as R,
  onElicitationComplete: () => {},
  onAgentPaused: () => {},
  onAgentRetry: () => {},
  onTrace: () => {},
};

/** How long advancing offsets/counters wait before one write. */
const PROGRESS_FLUSH_MS = 500;
/** Every connection with a process behind it, for `flushAllProcessStates`. */
const live = new Set<AcpConnection>();

/** Write every dirty row now — before the server lets go of its processes. */
export async function flushAllProcessStates(): Promise<void> {
  await Promise.all([...live].map((c) => c.flush()));
}

/** Let go of every live process without ending it, for a server that is exiting
    over a durable sandbox. Call before `flushAllProcessStates` so no frame
    moves an offset after it is written. */
export function detachAllConnections(): void {
  for (const c of live) c.proc.detach();
}

export class AcpConnection {
  readonly proc: Handle;
  readonly rpc: acp.ClientConnection;
  /** The `initialize` answer, asked once for every session on this process. */
  readonly initialized: Promise<acp.InitializeResponse>;
  readonly shared: boolean;
  readonly agentId: string;
  exited = false;
  /** Sent its SIGTERM: not handed out again, though it has not exited yet. */
  private killed = false;

  private readonly routes = new Set<ConnectionRoute>();
  /** `session/close` requests still in flight, by session id. A resume of the
      same id waits for its close: claude-agent-acp answers a resume of a live
      session from memory, without the `_meta` the new bridge carries. */
  private readonly closing = new Map<string, Promise<unknown>>();
  private createChain: Promise<unknown> = Promise.resolve();
  private creating: ConnectionRoute | null = null;
  /** Set by the pool while nobody is on the process. */
  idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** The pool's key for a shared process (set by the pool; persisted for adopt). */
  poolKey: string | null = null;
  /** Ids, offset and in-flight prompts on the wire — what adopt persists. */
  readonly ledger: WireLedger | null;
  /** Lets an adopted connection's buffered frames through (no-op otherwise). */
  private readonly release: () => void;
  private readonly createdAt = Date.now();
  private saved = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private writing: Promise<unknown> = Promise.resolve();
  private initResult: acp.InitializeResponse | null = null;

  constructor(
    agentId: string,
    proc: Handle,
    shared: boolean,
    /** Extra inbound frames merged ahead of the reroute — see `agentStream`. */
    extra?: ReadableStream<acp.AnyMessage>,
    /** Present = adopt: the process is already initialized, so `initialize`
        is not sent and the wire resumes from this state. */
    adopted?: ProcessState,
  ) {
    this.agentId = agentId;
    // Only a process that can outlive the server needs bookkeeping; under `direct` the wire is the plain stream.
    this.ledger = adopted || durable ? new WireLedger(adopted) : null;
    // An adopted wire is held shut until its sessions' bridges exist (`open`).
    this.release = adopted && this.ledger ? this.ledger.hold() : () => {};
    if (this.ledger) this.ledger.onChange = (urgent) => this.markDirty(urgent);
    this.proc = proc;
    this.shared = shared;
    proc.on("exit", () => {
      this.exited = true;
      this.forget();
    });
    // An unhandled 'error' on a ChildProcess takes the server down; each
    // session's own `wire` reports it, and a warm process nobody is on has
    // nobody to report it to.
    proc.on("error", () => {
      this.exited = true;
      this.forget();
    });
    this.rpc = acp
      .client({ name: "daedalus" })
      .onNotification(acp.methods.client.session.update, (ctx) =>
        this.route(ctx.params.sessionId)?.onUpdate(ctx.params as SessionNotification),
      )
      // The RFD's subagent updates, re-addressed by `agentStream` — see
      // SUBAGENT_UPDATE_METHOD. Same handler: they are session updates.
      .onNotification(SUBAGENT_UPDATE_METHOD, parseSessionNotification, (ctx) =>
        this.route(ctx.params.sessionId)?.onUpdate(ctx.params),
      )
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        (this.route(ctx.params.sessionId) ?? SINK).park<acp.RequestPermissionResponse>(
          "permission",
          ctx.params,
          ctx.params.toolCall?.toolCallId,
        ),
      )
      .onRequest(acp.methods.client.elicitation.create, (ctx) =>
        (this.route((ctx.params as { sessionId?: string }).sessionId) ?? SINK).park<acp.CreateElicitationResponse>(
          "elicitation",
          ctx.params,
          (ctx.params as { toolCallId?: string }).toolCallId,
        ),
      )
      /* Carries no session id — only the elicitation's, which exactly one
         bridge holds and the rest ignore. */
      .onNotification(acp.methods.client.elicitation.complete, (ctx) => {
        for (const route of this.routes) route.onElicitationComplete(ctx.params.elicitationId);
      })
      .onNotification(PAUSED_NOTIFICATION, parsePausedParams, (ctx) =>
        this.route(ctx.params.sessionId)?.onAgentPaused(ctx.params),
      )
      .onNotification(RETRY_NOTIFICATION, parseRetryParams, (ctx) =>
        this.route(ctx.params.sessionId)?.onAgentRetry(ctx.params),
      )
      .onNotification(TRACE_NOTIFICATION, parseTraceParams, (ctx) =>
        this.route(ctx.params.sessionId)?.onTrace(ctx.params),
      )
      .connect(agentStream(proc, extra, this.ledger ?? undefined));
    if (adopted) {
      this.initResult = adopted.initResult;
      this.saved = true;
      this.initialized = Promise.resolve(adopted.initResult);
    } else {
      this.initialized = this.rpc.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: CLIENT_CAPABILITIES,
      });
      this.initialized.catch(() => {});
      this.initialized.then((init) => {
        this.initResult = init;
        this.markDirty(true);
      }, () => {});
    }
    live.add(this);
  }

  /**
   * A connection around a process the previous server left running: no
   * `initialize` (its answer is `state.initResult`), request ids resumed above
   * `state.nextRequestId`, and the prompts `state.prompts` left unanswered
   * surfaced as `ledger.orphans` instead of "unknown request" noise. The
   * caller attached `handle` from `state.offset`.
   */
  static adopt(handle: Handle, state: ProcessState, extra?: ReadableStream<acp.AnyMessage>): AcpConnection {
    const conn = new AcpConnection(state.agentId, handle, state.poolKey !== null, extra, state);
    conn.poolKey = state.poolKey;
    return conn;
  }

  /** An adopted connection delivers nothing until this: call it once every bridge
      that will own a session on it has been constructed. */
  open(): void {
    this.release();
  }

  private markDirty(urgent: boolean): void {
    if (!this.ledger || !this.initResult || this.exited || this.killed) return; // nothing persisted before `initialize` answered
    this.dirty = true;
    if (urgent) return void this.flush();
    this.flushTimer ??= setTimeout(() => void this.flush(), PROGRESS_FLUSH_MS).unref();
  }

  /** Write the row now (insert on first call, progress after). Never throws. */
  async flush(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.dirty && this.ledger && this.initResult && !this.exited && !this.killed) this.write(this.ledger);
    // Always wait for the chain, so a caller that finds nothing dirty still waits out a write in flight.
    await this.writing;
  }

  private write(ledger: WireLedger): void {
    this.dirty = false;
    const p = ledger.snapshot();
    const first = !this.saved;
    this.saved = true;
    // Serialised: an update must not overtake the insert it follows.
    this.writing = this.writing.then(() =>
      (first
        ? saveProcessState({
            hostId: this.proc.id,
            poolKey: this.poolKey,
            agentId: this.agentId,
            initResult: this.initResult!,
            createdAt: this.createdAt,
            ...p,
          })
        : saveProcessProgress(this.proc.id, p)
      ).catch((e) => console.warn(`[acp:${this.agentId}] could not persist adopt state`, e)),
    );
  }

  /** The process is gone for good: its row is useless. */
  private forget(): void {
    live.delete(this);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.dirty = false;
    if (this.saved) this.writing = this.writing.then(() => dropProcessState(this.proc.id)).catch(() => {});
  }

  get alive(): boolean {
    return !this.exited && !this.killed && !this.rpc.signal.aborted;
  }

  get sessionCount(): number {
    return this.routes.size;
  }

  attach(route: ConnectionRoute): void {
    this.routes.add(route);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /**
   * Who a frame is for. The owner of the id first; then whoever is creating a
   * session (its id is not known yet); then, on a connection of its own, its
   * one bridge — which is how an unrecognised id has always been read there:
   * a subagent's session that outran its `subagent_spawned`. On a shared
   * connection there is no such guess to make, and the frame is dropped.
   */
  private route(sessionId: string | undefined): ConnectionRoute | undefined {
    if (sessionId) {
      for (const route of this.routes) if (route.ownsSession(sessionId)) return route;
    }
    if (this.creating) return this.creating;
    if (!this.shared && this.routes.size === 1) return this.routes.values().next().value;
    if (this.routes.size > 0) console.warn(`[acp:${this.agentId}] dropped a frame for unknown session ${sessionId}`);
    return undefined;
  }

  /** Run a `session/new` (or anything else that mints an id) with `route` as
      the owner of every frame that arrives before its answer. Serialised on a
      shared connection, so there is only ever one such owner. */
  create<T>(route: ConnectionRoute, fn: () => Promise<T>): Promise<T> {
    const run = this.createChain.then(async () => {
      this.creating = route;
      try {
        return await fn();
      } finally {
        this.creating = null;
      }
    });
    this.createChain = run.catch(() => {});
    return run;
  }

  /** Resolves once any `session/close` of this id has been answered. */
  async whenClosed(sessionId: string): Promise<void> {
    await this.closing.get(sessionId);
  }

  /**
   * A session is done with this process. On a connection of its own that is
   * the process done too — closed and killed, as a bridge closing always was.
   * On a shared one the session is closed (ACP `session/close`, where the agent
   * offers it) and the process is handed back to the pool, which keeps it warm
   * for the next thread.
   */
  detach(route: ConnectionRoute, sessionId: string | null, reason?: unknown): void {
    this.routes.delete(route);
    if (!this.shared) {
      this.rpc.close(reason);
      this.kill();
      return;
    }
    this.markDirty(true);
    if (sessionId && this.alive) {
      void this.initialized
        .then((init) => {
          if (!init.agentCapabilities?.sessionCapabilities?.close || !this.alive) return;
          const closing = this.rpc.agent.request(acp.methods.agent.session.close, { sessionId }).catch(() => {});
          this.closing.set(sessionId, closing);
          void closing.finally(() => {
            if (this.closing.get(sessionId) === closing) this.closing.delete(sessionId);
          });
          return closing;
        })
        .catch(() => {});
    }
    pool.release(this);
  }

  /** SIGTERM, then SIGKILL for a process that ignores it. */
  kill(): void {
    if (this.exited) return;
    this.killed = true;
    this.forget();
    this.proc.kill("SIGTERM");
    setTimeout(() => {
      if (this.proc.running) this.proc.kill("SIGKILL");
    }, 5000).unref();
  }
}

/** How long a shared process nobody is on stays warm — acpx's default. */
export const IDLE_TTL_MS = 5 * 60_000;

/**
 * The shared processes, keyed by everything `spawn()` is given. Two threads
 * whose spawns would be identical get the same process; anything that differs
 * — a cwd, an arg, an env var — is a different key and a different process,
 * which is what keeps the sharing honest without the pool knowing anything
 * about the runtime.
 */
export class AcpPool {
  private readonly shared = new Map<string, AcpConnection>();
  /** Spawns in flight, so two callers racing on one key start one process. */
  private readonly starting = new Map<string, Promise<AcpConnection>>();

  static key(spec: SpawnSpec): string {
    const env = Object.keys(spec.env)
      .sort()
      .map((k) => [k, spec.env[k]]);
    return JSON.stringify([spec.command, spec.args, spec.cwd, env]);
  }

  /**
   * A connection for this spawn. `key` null = a process of its own, never
   * reused. Otherwise a live process under the same key is handed out (its
   * idle clock stopped), and only a missing or dead one is spawned.
   */
  async acquire(
    agentId: string,
    key: string | null,
    start: () => Promise<{ proc: Handle; extra?: ReadableStream<acp.AnyMessage> }>,
  ): Promise<AcpConnection> {
    if (key !== null) {
      const warm = this.shared.get(key);
      if (warm?.alive) {
        if (warm.idleTimer) clearTimeout(warm.idleTimer);
        warm.idleTimer = null;
        return warm;
      }
    }
    if (key !== null) {
      const pending = this.starting.get(key);
      if (pending) {
        await pending.catch(() => {});
        return this.acquire(agentId, key, start);
      }
    }
    const spawned = this.spawnConn(agentId, key, start);
    if (key === null) return spawned;
    this.starting.set(key, spawned);
    try {
      return await spawned;
    } finally {
      this.starting.delete(key);
    }
  }

  private async spawnConn(
    agentId: string,
    key: string | null,
    start: () => Promise<{ proc: Handle; extra?: ReadableStream<acp.AnyMessage> }>,
  ): Promise<AcpConnection> {
    const { proc, extra } = await start();
    const conn = new AcpConnection(agentId, proc, key !== null, extra);
    conn.poolKey = key;
    this.adopt(conn);
    return conn;
  }

  /** Make a shared connection findable by `acquire` — also how a connection
      built around an adopted process (`AcpConnection.adopt`) joins the pool.
      A connection of its own (no key) has nothing to register. */
  adopt(conn: AcpConnection): void {
    const key = conn.poolKey;
    if (key === null) return;
    const { proc, agentId } = conn;
    this.shared.set(key, conn);
    proc.stderr.on("data", (chunk: Buffer) => console.error(`[acp:${agentId}]`, chunk.toString().trimEnd()));
    const forget = () => {
      if (conn.idleTimer) clearTimeout(conn.idleTimer);
      if (this.shared.get(key) === conn) this.shared.delete(key);
    };
    proc.on("exit", forget);
    proc.on("error", forget);
  }

  /** Nobody left on a shared process: keep it warm for `IDLE_TTL_MS`. */
  release(conn: AcpConnection): void {
    if (!conn.shared || conn.sessionCount > 0 || conn.idleTimer) return;
    conn.idleTimer = setTimeout(() => {
      conn.idleTimer = null;
      if (conn.sessionCount === 0) conn.kill();
    }, IDLE_TTL_MS);
    conn.idleTimer.unref();
  }

  /** Stop every shared process — shutdown and tests. */
  drain(): void {
    for (const conn of this.shared.values()) conn.kill();
    this.shared.clear();
  }
}

export const pool = new AcpPool();
