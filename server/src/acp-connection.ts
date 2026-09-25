import type { ChildProcessWithoutNullStreams } from "node:child_process";
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

export class AcpConnection {
  readonly proc: ChildProcessWithoutNullStreams;
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

  constructor(
    agentId: string,
    proc: ChildProcessWithoutNullStreams,
    shared: boolean,
    /** Extra inbound frames merged ahead of the reroute — see `agentStream`. */
    extra?: ReadableStream<acp.AnyMessage>,
  ) {
    this.agentId = agentId;
    this.proc = proc;
    this.shared = shared;
    proc.on("exit", () => {
      this.exited = true;
    });
    // An unhandled 'error' on a ChildProcess takes the server down; each
    // session's own `wire` reports it, and a warm process nobody is on has
    // nobody to report it to.
    proc.on("error", () => {
      this.exited = true;
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
      .connect(agentStream(proc, extra));
    this.initialized = this.rpc.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: CLIENT_CAPABILITIES,
    });
    this.initialized.catch(() => {});
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
    this.proc.kill("SIGTERM");
    setTimeout(() => {
      if (this.proc.exitCode === null && this.proc.signalCode === null) this.proc.kill("SIGKILL");
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
  acquire(
    agentId: string,
    key: string | null,
    start: () => { proc: ChildProcessWithoutNullStreams; extra?: ReadableStream<acp.AnyMessage> },
  ): AcpConnection {
    if (key !== null) {
      const warm = this.shared.get(key);
      if (warm?.alive) {
        if (warm.idleTimer) clearTimeout(warm.idleTimer);
        warm.idleTimer = null;
        return warm;
      }
    }
    const { proc, extra } = start();
    const conn = new AcpConnection(agentId, proc, key !== null, extra);
    if (key !== null) {
      this.shared.set(key, conn);
      proc.stderr.on("data", (chunk: Buffer) => console.error(`[acp:${agentId}]`, chunk.toString().trimEnd()));
      const forget = () => {
        if (conn.idleTimer) clearTimeout(conn.idleTimer);
        if (this.shared.get(key) === conn) this.shared.delete(key);
      };
      proc.on("exit", forget);
      proc.on("error", forget);
    }
    return conn;
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
