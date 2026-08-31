import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { WebSocket } from "ws";
import type * as acp from "@agentclientprotocol/sdk";
import { db, sessions as sessionsTable } from "./db/index.js";
import { SESSION_LINKS, emptyLinks, linksOf, readLinks, unionLinks, writeLinks, type LinkSet } from "./db/links.js";
import { materializeModelAllowlist, materializeWorkspace } from "./materialize.js";
import { mcpServers as mcpLibrary } from "./library.js";
import type { Profile } from "./profiles.js";
import type { Project } from "./projects.js";
import { getProfile, listProfiles, profileBaseUrl, profileSupports } from "./profiles.js";
import { agentModelId, bareModelId, getAgent, modelAllowlistFor } from "./registry.js";
import { gatewayUrlFor, setGatewaySessionResolver, type GatewaySession } from "./gateway-shim.js";
import { getProject } from "./projects.js";
import { getConfig, loadConfig } from "./config.js";
import { WEB_SEARCH_SERVER_NAME, toMcpServerEnv } from "./websearch.js";
import { pruneWebSearchUsage, recordWebSearchUsage } from "./websearch-usage.js";
import { KNOWLEDGE_SERVER_NAME, toKnowledgeServerEnv } from "./knowledge-db.js";
import { AcpBridge, spawnAgent, type BridgeHost } from "./acp-bridge.js";
import { WORKFLOW_SERVER_NAME } from "./workflow-schema.js";
import { deleteSearchIndex } from "./search.js";
import { getQuota, invalidateQuota } from "./quota.js";
import { profileUsage } from "./usage-api.js";
import { SessionJournal } from "./session-journal.js";
import { SessionSocket } from "./session-socket.js";
import {
  JOURNALED_EVENTS,
  type HistoryLost,
  type PromptReply,
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
      not into any array — the log itself is a table (see session-journal.ts),
      so nothing about a long thread is held in memory. */
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
  /** The thread this one is a workflow step of (workflows.ts), else null. A
      child never pushes, is never idle-retired, is hidden from the sidebar and
      is never handed the workflow server itself. Persisted. */
  parentSessionId: string | null;
  /** The profile this process was actually spawned on. Equal to `profileId`
      until the thread is moved to another provider without restarting, and the
      gap is what says the child's env — its credentials, and for Claude Code
      the model ids pinned into its side-job and alias vars — is out of date and
      has to be repaired on the wire (`gatewayStateOf`). Goes with the process. */
  spawnProfileId: string;
  /** Whether this process talks to its provider through the harness's shim. A
      thread whose profile has no base URL (the virtual Default) does not, and
      nothing about its provider can be changed under it. */
  viaGateway: boolean;
  /** True only while this process has the profile-provided web-search MCP. */
  websearchViaMcp: boolean;
  /** toolCallIds of in-flight web-search/fetch calls, so a streamed update for
      any *other* tool never touches the usage ledger. Owned by the process —
      reset with it. */
  websearchCalls: Set<string>;
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
  /** The `workflow` server as this thread may have it — null for a thread
      that must not (a workflow step: one level, never a tree). */
  workflow: StdioMcpServer | null = null,
): acp.McpServer[] {
  const linked = new Set(links.mcpServerIds);
  const out: acp.McpServer[] = [];
  for (const s of mcpLibrary.list()) {
    if (!linked.has(s.id)) continue;
    if (s.type === "builtin") {
      const built =
        s.builtin === "web-search"
          ? websearchServer(config)
          : s.builtin === "knowledge"
            ? knowledgeServer(project)
            : workflow;
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

/** The harness's own `workflow` MCP server. The only thing it is handed is the
    loopback URL that names the calling thread (`/wf/<key>/<sessionId>`): the
    server process cannot reach the SessionManager, so it drives the run over
    HTTP, and the key in that path is what lets the route act for exactly this
    thread and no other. */
export function workflowServer(session: Pick<Session, "id">, runner: WorkflowUrlSource): StdioMcpServer {
  return harnessMcpServer(WORKFLOW_SERVER_NAME, "workflow-mcp", [
    { name: "WORKFLOW_URL", value: runner.urlFor(session) },
  ]);
}

export interface SessionEvents {
  /** Fired only while no client is attached — used for push notifications. */
  onPermissionRequest?: (session: Session) => void;
  /** The agent asked the user something (elicitation/create) with nobody
      attached to answer. Same push case as a permission, different sentence. */
  onElicitationRequest?: (session: Session) => void;
  /** `error` is the error the prompt failed with, when it failed. */
  onTurnEnd?: (session: Session, error?: unknown) => void;
  /** The process is gone — retired, collapsed, or the thread deleted. Fired
      for every session, live or not; the workflow runner cancels whatever this
      thread was orchestrating. */
  onProcessGone?: (session: Session) => void;
}

/** What the manager needs from the workflow runner (workflows.ts) to hand a
    thread the `workflow` MCP server: the loopback URL that names the caller.
    An interface rather than the class so the two modules do not import each
    other — the runner is injected at boot (`setWorkflowRunner`). */
export interface WorkflowUrlSource {
  urlFor(session: Pick<Session, "id">): string;
}

/** A turn's outcome as `whenTurnSettled` reports it. */
export interface TurnOutcome {
  error?: WireError;
  interrupted: boolean;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  /** Server-side subscribers to a session's events (the workflow runner
      mirroring a step into its parent). Tapped after the journal, whether or
      not a peer is attached. */
  private subscribers = new Map<string, Set<(event: ThreadEvent) => void>>();
  /** One-shot waiters for a turn to settle, by session — see `whenTurnSettled`. */
  private turnWaiters = new Map<string, { turnId: string; settle: (outcome: TurnOutcome) => void; fail: (error: Error) => void }[]>();
  /** Injected at boot; null means no thread is handed the workflow server. */
  private workflowRunner: WorkflowUrlSource | null = null;

  /** The event-journal concern — the buffered writes, the reads that flush
      first, the turn-boundary math and the replay framing — extracted to
      session-journal.ts. The manager decides when; the journal knows the table. */
  private log = new SessionJournal(db);

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

    /* What answers a `/gw/<key>/s/<id>/…` request. The shim asks per request
       rather than being told at spawn, which is the whole of "the endpoint,
       credentials and model behind a running child are still ours to change"
       — see `applyConfig`. */
    setGatewaySessionResolver((id) => this.gatewayStateOf(id));

    const idleMs = idleMinutes * 60_000;
    setInterval(() => {
      for (const s of this.sessions.values()) {
        /* Not a thread mid-turn: a parent blocked inside a workflow call with
           no browser open was being retired under it. And never a workflow
           step, which has no peers by design — its lifetime is its run's. */
        if (s.parentSessionId || s.bridge?.promptActive) continue;
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
    const counts = this.log.nextSeqBySession();
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
           are still there — see SessionJournal.nextSeqBySession for why a
           count that restarted at 0 would collide. */
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
        // All three belong to a process, and there is none until this thread is
        // revived — the spawn that revives it sets them from the row it reads.
        spawnProfileId: row.profileId,
        viaGateway: false,
        websearchViaMcp: false,
        websearchCalls: new Set(),
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
   * The process is exiting. Retire every live session — which kills the agent
   * children instead of orphaning them and journals each turn's last event —
   * and land whatever `appendEvent` buffered for the next tick, which a bare
   * `process.exit()` would silently drop. Idempotent; the signal handler in
   * index.ts awaits a bounded drain after calling this so the SIGTERM→SIGKILL
   * escalation timers elsewhere get a chance to fire.
   */
  shutdown(): void {
    for (const session of this.sessions.values()) {
      this.closePeers(session, 4000, "server shutting down");
      if (!session.exited) this.retire(session);
    }
    this.log.flush();
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
        parentSessionId: s.parentSessionId,
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

  // ---- the event log (see session-journal.ts for the table itself) ----

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
    const cutoff = days === 0 ? Date.now() : Date.now() - days * 86_400_000;
    const live = [...this.sessions.values()].filter((s) => !s.exited).map((s) => s.id);
    for (const id of this.log.prune(cutoff, live)) {
      const session = this.sessions.get(id);
      if (session) session.eventCount = 0;
    }
    /* The web-search usage ledger ages out on the same clock: it is metadata
       about transcripts whose archives were just judged by this cutoff. */
    const usageDropped = pruneWebSearchUsage(cutoff);
    if (usageDropped > 0) console.log(`[journal] dropped ${usageDropped} web-search usage row(s)`);
    /* And so does the trash. A soft delete keeps the row so a delete stays
       undoable, but "undoable" was never meant to mean "immortal" — a thread
       trashed longer than the retention window is purged for good. Only with a
       positive window: `0` means "no archive", not "empty the trash at boot". */
    if (days > 0) {
      for (const session of [...this.sessions.values()]) {
        if (session.deletedAt !== null && session.deletedAt < cutoff) this.purge(session.id);
      }
    }
  }

  /** Everything this session has journaled, and the cursor that follows it. */
  journal(id: string): { cursor: number; events: ThreadEvent[] } | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    return { cursor: session.eventCount, events: this.log.eventsFrom(session.id, 0) };
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
  private emit(session: Session, event: ThreadEvent, except?: Peer, mirrored = false): void {
    /* Closing a bridge rejects whatever it had in flight, and those rejections
       land a microtask later — after a purge has already deleted the row the
       event rows point at. Nothing is listening for them either way. */
    if (!this.sessions.has(session.id)) return;
    // A mirrored event is a step's, already recorded under the step's own
    // thread — counting it again here would bill every search twice.
    if (!mirrored && session.websearchViaMcp && event.ev === "update" && !event.historyReplay) {
      recordWebSearchUsage({
        sessionId: session.id,
        threadTitle: session.title,
        profileId: session.profileId,
        profileName: session.profile?.name ?? session.profileId,
        projectId: session.projectId,
        projectName: session.project?.name ?? session.projectId,
      }, event.update, session.websearchCalls);
    }
    const out = JOURNALED.has(event.ev) ? this.log.append(session, event) : event;
    const subs = this.subscribers.get(session.id);
    if (subs) for (const fn of subs) fn(out);
    if (session.peers.size === 0) return;
    const line = JSON.stringify(out);
    for (const peer of session.peers) if (peer !== except) peer.ws.send(line);
  }

  /**
   * Re-read this thread's subscription quota and tell its peers, after a turn.
   *
   * Three things it refuses to do, each for its own reason. It does nothing for
   * a **child session**: a workflow's five steps are five settled turns on one
   * account, and probing per step would spawn five CLIs to learn the same number
   * — the parent's own turn covers the run. It does nothing with **no peer
   * attached**: the reading is for a screen, and a thread draining a queue
   * overnight should not be spawning a process per turn for nobody. And it
   * **swallows its own failure**: a missing `claude` binary must not surface as
   * an error on a turn that succeeded — `getQuota` already records that verdict
   * for the settings page to show, where it is the answer to a question someone
   * actually asked.
   *
   * Deliberately not awaited. The turn is settled; nothing downstream of it may
   * wait on a child process.
   */
  private refreshQuota(session: Session): void {
    if (session.parentSessionId || session.peers.size === 0) return;
    const agent = getAgent(session.agentId);
    const profile = session.profile ?? getProfile(session.profileId);
    const project = session.project ?? getProject(session.projectId);
    /* Either reader will do: the agent's own probe, or the provider plan the
       profile names — which outranks it, and is the only quota a thread on a
       gateway has at all. */
    if (!agent || !profile || !project) return;
    if (!agent.quotaProbe && !profileUsage(profile)) return;
    invalidateQuota(profile, agent.id);
    void getQuota(agent, profile, project)
      .then((quota) => this.emit(session, { ev: "quota", quota }))
      .catch(() => {});
  }

  /** Hear every event of a session as it is journaled/fanned out — attached
      peers or not. Returns the unsubscribe. */
  subscribe(id: string, fn: (event: ThreadEvent) => void): () => void {
    let set = this.subscribers.get(id);
    if (!set) this.subscribers.set(id, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0 && this.subscribers.get(id) === set) this.subscribers.delete(id);
    };
  }

  /** A server-side subsystem putting an `update` on a thread's log — the
      workflow runner mirroring a step into its parent. Journaled like any
      update (which is what makes it replay), and flagged so the usage ledger
      leaves it alone. */
  emitOn(id: string, event: Extract<ThreadEvent, { ev: "update" }>): void {
    const session = this.sessions.get(id);
    if (session) this.emit(session, event, undefined, true);
  }

  /** Resolves when the named turn settles — cleanly, cancelled, or failed —
      and rejects if the process goes away before it does. */
  whenTurnSettled(id: string, turnId: string): Promise<TurnOutcome> {
    return new Promise((settle, fail) => {
      let list = this.turnWaiters.get(id);
      if (!list) this.turnWaiters.set(id, (list = []));
      list.push({ turnId, settle, fail });
    });
  }

  private settleWaiters(session: Session, turnId: string, outcome: TurnOutcome): void {
    const list = this.turnWaiters.get(session.id);
    if (!list) return;
    const rest = list.filter((w) => w.turnId !== turnId);
    for (const w of list) if (w.turnId === turnId) w.settle(outcome);
    if (rest.length) this.turnWaiters.set(session.id, rest);
    else this.turnWaiters.delete(session.id);
  }

  /** The process is gone. Whatever it was still going to settle, it will not —
      after the bridge's own rejections have had their microtask, so a turn the
      close itself ended is reported as that turn's error, not as this. */
  private processGone(session: Session, reason: string): void {
    this.events.onProcessGone?.(session);
    setImmediate(() => {
      const list = this.turnWaiters.get(session.id);
      if (!list) return;
      this.turnWaiters.delete(session.id);
      for (const w of list) w.fail(new Error(reason));
    });
  }

  /** The live children of a thread — its workflow steps. */
  childrenOf(id: string): Session[] {
    return [...this.sessions.values()].filter((s) => s.parentSessionId === id);
  }

  setWorkflowRunner(runner: WorkflowUrlSource): void {
    this.workflowRunner = runner;
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
      /* A workflow step never pushes: its question and its turn end belong to
         the run, and a phone told "turn finished" per step would be told it
         five times for one workflow. */
      onPermissionRequest: () => {
        if (!session.parentSessionId) this.events.onPermissionRequest?.(session);
      },
      onElicitationRequest: () => {
        if (!session.parentSessionId) this.events.onElicitationRequest?.(session);
      },
      hasQueued: () => !session.queueChain && listQueue(session.id).length > 0,
      /* The drain runs here, synchronously after `turn_ended` was journaled,
         so the log reads turn_ended(continued) → turn_started(combined). The
         push says "turn finished" only for a turn nothing follows. */
      onTurnSettled: ({ error, interrupted, continued, turnId }) => {
        this.settleWaiters(session, turnId, { error, interrupted });
        /* A turn is what spends the plan, so it is also what dates the reading.
           Before the `continued` return: a queue draining into the next turn is
           still a turn that just ended, and skipping it would leave a long drain
           showing the number from before any of it. */
        this.refreshQuota(session);
        if (continued) {
          this.drainQueue(session);
          return;
        }
        if (session.peers.size === 0 && !session.parentSessionId) this.events.onTurnEnd?.(session, error);
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
        /* The agent reports the id it was given, which for Claude Code carries
           the 1M suffix the env template appends. What the row holds is the
           catalog's own id — the one every menu matches against and the one a
           revive resolves the suffix from again. */
        if (next.model !== undefined) {
          session.model = session.profile ? bareModelId(session.profile, next.model) : next.model;
        }
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
    this.processGone(session, reason);
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
    opts: {
      /** Make this a workflow step of that thread. */
      parentSessionId?: string;
      /** A title set before the first prompt, which the title sniff then leaves alone. */
      title?: string;
      /** Settings to put in place once the session exists — a step inheriting
          its parent's permission mode, the same way a respawn keeps its own. */
      restore?: import("./protocol.js").RestoreState;
    } = {},
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
      title: opts.title ?? "New thread",
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
      parentSessionId: opts.parentSessionId ?? null,
      spawnProfileId: profile.id,
      viaGateway: false,
      websearchViaMcp: false,
      websearchCalls: new Set(),
    };
    this.sessions.set(session.id, session);
    // Before the bridge: the event rows reference this one, so the session has
    // to exist by the time the agent's first update arrives.
    this.persist(session);
    this.persistLinks(session);
    this.start(session, profile, project, model, effort, { configChoices, restore: opts.restore });
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
    const agent = getAgent(session.agentId);
    /* The allowlist an `"acp"`-live agent builds its model picker from. Written
       before the spawn because it is read once, at `session/new`, and it is the
       union across every profile that serves this agent rather than this one's
       — a thread outlives its profile, and a list scoped to the spawning
       profile would make the next one's models unreachable without exactly the
       restart this is here to avoid. Empty for a profile with no catalog, which
       hands the picker back to the agent's own models. */
    if (agent?.liveConfig === "acp") {
      materializeModelAllowlist(project.cwd, modelAllowlistFor(agent, profile, listProfiles()));
    }
    session.spawnProfileId = profile.id;
    session.viaGateway = !!gatewayUrlFor(profile.id, session.agentId, profileBaseUrl(profile, session.agentId), session.id);
    const proc = spawnAgent(
      profile,
      session.agentId,
      project,
      ownsCatalog ? model : undefined,
      ownsCatalog ? effort : undefined,
      session.id,
    );
    const { mcpServers, websearchViaMcp, workflowViaMcp } = this.serversFor(session, profile, project);
    session.websearchViaMcp = websearchViaMcp;
    session.websearchCalls = new Set(); // in-flight calls went with the old process
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
      workflowViaMcp,
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
    workflowViaMcp: boolean;
  } {
    // getConfig, not loadConfig: this runs on every spawn, and re-reading and
    // re-parsing config.json each time bought nothing — saveWebSearch is the
    // only runtime writer and it invalidates the cache.
    /* A workflow step is never handed the workflow server, whatever its
       profile links: a step that could start a workflow makes the lifetime
       accounting — caps, cancel propagation, restart recovery — a tree, and a
       definition that spawns itself the obvious failure. One level. */
    const workflow =
      this.workflowRunner && !session.parentSessionId ? workflowServer(session, this.workflowRunner) : null;
    const mcpServers = mcpServersFor(this.effectiveLinks(session, profile), project, getConfig(), workflow);
    return {
      mcpServers,
      websearchViaMcp: mcpServers.some((s) => s.name === WEB_SEARCH_SERVER_NAME),
      workflowViaMcp: mcpServers.some((s) => s.name === WORKFLOW_SERVER_NAME),
    };
  }

  /* ── Changing a thread's provider, model or effort ──────────────────────
   *
   * All three used to mean the same thing: kill the process and spawn another,
   * because all three are placed by the env template. They still are *at
   * spawn* — but a running agent can be moved without being restarted, and the
   * two halves of how are `AgentDef.liveConfig`:
   *
   *  - the endpoint and the credential are the shim's, not the child's. The
   *    child talks to `/gw/<key>/s/<id>/…` and the shim resolves the thread's
   *    profile per request (`gatewayStateOf`), so a profile change retargets
   *    the very next call — including its `x-api-key`.
   *  - the model is the agent's own selector where it will take one
   *    (`"acp"`), and the shim's rewrite of the request body where it will not
   *    (`"gateway"`).
   *
   * What is left over is still a respawn, and `applyConfig` is where the line
   * is drawn — every case it cannot do live falls through to `respawn` rather
   * than being refused, so the menu never has to know which is which.
   */

  /** What the shim needs to know about a thread, resolved per request. */
  private gatewayStateOf(id: string): GatewaySession | undefined {
    const session = this.sessions.get(id);
    if (!session || !session.profile) return undefined;
    const agent = getAgent(session.agentId);
    const ownsCatalog = (session.profile.models?.length ?? 0) > 0;
    /* Two ways the id the child names can be the wrong one. Codex is told its
       model at spawn and will not be told another, so every request it makes
       carries the stale id once the thread's model changes. And *any* agent
       that has been moved to another profile is carrying that profile's ids in
       its env — for Claude Code that is the side-job and alias vars, which name
       models the new gateway very likely does not serve; the main model has
       already been switched over ACP by then, but those have not. Everything
       else forwards untouched, which is the case that costs nothing. */
    const rewriteModel =
      ownsCatalog &&
      !!session.model &&
      (agent?.liveConfig === "gateway" || session.profileId !== session.spawnProfileId);
    return {
      profileId: session.profileId,
      agentId: session.agentId,
      model: rewriteModel ? session.model : "",
      effort: rewriteModel ? session.effort : "",
      rewriteModel,
    };
  }

  /**
   * Move a thread to another profile, model or effort — without restarting it
   * where that is possible, and by restarting it where it is not.
   *
   * The live path is the point, and it is deliberately conservative: anything
   * it is not sure of falls back to the respawn that was always here. It
   * refuses to be clever about four things in particular —
   *
   *  - a different **agent** is a different runtime, and nothing about a
   *    running process survives that;
   *  - a thread that is not behind the shim (the virtual Default profile has
   *    no base URL to front) has no way to be retargeted, and neither has one
   *    moving *to* such a profile;
   *  - an `"acp"` agent that will not take the model — a profile whose models
   *    reached the workspace allowlist after this process read it — because
   *    the alternative to asking is finding out by being refused, with the
   *    thread's record already changed;
   *  - a thread with no live process at all, which is a revive.
   *
   * Answers `{ live }` so the caller can tell a client whether its socket
   * survived: a respawn clears the event log and every peer has to reattach,
   * and a live change is invisible to all of them but the menu that asked.
   */
  async applyConfig(
    id: string,
    next: { profile: Profile; agentId: string; project: Project; model?: string; effort?: string },
  ): Promise<{ live: boolean }> {
    const session = this.sessions.get(id);
    if (!session) throw new Error("unknown session");
    if (session.deletedAt !== null) throw new Error("session deleted");
    if (await this.applyConfigLive(session, next)) return { live: true };
    await this.respawn(id, next.profile, next.agentId, next.project, next.model, next.effort);
    return { live: false };
  }

  /** The live half of `applyConfig`; false means "this one needs a respawn",
      and it is answered before anything about the thread has been changed. */
  private async applyConfigLive(
    session: Session,
    next: { profile: Profile; agentId: string; project: Project; model?: string; effort?: string },
  ): Promise<boolean> {
    const agent = getAgent(session.agentId);
    if (!agent?.liveConfig) return false;
    if (next.agentId !== session.agentId) return false;
    // Mid-respawn, mid-revive, or no process: whatever is about to exist is
    // going to be spawned with these settings anyway.
    if (session.respawnChain || !session.bridge || session.exited) return false;
    const bridge = session.bridge;
    const moving = next.profile.id !== session.profileId;
    if (moving) {
      // Nothing to retarget through, on one side or the other.
      if (!session.viaGateway) return false;
      if (!profileSupports(next.profile, session.agentId)) return false;
      if (!gatewayUrlFor(next.profile.id, session.agentId, profileBaseUrl(next.profile, session.agentId), session.id)) {
        return false;
      }
    }
    const model = next.model || next.profile.defaultModel || "";
    const effort = next.effort ?? "";
    const ownsCatalog = (next.profile.models?.length ?? 0) > 0;
    /* A profile with no catalog hands model and effort back to the agent (see
       CLAUDE.md), and "back to the agent" is a different session state, not a
       value we can set: the ids it would then own come out of its own selector
       and the env that named them is still in the child. Respawn. */
    if (moving && !ownsCatalog) return false;
    if (!model) return false;

    /* Asked before anything moves, because being refused after the record has
       changed is the one failure this cannot recover from cheaply. */
    const wire = agent.liveConfig === "acp" ? agentModelId(agent, next.profile, model) : "";
    if (wire && !bridge.offersModel(wire)) return false;

    /* The row moves first, and the order is load-bearing for a profile change:
       the shim resolves the thread's provider per request, so between these two
       statements a request either goes to the new gateway naming the new model
       (row first — what the shim would rewrite it to anyway) or to the *old*
       gateway naming the new model, which is a 404 the user did not ask for.
       Nothing is lost if the change below then fails: `applyConfig` falls
       through to a respawn that starts on exactly these settings. */
    const previous = { profileId: session.profileId, profile: session.profile, model: session.model, effort: session.effort };
    session.profileId = next.profile.id;
    session.profile = next.profile;
    session.model = model;
    session.effort = effort;

    if (wire) {
      const placed = await bridge.setByCategory({ model: wire, effort }, "on the running agent");
      /* Effort is the softer half, and only for this agent: Claude Code's env
         has no effort var at all, so a restart would not have placed one either
         — a selector the model does not offer costs the same nothing it always
         did, and the row still records the pick for the next spawn. The model
         is not soft, so a refusal puts the thread back as it was and lets the
         respawn place it the old way. */
      if (!placed.model) {
        Object.assign(session, previous);
        return false;
      }
      /* `setConfigOption` recorded the id it was given, which for Claude Code
         carries the 1M suffix and was resolved against the profile the thread
         was still on when the call went out. */
      session.model = model;
    }
    /* `"gateway"` needs nothing said to the agent: the row is what the shim
       reads on the next request, and the child never learns it moved. */

    this.persist(session);
    /* Every peer, the asking one included: nothing here went through the
       journal, so a device that is not the one holding the menu has no other
       way to learn the thread moved. */
    this.emit(session, { ev: "spawn_config", profileId: session.profileId, model, effort });
    return true;
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
    this.log.clear(session);
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
   * The bridge a prompt may be put on, once it exists and is ready.
   *
   * `start()` sets `session.bridge` before the handshake resolves, so a
   * command arriving between a (re)spawn and its `session/new` answer used to
   * hit a bridge that could not take a prompt yet — the scheduler already
   * awaited `bridge.ready` for exactly this; now every prompt path does. An
   * in-flight respawn is waited out first (whichever way it settles) so the
   * bridge read afterwards is the one that survived it.
   */
  private async whenSpawnable(session: Session): Promise<AcpBridge> {
    await session.respawnChain?.catch(() => {});
    const bridge = session.bridge;
    if (!bridge) throw new Error("this thread has no running agent");
    await bridge.ready;
    if (session.bridge !== bridge) throw new Error("the agent process is gone");
    return bridge;
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
    if (!session) throw new Error("this thread has no running agent");
    const bridge = await this.whenSpawnable(session);
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
    const bridge = await this.whenSpawnable(session);
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
    const bridge = await this.whenSpawnable(session);
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
    this.log.flush();
    this.resetStderr(session);
    proc?.kill();
    this.processGone(session, "thread retired");
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
      parentSessionId: s.parentSessionId,
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
    // Retiring fires onProcessGone, which is where the runner cancels the run
    // this thread was orchestrating; the steps then go to the trash with it.
    this.retire(session);
    this.persist(session);
    for (const child of this.childrenOf(id)) this.softDelete(child.id);
    return true;
  }

  restore(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session || session.deletedAt === null) return false;
    session.deletedAt = null;
    // Still process-less: the client revives it the same way it revives any
    // retired thread.
    this.persist(session);
    for (const child of this.childrenOf(id)) this.restore(child.id);
    return true;
  }

  /** Forget the thread for good. Only the agent's own store still has it. */
  purge(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    /* Children first: `parent_session_id` is not a foreign key on purpose (see
       schema.ts), so each step goes through this same path — its process, its
       peers, its FTS rows, its slot in the map. */
    for (const child of this.childrenOf(id)) this.purge(child.id);
    this.closePeers(session, 4000, "session purged");
    this.retire(session);
    this.sessions.delete(id);
    // ON DELETE CASCADE takes the event rows with it; the FTS rows have no
    // foreign key (virtual table), so they go by hand.
    db.delete(sessionsTable).where(eq(sessionsTable.id, id)).run();
    deleteSearchIndex([id]);
    return true;
  }

  private closePeers(session: Session, code: number, reason: string): void {
    for (const peer of session.peers) peer.ws.close(code, reason);
  }

  // ---- the socket ----

  /** The wire — attach bracket, replay windowing, command dispatch — lives in
      session-socket.ts, behind a port of exactly the methods it needs. */
  private socket = new SessionSocket({
    getSession: (id) => this.sessions.get(id),
    journal: this.log,
    prompt: (id, text, peer, opts) => this.prompt(id, text, peer, opts),
    queueAdd: (id, text) => this.queueAdd(id, text),
    queueSendNow: (id, itemId) => this.queueSendNow(id, itemId),
    queueSteer: (id, itemId) => this.queueSteer(id, itemId),
    queueUpdate: (id, itemId, text) => this.queueUpdate(id, itemId, text),
    queueRemove: (id, itemId) => this.queueRemove(id, itemId),
    queueClear: (id) => this.queueClear(id),
    enrichError: (session, error) => this.enrichError(session, error),
  });

  /**
   * Attach a WebSocket. Replays journaled events from `cursor`, brackets them
   * with `attached`/`caught_up` so the client can tell history from news, then
   * hands over whatever question the agent is currently blocked on.
   *
   * Returns null on success, or why it refused — that string becomes the close
   * reason. The mechanics live in SessionSocket.attach.
   */
  attach(
    id: string,
    ws: WebSocket,
    cursor = 0,
    batch = false,
    opts: { window?: number } = {},
  ): string | null {
    return this.socket.attach(id, ws, cursor, batch, opts);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
