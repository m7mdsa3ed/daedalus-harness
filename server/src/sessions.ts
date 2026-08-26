import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import type { WebSocket } from "ws";
import { db, journal as journalTable, sessions as sessionsTable } from "./db/index.js";
import { getAgent, resolveSpawn } from "./registry.js";
import type { Profile } from "./profiles.js";
import type { Project } from "./projects.js";
import { materializeProject } from "./materialize.js";

/** One NDJSON frame with its direction: agent->client or client->agent. */
export interface JournalEntry {
  d: "a" | "c";
  line: string;
  /** Agent->client request id. Replay skips requests another peer answered. */
  reqId?: string | number;
  /** Agent->client response. Ids are per-peer, so replay skips these; the
      synthetic _daedalus/turn_ended carries what a late peer actually needs. */
  res?: boolean;
}

/** One attached client. Several may share a session; the manager arbitrates. */
export interface Peer {
  ws: WebSocket;
  /** Agent-facing id -> the id this peer used, for requests it has in flight. */
  inflight: Map<string | number, string | number>;
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
  /** Frames ever journaled for this session. `cursor` is an index into this,
      not into any array — the log itself is a table (see appendJournal), so
      nothing about a long thread is held in memory any more. */
  journalCount: number;
  /** null = no live process (loaded from disk / retired); revive via respawn. */
  proc: ChildProcessWithoutNullStreams | null;
  /** Every attached client. Agent notifications fan out to all of them. */
  peers: Set<Peer>;
  /** Agent-facing request id -> the peer waiting for it, and enough of the
      request to tell the other peers what changed once the answer arrives. */
  routes: Map<string | number, { peer: Peer; method: string; modeId?: string }>;
  /** Open agent->client requests (permission prompts) -> the toolCallId that
      identifies them client-side, so peers can dismiss one another's dialogs. */
  openRequests: Map<string | number, string | undefined>;
  /** Counter behind the rewritten, session-unique client->agent request ids. */
  nextRequestId: number;
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
  promptActive: boolean;
  pendingPrompts: Set<string | number>;
  pendingNews: Set<string | number>;
}

/** How much of the agent's stderr to keep. Enough for a stack trace, bounded so
    a chatty agent can't grow a session without limit. */
const STDERR_TAIL_LINES = 200;

/** How long to wait after 'exit' for the agent's stdio to close before telling
    the peers anyway — a grandchild holding a pipe must not strand them. */
const EXIT_DRAIN_MS = 250;

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

export interface SessionEvents {
  /** Fired only while no client is attached — used for push notifications. */
  onPermissionRequest?: (session: Session) => void;
  /** The agent asked the user something (elicitation/create) with nobody
      attached to answer. Same push case as a permission, different sentence. */
  onElicitationRequest?: (session: Session) => void;
  /** `error` is the JSON-RPC error the prompt failed with, when it failed. */
  onTurnEnd?: (session: Session, error?: unknown) => void;
}

export class SessionManager {
  private sessions = new Map<string, Session>();

  constructor(private events: SessionEvents = {}, idleMinutes = 30) {
    // Sessions from before the last server restart: processes are gone, but the
    // thread identity remains and the client can revive it (respawn + load).
    // Their journals go with the processes — reviving replays the conversation
    // through session/load, which is the agent's account and the canonical one.
    db.delete(journalTable).run();
    for (const row of db.select().from(sessionsTable).all()) {
      this.sessions.set(row.id, {
        ...row,
        acpSessionId: row.acpSessionId ?? undefined,
        journalCount: 0,
        stderr: [],
        stderrCount: 0,
        stderrMark: 0,
        proc: null,
        peers: new Set(),
        routes: new Map(),
        openRequests: new Map(),
        nextRequestId: 1,
        detachedAt: Date.now(),
        exited: true,
        promptActive: false,
        pendingPrompts: new Set(),
        pendingNews: new Set(),
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

  /** Append one frame to the session's log.
   *
   * One INSERT per ACP frame. Under WAL with synchronous=NORMAL a commit is a
   * buffered append, not an fsync, so a streaming turn costs no more than the
   * array push it replaces — and unlike the array, nothing accumulates in RAM. */
  private appendJournal(session: Session, entry: JournalEntry): void {
    db.insert(journalTable)
      .values({
        sessionId: session.id,
        seq: session.journalCount++,
        dir: entry.d,
        // A request id may be a string or a number, so it is stored encoded.
        reqId: entry.reqId === undefined ? null : JSON.stringify(entry.reqId),
        res: entry.res ?? false,
        line: entry.line,
      })
      .run();
  }

  /** Frames from `cursor` on, in order. A range scan on (session_id, seq). */
  private journalFrom(session: Session, cursor: number): JournalEntry[] {
    return db
      .select()
      .from(journalTable)
      .where(and(eq(journalTable.sessionId, session.id), gte(journalTable.seq, cursor)))
      .orderBy(asc(journalTable.seq))
      .all()
      .map((row) => ({
        d: row.dir,
        line: row.line,
        ...(row.reqId !== null ? { reqId: JSON.parse(row.reqId) as string | number } : {}),
        ...(row.res ? { res: true } : {}),
      }));
  }

  /** Everything this session has journaled, and the cursor that follows it. */
  journal(id: string): { cursor: number; entries: JournalEntry[] } | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    return { cursor: session.journalCount, entries: this.journalFrom(session, 0) };
  }

  /** Journal lines for still-open agent->client requests that fall below
      `cursor` — the ones a reattaching client would otherwise never be sent. */
  private openRequestFrames(session: Session, cursor: number): string[] {
    if (cursor === 0 || session.openRequests.size === 0) return [];
    const ids = [...session.openRequests.keys()].map((id) => JSON.stringify(id));
    return db
      .select({ line: journalTable.line })
      .from(journalTable)
      .where(
        and(
          eq(journalTable.sessionId, session.id),
          inArray(journalTable.reqId, ids),
          lt(journalTable.seq, cursor),
        ),
      )
      .orderBy(asc(journalTable.seq))
      .all()
      .map((row) => row.line);
  }

  private clearJournal(session: Session): void {
    db.delete(journalTable).where(eq(journalTable.sessionId, session.id)).run();
    session.journalCount = 0;
  }

  /** Stop the process but keep the thread — the opposite of kill(). */
  private retire(session: Session): void {
    const proc = session.proc;
    session.proc = null; // flips the generation guard
    session.exited = true;
    this.clearJournal(session);
    session.promptActive = false;
    this.resetRouting(session);
    proc?.kill();
  }

  private spawnProc(profile: Profile, project: Project, model?: string, effort?: string) {
    const agent = getAgent(profile.agentId);
    if (!agent) throw new Error(`unknown agent: ${profile.agentId}`);
    materializeProject(project);
    const { command, args, env, cwd } = resolveSpawn(agent, profile, project, model, effort);
    return spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
  }

  /** Pipe a process into the session. Guards on session.proc so a respawned
      session's stale process can't write into the journal or close the WS. */
  private wire(session: Session, proc: ChildProcessWithoutNullStreams, profileName: string): void {
    let buffer = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      if (session.proc !== proc) return;
      buffer += chunk.toString("utf8");
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) this.onAgentLine(session, line);
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trimEnd();
      console.error(`[${session.id.slice(0, 8)}:${profileName}]`, text);
      if (session.proc !== proc) return;
      this.pushStderr(session, text);
    });
    // spawn() reports a missing binary, a bad cwd or a permissions problem
    // asynchronously — and an unhandled 'error' on a ChildProcess takes the
    // whole server down with it. Treat it as an immediate exit and tell the
    // client what the OS said, which is the only useful thing anyone has.
    proc.on("error", (error: NodeJS.ErrnoException) => {
      if (session.proc !== proc) return;
      const reason = `agent failed to start: ${error.code ?? error.name} — ${error.message}`;
      console.error(`[${session.id.slice(0, 8)}:${profileName}]`, reason);
      this.pushStderr(session, reason);
      session.exited = true;
      session.proc = null;
      this.failPendingRequests(session, reason);
      this.closePeers(session, 4001, truncateReason(reason));
    });
    // 'exit' fires the moment the process is gone, but stderr written just
    // before it dies is often still in flight — and that last line is usually
    // the whole explanation. 'close' is the event that waits for the pipes, so
    // the peers are told there, with a timer in case a grandchild holds a pipe
    // open and 'close' never comes.
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled || session.proc !== proc) return;
      settled = true;
      session.exited = true;
      // Anything the client was waiting on will never be answered now. Without
      // this, a prompt sent to a dying agent hangs until the socket closes and
      // the transcript just stops mid-turn.
      const how = code !== null ? `exit code ${code}` : `signal ${signal}`;
      this.failPendingRequests(session, `The agent process ended (${how}).`);
      this.closePeers(session, 4001, truncateReason(`agent exited (${code ?? signal ?? "unknown"})`));
    };
    proc.on("exit", (code, signal) => {
      if (session.proc !== proc) return;
      session.exited = true;
      setTimeout(() => finish(code, signal), EXIT_DRAIN_MS).unref();
    });
    proc.on("close", finish);
  }

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
   * Attach the agent's own output to a JSON-RPC error before it reaches the
   * client. "Internal error" is a code, not an explanation; the explanation was
   * on stderr, and this is the only place that has both.
   */
  private enrichError(session: Session, error: unknown): unknown {
    const stderr = this.stderrSinceMark(session);
    if (!stderr || !error || typeof error !== "object") return error;
    const { data } = error as { data?: unknown };
    const merged =
      data && typeof data === "object" && !Array.isArray(data)
        ? { ...(data as Record<string, unknown>), stderr }
        : data === undefined
          ? { stderr }
          : { details: data, stderr };
    return { ...(error as Record<string, unknown>), data: merged };
  }

  /** Answer every in-flight client->agent request with a JSON-RPC error, so the
      client's promises reject with a reason instead of hanging forever. */
  private failPendingRequests(session: Session, reason: string): void {
    const stderr = this.stderrSinceMark(session) || session.stderr.join("\n").trim();
    for (const [agentId, route] of session.routes) {
      const clientId = route.peer.inflight.get(agentId);
      route.peer.inflight.delete(agentId);
      if (clientId === undefined) continue;
      route.peer.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: clientId,
          error: {
            code: -32603,
            message: reason,
            // The agent's last words. When an agent dies mid-prompt this is
            // usually the stack trace that explains why.
            data: stderr ? { details: stderr } : undefined,
          },
        }),
      );
    }
    session.routes.clear();
    session.pendingPrompts.clear();
    session.pendingNews.clear();
    session.promptActive = false;
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
  ): Session {
    const proc = this.spawnProc(profile, project, model, effort);
    const session: Session = {
      id: id ?? randomUUID(),
      profileId: profile.id,
      projectId: project.id,
      agentId: profile.agentId,
      model: model || profile.defaultModel || "",
      effort: effort ?? "",
      title: "New thread",
      createdAt: Date.now(),
      journalCount: 0,
      stderr: [],
      stderrCount: 0,
      stderrMark: 0,
      proc,
      peers: new Set(),
      routes: new Map(),
      openRequests: new Map(),
      nextRequestId: 1,
      detachedAt: Date.now(),
      deletedAt: null,
      exited: false,
      promptActive: false,
      pendingPrompts: new Set(),
      pendingNews: new Set(),
    };
    this.sessions.set(session.id, session);
    // Before wire(): the journal rows reference this one, so the session has to
    // exist by the time the agent's first frame arrives.
    this.persist(session);
    this.wire(session, proc, profile.name);
    return session;
  }

  /**
   * Swap the session's agent process for one spawned with a different
   * profile/model/effort (same project) — also the revive path for sessions
   * whose process is gone (idle-retired or pre-restart). The journal is
   * reset — the client re-handshakes and restores the conversation via ACP
   * session/load, and that replay becomes the new canonical journal.
   */
  respawn(id: string, profile: Profile, project: Project, model?: string, effort?: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error("unknown session");
    if (session.deletedAt !== null) throw new Error("session deleted");
    const oldProc = session.proc;
    const proc = this.spawnProc(profile, project, model, effort);
    session.proc = proc; // flips the generation guard before the old proc dies
    if (!session.exited) oldProc?.kill();
    session.exited = false;
    session.profileId = profile.id;
    session.agentId = profile.agentId;
    session.model = model || profile.defaultModel || "";
    session.effort = effort ?? "";
    this.clearJournal(session);
    session.promptActive = false;
    this.resetRouting(session);
    this.wire(session, proc, profile.name);
    this.persist(session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /**
   * Record a model/effort change the agent accepted over ACP. No process is
   * touched — the running agent already made the change. This only keeps the
   * record that `respawn` rebuilds the child's env from in step with what the
   * session is actually running, so reviving a retired thread does not quietly
   * put it back on the model the user switched away from.
   */
  setSpawnState(id: string, next: { model?: string; effort?: string }): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (next.model !== undefined) session.model = next.model;
    if (next.effort !== undefined) session.effort = next.effort;
    this.persist(session);
    return true;
  }

  /** The agent's recent stderr, for a client that wants to see why a thread is
      misbehaving. Read-only; the server's console gets it either way. */
  stderrTail(id: string): string[] {
    return this.sessions.get(id)?.stderr ?? [];
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
      promptActive: s.promptActive,
      cursor: s.journalCount,
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
    const proc = session.proc;
    session.proc = null;
    if (!session.exited) proc?.kill();
    this.sessions.delete(id);
    // ON DELETE CASCADE takes the journal rows with it.
    db.delete(sessionsTable).where(eq(sessionsTable.id, id)).run();
    return true;
  }

  /** A new process (or none) invalidates every in-flight id and open request —
      and its predecessor's output, which explains nothing about the new one. */
  private resetRouting(session: Session): void {
    session.routes.clear();
    session.openRequests.clear();
    session.nextRequestId = 1;
    session.pendingPrompts.clear();
    session.pendingNews.clear();
    session.stderr = [];
    session.stderrCount = 0;
    session.stderrMark = 0;
    for (const peer of session.peers) peer.inflight.clear();
  }

  private closePeers(session: Session, code: number, reason: string): void {
    for (const peer of session.peers) peer.ws.close(code, reason);
  }

  private broadcast(session: Session, line: string, except?: Peer): void {
    for (const peer of session.peers) if (peer !== except) peer.ws.send(line);
  }

  /** Journal + fan out a server-synthesized agent->client notification. */
  private emitToClient(session: Session, msg: object): void {
    const line = JSON.stringify(msg);
    this.appendJournal(session, { d: "a", line });
    this.broadcast(session, line);
  }

  /** Fan out a synthesized notification WITHOUT journaling it — for frames that
      exist only to sync peers with each other, where the journal already holds
      the underlying event and a replay would double-count it. */
  private notifyPeers(session: Session, msg: object, except?: Peer): void {
    if (session.peers.size === 0) return;
    this.broadcast(session, JSON.stringify(msg), except);
  }

  /** A server-side subsystem (the task tailer) telling a thread's live peers
      something. Not journaled: the source is durable on its own and re-read at
      watch time, so replaying these would double-count every event. */
  notify(id: string, method: string, params: unknown): void {
    const session = this.sessions.get(id);
    if (session) this.notifyPeers(session, { jsonrpc: "2.0", method, params });
  }

  /** Attach a WebSocket; replays agent frames after `cursor`, then pipes live.
      Returns null on success, or why it refused — that string becomes the close
      reason, and "unknown session" for all three cases was a lie in two. */
  attach(id: string, ws: WebSocket, cursor = 0): string | null {
    const session = this.sessions.get(id);
    if (!session) return "no such thread on this server";
    if (session.deletedAt !== null) return "this thread is in the trash";
    if (session.exited) return "this thread has no running agent — revive it first";
    const peer: Peer = { ws, inflight: new Map() };
    session.peers.add(peer);
    session.detachedAt = null;
    for (const entry of this.journalFrom(session, cursor)) {
      if (entry.d !== "a") continue;
      // Responses carry another peer's ids — meaningless here, and the SDK
      // would warn about an unknown id. Requests another peer already answered
      // would raise a dead permission dialog. Notifications are the replay.
      if (entry.res) continue;
      if (entry.reqId !== undefined && !session.openRequests.has(entry.reqId)) continue;
      ws.send(entry.line);
    }
    // An unanswered agent request is replayed whatever the cursor says. A
    // client that reloaded reattaches from the END of the log, so the
    // permission prompt it was showing sits below its cursor and the loop above
    // skips it — leaving the agent blocked on a question with nothing on screen
    // to answer it. Anything at or above the cursor already went out, so only
    // the older ones are resent here.
    for (const line of this.openRequestFrames(session, cursor)) ws.send(line);
    ws.on("message", (data) => {
      const line = data.toString();
      this.onClientLine(session, peer, line);
    });
    ws.on("close", () => {
      session.peers.delete(peer);
      // Responses to this peer's in-flight requests can no longer be delivered.
      for (const agentId of peer.inflight.keys()) session.routes.delete(agentId);
      if (session.peers.size === 0) session.detachedAt = Date.now();
    });
    return null;
  }

  private onAgentLine(session: Session, line: string): void {
    let turnEndedUsage: unknown = undefined;
    /** The prompt's JSON-RPC error, when the turn ended by failing. */
    let turnEndedError: unknown = undefined;
    const entry: JournalEntry = { d: "a", line };
    // Where this frame goes: one peer for a response, everyone otherwise.
    let target: Peer | undefined;
    let out = line;
    try {
      const msg = JSON.parse(line);
      if (msg.method !== undefined && msg.id !== undefined) {
        // Agent asks the client something (permission, fs, terminal). Every peer
        // sees it; the first answer wins and the rest are told to dismiss.
        entry.reqId = msg.id;
        // Both question-shaped requests name the tool call they belong to, in
        // their own place: the permission nests it under `toolCall`, the
        // elicitation carries it flat. Either way it is what tells the other
        // peers WHICH card the first answer just closed.
        session.openRequests.set(
          msg.id,
          msg.params?.toolCall?.toolCallId ?? msg.params?.toolCallId,
        );
        if (session.peers.size === 0) {
          if (msg.method === "session/request_permission") this.events.onPermissionRequest?.(session);
          else if (msg.method === "elicitation/create") this.events.onElicitationRequest?.(session);
        }
      } else if (msg.method === undefined && msg.id !== undefined) {
        entry.res = true;
        // The agent's stderr is spliced in once, here, and everything
        // downstream — the requesting peer, the turn_ended fanout, the journal
        // a later reload rebuilds from — carries the same enriched error.
        if (msg.error) {
          msg.error = this.enrichError(session, msg.error);
          entry.line = JSON.stringify(msg);
        }
        if (session.pendingNews.delete(msg.id) && msg.result?.sessionId) {
          session.acpSessionId = msg.result.sessionId;
          this.persist(session);
        }
        if (session.pendingPrompts.delete(msg.id) && session.pendingPrompts.size === 0) {
          session.promptActive = false;
          turnEndedUsage = msg.result?.usage ?? null;
          // Only the peer that sent the prompt gets the error response; the
          // others would see a turn that ended for no visible reason, so it
          // rides along on the fanout too.
          if (msg.error) turnEndedError = msg.error;
        }
        // Restore the id the requesting peer used and send it back only there;
        // ids are rewritten on the way in so two peers can't collide.
        const route = session.routes.get(msg.id);
        if (route) {
          session.routes.delete(msg.id);
          const clientId = route.peer.inflight.get(msg.id);
          route.peer.inflight.delete(msg.id);
          target = route.peer;
          out = JSON.stringify({ ...msg, id: clientId });
          // Session settings are shared state: only the peer that changed them
          // sees the response, so hand the result to everyone else.
          const configOptions = msg.result?.configOptions;
          if (route.method === "session/set_mode" || configOptions) {
            this.notifyPeers(
              session,
              {
                jsonrpc: "2.0",
                method: "_daedalus/peer_settings",
                params: { sessionId: session.acpSessionId, modeId: route.modeId, configOptions },
              },
              route.peer,
            );
          }
        }
      }
    } catch {
      // not JSON — pipe through untouched
    }
    this.appendJournal(session, entry);
    if (target) target.ws.send(out);
    else if (!entry.res) this.broadcast(session, out);
    if (turnEndedUsage !== undefined) {
      // The prompt's requester may be a dead connection (client reattached
      // mid-turn) or one of several peers: a synthetic notification carries
      // turn end + usage to everyone listening now, and into the journal for
      // later replays. Emitted after the response so live and replay order match.
      this.emitToClient(session, {
        jsonrpc: "2.0",
        method: "_daedalus/turn_ended",
        params: { sessionId: session.acpSessionId, usage: turnEndedUsage, error: turnEndedError },
      });
      if (session.peers.size === 0) this.events.onTurnEnd?.(session, turnEndedError);
    }
  }

  private onClientLine(session: Session, peer: Peer, line: string): void {
    let out = line;
    try {
      const msg = JSON.parse(line);
      if (msg.method !== undefined && msg.id !== undefined) {
        // Client->agent request. Every peer numbers its own requests from 1, so
        // rewrite to a session-unique id and remember who to route the reply to.
        const agentId = `d${session.nextRequestId++}`;
        session.routes.set(agentId, { peer, method: msg.method, modeId: msg.params?.modeId });
        peer.inflight.set(agentId, msg.id);
        if (msg.method === "session/new") session.pendingNews.add(agentId);
        /* A load makes the agent restate the ENTIRE conversation as fresh
           session/update notifications, so everything already journaled is
           about to be said again. Without dropping it the log grows by a whole
           history per load — and a client rebuilding from it renders the thread
           once per replay, which is exactly what two peers each loading once
           produced here. Other peers' cursors go stale, which costs nothing:
           they are live and receiving these frames directly, and a reconnect
           re-reads the cursor from the journal endpoint anyway. */
        if (msg.method === "session/load") this.clearJournal(session);
        if (msg.method === "session/prompt") {
          session.pendingPrompts.add(agentId);
          // First prompt of a turn marks where this turn's stderr starts, so a
          // failure is explained by its own output and not the last one's.
          if (!session.promptActive) session.stderrMark = session.stderrCount;
          session.promptActive = true;
          const text = (msg.params?.prompt ?? [])
            .filter((b: { type: string }) => b.type === "text")
            .map((b: { text: string }) => b.text)
            .join(" ")
            .trim();
          if (text && session.title === "New thread") {
            session.title = text.slice(0, 60);
            this.persist(session);
          }
          // The other peers never see this request (it goes to the agent, not
          // to them), so tell them a turn started and whose words started it.
          // Not journaled: the d:"c" entry below is what replays rebuild from.
          if (text) {
            this.notifyPeers(
              session,
              {
                jsonrpc: "2.0",
                method: "_daedalus/peer_prompt",
                params: { sessionId: session.acpSessionId, text },
              },
              peer,
            );
          }
        }
        out = JSON.stringify({ ...msg, id: agentId });
      } else if (msg.method === undefined && msg.id !== undefined) {
        // A peer answering an agent request. First answer wins; a slower peer's
        // duplicate would be a second response to one JSON-RPC id, so drop it.
        if (!session.openRequests.has(msg.id)) return;
        const toolCallId = session.openRequests.get(msg.id);
        session.openRequests.delete(msg.id);
        this.notifyPeers(
          session,
          {
            jsonrpc: "2.0",
            method: "_daedalus/request_answered",
            params: { sessionId: session.acpSessionId, toolCallId },
          },
          peer,
        );
      }
    } catch {
      // not JSON — pipe through untouched
    }
    this.appendJournal(session, { d: "c", line: out });
    if (!session.exited) session.proc?.stdin.write(out + "\n");
  }
}
