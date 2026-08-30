import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { WebSocket } from "ws";
import type * as acp from "@agentclientprotocol/sdk";
import { db, sessionEvents as eventsTable, sessions as sessionsTable } from "./db/index.js";
import { SESSION_LINKS, emptyLinks, linksOf, readLinks, unionLinks, writeLinks, type LinkSet } from "./db/links.js";
import { materializeWorkspace } from "./materialize.js";
import { mcpServers as mcpLibrary } from "./library.js";
import type { Profile } from "./profiles.js";
import type { Project } from "./projects.js";
import { getProfile } from "./profiles.js";
import { getProject } from "./projects.js";
import { loadConfig } from "./config.js";
import { WEB_SEARCH_SERVER_NAME, toMcpServerEnv } from "./websearch.js";
import { recordWebSearchUsage } from "./websearch-usage.js";
import { KNOWLEDGE_SERVER_NAME, toKnowledgeServerEnv } from "./knowledge-db.js";
import { AcpBridge, spawnAgent, toWireError, type BridgeHost } from "./acp-bridge.js";
import {
  EARLIER_PAGE_STEPS,
  JOURNALED_EVENTS,
  REPLAY_CHUNK_BYTES,
  REPLAY_CHUNK_SIZE,
  type EarlierPage,
  type HistoryLost,
  type JournaledEvent,
  type PromptReply,
  type ThreadCommand,
  type ThreadEvent,
  type WireError,
} from "./protocol.js";
import {
  clearQueue,
  combineQueued,
  enqueue,
  listQueue,
  removeQueued,
  removeQueuedMany,
  updateQueued,
} from "./queue.js";

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
  /** Live spawn inputs. Persisted threads resolve them again on revive. */
  profile: Profile | null;
  project: Project | null;
  model: string;
  effort: string;
  title: string;
  /** What this thread was started with, on top of its profile's links —
      picked on the draft, persisted with the row (db/links.ts), and what a
      revive spawns with again. The agent sees the union of both:
      `effectiveLinks`. */
  links: LinkSet;
  /** The thread's recorded conversation — what a revive calls `session/load`
      with, and the field that is written to the database. */
  acpSessionId?: string;
  /** Whether `acpSessionId` is still unproven: an id `session/new` returned
      that no turn has committed to. It is written down all the same — a thread
      whose process died mid-first-turn used to keep *nothing*, which left the
      agent's rollout orphaned on disk and the thread permanently blank — but it
      is the only id a later `session/new` may overwrite, and a load it refuses
      is reported as nothing at all rather than as a lost history. */
  acpSessionProvisional: boolean;
  /** The session the *running* process is on. Usually the same string; they
      differ for exactly as long as a proven id is being kept against an
      unproven one — a thread whose `session/load` was refused and fell back.
      Not persisted; goes with the process. */
  liveAcpSessionId: string | null;
  /** Why this process has no conversation in it, when that is the case. Set by
      the bridge's failed `session/load`, handed to every peer on attach, and
      cleared by the next spawn — the same lifetime as the process it describes. */
  historyLost: HistoryLost | null;
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
  /** Tail of this thread's in-flight "send now" chain — cancel the turn, wait
      for it to settle, send. While it is set the auto-drain stands down, so
      the items it is about to send cannot also be drained by the turn it just
      cancelled. Null when idle. */
  queueChain: Promise<unknown> | null;
  /** True only while this process has the profile-provided web-search MCP. */
  websearchViaMcp: boolean;
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
/**
 * The linked library rows as what `session/new` takes. A `builtin` row is a
 * handle, not a definition: it resolves here, at spawn, to the harness's own
 * server with live config and the thread's project in its env — and to
 * nothing when that server cannot run (search unconfigured), because a linked
 * tool that cannot answer is worse than an absent one.
 */
export function mcpServersFor(
  links: Pick<LinkSet, "mcpServerIds">,
  project: Pick<Project, "id">,
  config: ReturnType<typeof loadConfig>,
): acp.McpServer[] {
  const linked = new Set(links.mcpServerIds);
  const out: acp.McpServer[] = [];
  for (const s of mcpLibrary.list()) {
    if (!linked.has(s.id)) continue;
    if (s.type === "builtin") {
      const built = s.builtin === "web-search" ? websearchServer(config) : knowledgeServer(project);
      if (built) out.push(built);
    } else if (s.type === "http") {
      out.push({ type: "http", name: s.name, url: s.url, headers: s.headers });
    } else {
      out.push({ name: s.name, command: s.command, args: s.args, env: s.env });
    }
  }
  return out;
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
 * The harness's own `web-search` MCP server, synthesized from
 * `data/config.json` — the library row that links it stores nothing, so the
 * credentials come live and a config edit is picked up on the next
 * session/new or respawn. Null when search is not configured: a thread must
 * not advertise tools that cannot answer, however it was linked.
 */
export function websearchServer(config: ReturnType<typeof loadConfig>): StdioMcpServer | null {
  const ws = config.webSearch;
  if (!ws) return null;
  return harnessMcpServer(WEB_SEARCH_SERVER_NAME, "websearch-mcp", toMcpServerEnv(ws));
}

/**
 * A harness-owned stdio MCP server as the agent will spawn it. The script sits
 * beside this module — `dist/` when built, `src/` under tsx (`pnpm dev`,
 * `pnpm start`, the tests) — and under tsx it is a `.ts` file with no `.js`
 * next to it, so node must be handed tsx's CLI to run it, exactly as pnpm runs
 * the server itself. Blindly appending `.js` pointed every dev server at a
 * file that did not exist, and the agent reported it as the MCP server
 * closing the connection before `initialize` answered.
 */
function harnessMcpServer(name: string, script: string, env: StdioMcpServer["env"]): StdioMcpServer {
  const here = fileURLToPath(import.meta.url);
  const dir = dirname(here);
  const args = here.endsWith(".ts")
    ? [fileURLToPath(import.meta.resolve("tsx/cli")), join(dir, `${script}.ts`)]
    : [join(dir, `${script}.js`)];
  return { name, command: process.execPath, args, env };
}

/** The harness's own `knowledge` MCP server. The project's id is injected
    into the server's env so every query is scoped to the workspace this
    session runs in — which is why it cannot be a stored command. */
export function knowledgeServer(project: Pick<Project, "id">): StdioMcpServer {
  return harnessMcpServer(KNOWLEDGE_SERVER_NAME, "knowledge-mcp", toKnowledgeServerEnv(project.id));
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

  constructor(
    private events: SessionEvents = {},
    idleMinutes = 30,
    private journalRetentionDays = 30,
  ) {
    /* Sessions from before the last server restart: the processes are gone, but
       the thread identity remains and the client can revive it (respawn +
       session/load), which is the agent's account and the canonical one.

       Their event logs used to be deleted right here, which enforced that rule
       by making the journal impossible to mistake for the conversation. It also
       meant a thread could not be *read* without spawning an agent to re-narrate
       it — several seconds and a live child process to scroll back through
       yesterday's work. Keeping the rows separates the two concerns instead:
       reading is served from the log, resuming still goes through the agent, and
       `respawnNow` clears the log before the load refills it so the two can
       never be stitched together. */
    this.pruneJournals();
    this.reload();

    const idleMs = idleMinutes * 60_000;
    setInterval(() => {
      for (const s of this.sessions.values()) {
        if (!s.exited && s.peers.size === 0 && s.detachedAt && Date.now() - s.detachedAt > idleMs) {
          this.retire(s);
        }
      }
    }, 60_000).unref();
    // Retention is checked at boot and then hourly, so a server that runs for
    // months does not accumulate every thread it ever ran.
    setInterval(() => this.pruneJournals(), 3_600_000).unref();
  }

  /**
   * (Re)build the in-memory map from the sessions table.
   *
   * At boot every row is process-less. Called again after a backup import,
   * where some threads may be live: one with a running process is left exactly
   * as it is (the import retired every thread it touched first, so a live one
   * is by definition one the bundle did not name), a process-less one is
   * rebuilt from its row — its peers, if any are reading the archive, are
   * closed so they reconnect to the new log — and one whose row is gone
   * (`replace` mode) is dropped.
   */
  reload(): void {
    this.flushWrites();
    const counts = new Map(
      db
        .select({ sessionId: eventsTable.sessionId, next: sql<number>`max(${eventsTable.seq}) + 1` })
        .from(eventsTable)
        .groupBy(eventsTable.sessionId)
        .all()
        .map((row) => [row.sessionId, row.next] as const),
    );
    const rows = db.select().from(sessionsTable).all();
    const links = readLinks(SESSION_LINKS, rows.map((r) => r.id));
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.id);
      const current = this.sessions.get(row.id);
      if (current && !current.exited) continue;
      if (current) this.closePeers(current, 4000, "session reloaded");
      this.sessions.set(row.id, {
        ...row,
        links: links.get(row.id) ?? emptyLinks(),
        acpSessionId: row.acpSessionId ?? undefined,
        profile: null,
        project: null,
        liveAcpSessionId: null,
        historyLost: null,
        /* Picked up where the last process left it, because the rows it wrote
           are still there. Restoring this is not bookkeeping — `appendEvent`
           stamps from it and the (session_id, seq) index is unique, so a count
           that restarted at 0 would collide on the first event of the revive. */
        eventCount: counts.get(row.id) ?? 0,
        stderr: [],
        stderrCount: 0,
        stderrMark: 0,
        proc: null,
        bridge: null,
        peers: new Set(),
        detachedAt: Date.now(),
        exited: true,
        respawnChain: null,
        queueChain: null,
        // Belongs to a process, and there is none until this thread is revived.
        websearchViaMcp: false,
      });
    }
    for (const [id, session] of this.sessions) {
      if (seen.has(id)) continue;
      this.closePeers(session, 4000, "session purged");
      this.retire(session);
      this.sessions.delete(id);
    }
  }

  /**
   * Stop every running process (or only the named threads') and detach their
   * peers, ahead of a backup import that is about to rewrite their rows. The
   * threads stay — a retired thread revives on the next send, as usual.
   */
  retireAll(ids?: Iterable<string>): void {
    const targets = ids ? [...ids].map((id) => this.sessions.get(id)).filter((s): s is Session => Boolean(s)) : [...this.sessions.values()];
    for (const session of targets) {
      this.closePeers(session, 4000, "session reloaded");
      if (!session.exited) this.retire(session);
    }
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
        acpSessionProvisional: s.acpSessionProvisional,
        createdAt: s.createdAt,
        deletedAt: s.deletedAt,
      };
      db.insert(sessionsTable).values(values).onConflictDoUpdate({
        target: sessionsTable.id,
        set: values,
      }).run();
    }
  }

  /** The thread's own links are written once, at create — they do not change
      with a title sniff or a model switch, so `persist` leaves them alone. */
  private persistLinks(session: Session): void {
    db.transaction((tx) => writeLinks(tx, SESSION_LINKS, session.id, session.links));
    // What the tables kept (a stale id links nothing) is what the thread has.
    session.links = linksOf(SESSION_LINKS, session.id);
  }

  /**
   * Everything a thread's agent is given: the profile's links (the provider
   * setup) and the thread's own picks, as one set. Profile first so a server
   * the profile names keeps its position; duplicates collapse. The project
   * contributes nothing — it is the directory, not the toolset.
   */
  effectiveLinks(session: Session, profile = session.profile): LinkSet {
    return unionLinks(profile, session.links);
  }

  /**
   * Write skills and commands into the project's cwd for the thread about to
   * spawn — and for every other thread live in the same cwd, because they
   * share it. The materializer sweeps what it does not write, so the set it is
   * handed is the union over all of them; a thread being spawned counts as
   * live already, and a retired one has no process to lose anything.
   */
  private materializeFor(session: Session, profile: Profile, project: Project): void {
    const sets: LinkSet[] = [this.effectiveLinks(session, profile)];
    for (const other of this.sessions.values()) {
      if (other === session || other.exited || other.deletedAt !== null) continue;
      if (other.project?.cwd !== project.cwd) continue;
      sets.push(this.effectiveLinks(other));
    }
    materializeWorkspace(project.cwd, unionLinks(...sets));
  }

  // ---- the event log ----

  /**
   * Journaled events not yet written to SQLite.
   *
   * The seq is assigned synchronously in `appendEvent` and the row is written a
   * tick later, which is safe because nothing reads the log through anything but
   * `flushWrites` first — and worth doing because a streaming turn is thousands
   * of events. One INSERT each is one transaction each: cheap individually under
   * WAL, but the surrounding work (building the statement, serializing the
   * payload) is per-event too, and a turn's worth of it lands on the same tick
   * as the fan-out the browser is waiting for. Batched, a turn is a handful of
   * commits and the serialization happens off the emit path.
   *
   * The exposure is one tick of events on a hard crash. That was already the
   * bargain (`synchronous = NORMAL` trades the fsync for the OS's word), and the
   * journal is a cache for reading, not the conversation — the agent still has
   * that, and a revive re-reads it.
   */
  private pendingWrites: (typeof eventsTable.$inferInsert)[] = [];
  private flushScheduled = false;

  /** Append one event to the session's log and stamp it with its seq. */
  private appendEvent(session: Session, event: ThreadEvent): ThreadEvent {
    const seq = session.eventCount++;
    const stamped = { ...event, seq } as ThreadEvent;
    this.pendingWrites.push({
      sessionId: session.id,
      seq,
      kind: event.ev,
      payload: stamped,
      at: Date.now(),
    });
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      setImmediate(() => this.flushWrites()).unref();
    }
    return stamped;
  }

  /**
   * Land the buffered rows. Called before every read of the log and before every
   * delete from it, so no caller can observe a journal that is missing its most
   * recent events — and on the next tick after an append, so an idle server is
   * never holding one.
   */
  private flushWrites(): void {
    this.flushScheduled = false;
    if (this.pendingWrites.length === 0) return;
    const rows = this.pendingWrites;
    this.pendingWrites = [];
    try {
      db.transaction((tx) => {
        for (const row of rows) tx.insert(eventsTable).values(row).run();
      });
    } catch {
      /* One bad row must not cost every other thread its tick. A batch is a
         transaction, so a single failure rolls the whole thing back — and the
         rows in it belong to whatever threads happened to be streaming at the
         same moment, which is the wrong blast radius for a fault that is always
         about one session. The usual cause is a thread purged between the
         append and this flush: its rows went with it (the foreign key cascades)
         and nothing is owed an error, because the log they belonged to no
         longer exists. So retry row by row and report only what actually fails.
         A throw here would be an uncaught exception — this runs on a
         setImmediate, with no caller to catch it. */
      for (const row of rows) {
        try {
          db.insert(eventsTable).values(row).run();
        } catch (error) {
          console.error(
            `[journal] dropped event ${row.seq} of session ${row.sessionId.slice(0, 8)}`,
            error,
          );
        }
      }
    }
  }

  /** Events in `[from, from + limit)`, in order. A range scan on (session_id,
      seq). Parsed — the replay path deliberately does not use this; see
      `replayFrames`. */
  private eventsFrom(session: Session, from: number, limit?: number): JournaledEvent[] {
    this.flushWrites();
    const query = db
      .select({ payload: eventsTable.payload })
      .from(eventsTable)
      .where(and(eq(eventsTable.sessionId, session.id), gte(eventsTable.seq, from)))
      .orderBy(asc(eventsTable.seq));
    const rows = limit === undefined ? query.all() : query.limit(limit).all();
    return rows.map((row) => row.payload as JournaledEvent);
  }

  /**
   * The replay, as frames ready to put on a socket.
   *
   * Two things are deliberate here. The rows come back as **text**, not as
   * parsed objects: the payload column already holds exactly the JSON the
   * browser needs, so parsing it to re-serialize it once per peer is work with
   * no reader. And the scan is **paged**, so a long thread's replay is bounded
   * by a page rather than by the thread — `.all()` over the whole range put the
   * entire transcript in memory at attach time, which is the cost the table was
   * introduced to remove, merely moved from steady-state to connect-time.
   *
   * A frame is cut on whichever budget runs out first, count or bytes. Bytes is
   * the one that matters for a thread full of terminal output or large diffs;
   * count is what keeps a chatty-but-small thread from being one frame.
   */
  private *replayFrames(session: Session, from: number, batch: boolean): Generator<string> {
    this.flushWrites();
    let cursor = from;
    let frame: string[] = [];
    let bytes = 0;
    const cut = function* (): Generator<string> {
      if (frame.length === 0) return;
      yield `{"ev":"replay","events":[${frame.join(",")}]}`;
      frame = [];
      bytes = 0;
    };
    for (;;) {
      const page = db
        .select({ payload: sql<string>`cast(${eventsTable.payload} as text)` })
        .from(eventsTable)
        .where(and(eq(eventsTable.sessionId, session.id), gte(eventsTable.seq, cursor)))
        .orderBy(asc(eventsTable.seq))
        .limit(REPLAY_CHUNK_SIZE)
        .all();
      if (page.length === 0) break;
      cursor += page.length;
      for (const row of page) {
        // A client that did not ask for bulk gets the events one at a time; it
        // would drop a `replay` frame it does not know, and `caught_up` rides
        // inside that frame, so the thread would never finish connecting.
        if (!batch) {
          yield row.payload;
          continue;
        }
        if (frame.length >= REPLAY_CHUNK_SIZE || bytes + row.payload.length > REPLAY_CHUNK_BYTES) {
          yield* cut();
        }
        frame.push(row.payload);
        bytes += row.payload.length;
      }
      if (page.length < REPLAY_CHUNK_SIZE) break;
    }
    yield* cut();
  }

  /* ---- step-paging ---- */

  /** A **step** is a turn, and a turn begins at its journaled `turn_started` —
      the one structural event the server interprets without parsing an update
      payload. `from`/`before` are therefore always the seq of a `turn_started`,
      so a replay or a page is whole turns, never a cut inside one. */

  /** The `turn_started` seqs strictly before `before`, newest first, capped at
      `limit`. */
  private turnStartsBefore(session: Session, before: number, limit: number): number[] {
    this.flushWrites();
    return db
      .select({ seq: eventsTable.seq })
      .from(eventsTable)
      .where(and(
        eq(eventsTable.sessionId, session.id),
        eq(eventsTable.kind, "turn_started"),
        lt(eventsTable.seq, before),
      ))
      .orderBy(desc(eventsTable.seq))
      .limit(limit)
      .all()
      .map((row) => row.seq);
  }

  /** How many turns the log holds. */
  private turnCount(session: Session): number {
    this.flushWrites();
    const row = db
      .select({ count: sql<number>`count(*)` })
      .from(eventsTable)
      .where(and(eq(eventsTable.sessionId, session.id), eq(eventsTable.kind, "turn_started")))
      .get();
    return Number(row?.count ?? 0);
  }

  /** How many turns lie before `before`. */
  private countTurnsBefore(session: Session, before: number): number {
    this.flushWrites();
    const row = db
      .select({ count: sql<number>`count(*)` })
      .from(eventsTable)
      .where(and(
        eq(eventsTable.sessionId, session.id),
        eq(eventsTable.kind, "turn_started"),
        lt(eventsTable.seq, before),
      ))
      .get();
    return Number(row?.count ?? 0);
  }

  /** The seq of the `index`-th `turn_started` (0-based, oldest first), or null
      when the log has fewer than `index + 1` turns. */
  private turnStartAt(session: Session, index: number): number | null {
    this.flushWrites();
    const row = db
      .select({ seq: eventsTable.seq })
      .from(eventsTable)
      .where(and(eq(eventsTable.sessionId, session.id), eq(eventsTable.kind, "turn_started")))
      .orderBy(asc(eventsTable.seq))
      .offset(index)
      .limit(1)
      .get();
    return row?.seq ?? null;
  }

  /** The page of whole turns immediately before `before`, plus how many turns
      are still behind it. Empty when `before` is already the head of the log. */
  private earlierPage(session: Session, before: number): EarlierPage {
    if (before <= 0) return { events: [], earlier: 0 };
    const starts = this.turnStartsBefore(session, before, EARLIER_PAGE_STEPS).reverse();
    if (starts.length === 0) return { events: [], earlier: 0 };
    const first = starts[0];
    return {
      events: this.eventsFrom(session, first, before - first),
      earlier: this.countTurnsBefore(session, first),
    };
  }

  private clearEvents(session: Session): void {
    /* Drop this session's buffered rows rather than writing them: they belong
       to the log being thrown away, and landing them after the delete would
       leave orphans that the next append then collides with on seq. */
    this.pendingWrites = this.pendingWrites.filter((row) => row.sessionId !== session.id);
    db.delete(eventsTable).where(eq(eventsTable.sessionId, session.id)).run();
    session.eventCount = 0;
  }

  /**
   * Drop the archives of retired threads nobody has touched in a while.
   *
   * Only threads with **no live process**, and only whole logs. A running
   * thread's log is what its peers are attached to and what a resume indexes
   * into; trimming the head of one would hand the next full attach a transcript
   * that silently begins in the middle, which is worse than the rebuild it saves.
   * Dropping a whole archive is safe because it is only ever a cache: the thread
   * falls back to reviving through `session/load`, exactly as it did before any
   * of this existed.
   */
  private pruneJournals(): void {
    const days = this.journalRetentionDays;
    if (days < 0) return;
    this.flushWrites();
    const cutoff = days === 0 ? Date.now() : Date.now() - days * 86_400_000;
    const live = [...this.sessions.values()].filter((s) => !s.exited).map((s) => s.id);
    const stale = db
      .select({ sessionId: eventsTable.sessionId, newest: sql<number>`max(${eventsTable.at})` })
      .from(eventsTable)
      .groupBy(eventsTable.sessionId)
      .having(sql`max(${eventsTable.at}) < ${cutoff}`)
      .all()
      .map((row) => row.sessionId)
      .filter((id) => !live.includes(id));
    if (stale.length === 0) return;
    db.delete(eventsTable).where(inArray(eventsTable.sessionId, stale)).run();
    for (const id of stale) {
      const session = this.sessions.get(id);
      if (session) session.eventCount = 0;
    }
    console.log(`[journal] dropped ${stale.length} retired thread archive(s)`);
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
    if (session.websearchViaMcp && event.ev === "update" && !event.historyReplay) {
      recordWebSearchUsage({
        sessionId: session.id,
        threadTitle: session.title,
        profileId: session.profileId,
        profileName: session.profile?.name ?? session.profileId,
        projectId: session.projectId,
        projectName: session.project?.name ?? session.projectId,
      }, event.update);
    }
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
      hasQueued: () => !session.queueChain && listQueue(session.id).length > 0,
      /* The drain runs here, synchronously after `turn_ended` was journaled,
         so the log reads turn_ended(continued) → turn_started(combined). The
         push says "turn finished" only for a turn nothing follows. */
      onTurnSettled: ({ error, continued }) => {
        if (continued) {
          this.drainQueue(session);
          return;
        }
        if (session.peers.size === 0) this.events.onTurnEnd?.(session, error);
      },
      /* Two callbacks where there was one, and the gap between them is the
         point — but the gap is about *precedence*, not about whether to write
         anything down. A session the agent has just created exists in its
         memory and nowhere else, so its id is unproven until a turn commits to
         it; withholding it entirely, though, is how a thread killed inside that
         window (a restart, a crash, `tsx watch`) ended up pointing at nothing
         while the agent's rollout sat on disk with the whole conversation in
         it, reachable by no one. So an unproven id IS persisted — flagged
         provisional, which makes it the one id the next `session/new` is
         allowed to replace. A proven id (a load that answered, or a turn that
         committed) is never replaced on the strength of a `session/new`. */
      onAcpSessionId: (acpSessionId, proven) => {
        session.liveAcpSessionId = acpSessionId;
        if (proven) {
          // The agent found this session and read it back: nothing outranks it.
          if (session.acpSessionId === acpSessionId && !session.acpSessionProvisional) return;
          session.acpSessionId = acpSessionId;
          session.acpSessionProvisional = false;
        } else {
          // Fresh session. Take the slot only when what is in it is unproven.
          if (session.acpSessionId && !session.acpSessionProvisional) return;
          session.acpSessionId = acpSessionId;
          session.acpSessionProvisional = true;
        }
        this.persist(session);
      },
      onSessionDurable: () => {
        const live = session.liveAcpSessionId;
        if (!live) return;
        if (live === session.acpSessionId && !session.acpSessionProvisional) {
          if (session.historyLost) {
            session.historyLost = null;
            this.persist(session);
          }
          return;
        }
        session.acpSessionId = live;
        session.acpSessionProvisional = false;
        session.historyLost = null; // superseded: this session is the thread now
        this.persist(session);
      },
      /* Recorded, not broadcast. A load only ever runs inside a spawn, and a
         spawn is either a revive (no peers yet) or a respawn (whose
         `clearEvents` forces every peer to reconnect anyway) — so the peers
         that need to hear it are the ones about to attach, and `attached` is
         where they hear it. Re-sending `attached` to a live peer would reset a
         transcript and then never close the replay it opened. */
      onHistoryLost: (lost) => {
        /* A provisional id never had a turn behind it, so a refusal to load it
           is the agent saying "I never wrote that down" — which is the truth
           about an empty thread, not the loss of a conversation. Reporting it
           would put an error row at the top of every thread that was killed
           before its first turn ever finished. */
        if (session.acpSessionProvisional) return;
        session.historyLost = lost;
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
    agentId: string,
    project: Project,
    model?: string,
    effort?: string,
    id?: string,
    configChoices?: Record<string, string | boolean>,
    links: LinkSet = emptyLinks(),
  ): Session {
    const session: Session = {
      id: id ?? randomUUID(),
      profileId: profile.id,
      projectId: project.id,
      links,
      /* A thread is a (profile, agent) pair: the profile is the provider, and
         it may serve several agents, so which one answers here is its own
         choice, made at draft time and kept for the thread's life. */
      agentId,
      profile,
      project,
      model: model || profile.defaultModel || "",
      effort: effort ?? "",
      title: "New thread",
      acpSessionProvisional: false,
      liveAcpSessionId: null,
      historyLost: null,
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
      queueChain: null,
      websearchViaMcp: false,
    };
    this.sessions.set(session.id, session);
    // Before the bridge: the event rows reference this one, so the session has
    // to exist by the time the agent's first update arrives.
    this.persist(session);
    this.persistLinks(session);
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
    session.profile = profile;
    session.project = project;
    /* Model and effort go back the way they came. A profile with a catalog
       overrode the agent, so those ids only reach it as env and this is the
       spawn that places them. A profile with no `models[]` deferred to the
       agent (see CLAUDE.md), so the recorded value is an id out of the agent's
       own selector — meaningless as env, and actively harmful for claude-code,
       where it also pins the model alias vars — and it is put back over ACP
       once the session exists instead. */
    const ownsCatalog = (profile.models?.length ?? 0) > 0;
    this.materializeFor(session, profile, project);
    const proc = spawnAgent(
      profile,
      session.agentId,
      project,
      ownsCatalog ? model : undefined,
      ownsCatalog ? effort : undefined,
    );
    const { mcpServers, websearchViaMcp } = this.serversFor(session, profile, project);
    session.websearchViaMcp = websearchViaMcp;
    // Both belong to the process about to be replaced, and the handshake below
    // is what fills them in again — a stale "history lost" would outlive the
    // load that failed and mark a thread that has just been restored fine.
    session.liveAcpSessionId = null;
    session.historyLost = null;
    const bridge = new AcpBridge(this.hostFor(session), proc, {
      cwd: project.cwd,
      mcpServers,
      ...opts,
      agentOwned: ownsCatalog ? undefined : { model, effort },
      websearchViaMcp,
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

  /** Everything the thread's agent is handed at `session/new`, and whether the
      harness's web-search server is among them — the bridge turns Claude
      Code's own WebSearch/WebFetch off when it is, and usage is recorded. */
  private serversFor(session: Session, profile: Profile, project: Project): {
    mcpServers: acp.McpServer[];
    websearchViaMcp: boolean;
  } {
    const mcpServers = mcpServersFor(this.effectiveLinks(session, profile), project, loadConfig());
    return {
      mcpServers,
      websearchViaMcp: mcpServers.some((s) => s.name === WEB_SEARCH_SERVER_NAME),
    };
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
    agentId: string,
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
      return this.respawnNow(session, profile, agentId, project, model, effort);
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
    agentId: string,
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
    session.agentId = agentId;
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

  /**
   * Dispatch a logical prompt from any source (socket or scheduler).
   *
   * While a turn is running the words are QUEUED, not sent — unless `steer`
   * is set, which joins the running turn the way every mid-turn prompt used
   * to. The server decides, not the browser: its `turnActive` is a hint, and
   * only `bridge.promptActive` knows whether the turn is still open. The
   * scheduler gets the same rule for free — a scheduled message that lands
   * mid-turn waits its turn instead of steering it.
   */
  async prompt(
    id: string,
    text: string,
    peer?: Peer,
    opts: { steer?: boolean } = {},
  ): Promise<PromptReply> {
    const session = this.sessions.get(id);
    const bridge = session?.bridge;
    if (!session || !bridge) throw new Error("this thread has no running agent");
    if (bridge.promptActive && !opts.steer) {
      const item = enqueue(session.id, text);
      this.emitQueue(session);
      return { queued: true, itemId: item.id };
    }
    return this.startTurn(session, bridge, text, peer);
  }

  /** Put a prompt on the wire. `peer` is the origin (told nothing — it already
      showed its own message); a drained prompt has none, so every peer draws
      the bubble from `turn_started`. */
  private startTurn(
    session: Session,
    bridge: AcpBridge,
    text: string,
    peer: Peer | undefined,
  ): { turnId: string } {
    /* One id per logical turn: steering (a second prompt while one is in
       flight) joins the turn already running rather than starting another. */
    const turnId = bridge.promptActive && bridge.currentTurnId ? bridge.currentTurnId : randomUUID();
    bridge.prompt(text, peer, turnId);
    if (text && session.title === "New thread") {
      session.title = text.slice(0, 60);
      this.persist(session);
    }
    return { turnId };
  }

  // ---- the queue ----

  /** The whole queue to every peer, the origin included: ids are minted here,
      so no peer's own picture of the list is the one to keep. */
  private emitQueue(session: Session): void {
    this.emit(session, { ev: "queue", items: listQueue(session.id) });
  }

  /**
   * Combine everything queued into ONE prompt and start a turn on it. Only on
   * an idle bridge with no "send now" mid-flight — that path is about to send
   * some of these rows itself and must not find them gone. Rows are deleted
   * after the prompt is dispatched, so nothing here can lose a message.
   */
  private drainQueue(session: Session): { turnId: string } | null {
    const bridge = session.bridge;
    if (!bridge || bridge.promptActive || session.queueChain) return null;
    const items = listQueue(session.id);
    if (items.length === 0) return null;
    const result = this.startTurn(session, bridge, combineQueued(items), undefined);
    removeQueuedMany(session.id, items.map((item) => item.id));
    this.emitQueue(session);
    return result;
  }

  /** `prompt` from a client that already knows the thread is busy. On an idle
      thread it drains straight away — one path, so a client whose picture of
      the turn was stale still gets its words sent. */
  queueAdd(id: string, text: string): PromptReply {
    const session = this.requireSession(id);
    const item = enqueue(session.id, text);
    this.emitQueue(session);
    return this.drainQueue(session) ?? { queued: true, itemId: item.id };
  }

  /* The three edits need no process: a parked queue on an archived thread is
     edited without spawning an agent to do it. */
  queueUpdate(id: string, itemId: string, text: string): void {
    const session = this.requireSession(id);
    if (!updateQueued(session.id, itemId, text)) throw new Error("that queued message is gone");
    this.emitQueue(session);
  }

  queueRemove(id: string, itemId: string): void {
    const session = this.requireSession(id);
    removeQueued(session.id, itemId);
    this.emitQueue(session);
  }

  queueClear(id: string): void {
    const session = this.requireSession(id);
    clearQueue(session.id);
    this.emitQueue(session);
  }

  /** Inject one queued item into the running turn without stopping it — the
      old steering path (`inflight++`). On an idle thread it simply starts one. */
  async queueSteer(id: string, itemId: string): Promise<{ turnId: string }> {
    const session = this.requireSession(id);
    const bridge = session.bridge;
    if (!bridge) throw new Error("this thread has no running agent");
    const item = listQueue(session.id).find((entry) => entry.id === itemId);
    if (!item) throw new Error("that queued message is gone");
    const result = this.startTurn(session, bridge, item.text, undefined);
    removeQueued(session.id, itemId);
    this.emitQueue(session);
    return result;
  }

  /**
   * Interrupt the running turn and send what is queued — one item, or all of
   * it combined — in its place. Atomic and server-side for the reason the
   * respawn route is: cancel → wait for the turn to settle → prompt is three
   * steps, and a browser driving them could close halfway and leave a
   * cancelled turn with nothing sent after it. Serialised per thread on
   * `queueChain`, which is also what stands the auto-drain down meanwhile.
   */
  queueSendNow(id: string, itemId?: string): Promise<{ turnId: string }> {
    const session = this.requireSession(id);
    const ahead = session.queueChain;
    const run = (async () => {
      await ahead?.catch(() => {});
      return this.queueSendNowNow(session, itemId);
    })();
    session.queueChain = run;
    void run
      .finally(() => {
        if (session.queueChain === run) session.queueChain = null;
      })
      .catch(() => {});
    return run;
  }

  private async queueSendNowNow(session: Session, itemId?: string): Promise<{ turnId: string }> {
    const bridge = session.bridge;
    if (!bridge) throw new Error("this thread has no running agent");
    const all = listQueue(session.id);
    const items = itemId ? all.filter((item) => item.id === itemId) : all;
    if (items.length === 0) throw new Error("nothing is queued");
    if (bridge.promptActive) {
      await bridge.cancel();
      // The agent answers the cancelled prompt with `stopReason: "cancelled"`,
      // which settles the turn as interrupted — so nothing drains on its own.
      await bridge.whenIdle();
    }
    /* The process may have died while we waited. The rows are untouched, so
       the queue is exactly as the user left it and the next revive still has
       it. */
    if (session.bridge !== bridge) throw new Error("the agent process is gone");
    const result = this.startTurn(session, bridge, combineQueued(items), undefined);
    removeQueuedMany(session.id, items.map((item) => item.id));
    this.emitQueue(session);
    return result;
  }

  private requireSession(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error("unknown session");
    return session;
  }

  private resetStderr(session: Session): void {
    session.stderr = [];
    session.stderrCount = 0;
    session.stderrMark = 0;
  }

  /** Stop the process but keep the thread — the opposite of purge(). The thread
      stays readable afterwards: the log is kept and `attach` serves it. */
  retire(session: Session): void {
    const proc = session.proc;
    const bridge = session.bridge;
    session.proc = null;
    session.bridge = null; // flips the generation guard
    session.exited = true;
    // The live session goes with the process. What the thread reverts to is the
    // recorded id — which, if this process never committed a turn, is still the
    // one with a transcript behind it.
    session.liveAcpSessionId = null;
    session.historyLost = null;
    /* The log is NOT cleared here any more, and that is what makes a retired
       thread readable. Closing the bridge ends whatever turn was in flight, and
       that last event is the end of this archive — so it is journaled like the
       rest rather than thrown away with the process. What still clears the log
       is the revive (`respawnNow`), which is the only moment the agent is about
       to re-narrate the conversation and the two accounts could otherwise be
       stitched together. */
    bridge?.close(new Error("thread retired"));
    this.flushWrites();
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
      ...s.links,
      /* The session anything asking today would mean: a task transcript's
         directory is named after the process's session, not after the one the
         thread will settle on. The recorded id is the fallback for a thread
         with no process. */
      acpSessionId: s.liveAcpSessionId ?? s.acpSessionId,
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
  attach(
    id: string,
    ws: WebSocket,
    cursor = 0,
    batch = false,
    opts: { window?: number } = {},
  ): string | null {
    const session = this.sessions.get(id);
    if (!session) return "no such thread on this server";
    if (session.deletedAt !== null) return "this thread is in the trash";
    /* A thread with no process is served read-only from its journal — but only
       if there IS one. An archive that was pruned, or a thread from before the
       archive existed, has nothing to show, and replaying nothing would render
       a blank transcript for a conversation that is still sitting in the
       agent's store. That is the case the old refusal was always about, so it
       is still the answer: the client reads it and revives. */
    if (session.exited && session.eventCount === 0) {
      return "this thread has no running agent — revive it first";
    }
    const peer: Peer = { ws };
    session.peers.add(peer);
    session.detachedAt = null;

    /* A cursor past the end of the journal means the log shrank under the
       client — a respawn or retirement clears it, and the id the client saved
       is no longer a position in it. Asking for a delta then would append
       nothing onto a transcript the client still believes is current, which is
       worse than the full rebuild it is being asked to avoid. So clamp to 0
       and let `attached.from` tell the truth: `from: 0` is the client's cue to
       reset and rebuild. */
    if (cursor > session.eventCount) cursor = 0;
    const resumed = cursor > 0;

    /* A client that named a window wants the tail, not the thread: an archive
       hundreds of turns long is opened to read the end of it, and paying for
       all of it to look at the last screen is the cost windowing removes. The
       rest stays on the server and is fetched backwards with `load_earlier`.
       The window is counted in **steps** (turns), and the replay starts at the
       `turn_started` of the first step it includes — a transcript that begins
       in the middle of a turn would re-fold into a half turn the reducer has
       never seen opened. `earlier` says how many whole steps were withheld.
       Never applied to a resume — the client is asking for a delta it already
       knows the size of, and windowing that would hide events it is missing. */
    const window = opts.window && opts.window > 0 ? opts.window : 0;
    const from = resumed
      ? cursor
      : window
        ? this.turnStartAt(session, Math.max(0, this.turnCount(session) - window)) ?? 0
        : 0;

    this.send(peer, {
      ev: "attached",
      from,
      resumed,
      earlier: resumed ? 0 : this.countTurnsBefore(session, from),
      archived: session.bridge === null,
      acpSessionId: session.liveAcpSessionId ?? session.acpSessionId ?? null,
      ...(session.historyLost ? { historyLost: session.historyLost } : {}),
    });
    /* Same events, same order, still inside the bracket — `batch` only decides
       how many frames carry them. One per event is a wake-up, a parse and a
       render each on the client, which is what made a long thread visibly
       rebuild itself; a client that says it can unroll a chunk gets the whole
       replay in a handful of frames instead. Frames come out pre-serialized
       (see `replayFrames`), so they go straight onto the socket. */
    for (const frame of this.replayFrames(session, from, batch)) peer.ws.send(frame);
    // Read in the same tick as the log it follows, so a client can't pair a
    // stale turn state with a fresh replay window (or vice versa).
    this.send(peer, {
      ev: "caught_up",
      cursor: session.eventCount,
      promptActive: session.bridge?.promptActive ?? false,
      queue: listQueue(session.id),
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
    /* Answered before the bridge check, and it is the only command that is:
       paging back through history is a read of the journal, and an archived
       thread — one with no process at all — is exactly where someone is doing
       it. Requiring an agent for it would mean spawning one to scroll. */
    if (command.cmd === "load_earlier") {
      this.send(peer, { ev: "reply", id: command.id, result: this.earlierPage(session, command.before) });
      return;
    }
    /* The queue edits, for the same reason: a queue parked on a thread whose
       process is gone is still the user's words, and taking one back should
       not cost a spawn. */
    switch (command.cmd) {
      case "queue_update":
        this.run(session, peer, command.id, async () => {
          this.queueUpdate(session.id, command.itemId, command.text);
          return {};
        });
        return;
      case "queue_remove":
        this.run(session, peer, command.id, async () => {
          this.queueRemove(session.id, command.itemId);
          return {};
        });
        return;
      case "queue_clear":
        this.run(session, peer, command.id, async () => {
          this.queueClear(session.id);
          return {};
        });
        return;
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
        this.run(session, peer, command.id, () =>
          this.prompt(session.id, command.text, peer, { steer: command.steer }),
        );
        return;
      case "queue_add":
        this.run(session, peer, command.id, async () => this.queueAdd(session.id, command.text));
        return;
      case "queue_send_now":
        this.run(session, peer, command.id, () => this.queueSendNow(session.id, command.itemId));
        return;
      case "queue_steer":
        this.run(session, peer, command.id, () => this.queueSteer(session.id, command.itemId));
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
