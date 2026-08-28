import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, eq, gte } from "drizzle-orm";
import type { WebSocket } from "ws";
import type * as acp from "@agentclientprotocol/sdk";
import { db, sessionEvents as eventsTable, sessions as sessionsTable } from "./db/index.js";
import { mcpServers as mcpLibrary } from "./library.js";
import type { Profile } from "./profiles.js";
import type { Project } from "./projects.js";
import { loadConfig } from "./config.js";
import { WEB_SEARCH_SERVER_NAME, toMcpServerEnv } from "./websearch.js";
import { KNOWLEDGE_SERVER_NAME, toKnowledgeServerEnv } from "./knowledge-db.js";
import { AcpBridge, spawnAgent, toWireError, type BridgeHost } from "./acp-bridge.js";
import { JOURNALED_EVENTS, type ThreadCommand, type ThreadEvent, type WireError } from "./protocol.js";

/** One attached client. Several may share a session; they are subscribers to
    one server-side ACP client, not ACP clients themselves — which is why a peer
    carries no request bookkeeping any more. */
export interface Peer {
  ws: WebSocket;
}

export interface Session {
  id: string;
  profileId: string;
  projectId: string;
  agentId: string;
  model: string;
  effort: string;
  title: string;
  acpSessionId?: string;
  createdAt: number;
  /** Events ever journaled for this session. `cursor` is an index into this,
      not into any array — the log itself is a table (see appendEvent), so
      nothing about a long thread is held in memory. */
  eventCount: number;
  /** null = no live process (loaded from disk / retired); revive via respawn. */
  proc: ChildProcessWithoutNullStreams | null;
  /** The ACP client driving that process. Goes with it. */
  bridge: AcpBridge | null;
  /** Every attached client. Agent events fan out to all of them. */
  peers: Set<Peer>;
  /** Rolling tail of the agent's stderr. When an agent answers a prompt with a
      bare "Internal error", this is where the reason actually is — so it is
      kept, capped, and handed to the client instead of only reaching the
      server's console. Reset with the process. */
  stderr: string[];
  /** Lines ever written to stderr; the retained tail is the last of them.
      Monotonic, so a mark taken now stays meaningful after the tail rolls. */
  stderrCount: number;
  /** stderrCount when the running turn's prompt was dispatched — everything
      after it is what this turn printed, and nothing older gets blamed on it. */
  stderrMark: number;
  detachedAt: number | null;
  /** Epoch ms this thread was deleted; null = live. Deleted threads keep their
      row (and their acpSessionId) so a delete stays undoable — purge is the
      only thing that forgets a thread. */
  deletedAt: number | null;
  exited: boolean;
  /** Tail of this session's in-flight respawn chain, null when idle. A second
      respawn — a double-click, two tabs, model then effort changed in quick
      succession — queues behind the first instead of closing its not-yet-ready
      bridge, which is what used to reject the first call's `await bridge.ready`
      with the close reason and answer a fine respawn with 500 "respawning". */
  respawnChain: Promise<Session> | null;
}

/** How much of the agent's stderr to keep. Enough for a stack trace, bounded so
    a chatty agent can't grow a session without limit. */
const STDERR_TAIL_LINES = 200;

/** How long to wait after 'exit' for the agent's stdio to close before telling
    the peers anyway — a grandchild holding a pipe must not strand them. */
const EXIT_DRAIN_MS = 250;

const JOURNALED = new Set<string>(JOURNALED_EVENTS);

/** A WebSocket close reason is capped at 123 bytes by the protocol, and `ws`
    throws rather than truncating — which, in an exit handler, would take the
    server down instead of closing the socket. Trim by whole characters so a
    multi-byte one can't be cut in half. */
function truncateReason(reason: string): string {
  let text = reason.replace(/\s+/g, " ").trim();
  if (Buffer.byteLength(text, "utf8") <= 120) return text;
  text = text.slice(0, 116);
  while (Buffer.byteLength(text, "utf8") > 116) text = text.slice(0, -1);
  return `${text}…`;
}

/**
 * The project's MCP servers, in the shape `session/new` takes.
 *
 * The browser used to send these — it no longer speaks to the agent, and the
 * server already holds the links (join tables, so nothing dangling can be in
 * them). ACP's stdio variant carries no `type` discriminator, so ours is
 * stripped on the way out.
 */
export function mcpServersFor(project: Project): acp.McpServer[] {
  const linked = new Set(project.mcpServerIds);
  return mcpLibrary
    .list()
    .filter((s) => linked.has(s.id))
    .map((s) =>
      s.type === "http"
        ? { type: "http" as const, name: s.name, url: s.url, headers: s.headers }
        : { name: s.name, command: s.command, args: s.args, env: s.env },
    );
}

/**
 * The harness's own `web-search` MCP server, synthesized at spawn from
 * `data/config.json` — never a stored library row, so the credentials come
 * live and a config edit is picked up on the next session/new or respawn.
 * Null when search is not configured (a thread must not advertise tools that
 * cannot answer). The environment is mapped onto the stdio `McpServerStdio.env`
 * shape the agent spawns the server with.
 */
/** A stdio `McpServerStdio`-shaped def, but with `type` omitted — ACP's stdio
    variant carries no discriminator, and that is the shape `session/new` takes
    (see the `mcpServersFor` mapping). Narrowed here so `command`/`args`/`env`
    are typed rather than buried in the `McpServer` union. */
export type StdioMcpServer = {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
};

/**
 * Resolve the effective web-search config for a profile: its own override wins
 * per field, falling back to the server-global default. Only `enabled` is
 * required on the profile; the rest inherit. Returns the server default verbatim
 * when the profile carries no override.
 */
export function resolveWebSearch(
  profile: Pick<Profile, "webSearch">,
  config: ReturnType<typeof loadConfig>,
): { enabled: boolean; searchApiBaseUrl: string; searchApiToken: string; searchModel: string; fetchModel: string } | null {
  const profileWs = profile.webSearch;
  const serverWs = config.webSearch;
  if (!profileWs?.enabled) return null;
  if (!serverWs) return null;
  return {
    enabled: true,
    searchApiBaseUrl: profileWs.searchApiBaseUrl || serverWs.searchApiBaseUrl,
    searchApiToken: profileWs.searchApiToken || serverWs.searchApiToken,
    searchModel: profileWs.searchModel || serverWs.searchModel,
    fetchModel: profileWs.fetchModel || serverWs.fetchModel,
  };
}

export function websearchServer(
  profile: Pick<Profile, "webSearch">,
  config: ReturnType<typeof loadConfig>,
): StdioMcpServer | null {
  const resolved = resolveWebSearch(profile, config);
  if (!resolved) return null;
  // `process.execPath` (node) is the executable; the compiled/tsx path to the
  // server resolves to the directory this module runs from, so it is correct
  // under both tsx (src/) and the built dist/.
  return {
    name: WEB_SEARCH_SERVER_NAME,
    command: process.execPath,
    args: [join(dirname(fileURLToPath(import.meta.url)), "websearch-mcp.js")],
    env: toMcpServerEnv(resolved),
  };
}

/**
 * The harness's own `knowledge` MCP server, synthesized at spawn when the PROFILE
 * opts in — never a stored library row. The project's id is injected into the
 * server's env so every query is scoped to the workspace this session runs in.
 * Null when the profile has not enabled it, mirroring `websearchServer`.
 */
export function knowledgeServer(
  profile: Pick<Profile, "knowledge">,
  project: Pick<Project, "id">,
): StdioMcpServer | null {
  if (!profile.knowledge?.enabled) return null;
  return {
    name: KNOWLEDGE_SERVER_NAME,
    command: process.execPath,
    args: [join(dirname(fileURLToPath(import.meta.url)), "knowledge-mcp.js")],
    env: toKnowledgeServerEnv(project.id),
  };
}

export interface SessionEvents {
  /** Fired only while no client is attached — used for push notifications. */
  onPermissionRequest?: (session: Session) => void;
  /** The agent asked the user something (elicitation/create) with nobody
      attached to answer. Same push case as a permission, different sentence. */
  onElicitationRequest?: (session: Session) => void;
  /** `error` is the error the prompt failed with, when it failed. */
  onTurnEnd?: (session: Session, error?: unknown) => void;
}

export class SessionManager {
  private sessions = new Map<string, Session>();

  constructor(private events: SessionEvents = {}, idleMinutes = 30) {
    // Sessions from before the last server restart: processes are gone, but the
    // thread identity remains and the client can revive it (respawn + load).
    // Their event logs go with the processes — reviving replays the conversation
    // through session/load, which is the agent's account and the canonical one.
    db.delete(eventsTable).run();
    for (const row of db.select().from(sessionsTable).all()) {
      this.sessions.set(row.id, {
        ...row,
        acpSessionId: row.acpSessionId ?? undefined,
        eventCount: 0,
        stderr: [],
        stderrCount: 0,
        stderrMark: 0,
        proc: null,
        bridge: null,
        peers: new Set(),
        detachedAt: Date.now(),
        exited: true,
        respawnChain: null,
      });
    }

    const idleMs = idleMinutes * 60_000;
    setInterval(() => {
      for (const s of this.sessions.values()) {
        if (!s.exited && s.peers.size === 0 && s.detachedAt && Date.now() - s.detachedAt > idleMs) {
          this.retire(s);
        }
      }
    }, 60_000).unref();
  }

  /**
   * Write one session's durable fields. This used to rewrite the whole list on
   * every title sniff and every model change; now it touches one row, so it
   * stays cheap however many threads exist.
   *
   * What is NOT here is deliberate: the conversation lives in the agent's own
   * session store and comes back through ACP session/load on revive.
   */
  private persist(session?: Session): void {
    const rows = session ? [session] : [...this.sessions.values()];
    for (const s of rows) {
      const values = {
        id: s.id,
        profileId: s.profileId,
        projectId: s.projectId,
        agentId: s.agentId,
        model: s.model,
        effort: s.effort,
        title: s.title,
        acpSessionId: s.acpSessionId ?? null,
        createdAt: s.createdAt,
        deletedAt: s.deletedAt,
      };
      db.insert(sessionsTable).values(values).onConflictDoUpdate({
        target: sessionsTable.id,
        set: values,
      }).run();
    }
  }

  // ---- the event log ----

  /** Append one event to the session's log and stamp it with its seq.
   *
   * One INSERT per journaled event. Under WAL with synchronous=NORMAL a commit
   * is a buffered append, not an fsync, so a streaming turn costs no more than
   * the array push it replaces — and unlike the array, nothing accumulates in
   * RAM. */
  private appendEvent(session: Session, event: ThreadEvent): ThreadEvent {
    const seq = session.eventCount++;
    const stamped = { ...event, seq } as ThreadEvent;
    db.insert(eventsTable)
      .values({ sessionId: session.id, seq, kind: event.ev, payload: stamped })
      .run();
    return stamped;
  }

  /** Events from `cursor` on, in order. A range scan on (session_id, seq). */
  private eventsFrom(session: Session, cursor: number): ThreadEvent[] {
    return db
      .select({ payload: eventsTable.payload })
      .from(eventsTable)
      .where(and(eq(eventsTable.sessionId, session.id), gte(eventsTable.seq, cursor)))
      .orderBy(asc(eventsTable.seq))
      .all()
      .map((row) => row.payload as ThreadEvent);
  }

  private clearEvents(session: Session): void {
    db.delete(eventsTable).where(eq(eventsTable.sessionId, session.id)).run();
    session.eventCount = 0;
  }

  /** Everything this session has journaled, and the cursor that follows it. */
  journal(id: string): { cursor: number; events: ThreadEvent[] } | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    return { cursor: session.eventCount, events: this.eventsFrom(session, 0) };
  }

  // ---- fan-out ----

  private send(peer: Peer, event: ThreadEvent): void {
    peer.ws.send(JSON.stringify(event));
  }

  /**
   * Journal (when the event is one of the four that are) and fan out.
   *
   * `except` is the peer whose own action produced the event — it has already
   * shown the result and being told again would double it.
   */
  private emit(session: Session, event: ThreadEvent, except?: Peer): void {
    /* Closing a bridge rejects whatever it had in flight, and those rejections
       land a microtask later — after a purge has already deleted the row the
       event rows point at. Nothing is listening for them either way. */
    if (!this.sessions.has(session.id)) return;
    const out = JOURNALED.has(event.ev) ? this.appendEvent(session, event) : event;
    if (session.peers.size === 0) return;
    const line = JSON.stringify(out);
    for (const peer of session.peers) if (peer !== except) peer.ws.send(line);
  }

  /** A server-side subsystem (the task tailer) telling a thread's live peers
      something. Not journaled: the source is durable on its own and re-read at
      watch time, so replaying these would double-count every event. */
  taskEvent(id: string, transcriptDir: string, event: unknown): void {
    const session = this.sessions.get(id);
    if (session) {
      this.emit(session, {
        ev: "task_event",
        transcriptDir,
        event: event as Record<string, unknown>,
      });
    }
  }

  // ---- stderr ----

  private pushStderr(session: Session, text: string): void {
    const lines = text.split("\n");
    session.stderr.push(...lines);
    session.stderrCount += lines.length;
    if (session.stderr.length > STDERR_TAIL_LINES) {
      session.stderr.splice(0, session.stderr.length - STDERR_TAIL_LINES);
    }
  }

  /** What the agent printed since the running turn began — the part of stderr
      that can honestly be blamed on this failure, bounded by what we still hold. */
  private stderrSinceMark(session: Session): string {
    const since = Math.min(session.stderrCount - session.stderrMark, session.stderr.length);
    return since > 0 ? session.stderr.slice(-since).join("\n").trim() : "";
  }

  /**
   * Attach the agent's own output to an error before it reaches the client.
   * "Internal error" is a code, not an explanation; the explanation was on
   * stderr, and this is the only place that has both.
   */
  private enrichError(session: Session, error: WireError): WireError {
    const stderr = this.stderrSinceMark(session);
    if (!stderr) return error;
    const { data } = error;
    const merged =
      data && typeof data === "object" && !Array.isArray(data)
        ? { ...(data as Record<string, unknown>), stderr }
        : data === undefined
          ? { stderr }
          : { details: data, stderr };
    return { ...error, data: merged };
  }

  /** The agent's recent stderr, for a client that wants to see why a thread is
      misbehaving. Read-only; the server's console gets it either way. */
  stderrTail(id: string): string[] {
    return this.sessions.get(id)?.stderr ?? [];
  }

  // ---- process lifecycle ----

  /** What the bridge calls back into. One per session, reused across respawns —
      the `session` closure is stable, the bridge inside it is not. */
  private hostFor(session: Session): BridgeHost {
    return {
      emit: (event, except) => this.emit(session, event, except),
      peerCount: () => session.peers.size,
      markTurnStderr: () => {
        session.stderrMark = session.stderrCount;
      },
      enrichError: (error) => this.enrichError(session, error),
      onPermissionRequest: () => this.events.onPermissionRequest?.(session),
      onElicitationRequest: () => this.events.onElicitationRequest?.(session),
      onTurnEnd: (error) => this.events.onTurnEnd?.(session, error),
      onAcpSessionId: (acpSessionId) => {
        session.acpSessionId = acpSessionId;
        this.persist(session);
      },
      onSpawnStateChange: (next) => {
        if (next.model !== undefined) session.model = next.model;
        if (next.effort !== undefined) session.effort = next.effort;
        this.persist(session);
      },
    };
  }

  /**
   * Watch a process on the session's behalf. Everything here is guarded on
   * `session.bridge`, the generation token: a respawned session's dying
   * predecessor must not close the new one's sockets.
   *
   * Note what is NOT here any more: stdout. The bridge's ndJsonStream owns it,
   * and a second reader would silently steal its bytes.
   */
  private wire(session: Session, proc: ChildProcessWithoutNullStreams, bridge: AcpBridge, profileName: string): void {
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trimEnd();
      console.error(`[${session.id.slice(0, 8)}:${profileName}]`, text);
      if (session.bridge !== bridge) return;
      this.pushStderr(session, text);
    });
    // spawn() reports a missing binary, a bad cwd or a permissions problem
    // asynchronously — and an unhandled 'error' on a ChildProcess takes the
    // whole server down with it. Treat it as an immediate exit and tell the
    // client what the OS said, which is the only useful thing anyone has.
    proc.on("error", (error: NodeJS.ErrnoException) => {
      if (session.bridge !== bridge) return;
      const reason = `agent failed to start: ${error.code ?? error.name} — ${error.message}`;
      console.error(`[${session.id.slice(0, 8)}:${profileName}]`, reason);
      this.pushStderr(session, reason);
      this.collapse(session, bridge, reason);
    });
    // 'exit' fires the moment the process is gone, but stderr written just
    // before it dies is often still in flight — and that last line is usually
    // the whole explanation. 'close' is the event that waits for the pipes, so
    // the peers are told there, with a timer in case a grandchild holds a pipe
    // open and 'close' never comes.
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled || session.bridge !== bridge) return;
      settled = true;
      const how = code !== null ? `exit code ${code}` : `signal ${signal}`;
      this.collapse(session, bridge, `The agent process ended (${how}).`);
    };
    proc.on("exit", (code, signal) => {
      if (session.bridge !== bridge) return;
      session.exited = true;
      setTimeout(() => finish(code, signal), EXIT_DRAIN_MS).unref();
    });
    proc.on("close", finish);
  }

  /**
   * The process is gone. Reject whatever the agent was going to answer, settle
   * whatever it was asking, and only then close the sockets.
   *
   * The order is the point: closing the bridge rejects the in-flight prompt,
   * which becomes a `turn_ended` carrying the stderr that explains the failure.
   * Close the peers first and that explanation never reaches anyone — which is
   * how a prompt to a dying agent used to just stop mid-turn.
   */
  private collapse(session: Session, bridge: AcpBridge, reason: string): void {
    session.exited = true;
    bridge.close(new Error(reason));
    setTimeout(() => {
      if (session.bridge !== bridge) return;
      this.closePeers(session, 4001, truncateReason(reason));
    }, 0).unref();
  }

  /** `id` lets the client name the thread it has already routed to; the caller
      is responsible for having checked that it is a free UUID. Without one the
      server names it, which is still the path the API takes when asked. */
  create(
    profile: Profile,
    project: Project,
    model?: string,
    effort?: string,
    id?: string,
    configChoices?: Record<string, string | boolean>,
  ): Session {
    const session: Session = {
      id: id ?? randomUUID(),
      profileId: profile.id,
      projectId: project.id,
      agentId: profile.agentId,
      model: model || profile.defaultModel || "",
      effort: effort ?? "",
      title: "New thread",
      createdAt: Date.now(),
      eventCount: 0,
      stderr: [],
      stderrCount: 0,
      stderrMark: 0,
      proc: null,
      bridge: null,
      peers: new Set(),
      detachedAt: Date.now(),
      deletedAt: null,
      exited: false,
      respawnChain: null,
    };
    this.sessions.set(session.id, session);
    // Before the bridge: the event rows reference this one, so the session has
    // to exist by the time the agent's first update arrives.
    this.persist(session);
    this.start(session, profile, project, model, effort, { configChoices });
    return session;
  }

  /** Spawn a process for this session and put an ACP client in front of it. */
  private start(
    session: Session,
    profile: Profile,
    project: Project,
    model: string | undefined,
    effort: string | undefined,
    opts: {
      load?: { acpSessionId: string };
      restore?: import("./protocol.js").RestoreState;
      configChoices?: Record<string, string | boolean>;
    },
  ): AcpBridge {
    const proc = spawnAgent(profile, project, model, effort);
    const mcpServers = mcpServersFor(project);
    // The web-search MCP server replaces claude-code's built-in WebSearch/
    // WebFetch, but only when the PROFILE opts in (and a search backend is
    // resolvable — profile override or server default). Default is off: a
    // profile that never set `webSearch.enabled`, or an agent that never
    // declared the originals (codex/opencode), adds nothing and disallows
    // nothing.
    const wsServer = websearchServer(profile, loadConfig());
    const websearchFromProfile = session.agentId === "claude-code" && wsServer !== null;
    // Knowledge is additive for every agent — there is no built-in to disallow
    // (unlike web-search), so no agentId gating and no special-casing. Gated on
    // the profile's own toggle.
    const kbServer = knowledgeServer(profile, project);
    const extra = [
      ...(websearchFromProfile ? [wsServer!] : []),
      ...(kbServer ? [kbServer] : []),
    ];
    const bridge = new AcpBridge(this.hostFor(session), proc, {
      cwd: project.cwd,
      mcpServers: [...extra, ...mcpServers],
      ...opts,
      websearchViaMcp: websearchFromProfile,
    });
    session.proc = proc;
    session.bridge = bridge; // flips the generation guard
    session.exited = false;
    // Not every caller awaits `ready` (create() hands the promise to its route,
    // respawn awaits it here). Attaching a handler now keeps a failed handshake
    // from surfacing as an unhandled rejection; the real awaiter still sees it.
    bridge.ready.catch(() => {});
    this.wire(session, proc, bridge, profile.name);
    return bridge;
  }

  /**
   * Swap the session's agent process for one spawned with a different
   * profile/model/effort (same project) — also the revive path for sessions
   * whose process is gone (idle-retired or pre-restart).
   *
   * Atomic now, and that is the change: the whole spawn → session/load →
   * restore-the-settings sequence happens here, while it used to be three
   * round trips the browser drove. A tab closing halfway through can no longer
   * leave a thread half-restored.
   */
  async respawn(
    id: string,
    profile: Profile,
    project: Project,
    model?: string,
    effort?: string,
  ): Promise<Session> {
    const session = this.sessions.get(id);
    if (!session) throw new Error("unknown session");
    if (session.deletedAt !== null) throw new Error("session deleted");
    // One respawn at a time, per thread. The whole spawn → session/load →
    // restore sequence runs against a bridge that `session.bridge` already
    // points at, so a second call before the first settles would close that
    // half-started bridge — and its in-flight `session/load` is exactly what
    // `close(reason)` rejects, handing the first route the close reason as a
    // 500 while the second one's thread came up fine. Queuing keeps every
    // respawn atomic and lets the last request win.
    const ahead = session.respawnChain;
    const run = (async (): Promise<Session> => {
      await ahead?.catch(() => {}); // queue behind it, whichever way it settled
      return this.respawnNow(session, profile, project, model, effort);
    })();
    session.respawnChain = run;
    void run.finally(() => {
      if (session.respawnChain === run) session.respawnChain = null;
    }).catch(() => {});
    return run;
  }

  private async respawnNow(
    session: Session,
    profile: Profile,
    project: Project,
    model?: string,
    effort?: string,
  ): Promise<Session> {
    // Re-checked once the queue lets us through: the thread may have been
    // deleted (or purged) while a first respawn was still in flight.
    if (this.sessions.get(session.id) !== session) throw new Error("unknown session");
    if (session.deletedAt !== null) throw new Error("session deleted");
    // Captured while the old process is still up — it is the only thing that
    // knows how the agent was configured.
    const restore = session.bridge?.captureRestoreState();
    const oldProc = session.proc;
    const oldBridge = session.bridge;
    session.bridge = null; // stale generation from here on
    oldBridge?.close(new Error("respawning"));
    if (!session.exited) oldProc?.kill();
    session.profileId = profile.id;
    session.agentId = profile.agentId;
    session.model = model || profile.defaultModel || "";
    session.effort = effort ?? "";
    // The load replays the entire conversation as fresh updates, so everything
    // already journaled is about to be said again.
    this.clearEvents(session);
    this.resetStderr(session);
    const bridge = this.start(session, profile, project, model, effort, {
      load: session.acpSessionId ? { acpSessionId: session.acpSessionId } : undefined,
      restore,
    });
    this.persist(session);
    try {
      await bridge.ready;
    } catch (error) {
      // A handshake that never finished leaves a thread that needs reviving —
      // the caller turns this into an {error} the client can read.
      if (session.bridge === bridge) this.collapse(session, bridge, describe(error));
      throw error;
    }
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  private resetStderr(session: Session): void {
    session.stderr = [];
    session.stderrCount = 0;
    session.stderrMark = 0;
  }

  /** Stop the process but keep the thread — the opposite of purge(). */
  private retire(session: Session): void {
    const proc = session.proc;
    const bridge = session.bridge;
    session.proc = null;
    session.bridge = null; // flips the generation guard
    session.exited = true;
    // Close before clearing: closing ends whatever turn was in flight, and that
    // last event belongs to the log this is about to throw away, not the next one.
    bridge?.close(new Error("thread retired"));
    this.clearEvents(session);
    this.resetStderr(session);
    proc?.kill();
  }

  list() {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      profileId: s.profileId,
      projectId: s.projectId,
      agentId: s.agentId,
      model: s.model,
      effort: s.effort,
      title: s.title,
      acpSessionId: s.acpSessionId,
      createdAt: s.createdAt,
      deletedAt: s.deletedAt,
      attached: s.peers.size > 0,
      peerCount: s.peers.size,
      exited: s.exited,
      promptActive: s.bridge?.promptActive ?? false,
      cursor: s.eventCount,
    }));
  }

  /**
   * Delete a thread the reversible way: the process goes, the row stays.
   * Reviving a restored thread respawns and replays it through session/load
   * exactly like an idle-retired one — the acpSessionId is what makes that
   * possible, so deleting must not drop it.
   */
  softDelete(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session || session.deletedAt !== null) return false;
    this.closePeers(session, 4000, "session deleted");
    session.deletedAt = Date.now();
    this.retire(session);
    this.persist(session);
    return true;
  }

  restore(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session || session.deletedAt === null) return false;
    session.deletedAt = null;
    // Still process-less: the client revives it the same way it revives any
    // retired thread.
    this.persist(session);
    return true;
  }

  /** Forget the thread for good. Only the agent's own store still has it. */
  purge(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.closePeers(session, 4000, "session purged");
    this.retire(session);
    this.sessions.delete(id);
    // ON DELETE CASCADE takes the event rows with it.
    db.delete(sessionsTable).where(eq(sessionsTable.id, id)).run();
    return true;
  }

  private closePeers(session: Session, code: number, reason: string): void {
    for (const peer of session.peers) peer.ws.close(code, reason);
  }

  // ---- the socket ----

  /**
   * Attach a WebSocket. Replays journaled events from `cursor`, brackets them
   * with `attached`/`caught_up` so the client can tell history from news, then
   * hands over whatever question the agent is currently blocked on.
   *
   * Returns null on success, or why it refused — that string becomes the close
   * reason, and "unknown session" for all three cases was a lie in two.
   */
  attach(id: string, ws: WebSocket, cursor = 0): string | null {
    const session = this.sessions.get(id);
    if (!session) return "no such thread on this server";
    if (session.deletedAt !== null) return "this thread is in the trash";
    if (session.exited) return "this thread has no running agent — revive it first";
    const peer: Peer = { ws };
    session.peers.add(peer);
    session.detachedAt = null;

    this.send(peer, { ev: "attached", from: cursor, acpSessionId: session.acpSessionId ?? null });
    for (const event of this.eventsFrom(session, cursor)) this.send(peer, event);
    // Read in the same tick as the log it follows, so a client can't pair a
    // stale turn state with a fresh replay window (or vice versa).
    this.send(peer, {
      ev: "caught_up",
      cursor: session.eventCount,
      promptActive: session.bridge?.promptActive ?? false,
    });
    /* An unanswered question is sent whatever the cursor says. A client that
       reloaded reattaches from the END of the log, and the agent is still
       blocked — so without this it would show nothing to answer with. There is
       no filtering to do: an answered request is not in the map. */
    for (const event of session.bridge?.pendingEvents() ?? []) this.send(peer, event);

    ws.on("message", (data) => this.onCommand(session, peer, data.toString()));
    ws.on("close", () => {
      session.peers.delete(peer);
      if (session.peers.size === 0) session.detachedAt = Date.now();
    });
    return null;
  }

  private onCommand(session: Session, peer: Peer, line: string): void {
    let command: ThreadCommand;
    try {
      command = JSON.parse(line) as ThreadCommand;
    } catch {
      return; // not JSON — nothing to answer
    }
    const bridge = session.bridge;
    if (!bridge) {
      if ("id" in command) {
        this.send(peer, {
          ev: "reply",
          id: command.id,
          error: { code: -32603, message: "this thread has no running agent" },
        });
      }
      return;
    }

    switch (command.cmd) {
      case "answer_permission":
      case "answer_elicitation": {
        // First answer wins. A loser is told directly, so its card clears even
        // though it never saw the winner's broadcast.
        const answered = bridge.answer(command.requestId, command.response, peer);
        if (!answered) this.send(peer, { ev: "request_answered", requestId: command.requestId });
        return;
      }
      case "prompt":
        this.run(session, peer, command.id, async () => {
          bridge.prompt(command.text, peer);
          if (command.text && session.title === "New thread") {
            session.title = command.text.slice(0, 60);
            this.persist(session);
          }
        });
        return;
      case "cancel":
        this.run(session, peer, command.id, () => bridge.cancel());
        return;
      case "set_mode":
        this.run(session, peer, command.id, () => bridge.setMode(command.modeId, peer));
        return;
      case "set_config_option":
        this.run(session, peer, command.id, async () => ({
          configOptions: await bridge.setConfigOption(command.configId, command.value, peer),
        }));
        return;
    }
  }

  /** One command, one reply. Failures carry the agent's stderr, so the browser
      gets the explanation and not just the code. */
  private run(
    session: Session,
    peer: Peer,
    id: number,
    op: () => Promise<unknown>,
  ): void {
    void op().then(
      (result) => this.send(peer, { ev: "reply", id, result }),
      (error: unknown) =>
        this.send(peer, { ev: "reply", id, error: this.enrichError(session, toWireError(error)) }),
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
