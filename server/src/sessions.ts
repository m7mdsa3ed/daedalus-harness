import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { WebSocket } from "ws";
import type * as acp from "./acp.js";
import { db, sessions as sessionsTable } from "./db/index.js";
import { SESSION_LINKS, emptyLinks, linksOf, readLinks, unionLinks, writeLinks, type LinkSet } from "./db/links.js";
import { ensureProjectDir, materializeModelAllowlist, materializeWorkspace } from "./materialize.js";
import { mcpServers as mcpLibrary } from "./library.js";
import { isConnected as isMcpConnected } from "./mcp-oauth.js";
import { mcpProxyUrlFor } from "./mcp-shim.js";
import { personaEffort, personas, resolvePersonaSpawn } from "./personas.js";
import { globalRules, projectRules } from "./rules.js";
import type { Profile } from "./profiles.js";
import type { Project } from "./projects.js";
import { getProfile, listProfiles, profileBaseUrl, profileSupports } from "./profiles.js";
import { agentModelId, bareModelId, getAgent, modelAllowlistFor, type AgentDef } from "./registry.js";
import type { WorkspaceLayout } from "./db/schema.js";
import { gatewayUrlFor, setGatewaySessionResolver, type GatewaySession } from "./gateway-shim.js";
import { HttpError } from "./http-error.js";
import * as git from "./git.js";
import { getProject } from "./projects.js";
import { databaseUrl, getConfig, loadConfig } from "./config.js";
import { WEB_SEARCH_SERVER_NAME, toMcpServerEnv } from "./websearch.js";
import { pruneWebSearchUsage, recordWebSearchUsage } from "./websearch-usage.js";
import { KNOWLEDGE_SERVER_NAME, toKnowledgeServerEnv } from "./knowledge-db.js";
import { AcpBridge, agentStream, spawnAgent, toWireError, type BridgeHost, type ConfigNoticeLabel } from "./acp-bridge.js";
import { makeBridgeHost } from "./bridge-host.js";
import { enrichError, pushStderr, resetStderr } from "./stderr-ring.js";
import { SessionQueue } from "./session-queue.js";
import type { AutonomyPolicy } from "./autonomy.js";
import { WORKFLOW_SERVER_NAME } from "./workflow-schema.js";
import { deleteSearchIndex } from "./search.js";
import { getQuota, invalidateQuota, planReadable, setRuntimeLiveCheck } from "./quota.js";
import { profileUsage } from "./usage-api.js";
import { SessionJournal } from "./session-journal.js";
import { TurnChangesRecorder } from "./turn-changes.js";
import { OpencodeSubagentFeed } from "./opencode-subagents.js";
import { PortPool } from "./net.js";
import { SessionSocket } from "./session-socket.js";
import {
  JOURNALED_EVENTS,
  type AttachmentRef,
  type HistoryLost,
  type CancelReply,
  type PromptReply,
  type StagedConfig,
  type ThreadEvent,
  type TracePage,
  type WireError,
} from "./protocol.js";
import { enqueue } from "./queue.js";
import {
  claimAttachments,
  claimedAttachmentIds,
  deleteSessionAttachments,
  sweepAttachments,
} from "./attachments.js";
import { sweepMaterialisedAttachments } from "./attachment-blocks.js";

/** What the first prompt's opening words are cut to when they become a title. */
const TITLE_SNIFF_MAX = 60;
/** What a hand-typed title is cut to — longer than the sniff's, because a name
    somebody chose is worth more room than one nobody did, and bounded at all
    only so the column cannot hold a whole prompt. */
const TITLE_MAX = 200;
/** What a turn's failure is cut to on the session row. It is a *reading* — one
    line in a list, a status word in a card — and the failure itself is on the
    journaled `turn_ended`, which is what the transcript draws in full. */
const LAST_ERROR_MAX = 300;

/** One attached client. Several may share a session; they are subscribers to
    one server-side ACP client, not ACP clients themselves — which is why a peer
    carries no request bookkeeping any more. */
export interface Peer {
  ws: WebSocket;
  /**
   * Live events held back while this peer's replay is still being written to
   * the socket, or null once it is caught up and everything goes straight out.
   *
   * The replay used to be one synchronous loop, which made this unnecessary:
   * nothing else could run between the first frame and `caught_up`, so no live
   * event could overtake the history it belongs after. Now that the frames
   * yield to the event loop (see `SessionSocket.attach` — a long replay must
   * not stall every other thread's turn, and a slow client must not be handed
   * megabytes at once), another thread's turn — or this one's — can journal an
   * event while the archive is still going out. Sending it immediately would
   * put it *before* the history it follows, and the replay's own trailing page
   * would then send it a second time.
   *
   * So a peer mid-replay is a peer whose live events are queued, in order, and
   * flushed the moment its `caught_up` has gone out. The buffer is bounded by
   * the replay, which is bounded by the window.
   */
  pending: string[] | null;
  /**
   * This peer's page is frozen, so it cannot raise a notification of its own.
   *
   * Set by the `background` command and cleared when the page resumes. It is
   * deliberately narrower than "hidden": see the command's own note in
   * protocol.ts. Nothing about the event stream changes — a frozen peer is
   * still sent everything, and the browser hands it over when the page comes
   * back — it changes only who is counted as *watching* (`watchers`), which is
   * what decides whether the server pushes.
   */
  background?: boolean;
}

/** Peers that could still tell the user something themselves. The push in
    `index.ts` is for a thread with none, and `peers.size` is not that number:
    a phone in a pocket holds its socket open with its page frozen. Every other
    reader of `peers.size` — the fan-out, the idle sweep, the quota refresh —
    wants the socket count and keeps it. */
export function watchers(session: Session): number {
  let count = 0;
  for (const peer of session.peers) if (!peer.background) count += 1;
  return count;
}

/** Fan one already-serialized event out to a peer, respecting its replay
    buffer. Everything that writes to a peer outside the attach bracket itself
    goes through here. */
export function sendToPeer(peer: Peer, line: string): void {
  if (peer.pending) {
    peer.pending.push(line);
    return;
  }
  peer.ws.send(line);
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
  /** The permission mode picked for this thread, or null for the agent's
      default. A spawn input like model and effort — and unlike them it is
      applied over `session/set_mode` right after the session exists, so a
      revive without a live process to copy from (idle-retired, pre-restart)
      puts it back from the row instead of coming back on default. Written on
      every accepted `set_mode`, not just the draft pick. */
  modeId: string | null;
  /** Every other agent selector this thread has been moved off its default on,
      `{configId: value}`. The same bargain `modeId` makes, for the settings
      that had no row to be restored from: `captureRestoreState` can only read
      them off a live process, so a revive with none (idle-retired,
      pre-restart) used to bring the thread back on the agent's defaults. */
  configChoices: Record<string, string | boolean>;
  /** How this thread wants to be worked on (`personas.ts`), or "" for no
      persona. A spawn input like model and effort — and unlike them it can
      never be applied live, because every runtime reads it only when a session
      is created or loaded. See `applyConfigLive`. */
  personaId: string;
  /** Whether the agent closes each answer with follow-up prompt suggestions
      in a `suggest-prompts` fenced block (`personas.ts`). Same spawn-input
      bargain as the persona: read only at session creation/load, so toggling
      it costs a respawn. */
  suggestFollowups: boolean;
  /** Whether the agent may answer with a fenced `openui-lang` block, which the
      client draws as real UI (`client/src/lib/openui/`). Same spawn-input
      bargain as the suggestions trailer: it is system-prompt text, so toggling
      it costs a respawn. */
  uiBlocks: boolean;
  title: string;
  /** The current title came from the first-prompt fallback, so an ACP
      `session_info_update` may replace it with the agent's better title. */
  titleFromPrompt: string | null;
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
  /** Epoch ms of the newest turn on this thread — the sidebar's order. A
      thread is recent because something was *said* in it, not because it was
      opened first, so this moves with every turn (once per turn: the journaled
      `turn_started`/`turn_ended`, never per streamed update) and starts at
      `createdAt`. Persisted; backfilled from the journal for rows written
      before it existed. */
  lastActivityAt: number;
  /** How the newest turn failed, or null when it did not — the message, capped
      at `LAST_ERROR_MAX`. Set and cleared by `emit` on the same journaled turn
      boundaries that move `lastActivityAt`, persisted with them, and reported
      by `list()`, so a thread that ended badly says so in a sidebar that has
      never opened it. A cancelled turn is a success on the wire and carries no
      error, so a Stop leaves this null. */
  lastTurnError: string | null;
  /** The newest `usage_update` this thread's own session reported — how full
      the agent says its context window is. Kept here rather than left to the
      client's fold of the journal, because it is current state and the journal
      is history: a windowed replay may not contain a reading at all, and a
      `load_earlier` page contains an older one. Handed to every attaching peer
      on `caught_up`, and written to the row at the turn boundary. Null for a
      runtime that reports no usage, which the ring draws as "—". */
  context: acp.UsageUpdate | null;
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
  /** Epoch ms this thread was pinned; null = not pinned. Server-side, so a pin
      made on one device is a pin on every device. */
  pinnedAt: number | null;
  exited: boolean;
  /** Tail of this session's in-flight respawn chain, null when idle. A second
      respawn — a double-click, two tabs, model then effort changed in quick
      succession — queues behind the first instead of closing its not-yet-ready
      bridge, which is what used to reject the first call's `await bridge.ready`
      with the close reason and answer a fine respawn with 500 "respawning". */
  respawnChain: Promise<Session> | null;
  /** True while a respawn that is *keeping* this thread's journal is running its
      `session/load`. The load narrates the whole conversation back as ordinary
      updates, which is the duplicate the clear used to answer — so the flag is
      read by `emit` and those updates are dropped at the one chokepoint they
      both journal and fan out through. Set for the length of one spawn; see
      `respawnNow`. */
  quietLoad: boolean;
  /** A config change waiting for the running turn to end — see `StagedConfig`.
      In memory, never a column: its whole lifetime is the turn it is held
      behind, and a server that restarted has killed that turn. Cleared by the
      flush, by a cancel, and by any respawn (which has just applied something
      newer than it). */
  stagedConfig: StagedConfig | null;
  /** Tail of this thread's in-flight "send now" chain — cancel the turn, wait
      for it to settle, send. While it is set the auto-drain stands down, so
      the items it is about to send cannot also be drained by the turn it just
      cancelled. Null when idle. */
  queueChain: Promise<unknown> | null;
  /** The thread this one is a workflow step of (workflows.ts), else null. A
      child never pushes, is never idle-retired, is hidden from the sidebar and
      is never handed the workflow server itself. Persisted. */
  parentSessionId: string | null;
  /** Where this thread was forked from (`SessionManager.fork`), else null both.
      Provenance only — drawn as a chip, never followed by a query. A branch is
      its own thread in every other respect: sidebar-visible, push-enabled,
      retired and revived on its own clock. Persisted. */
  forkedFromSessionId: string | null;
  forkedFromTurnId: string | null;
  /** How this thread answers the agent's own questions, or null for the
      ordinary thread with a human in front of it (`autonomy.ts`).

      In memory only — deliberately NOT a column. It is set when something
      starts an unattended run and it dies with the process, because a run a
      person later revives by hand is a thread with a human in front of it and
      must not inherit a standing grant from whatever started it. Persisting it
      would make "open last night's run and continue it" silently autonomous,
      which is exactly the surprise this feature cannot afford. It does survive
      a *respawn* — a profile change, a revive inside the run — because the
      field is on the session and the bridge reads it back through its host
      rather than being handed it at spawn. */
  autonomy: AutonomyPolicy | null;
  /** The run deadline's timer. Armed once, on the SESSION, when a policy naming
      `maxRunSeconds` is set — never per prompt: a queue drain starts a second
      turn on the same run, and a deadline that reset with each turn would not
      be a deadline. Cleared by `retire`. */
  deadline: ReturnType<typeof setTimeout> | null;
  /** How many of this thread's questions fell through to `askFallback` because
      nobody came. What lets a caller call such a run *blocked* — a state a
      person can act on — rather than merely finished, and distinct from a run
      that was refused something by policy and carried on to say so. Goes with
      the process; nothing durable reads it yet. */
  autonomyBlocked: number;
  /** Why the harness cancelled this thread's turn, when it was the harness and
      not a person. A Stop and a run deadline are the same `stopReason:
      "cancelled"` on the wire, and the caller waiting on the turn has no other
      way to tell "the user pressed Stop" from "this run ran out of time".
      Cleared with the process. */
  cancelReason: "deadline" | null;
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
export async function mcpServersFor(
  links: Pick<LinkSet, "mcpServerIds">,
  project: Pick<Project, "id">,
  config: ReturnType<typeof loadConfig>,
  /** The `workflow` server as this thread may have it — null for a thread
      that must not (a workflow step: one level, never a tree). */
  workflow: StdioMcpServer | null = null,
): Promise<{ servers: acp.McpServer[]; skipped: string[] }> {
  const linked = new Set(links.mcpServerIds);
  const servers: acp.McpServer[] = [];
  /** Linked rows that resolved to nothing and *could* have resolved to
      something — an OAuth server nobody has connected. Not an error and not
      journaled: nothing failed, the thread simply spawned without a tool it
      was never able to use. */
  const skipped: string[] = [];
  for (const s of (await mcpLibrary.list())) {
    if (!linked.has(s.id)) continue;
    if (s.type === "builtin") {
      const built =
        s.builtin === "web-search"
          ? websearchServer(config)
          : s.builtin === "knowledge"
            ? knowledgeServer(project)
            : workflow;
      if (built) servers.push(built);
    } else if (s.type === "http") {
      /* An OAuth row is handed to the agent as the shim's loopback URL, never
         its own: the token is short-lived and the child must never hold it
         (mcp-shim.ts). Unconnected, it is not advertised at all — the rule the
         built-in web-search row already sets, that a tool which cannot answer
         is worse than an absent one. The user's static headers still travel,
         since a row may carry both. */
      if (s.auth !== "oauth") servers.push({ type: "http", name: s.name, url: s.url, headers: s.headers });
      else {
        const proxied = (await isMcpConnected(s.id)) ? mcpProxyUrlFor(s.id) : "";
        if (proxied) servers.push({ type: "http", name: s.name, url: proxied, headers: s.headers });
        else skipped.push(s.id);
      }
    } else {
      servers.push({ name: s.name, command: s.command, args: s.args, env: s.env });
    }
  }
  return { servers, skipped };
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
    session runs in — which is why it cannot be a stored command. The
    connection string goes with it: the subprocess opens its own connection to
    the same database, and must not import `config.ts` to find it. */
export function knowledgeServer(project: Pick<Project, "id">): StdioMcpServer {
  return harnessMcpServer(
    KNOWLEDGE_SERVER_NAME,
    "knowledge-mcp",
    toKnowledgeServerEnv(project.id, databaseUrl()),
  );
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

/** How long a hold — a turn held on a failure, or a pause the user asked for,
    turn or no turn — keeps its process alive with nobody attached. Long,
    because a hold exists to be come back to — but finite, because rate limits
    are common and a leaked process per one is not. */
const HELD_TURN_MAX_MS = 6 * 60 * 60_000;

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
    /* A quota probe is a second copy of the runtime's CLI on the same login, so
       it must not be spawned while one of ours is holding it — see the header in
       quota.ts. The manager owns the children, so it is what answers. */
    setRuntimeLiveCheck((agentId) => {
      for (const s of this.sessions.values()) if (s.proc && s.agentId === agentId) return true;
      return false;
    });
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
    /* The constructor cannot await, and both of these read the database. They
       are held on `ready` instead, and every entry point that touches
       `this.sessions` waits for it — `reload` ends by *purging* every session
       whose row it did not see, so a `create` that raced it had its thread
       deleted out from under the caller. */
    this.ready = (async () => {
      await this.pruneJournals();
      await this.reload();
    })().catch((error) => console.error("[sessions] boot read failed", error));

    /* What answers a `/gw/<key>/s/<id>/…` request. The shim asks per request
       rather than being told at spawn, which is the whole of "the endpoint,
       credentials and model behind a running child are still ours to change"
       — see `applyConfig`. */
    setGatewaySessionResolver(async (id) => await this.gatewayStateOf(id));

    const idleMs = idleMinutes * 60_000;
    setInterval(async () => {
      for (const s of this.sessions.values()) {
        /* Not a thread mid-turn: a parent blocked inside a workflow call with
           no browser open was being retired under it. And never a workflow
           step, which has no peers by design — its lifetime is its run's. */
        /* A held turn is still `promptActive`, so it would keep its process
           alive forever with nobody reading it — whether the runtime held it
           on a failure or the user paused it. And a pause with no turn open is
           the other way round: nothing is active, so the ordinary sweep would
           retire it and the revive would come back unpaused, silently. So any
           hold is kept off the sweep, and given up on after the same long
           while — a cancel, which lifts the hold and ends the turn cleanly,
           parks the queue and leaves no error card — and the ordinary sweep
           retires it next time round. Generous, because the whole point of a
           hold is that somebody may come back to it. */
        const bridge = s.bridge;
        if (bridge?.paused && bridge.heldSince !== null && s.peers.size === 0) {
          if (Date.now() - bridge.heldSince > HELD_TURN_MAX_MS) {
            console.warn(`[${s.id.slice(0, 8)}] hold (${bridge.pausedReason}) gave up after ${Math.round(HELD_TURN_MAX_MS / 3_600_000)}h with no reader`);
            void bridge.cancel().catch(() => {});
          }
          continue;
        }
        if (s.parentSessionId || bridge?.promptActive) continue;
        if (!s.exited && s.peers.size === 0 && s.detachedAt && Date.now() - s.detachedAt > idleMs) {
          this.retire(
            s,
            `Nobody had this thread open for ${idleMinutes} minutes, so its agent process was stopped to free it. The conversation is kept — sending a message starts the agent again.`,
          );
        }
      }
    }, 60_000).unref();
    // Retention is checked at boot and then hourly, so a server that runs for
    // months does not accumulate every thread it ever ran.
    setInterval(async () => this.pruneJournals(), 3_600_000).unref();
    /* Uploads nobody ever sent, on the same clock. An attachment is claimed by
       the prompt that references it (see attachments.ts); one that never was
       is a draft the user abandoned, and keeping it is a disk leak with no
       reader. */
    void sweepAttachments().catch((error) => console.error("[attachments] sweep failed", error));
    setInterval(() => {
      void sweepAttachments().catch((error) => console.error("[attachments] sweep failed", error));
    }, 3_600_000).unref();
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
  /** The boot read (`pruneJournals` + `reload`), which the constructor starts
      and every public entry point awaits before it touches `this.sessions`. */
  readonly ready: Promise<void>;

  async reload(): Promise<void> {
    const counts = await this.log.nextSeqBySession();
    /* Rows written before `last_activity_at` existed carry 0, and a thread
       that has never been ordered by activity would sort to the bottom of a
       list it may well belong at the top of. The journal already knows when it
       was last written to, so the backfill is one grouped scan here rather
       than a migration — and it is written back, so it happens once. */
    const activity = await this.log.lastActivityBySession();
    const rows = await db.select().from(sessionsTable);
    const links = await readLinks(SESSION_LINKS, rows.map((r) => r.id));
    const seen = new Set<string>();
    const backfilled: Session[] = [];
    for (const row of rows) {
      seen.add(row.id);
      const current = this.sessions.get(row.id);
      if (current && !current.exited) continue;
      if (current)
        this.closePeers(current, 4000, "The server reloaded this thread's record, so its connection was replaced.");
      const lastActivityAt =
        row.lastActivityAt || activity.get(row.id) || row.createdAt;
      const session: Session = {
        ...row,
        lastActivityAt,
        links: links.get(row.id) ?? emptyLinks(),
        acpSessionId: row.acpSessionId ?? undefined,
        // Null in the column, "" in memory: every other spawn input on the
        // session is a string, and "no persona" is not a third state.
        personaId: row.personaId ?? "",
        // Rows written before the mode column existed never picked one —
        // null is the agent's default, which is exactly what they had.
        modeId: row.modeId ?? null,
        // Same for the rest of the agent's selectors: a row written before the
        // column existed never recorded one, and "none recorded" is the empty
        // set, not a reason to restore anything.
        configChoices: row.configChoices ?? {},
        // Absent on rows written before the toggle existed — which never asked
        // either way — so missing reads as the default: on.
        suggestFollowups: row.suggestFollowups ?? true,
        // The same default-on bargain: a row written before the switch existed
        // never asked, and asking is the default.
        uiBlocks: row.uiBlocks ?? true,
        titleFromPrompt: null,
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
        quietLoad: false,
        stagedConfig: null,
        queueChain: null,
        /* Autonomy is not a column and never revives with a thread: a run a
           person opens by hand tomorrow is a thread with a human in front of
           it, and it must not come back holding last night's standing grant.
           See `Session.autonomy`. */
        autonomy: null,
        deadline: null,
        autonomyBlocked: 0,
        cancelReason: null,
        // All three belong to a process, and there is none until this thread is
        // revived — the spawn that revives it sets them from the row it reads.
        spawnProfileId: row.profileId,
        viaGateway: false,
        websearchViaMcp: false,
        websearchCalls: new Set(),
      };
      this.sessions.set(row.id, session);
      if (row.lastActivityAt !== lastActivityAt) backfilled.push(session);
    }
    for (const session of backfilled) this.persist(session);
    for (const [id, session] of this.sessions) {
      if (seen.has(id)) continue;
      this.closePeers(session, 4000, "This thread is no longer on the server.");
      this.retire(session, "This thread is no longer on the server, so its agent process was stopped.");
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
      this.closePeers(session, 4000, "A backup was imported, which restarts every thread it touched.");
      if (!session.exited)
        this.retire(
          session,
          "A backup was imported over this thread, so its agent process was stopped. The conversation is kept — sending a message starts the agent again.",
        );
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
      this.closePeers(session, 4000, "The server shut down, which stops every agent process with it.");
      if (!session.exited)
        this.retire(
          session,
          "The server shut down, which stops every agent process with it. The conversation is kept — sending a message starts the agent again.",
        );
    }
    this.log.flush();
  }

  /**
   * Write one session's durable fields. This used to rewrite the whole list on
   * every title sniff and every model change; now it touches one row, so it
   * stays cheap however many threads exist.
   *
   * **An UPDATE, never an upsert — this cannot create a row.** Two reasons, and
   * both were bugs:
   *
   *  - `INSERT … ON CONFLICT DO UPDATE` takes `FOR UPDATE` on the row, which
   *    conflicts with the `FOR KEY SHARE` every insert into `session_events`
   *    takes on its parent while the journal's flush transaction is open. A
   *    streaming turn flushes constantly, so the title sniff behind the first
   *    prompt — which is what makes that prompt's reply — waited seconds for a
   *    batch of its own events to commit. A plain UPDATE that leaves the key
   *    alone takes `FOR NO KEY UPDATE`, which does not conflict.
   *  - Several of these writes are started and not awaited (the agent's session
   *    id, a title the agent sent, the title sniff), so one can land after the
   *    `purge` that was meant to be the end of the thread. An upsert *put the
   *    row back* — with no links and nobody expecting it — and the journal rows
   *    buffered behind it then had a parent to attach to again.
   *
   * The row's existence belongs to `createRow` and `purge`. Nothing else.
   *
   * What is NOT here is deliberate: the conversation lives in the agent's own
   * session store and comes back through ACP session/load on revive.
   */
  private async persist(session?: Session): Promise<void> {
    const rows = session ? [session] : [...this.sessions.values()];
    for (const s of rows) {
      // A thread this manager no longer holds is one it has purged; the row is
      // gone and the update would match nothing anyway. Skipped rather than
      // sent, so a purge does not answer for every stale write behind it.
      if (this.sessions.get(s.id) !== s) continue;
      await db.update(sessionsTable).set(rowValues(s)).where(eq(sessionsTable.id, s.id));
    }
  }

  /** The row for a thread that does not have one yet — `create`, an import and
      a fork, which are the three places a session begins. Everything after is
      `persist`, which only ever updates. */
  private async createRow(session: Session): Promise<void> {
    await db.insert(sessionsTable).values(rowValues(session)).onConflictDoUpdate({
      target: sessionsTable.id,
      set: rowValues(session),
    });
  }

  /** The thread's own links are written once, at create — they do not change
      with a title sniff or a model switch, so `persist` leaves them alone. */
  private async persistLinks(session: Session): Promise<void> {
    await db.transaction(async (tx) => await writeLinks(tx, SESSION_LINKS, session.id, session.links));
    // What the tables kept (a stale id links nothing) is what the thread has.
    session.links = await linksOf(SESSION_LINKS, session.id);
  }

  /**
   * Everything a thread's agent is given: the thread's own picks.
   * Profiles carry no links — a profile is provider credentials.
   */
  effectiveLinks(session: Session, _profile = session.profile): LinkSet {
    return session.links;
  }

  /**
   * Write skills and commands into the project's cwd for the thread about to
   * spawn — and for every other thread live in the same cwd, because they
   * share it. The materializer sweeps what it does not write, so the set it is
   * handed is the union over all of them; a thread being spawned counts as
   * live already, and a retired one has no process to lose anything.
   */
  private async materializeFor(session: Session, profile: Profile, project: Project): Promise<void> {
    /* One sweep per *layout*, not one per cwd: where a skill or a command has
       to land is the runtime's fact (`AgentDef.workspaceLayout`), two runtimes
       may share a directory (claude-code and the harness's own agent both read
       `.claude`) and a runtime that reads neither — codex, which resolves both
       only under `$CODEX_HOME` — is written nothing at all. So the keep-set is
       the union across the live threads that share the layout being swept,
       which is the same rule as before with the right thing on both sides of
       it: unioning across the cwd would have one runtime's links deleted by a
       sweep of another's directory the moment the layouts differ. */
    ensureProjectDir(project.cwd);
    const layouts = new Map<string, { layout: WorkspaceLayout; sets: LinkSet[] }>();
    const agentCache = new Map<string, AgentDef | undefined>();
    const add = async (agentId: string, links: LinkSet) => {
      if (!agentCache.has(agentId)) agentCache.set(agentId, await getAgent(agentId));
      const layout = agentCache.get(agentId)?.workspaceLayout;
      if (!layout) return;
      const key = JSON.stringify(layout);
      const entry = layouts.get(key) ?? { layout, sets: [] };
      entry.sets.push(links);
      layouts.set(key, entry);
    };
    await add(session.agentId, this.effectiveLinks(session, profile));
    for (const other of this.sessions.values()) {
      if (other === session || other.exited || other.deletedAt !== null) continue;
      if (other.project?.cwd !== project.cwd) continue;
      await add(other.agentId, this.effectiveLinks(other));
    }
    for (const { layout, sets } of layouts.values()) {
      materializeWorkspace(project.cwd, layout, unionLinks(...sets));
    }
    /* The attachments materialised into `<cwd>/.daedalus/attachments/` follow
       the same rule and for the same reason: the directory is shared by every
       thread of the project, so the keep-set is the union across every live
       thread in this cwd — sweeping one thread's alone would delete the file
       the thread beside it just linked. `.daedalus/` is not covered by the
       project's own gitignore (we write one into it), so this sweep is the only
       thing keeping it from growing. */
    const cwds = [session, ...this.sessions.values()].filter(
      (s) => s.deletedAt === null && (s === session || (!s.exited && s.project?.cwd === project.cwd)),
    );
    sweepMaterialisedAttachments(project.cwd, await claimedAttachmentIds(cwds.map((s) => s.id)));
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
  private async pruneJournals(): Promise<void> {
    const days = this.journalRetentionDays;
    if (days < 0) return;
    const cutoff = days === 0 ? Date.now() : Date.now() - days * 86_400_000;
    const live = [...this.sessions.values()].filter((s) => !s.exited).map((s) => s.id);
    for (const id of (await this.log.prune(cutoff, live))) {
      const session = this.sessions.get(id);
      if (session) session.eventCount = 0;
    }
    /* The web-search usage ledger ages out on the same clock: it is metadata
       about transcripts whose archives were just judged by this cutoff. */
    const usageDropped = await pruneWebSearchUsage(cutoff);
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
  async journal(id: string): Promise<{ cursor: number; events: ThreadEvent[] } | undefined> {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    return { cursor: session.eventCount, events: await this.log.eventsFrom(session.id, 0) };
  }

  /** One page of the journal for the trace view — the newest `limit` events
      before `before`, or the whole tail when `before` is 0/absent. Undefined
      for a thread this server does not hold. The page's own `next` is the seq
      to page older from, computed here where `eventCount` — the head of the
      log — is known. */
  async trace(id: string, before: number, limit: number): Promise<TracePage | undefined> {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    const from = Number.isFinite(before) && before > 0 ? before : session.eventCount;
    const events = await this.log.trace(id, from, limit);
    const next = events.length > 0 && events[0].seq > 0 ? events[0].seq : null;
    return { events, next };
  }

  // ---- fan-out ----

  private send(peer: Peer, event: ThreadEvent): void {
    sendToPeer(peer, JSON.stringify(event));
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
    /* A respawn that kept the journal is being handed the conversation back by
       `session/load`, and every word of it is already a row in that journal.
       Dropped here rather than by clearing the log first, because the clear is
       what made a config change cost every peer a reattach and a rebuild — and
       what took the turn boundaries with it, which `rewindPoint`, the turn
       table of contents and every window are read from. See `respawnNow`. */
    if (session.quietLoad && event.ev === "update" && event.historyReplay) return;
    // A mirrored event is a step's, already recorded under the step's own
    // thread — counting it again here would bill every search twice.
    if (!mirrored && session.websearchViaMcp && event.ev === "update" && !event.historyReplay) {
      void recordWebSearchUsage({
        sessionId: session.id,
        threadTitle: session.title,
        profileId: session.profileId,
        profileName: session.profile?.name ?? session.profileId,
        projectId: session.projectId,
        projectName: session.project?.name ?? session.projectId,
      }, event.update, session.websearchCalls).catch((error) =>
        console.error("[websearch] usage write failed", error),
      );
    }
    /* How full the agent says its context window is. Kept on the session
       because it is current state rather than history — see `Session.context`:
       the replay a client folds may carry no reading (a short window) or an
       older one (a `load_earlier` page), and both used to be what the ring
       drew. A child's reading is the child's step's, never the thread's, which
       is the same line the reducer draws. Not persisted here: the turn
       boundary below already writes this row, and until it does the live
       session answers `caught_up` from memory. */
    if (
      event.ev === "update" &&
      !event.sessionId &&
      event.update.sessionUpdate === "usage_update"
    ) {
      session.context = event.update;
    }
    /* A turn is the unit of activity. Both ends of it are journaled exactly
       once, so bumping here costs one row write per turn rather than one per
       streamed token — and a thread merely opened to read yesterday's work
       does not claim to be today's, because attaching journals nothing. */
    if (event.ev === "turn_started" || event.ev === "turn_ended") {
      session.lastActivityAt = Date.now();
      /* And what the turn did to the worktree, measured by git rather than
         read off the transcript (turn-changes.ts). Off the prompt path: both
         calls return at once and do their git work on the next tick. */
      if (event.ev === "turn_started") this.turnChanges.begin(session.id, event.turnId);
      else this.turnChanges.end(session.id, event.turnId);
      /* And how that turn went, in the same write. A turn beginning clears the
         last one's failure — the thread is being worked on again, and a row
         that still said "failed" would be describing a turn two ago — and a
         turn ending states its own verdict, which for a clean or cancelled one
         is null. Only a top-level turn: a workflow step's `turn_ended` is
         never mirrored onto its parent, so a failed step marks the step. */
      session.lastTurnError =
        event.ev === "turn_ended" && event.error
          ? event.error.message.slice(0, LAST_ERROR_MAX)
          : null;
      this.persist(session);
      /* A staged change used to be flushed here, at `turn_ended`. It is not any
         more: the change is taken by the next *spawn* (`respawnNow` folds it)
         and by the next *turn* (`prompt` flushes it), never by the end of the
         last one. Restarting the agent the moment a turn ended spent a spawn on
         a user who was still reading the answer. */
    }
    const out = JOURNALED.has(event.ev) ? this.log.append(session, event) : event;
    const subs = this.subscribers.get(session.id);
    if (subs) for (const fn of subs) fn(out);
    if (session.peers.size === 0) return;
    const line = JSON.stringify(out);
    for (const peer of session.peers) if (peer !== except) sendToPeer(peer, line);
  }

  /**
   * Re-read this thread's subscription quota and tell its peers, after a turn.
   *
   * Four things it refuses to do, each for its own reason. It skips a pair with
   * **no plan to read** (`planReadable`): a stored profile with no usage
   * provider is a gateway or an API key, billed per token, and the reading an
   * agent probe would give back belongs to the machine's login rather than to
   * that profile — the composer draws no card for it, so no CLI is spawned
   * after every turn. A thread on the agent's **Default** profile is the other
   * way round: it runs on the machine's login, so the probe's reading is
   * exactly the plan this turn spent, and it is refreshed here. It does nothing for a **child
   * session**: a workflow's five steps are five settled turns on one account,
   * and probing per step would spawn five CLIs to learn the same number — the
   * parent's own turn covers the run. It does nothing with **no peer attached**:
   * the reading is for a screen, and a thread draining a queue overnight should
   * not be spawning a process per turn for nobody. And it **swallows its own
   * failure**: a missing `claude` binary must not surface as an error on a turn
   * that succeeded — `getQuota` already records that verdict for the settings
   * page to show, where it is the answer to a question someone actually asked.
   *
   * Deliberately not awaited. The turn is settled; nothing downstream of it may
   * wait on a child process.
   */
  private async refreshQuota(session: Session): Promise<void> {
    if (session.parentSessionId || session.peers.size === 0) return;
    const agent = await getAgent(session.agentId);
    const profile = session.profile ?? (await getProfile(session.profileId));
    const project = session.project ?? (await getProject(session.projectId));
    /* Only a plan the turn actually spent is the turn's to report: the
       profile's own provider, or — on a Default profile, which carries no
       credentials — the machine's `claude`/`codex login` the agent probe
       reads. A stored profile with neither is billed per token and has
       nothing here to say. */
    if (!agent || !profile || !project || !planReadable(profile, agent)) return;
    /* The provider reading is one HTTP call, so it is taken again for the turn
       that just moved it. The agent probe is a *process* — ~2.3s of `claude -p
       /usage` — and a turn is not worth spawning one for, so that side rides
       the 5-minute TTL instead: fresh enough for a glance, and one spawn
       however many turns land inside the window. */
    if (profileUsage(profile)) await invalidateQuota(profile, agent.id);
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

  /* The ring itself — push, mark, enrich, reset — lives in stderr-ring.ts,
     operating on the session's own `stderr`/`stderrCount`/`stderrMark`. */

  /** The agent's recent stderr, for a client that wants to see why a thread is
      misbehaving. Read-only; the server's console gets it either way. */
  stderrTail(id: string): string[] {
    return this.sessions.get(id)?.stderr ?? [];
  }

  // ---- process lifecycle ----

  /** The bridge-callback adapter lives in bridge-host.ts, beside the bridge it
      serves, behind a port of exactly the manager methods it needs. */
  private hostFor(session: Session): BridgeHost {
    return makeBridgeHost(session, {
      emit: (s, event, except) => this.emit(s, event, except),
      settleWaiters: (s, turnId, outcome) => this.settleWaiters(s, turnId, outcome),
      refreshQuota: (s) => this.refreshQuota(s),
      drainQueue: (s) => this.queue.drain(s),
      emitQueue: (s) => this.queue.emitQueue(s),
      persist: (s) => this.persist(s),
      events: this.events,
    });
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
      pushStderr(session, text);
    });
    // spawn() reports a missing binary, a bad cwd or a permissions problem
    // asynchronously — and an unhandled 'error' on a ChildProcess takes the
    // whole server down with it. Treat it as an immediate exit and tell the
    // client what the OS said, which is the only useful thing anyone has.
    proc.on("error", (error: NodeJS.ErrnoException) => {
      if (session.bridge !== bridge) return;
      const reason = `agent failed to start: ${error.code ?? error.name} — ${error.message}`;
      console.error(`[${session.id.slice(0, 8)}:${profileName}]`, reason);
      pushStderr(session, reason);
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
    /* Nothing is going to reach that turn's boundary now — the process holding
       it is gone. A change left staged would be applied by whatever revived the
       thread hours later, which is a setting moving on its own. */
    this.clearStaged(session);
    bridge.close(new Error(reason));
    this.processGone(session, reason);
    setTimeout(() => {
      if (session.bridge !== bridge) return;
      this.closePeers(session, 4001, reason);
    }, 0).unref();
  }

  /** `id` lets the client name the thread it has already routed to; the caller
      is responsible for having checked that it is a free UUID. Without one the
      server names it, which is still the path the API takes when asked. */
  async create(
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
      /** How this thread should be worked on — picked on the draft, and (for a
          workflow step) inherited from the parent along with everything else. */
      personaId?: string;
      /** Whether the agent should close answers with follow-up suggestions —
          picked on the draft like the persona, and free there: nothing is
          running yet, so there is no respawn to pay for. */
      suggestFollowups?: boolean;
      /** Whether answers may carry a drawn view — the same draft-picked,
          spawn-input bargain as the suggestions toggle. */
      uiBlocks?: boolean;
      /** The permission mode picked on the draft, out of the agent's probed
          `modes`. Applied over `session/set_mode` right after session/new —
          the same door a live mode change uses, so a later respawn puts it
          back through `captureRestoreState` like any mode the user picked
          mid-conversation. Best-effort: an agent without modes ignores it. */
      modeId?: string;
      /** Answer the agent's own questions for the user instead of parking them
          (`autonomy.ts`). Given here rather than set afterwards because the
          first question can arrive before the caller's next statement runs: the
          handshake and the first prompt are already in flight by the time
          `create` returns, and a policy applied a tick late is a policy that
          missed the request it existed for. */
      autonomy?: AutonomyPolicy;
    } = {},
  ): Promise<Session> {
    await this.ready;
    const session = this.blankSession(profile, agentId, project, links, {
      id,
      model,
      effort,
      modeId: opts.modeId,
      personaId: opts.personaId,
      suggestFollowups: opts.suggestFollowups,
      uiBlocks: opts.uiBlocks,
      title: opts.title,
      parentSessionId: opts.parentSessionId,
      autonomy: opts.autonomy,
    });
    this.sessions.set(session.id, session);
    // Before the bridge: the event rows reference this one, so the session has
    // to exist by the time the agent's first update arrives.
    await this.createRow(session);
    await this.persistLinks(session);
    await this.start(session, profile, project, model, effort, {
      configChoices,
      restore: opts.restore,
      modeId: opts.modeId,
    });
    /* Again, now that the handshake has answered. What it answered with — the
       agent's session id above all — is written by a callback whose own write
       is not awaited by anything (`onAcpSessionId`), so it is only as durable
       as whatever the connection pool is doing. `create` returning is the
       moment a caller is entitled to assume the row matches the thread, and an
       id that never reached the row is a conversation the next boot cannot
       find. */
    await this.persist(session);
    this.armDeadline(session);
    return session;
  }

  /**
   * Change (or drop) a live thread's autonomy policy.
   *
   * Exists because a policy has to be lowerable under a running process — the
   * dry-run switch, and "stop answering for me" on a run somebody is now
   * watching — without killing the agent mid-tool-call. That is also why the
   * bridge reads the policy through its host on every request instead of being
   * handed one at spawn: this method would otherwise only take effect at the
   * next respawn, which for a run in flight is never.
   *
   * The deadline is armed but never re-armed: a policy raised mid-run must not
   * be able to buy the run more wall-clock than it started with, or the ceiling
   * is advisory.
   */
  setAutonomy(id: string, policy: AutonomyPolicy | null): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.autonomy = policy;
    this.armDeadline(session);
  }

  /**
   * Arm the run deadline, once, on the session.
   *
   * Not on a prompt: a queue drain starts a second turn on the same run, and a
   * deadline that reset with it would not be a deadline — an unattended thread
   * that keeps finding something else to say would never reach one. It fires
   * through the ordinary `cancel()`, which notifies the agent and answers every
   * question it is still blocked on, so a deadline looks to the rest of the
   * system exactly like a Stop. `cancelReason` is what tells the two apart.
   */
  private armDeadline(session: Session): void {
    const seconds = session.autonomy?.maxRunSeconds ?? 0;
    if (seconds <= 0 || session.deadline) return;
    const timer = setTimeout(() => {
      session.deadline = null;
      const bridge = session.bridge;
      if (session.exited || !bridge) return;
      session.cancelReason = "deadline";
      /* Swallowed: the deadline fires from a timer with nobody to reject to,
         and a cancel that fails on a process already going away is not news. */
      void bridge.cancel().catch(() => {});
    }, seconds * 1000);
    timer.unref();
    session.deadline = timer;
  }

  /** A thread with no process behind it yet — everything `create` and `import`
      agree on, which is every field but the ones a spawn fills in. */
  private blankSession(
    profile: Profile,
    agentId: string,
    project: Project,
    links: LinkSet,
    opts: {
      id?: string;
      model?: string;
      effort?: string;
      modeId?: string | null;
      personaId?: string;
      suggestFollowups?: boolean;
      uiBlocks?: boolean;
      title?: string;
      parentSessionId?: string;
      autonomy?: AutonomyPolicy;
      /** Where a forked thread was branched from — the parent's id and the
          turn the branch carries through. Provenance only; see `Session`. */
      forkedFrom?: { sessionId: string; turnId: string };
      /** An imported thread already had a life before this row existed; its
          own last-activity time is where it belongs in the list. */
      createdAt?: number;
    },
  ): Session {
    const now = Date.now();
    return {
      id: opts.id ?? randomUUID(),
      profileId: profile.id,
      projectId: project.id,
      links,
      /* A thread is a (profile, agent) pair: the profile is the provider, and
         it may serve several agents, so which one answers here is its own
         choice, made at draft time and kept for the thread's life. */
      agentId,
      profile,
      project,
      model: opts.model || profile.defaultModel || "",
      effort: opts.effort ?? "",
      modeId: opts.modeId ?? null,
      /* A draft's picks are passed to `start` as `configChoices` and land here
         the moment the agent confirms them (`onSpawnStateChange`), so a fresh
         row starts empty rather than claiming settings no process has taken. */
      configChoices: {},
      personaId: opts.personaId ?? "",
      suggestFollowups: opts.suggestFollowups ?? true,
      uiBlocks: opts.uiBlocks ?? true,
      title: opts.title ?? "New thread",
      titleFromPrompt: null,
      acpSessionProvisional: false,
      liveAcpSessionId: null,
      historyLost: null,
      createdAt: opts.createdAt ?? now,
      lastActivityAt: opts.createdAt ?? now,
      lastTurnError: null,
      context: null,
      eventCount: 0,
      stderr: [],
      stderrCount: 0,
      stderrMark: 0,
      proc: null,
      bridge: null,
      peers: new Set(),
      detachedAt: now,
      deletedAt: null,
      pinnedAt: null,
      exited: false,
      respawnChain: null,
      quietLoad: false,
      stagedConfig: null,
      queueChain: null,
      parentSessionId: opts.parentSessionId ?? null,
      forkedFromSessionId: opts.forkedFrom?.sessionId ?? null,
      forkedFromTurnId: opts.forkedFrom?.turnId ?? null,
      autonomy: opts.autonomy ?? null,
      deadline: null,
      autonomyBlocked: 0,
      cancelReason: null,
      spawnProfileId: profile.id,
      viaGateway: false,
      websearchViaMcp: false,
      websearchCalls: new Set(),
    };
  }

  /**
   * Adopt a conversation that already exists in the agent's own store.
   *
   * The whole of a thread's identity is `acpSessionId` — the conversation lives
   * in the agent, and a revive is `session/load` (see `respawnNow`). So an
   * import writes a *pointer* and nothing else: no process is spawned, no
   * transcript is copied, and the row it leaves is exactly the shape an
   * idle-retired thread has after a restart. Opening it takes the revive path
   * every retired thread takes, which is what loads the history, journals it and
   * indexes it for search.
   *
   * The id is not provisional: the agent listed this session itself, so it is as
   * proven as an id gets before a turn settles on it — and if the load is
   * refused anyway, keeping it is what lets the next attempt try again instead
   * of stranding a transcript that is still on disk.
   */
  importSession(
    profile: Profile,
    agentId: string,
    project: Project,
    info: { acpSessionId: string; title?: string | null; updatedAt?: string | null },
    links: LinkSet = emptyLinks(),
  ): Session {
    const updatedAt = info.updatedAt ? Date.parse(info.updatedAt) : NaN;
    const session = this.blankSession(profile, agentId, project, links, {
      title: info.title?.trim() || "Imported thread",
      createdAt: Number.isNaN(updatedAt) ? undefined : updatedAt,
    });
    session.acpSessionId = info.acpSessionId;
    session.titleFromPrompt = null;
    // No process, and none until someone opens it. `exited` is what every path
    // that asks "is this thread live" reads, including the client's own
    // openThread — which is the one that revives it.
    session.exited = true;
    this.sessions.set(session.id, session);
    void this.createRow(session);
    this.persistLinks(session);
    return session;
  }

  /** Spawn a process for this session and put an ACP client in front of it. */
  private async start(
    session: Session,
    profile: Profile,
    project: Project,
    model: string | undefined,
    effort: string | undefined,
    opts: {
      load?: { acpSessionId: string };
      restore?: import("./protocol.js").RestoreState;
      configChoices?: Record<string, string | boolean>;
      modeId?: string;
    },
  ): Promise<AcpBridge> {
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
    const agent = await getAgent(session.agentId);
    /* The allowlist an `"acp"`-live agent builds its model picker from. Written
       before the spawn because it is read once, at `session/new`, and it is the
       union across every profile that serves this agent rather than this one's
       — a thread outlives its profile, and a list scoped to the spawning
       profile would make the next one's models unreachable without exactly the
       restart this is here to avoid. Empty for a profile with no catalog, which
       hands the picker back to the agent's own models. Which file it goes in
       is the layout's (`workspaceLayout.modelAllowlist`), so an `"acp"`-live
       runtime that reads its picker somewhere else — or nowhere — is written
       nothing rather than a Claude Code settings file it will never open. */
    const allowlist = agent?.workspaceLayout;
    if (agent?.liveConfig === "acp" && allowlist) {
      materializeModelAllowlist(project.cwd, allowlist, modelAllowlistFor(agent, profile, await listProfiles()));
    }
    session.spawnProfileId = profile.id;
    session.viaGateway = !!gatewayUrlFor(profile.id, session.agentId, profileBaseUrl(profile, session.agentId), session.id);
    /* Resolved once and handed to both halves, because which half uses it is
       the agent's business and not this one's: `spawnAgent` places it in the
       env for an `"env"` agent, `AcpBridge` puts it in the handshake `_meta`
       for an `"acp-meta"` one, and each ignores it for the other kind. Called
       unconditionally — a thread that has just had its persona removed needs
       the stale prompt file cleared as much as one that gained a persona needs
       it written. */
    const rules = [...(await globalRules()), ...(await projectRules(project.id))];
    /* Nobody in front of a workflow step or a scheduled run: `autonomy` is null
       exactly for the thread with a human at it (see `Session.autonomy`). */
    const unattended = !!session.parentSessionId || session.autonomy !== null;
    const persona = await resolvePersonaSpawn(
      session.id,
      session.personaId,
      agent,
      {
        suggestFollowups: session.suggestFollowups,
        /* A drawn view is read by a person; an unattended run's output goes to
           a log and wants prose it can grep. */
        uiBlocks: session.uiBlocks && !unattended,
      },
      rules,
    );
    /* An agent whose children never reach ACP is given a port and a secret so
       the server can read them off its own event bus (opencode-subagents.ts).
       Minted here, per spawn, never stored — like the gateway key. The pool
       is empty only in the first moments after boot; a thread spawned then
       runs without the feed and the log says so, rather than waiting. */
    const wantsFeed = agent?.subagentFeed === "opencode-http";
    const feedPort = wantsFeed ? this.ports.take() : undefined;
    const sidecar = feedPort ? { port: feedPort, password: randomBytes(24).toString("hex") } : undefined;
    if (wantsFeed && !sidecar) console.warn(`[${session.id.slice(0, 8)}] no port ready for the subagent feed; spawning without it`);
    const proc = await spawnAgent(
      profile,
      session.agentId,
      project,
      ownsCatalog ? model : undefined,
      ownsCatalog ? effort : undefined,
      session.id,
      persona,
      sidecar,
      /* Nobody is going to change the model for a workflow step or a scheduled
         run, and `whenTurnSettled` is what both wait on — so a held turn there
         is a run that never reports. */
      unattended,
    );
    const feed = sidecar
      ? new OpencodeSubagentFeed({
          ...sidecar,
          /* The bridge below fills this on `session/new`/`session/load`; the
             feed holds a child seen before then and re-checks it after. Read
             through the session so a respawn's stale feed sees null, not the
             successor's id. */
          rootSessionId: () => (session.proc === proc ? session.bridge?.acpSessionId ?? null : null),
        })
      : undefined;
    if (feed) proc.on("close", () => feed.close());
    const { mcpServers, websearchViaMcp, workflowViaMcp } = await this.serversFor(session, profile, project);
    session.websearchViaMcp = websearchViaMcp;
    session.websearchCalls = new Set(); // in-flight calls went with the old process
    // Both belong to the process about to be replaced, and the handshake below
    // is what fills them in again — a stale "history lost" would outlive the
    // load that failed and mark a thread that has just been restored fine.
    session.liveAcpSessionId = null;
    session.historyLost = null;
    const bridge = new AcpBridge(this.hostFor(session), agentStream(proc, feed?.stream), {
      cwd: project.cwd,
      mcpServers,
      ...opts,
      agentOwned: ownsCatalog ? undefined : { model, effort },
      websearchViaMcp,
      workflowViaMcp,
      /* Which of the runtime's own tools the two servers above stand in for,
         and how to switch them off. The bridge used to hold the answer for one
         runtime as two literal name lists; it is the row's, so an agent with
         no entry keeps its built-ins and one that grows a switch can say so. */
      builtinTools: agent?.builtinTools ?? null,
      persona: agent?.personaVia === "acp-meta" ? persona : undefined,
      /* The profile may opt out of Codex's fallback-metadata notice; the
         bridge is where it is dropped, so this is where the flag lands (see
         acp-bridge.ts). */
      suppressModelMetadataWarning: profile.suppressModelMetadataWarning === true,
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
      harness's web-search server is among them — the bridge turns the runtime's
      own web tools off when it is (`AgentDef.builtinTools`), and usage is
      recorded. */
  private async serversFor(session: Session, profile: Profile, project: Project): Promise<{
    mcpServers: acp.McpServer[];
    websearchViaMcp: boolean;
    workflowViaMcp: boolean;
  }> {
    // getConfig, not loadConfig: this runs on every spawn, and re-reading and
    // re-parsing config.json each time bought nothing — saveWebSearch is the
    // only runtime writer and it invalidates the cache.
    /* A workflow step is never handed the workflow server, whatever its
       profile links: a step that could start a workflow makes the lifetime
       accounting — caps, cancel propagation, restart recovery — a tree, and a
       definition that spawns itself the obvious failure. One level.

       Neither is a runtime that brings a workflow engine of its own
       (`AgentDef.workflowsVia === "native"`, which today is Claude Code). The
       harness's server exists because Codex and OpenCode have nothing like a
       workflow; Claude Code's `Workflow` tool writes a *script* — loops,
       branching, fan-out over a list it discovered — where a definition here is
       a static graph of at most 16 steps, and the harness can now draw its runs
       (`AIR_ASYNC_TASKS_META` in acp-bridge.ts, `nativeWorkflowRun` in the
       client), which is the only thing it ever lacked. Handing such a runtime
       the lesser engine AND disallowing its own — which is what linking the
       server does, see `workflowViaMcp` — would be trading down.

       Read off the row and not compared against a literal id, which is what it
       was: a fork of claude-agent-acp under another id got the lesser engine
       *and* kept its own, and a runtime that grows a workflow engine could not
       say so without an edit here.

       Enforced here rather than left to whoever edits the profile's links:
       the two decisions are one decision, and a half-applied one silently
       costs the better tool. */
    const ownsWorkflows = (await getAgent(session.agentId))?.workflowsVia === "native";
    const workflow =
      this.workflowRunner && !session.parentSessionId && !ownsWorkflows
        ? workflowServer(session, this.workflowRunner)
        : null;
    const { servers: mcpServers, skipped } = await mcpServersFor(
      this.effectiveLinks(session, profile),
      project,
      getConfig(),
      workflow,
    );
    if (skipped.length) {
      console.log(
        `[mcp] ${session.id}: skipped ${skipped.length} unauthorized MCP server(s) — connect them in Settings › MCP servers`,
      );
    }
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
  private async gatewayStateOf(id: string): Promise<GatewaySession | undefined> {
    const session = this.sessions.get(id);
    if (!session || !session.profile) return undefined;
    const agent = await getAgent(session.agentId);
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
   *  - a thread with no live process at all, which is a revive;
   *  - a **persona** change, which is not a matter of conservatism at all but
   *    of where the value is read: every runtime takes a persona only as a
   *    session is created or loaded (`personas.ts`), so there is no live path
   *    to be careful about. The suggestions toggle rides the same rule: its
   *    trailer is folded into the same spawn text. The respawn is cheap in the way that matters —
   *    it ends in `session/load`, so the conversation comes back with it.
   *
   * Answers `{ live }` so the caller can tell a client whether its socket
   * survived: a respawn clears the event log and every peer has to reattach,
   * and a live change is invisible to all of them but the menu that asked.
   *
   * Two things it does NOT do any more, both of which were paid for by the
   * person holding the menu:
   *
   *  - **It does not restart anything when the setting is picked.** A change
   *    that costs the process is *staged* — held in `session.stagedConfig` —
   *    and the next **spawn** takes it: `respawnNow` folds the patch into
   *    whatever spawn happens next, and `prompt` makes one happen when a turn
   *    finds a patch outstanding. Two mechanisms, no third, no timer.
   *
   *    This used to be the mid-turn case only, and it was the smaller half. The
   *    other half respawned on the spot — which on a *retired* thread woke a
   *    process for nobody, and then paid for a second spawn when the next
   *    message revived it, and on a live one restarted the agent for a user who
   *    was still reading. `defer: false` is the explicit "now, and never mind
   *    what it costs"; a **held** turn is never staged (it is stopped *waiting*
   *    for this change — see the `paused` event); and an **agent** change is
   *    never staged either, because it is a different runtime rather than a
   *    setting on this one.
   *  - **It does not hold its answer open across the restart.** The respawn is
   *    spawn → `session/load` → restore, which is seconds; the decision above
   *    it is immediate. So the decision is answered and the sequence runs on,
   *    reporting itself to *every* peer through the `restart` event — which is
   *    also the first time a device that was not holding the menu has been told
   *    that its transcript is being replaced under it.
   */
  async applyConfig(
    id: string,
    next: {
      profile: Profile;
      agentId: string;
      project: Project;
      model?: string;
      effort?: string;
      personaId?: string;
      suggestFollowups?: boolean;
      uiBlocks?: boolean;
    },
    opts: { defer?: boolean; follow?: boolean } = {},
  ): Promise<{ live: boolean; staged?: StagedConfig; restarting?: boolean }> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(
      "This thread is not on this server. It may have been deleted, or the server may have restarted without it.",
    );
    if (session.deletedAt !== null)
      throw new Error(
        "This thread is in Trash. Restore it from the thread list before changing or starting it.",
      );
    /* A model belongs to the profile that lists it, and this is the one door
       every change comes through — so it is where the pair is made true. What
       gets here otherwise is a model id of the profile being *left*: no client
       is trusted to have cleared it, the staged path used to lose the clearing,
       and every later revive re-passes whatever the row ended up holding. */
    next = { ...next, model: modelFor(session, next.profile, next.model) };
    /* Before anything moves — including `applyConfigLive`'s own writes and the
       persona this method assigns below — so the rows can be the difference
       between two readings rather than a guess from the request. */
    const before = await this.configLabels(session);
    if (await this.applyConfigLive(session, next)) {
      /* Whatever was waiting for the boundary has just been overtaken for the
         fields this call names — leaving them staged would move the setting
         back the moment the turn ended. */
      this.dropStaged(session, next);
      this.noteConfig(session, before, await this.configLabels(session));
      return { live: true };
    }
    /* Nothing live could be done, so this costs the process — and a change that
       costs the process is not taken when it is picked. It is **staged**: held
       in `session.stagedConfig`, and the next spawn is what takes it
       (`respawnNow` folds the patch; `prompt` flushes it before starting a
       turn). Staging used to be the mid-turn case alone, and the idle case
       respawned on the spot — which on a *retired* thread woke a process up for
       nobody, and then paid for a second spawn when the next message revived it.
       Now the pick costs nothing and the send costs one spawn.

       Three exclusions, and only three:
        - `defer: false` — the menu's "Apply now", which is the whole of "now,
          and never mind what it costs";
        - a **held** turn, which is stopped *waiting* for a model change (see
          the `paused` event): staging one behind a boundary it will never reach
          is a change that never happens;
        - an **agent** change, which is not a setting on this process but a
          different runtime. `StagedConfig` cannot carry one — a mid-turn agent
          change used to be staged and then silently dropped at flush — and it
          must not learn to: a respawn onto another binary ends in a
          `session/load` of an id that lives in the *old* runtime's store, so
          the conversation is lost while the transcript still shows it. Nothing
          drives this from the UI (a started thread's agent is fixed at draft
          time); the guard is here so a script or a workflow cannot either. */
    const bridge = session.bridge;
    const movesAgent = next.agentId !== session.agentId;
    if (opts.defer !== false && !bridge?.paused && !movesAgent) {
      return { live: false, staged: this.stageConfig(session, next) };
    }
    /* The row moves before the respawn rather than being passed to it, because
       a persona is not a spawn argument the way model and effort are: `start`
       reads it off the session (it has to, since a revive with no caller
       spawns from the row alone). Written here so the process that comes back
       is the one the user asked for. */
    const changed = next.personaId !== undefined && next.personaId !== session.personaId;
    if (next.personaId !== undefined) session.personaId = next.personaId;
    if (next.suggestFollowups !== undefined) session.suggestFollowups = next.suggestFollowups;
    if (next.uiBlocks !== undefined) session.uiBlocks = next.uiBlocks;
    /* A persona that names an effort applies it — but only at the moment it is
       *picked*, never on every later spawn. Otherwise the persona would win
       every argument: the user drops "Think more" to medium, changes their
       model, and the respawn silently puts it back on high. Picking is a
       statement about how to work; the effort row underneath stays theirs. */
    const effort = (changed ? await personaEffort(next.personaId) : undefined) ?? next.effort;
    /* Everything staged is about to be superseded by a process spawned on these
       settings — and it is dropped before the restart is announced, so a peer
       that reattaches at `ready` cannot be handed a stale one on `caught_up`. */
    this.clearStaged(session);
    const restart = this.restartWith(session, next, effort, before);
    /* Answered before the restart — but only for a caller that said it is
       attached and will follow the `restart` events. One that is not (a device
       reading a retired thread, a script) has no way to learn how this ended,
       and would be left to race the respawn by re-reading a journal that is
       being cleared. It gets the old bargain: the answer waits. */
    if (opts.follow) return { live: false, restarting: true };
    /* …and a failure it waited for is its answer, thrown the way this route has
       always thrown one. The following caller reads the same failure off the
       `restart` event instead. */
    const failed = await restart;
    if (failed) throw failed;
    return { live: false };
  }

  /**
   * The restart half of `applyConfig`, run *past* the HTTP answer.
   *
   * Three events, in the order a client needs them: `started` (a process is
   * being replaced under this thread), `spawn_config` + `ready` (the row as it
   * ended up, then whatever `kept` asks of the reader), or `failed` (the thread
   * needs reviving, and this is the only place the reason exists).
   *
   * **`kept` is what makes a setting change cost the reader nothing.** The
   * respawn keeps the journal wherever the log is actually holding this
   * conversation — a live process, a log with something in it, no second
   * respawn queued behind this one — so nothing is cleared, no seq moves, and
   * the sockets that were open across it carry on where they were. The old
   * bargain (clear, refill from `session/load`, every peer reattaches from 0)
   * is still what a thread with no such log gets, and it is still what a load
   * that came back without the conversation gets: `historyLost` moving across
   * the respawn is the one thing that can take `kept` back, and the rebuild it
   * forces is how that news reaches a peer at all (it is stated on `attached`).
   *
   * Stated on `started` as well as on `ready` because the client's gate goes up
   * there: a peer told to stop folding drops the `spawn_config` and
   * `session_config` of the process coming up, and on the kept path there is no
   * reattach to state them again.
   *
   * Nothing here throws — the caller is usually a route that has already
   * answered. The failure is *returned* as well as announced, for the one
   * caller that is still waiting on it (see `applyConfig`'s `follow`).
   */
  private async restartWith(
    session: Session,
    next: { profile: Profile; agentId: string; project: Project; model?: string },
    effort: string | undefined,
    /** The readings taken before any of this moved — see `noteConfig`. */
    before: Record<ConfigNoticeLabel, string>,
  ): Promise<unknown> {
    /* Three conditions, and every one of them is "the log in front of this
       thread is the conversation the load is about to restate":
        - a live process, so the log has not been pruned (`pruneJournals` only
          touches threads with none) and there are peers with cursors into it;
        - something in the log — a thread whose only record is the load's own
          narration needs that narration;
        - nothing queued behind this respawn, because a respawn that *does*
          clear (a rewind's) would then refill the log under peers that are no
          longer dropping what they are told. */
    const keep = !!session.bridge && !session.exited && session.eventCount > 0 && !session.respawnChain;
    const lostBefore = session.historyLost;
    this.emit(session, { ev: "restart", state: "started", kept: keep });
    try {
      await this.respawn(session.id, next.profile, next.agentId, next.project, next.model, effort, {
        keepJournal: keep,
      });
    } catch (error) {
      this.emit(session, { ev: "restart", state: "failed", error: toWireError(error) });
      return error;
    }
    /* Every setting this restart moved, one row each, journaled so they replay
       and reach every peer on reattach. Said after the respawn, once the
       restored conversation is journaled again — before it, the clear would
       take them straight back out.

       This used to be the profile alone, which is the setting a restart is
       *least* likely to be about: a persona change costs a respawn every time
       and is the change most likely to alter how the answers read, and it said
       nothing. */
    this.noteConfig(session, before, await this.configLabels(session));
    /* What the thread ended up on, absolute — the same event the live path
       sends, for the same reason: a cleared model resolved to the profile's
       default in here, and the answer rather than the request is what every
       menu should draw. Before `ready`, so a peer has the row before it is
       told to reattach. */
    this.emit(session, {
      ev: "spawn_config",
      profileId: session.profileId,
      model: session.model,
      effort: session.effort,
      personaId: session.personaId,
      suggestFollowups: session.suggestFollowups,
      uiBlocks: session.uiBlocks,
    });
    /* The load came back without the conversation, so the journal is no longer
       a record of what this process holds — and the peer that has not been
       reattaching has no other way to be told. `attached` carries `historyLost`;
       this is what sends it there. */
    this.emit(session, {
      ev: "restart",
      state: "ready",
      kept: keep && session.historyLost === lostBefore,
    });
    return null;
  }

  // ---- staged config ----

  /* A change is staged as a patch, not as a whole configuration: two picks made
     before it lands are one staged change (the second merges into the first),
     and a field nobody touched stays whatever the row says at flush time. Every
     one of these emits, because `staged_config` is absolute and every peer draws
     from it — which is the whole reason they all go through `setStaged`. */

  private setStaged(session: Session, staged: StagedConfig | null): void {
    session.stagedConfig = staged;
    this.emit(session, { ev: "staged_config", config: staged });
  }

  private stageConfig(
    session: Session,
    next: {
      profile: Profile;
      model?: string;
      effort?: string;
      personaId?: string;
      suggestFollowups?: boolean;
      uiBlocks?: boolean;
    },
  ): StagedConfig {
    const staged: StagedConfig = {
      ...(session.stagedConfig ?? {}),
      profileId: next.profile.id,
      ...(next.model !== undefined ? { model: next.model } : {}),
      ...(next.effort !== undefined ? { effort: next.effort } : {}),
      ...(next.personaId !== undefined ? { personaId: next.personaId } : {}),
      ...(next.suggestFollowups !== undefined ? { suggestFollowups: next.suggestFollowups } : {}),
      ...(next.uiBlocks !== undefined ? { uiBlocks: next.uiBlocks } : {}),
    };
    this.setStaged(session, staged);
    return staged;
  }

  /** Forget a staged change without applying it — the menu's Cancel, and every
      path that has just made one meaningless. */
  clearStaged(session: Session): void {
    if (!session.stagedConfig) return;
    this.setStaged(session, null);
  }

  /** Drop only the fields a live change has just placed, so what is left still
      reaches the boundary. Clears the patch when nothing is left of it. */
  private dropStaged(
    session: Session,
    applied: { profile: Profile; model?: string; effort?: string },
  ): void {
    const staged = session.stagedConfig;
    if (!staged) return;
    /* A live change taken on the profile the thread is *leaving* says nothing
       about a change staged for the one it is joining — and the model is where
       that mattered. A staged profile move carries `model: ""` on purpose (it
       names a model the new profile does not serve, so the new profile's own
       default is what should resolve); deleting that key because a live model
       pick "overtook" it left `{profileId}` alone, and the flush below then
       read `staged.model ?? current.model` and carried the old profile's model
       across the move. The agent refused it, the row kept claiming it, and the
       thread ran on a model nobody picked. */
    if (staged.profileId && staged.profileId !== applied.profile.id) return;
    const rest: StagedConfig = { ...staged };
    if (staged.profileId === applied.profile.id) delete rest.profileId;
    if (applied.model !== undefined) delete rest.model;
    if (applied.effort !== undefined) delete rest.effort;
    if (Object.keys(rest).length === 0) return this.clearStaged(session);
    this.setStaged(session, rest);
  }

  /** What a client asks for when it presses "Apply now" on a staged change, and
      what the turn boundary flushes: the patch as a config request. */
  stagedRequest(id: string): StagedConfig | null {
    return this.sessions.get(id)?.stagedConfig ?? null;
  }

  /**
   * Take the staged change now, and answer only once the process is on it.
   *
   * This is the send path's half of "the next turn takes it" — the other half
   * is `respawnNow`, which folds the patch into any spawn that happens for some
   * other reason (a revive, a rewind, the restart route). Between the two there
   * is no third mechanism and no timer: a staged change is taken when a spawn
   * happens, and a turn that finds one staged makes that spawn happen.
   *
   * It used to be a turn *boundary* that took it, fired off the `turn_ended`
   * event and deliberately not awaited. That flush is gone. It restarted the
   * agent the instant a turn ended, for a user who might then read the answer
   * for ten minutes and never reply — and, being unawaited, it could not tell
   * anybody that it had failed.
   */
  private async flushStagedNow(session: Session): Promise<void> {
    const staged = session.stagedConfig;
    if (!staged) return;
    const profile = await getProfile(staged.profileId ?? session.profileId);
    const project = await getProject(session.projectId);
    /* Validated here and not only where it was picked: a profile can be edited,
       deleted, or have this agent taken off it between the pick and the send.
       Dropped with a row saying so rather than thrown — this runs inside a
       prompt, and a setting nobody is watching must not fail a message that is
       fine. */
    if (!profile || !project || !profileSupports(profile, session.agentId)) {
      this.clearStaged(session);
      session.bridge?.noteConfigChange(
        "Profile",
        undefined,
        "staged change dropped — that profile can no longer run this agent",
      );
      return;
    }
    /* What the row is on stands in for anything the patch does not name —
       except across a profile move, where the row's model and effort name a
       model of the profile being left. There "unnamed" means "let the new
       profile's default resolve", which is what `applyConfig` does with "". */
    const moving = profile.id !== session.profileId;
    const model = staged.model ?? (moving ? "" : session.model);
    const effort = staged.effort ?? (moving ? "" : session.effort);
    try {
      await this.applyConfig(
        session.id,
        {
          profile,
          agentId: session.agentId,
          project,
          model,
          effort,
          ...(staged.personaId !== undefined ? { personaId: staged.personaId } : {}),
          ...(staged.suggestFollowups !== undefined ? { suggestFollowups: staged.suggestFollowups } : {}),
        },
        { defer: false },
      );
    } catch (error) {
      /* The spawn or the load failed, so the thread is not on the settings this
         message was meant for. `applyConfig` drops the patch *before* it
         restarts — so that a peer reattaching at `ready` cannot be handed a
         stale one — which makes putting it back this path's job. It has to go
         back: the pick would otherwise be lost by the one failure the user is
         actually watching, and the send is about to fail with it. */
      if (session.stagedConfig !== staged) this.setStaged(session, staged);
      throw error;
    }
  }

  /* ── Saying what changed ───────────────────────────────────────────────────
   *
   * One reading per setting, in the words the menu uses, taken before the
   * change and again after it. The rows are the difference, and taking them
   * this way rather than from the request is what makes them honest: a menu
   * sends model and effort on *every* call (they fall back to the row for what
   * the user did not pick), a profile move deliberately clears both, a persona
   * that names an effort moves it as a side effect, and a model the agent
   * refuses is put back. Diffing the readings says what the thread ended up
   * on; reading the request would have announced what was asked for.
   *
   * There used to be one row for one of these — a profile move — and it was
   * written in two places with two different rules for when it appeared. The
   * other five changed how the agent answers and said nothing at all.
   */
  private readonly configLabelOrder: ConfigNoticeLabel[] = [
    "Profile",
    "Agent",
    "Model",
    "Effort",
    "Persona",
    "Follow-ups",
    "Drawn UI",
  ];

  private async configLabels(session: Session): Promise<Record<ConfigNoticeLabel, string>> {
    const [persona, agent] = await Promise.all([
      session.personaId ? personas.get(session.personaId) : undefined,
      getAgent(session.agentId),
    ]);
    /* The catalog's label where the profile owns one, the raw id where it does
       not — the same fallback `selectValueName` makes, for the same reason: an
       id nobody can name is still better than saying nothing changed. */
    const model = session.profile?.models?.find((m) => m.id === session.model);
    return {
      Profile: session.profile?.name ?? session.profileId,
      Agent: agent?.name ?? session.agentId,
      Model: model?.label || session.model || "Default",
      Effort: session.effort || "Default",
      // A persona deleted out from under a live thread reads as "None", which
      // is exactly what the next spawn will give it.
      Persona: persona?.name ?? "None",
      "Follow-ups": session.suggestFollowups ? "On" : "Off",
      "Drawn UI": session.uiBlocks ? "On" : "Off",
      // Never diffed here: the mode travels its own door and writes its own row
      // (`AcpBridge.setMode`). Present so the record is total.
      Mode: session.modeId ?? "",
    };
  }

  private noteConfig(
    session: Session,
    before: Record<ConfigNoticeLabel, string>,
    after: Record<ConfigNoticeLabel, string>,
  ): void {
    const bridge = session.bridge;
    if (!bridge) return;
    for (const label of this.configLabelOrder) {
      if (before[label] === after[label]) continue;
      bridge.noteConfigChange(label, before[label], after[label]);
    }
  }

  /** The live half of `applyConfig`; false means "this one needs a respawn",
      and it is answered before anything about the thread has been changed. */
  private async applyConfigLive(
    session: Session,
    next: {
      profile: Profile;
      agentId: string;
      project: Project;
      model?: string;
      effort?: string;
      personaId?: string;
      suggestFollowups?: boolean;
      uiBlocks?: boolean;
    },
  ): Promise<boolean> {
    const agent = await getAgent(session.agentId);
    if (!agent?.liveConfig) return false;
    if (next.agentId !== session.agentId) return false;
    /* Nothing to be clever about: `_meta` is read at `session/new`/`session/load`
       and codex's config is read at spawn, so a persona cannot be moved on a
       running process by any runtime we ship. */
    if (next.personaId !== undefined && next.personaId !== session.personaId) return false;
    /* Same door, same rule: the suggestions trailer is spawn text, so a
       thread that flips it needs the new process rather than a live patch. */
    if (next.suggestFollowups !== undefined && next.suggestFollowups !== session.suggestFollowups) return false;
    /* As are the drawn-UI lane's instructions, for the same reason. */
    if (next.uiBlocks !== undefined && next.uiBlocks !== session.uiBlocks) return false;
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
    this.emit(session, {
      ev: "spawn_config",
      profileId: session.profileId,
      model,
      effort,
      personaId: session.personaId,
      suggestFollowups: session.suggestFollowups,
      uiBlocks: session.uiBlocks,
    });
    /* What moved is said by `applyConfig`, which owns both outcomes and can
       therefore say the same thing whether the change was live or cost the
       process. It used to be said here, which is why a live profile move drew
       a row and a live *model* move on the same agent drew nothing. */
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
   *
   * `keepJournal` is the caller saying "the conversation this comes back with
   * is the one already in the log" — see `respawnNow`. Only `restartWith`
   * passes it, and only after checking that the log is actually holding that
   * conversation; a rewind must NOT, because clearing and refilling the journal
   * is how it truncates.
   *
   * Every caller also, and silently, **takes whatever change is staged**: a
   * spawn is what reads these settings, so a spawn is what applies the patch
   * waiting for one. Callers pass the row's own values and get the user's
   * newest ones — which is why a send on a retired thread costs one spawn now
   * and not two. See the fold at the top of `respawnNow`.
   */
  async respawn(
    id: string,
    profile: Profile,
    agentId: string,
    project: Project,
    model?: string,
    effort?: string,
    opts: { keepJournal?: boolean } = {},
  ): Promise<Session> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(
      "This thread is not on this server. It may have been deleted, or the server may have restarted without it.",
    );
    if (session.deletedAt !== null)
      throw new Error(
        "This thread is in Trash. Restore it from the thread list before changing or starting it.",
      );
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
      return this.respawnNow(session, profile, agentId, project, model, effort, opts);
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
    opts: { keepJournal?: boolean } = {},
  ): Promise<Session> {
    // Re-checked once the queue lets us through: the thread may have been
    // deleted (or purged) while a first respawn was still in flight.
    if (this.sessions.get(session.id) !== session) throw new Error(
      "This thread is not on this server. It may have been deleted, or the server may have restarted without it.",
    );
    if (session.deletedAt !== null)
      throw new Error(
        "This thread is in Trash. Restore it from the thread list before changing or starting it.",
      );
    /* A change that costs the process was staged when it was picked, and this
       is a spawn — so the settings it comes up on are the staged ones. Folded
       as a *value substitution*, never by re-entering `applyConfig`: that path
       comes back through `restartWith` → `respawn` and spends two spawns on one
       revive (the inner call terminates, because the patch is gone by then, but
       the process has already been replaced twice).

       Every caller gets it without knowing: the revive behind a send on a
       retired thread, the scheduler's, a rewind's cut, the restart route. That
       is the difference between one spawn on the next send and today's two —
       an idle pick used to respawn on the spot, and the send then revived the
       thread it had just woken up.

       `restartWith` never sees a patch here: `applyConfig` drops it before it
       announces the restart, so the fold below is a no-op on that path and the
       notices it would duplicate are `restartWith`'s own. */
    const staged = session.stagedConfig;
    const stagedBefore = staged ? await this.configLabels(session) : null;
    let spawnProfile = profile;
    let spawnModel = model;
    let spawnEffort = effort;
    if (staged) {
      /* Re-validated at fold time rather than trusted from the pick: the
         profile may have been edited, deleted or had this agent taken off it
         since. A patch that no longer names a usable profile falls back to the
         one the caller asked for — a revive must not fail because a setting
         nobody is watching went stale. */
      const picked = staged.profileId ? await getProfile(staged.profileId) : profile;
      const usable = picked && profileSupports(picked, agentId) ? picked : profile;
      /* Across a profile move the row's model names a model of the profile
         being *left*, so "unnamed" means "let the new profile's default
         resolve" — `""`, exactly as `applyConfig` reads it. */
      const moving = usable.id !== session.profileId;
      spawnProfile = usable;
      spawnModel = modelFor(session, usable, staged.model ?? (moving ? "" : model));
      spawnEffort = staged.effort ?? (moving ? "" : effort);
      /* A persona that names an effort applies it — the same rule `applyConfig`
         states, and it has to be repeated here rather than inherited, because
         this path is a substitution and never re-enters that method. Only when
         the persona is *moving*, and only under an effort the patch does not
         name itself: picking a persona is a statement about how to work, and
         the effort row underneath stays the user's. */
      const movingPersona =
        staged.personaId !== undefined && staged.personaId !== session.personaId;
      if (movingPersona && staged.effort === undefined) {
        spawnEffort = (await personaEffort(staged.personaId)) ?? spawnEffort;
      }
      /* The row moves before the spawn rather than being passed to it, because
         a persona is not a spawn argument the way model and effort are: `start`
         reads it off the session. Same bargain as `applyConfig`'s. */
      if (staged.personaId !== undefined) session.personaId = staged.personaId;
      if (staged.suggestFollowups !== undefined) session.suggestFollowups = staged.suggestFollowups;
      if (staged.uiBlocks !== undefined) session.uiBlocks = staged.uiBlocks;
    }
    this.clearStaged(session);
    /* Captured while the old process is still up — it is the only thing that
       knows how the agent was configured. A thread with no live process
       (idle-retired, pre-restart) has nothing to capture from, so the row
       stands in: the mode it recorded, and — this is the half that used to be
       lost — every other selector it recorded, replayed below through
       `configChoices` rather than here, because `applyRestore` compares whole
       options and the row holds only values. Either way the settings the user
       did not touch survive the one they did. */
    const live = session.bridge?.captureRestoreState();
    const restore = live ?? { modeId: session.modeId ?? undefined, configOptions: [] };
    const choices = live ? undefined : session.configChoices;
    const oldProc = session.proc;
    const oldBridge = session.bridge;
    session.bridge = null; // stale generation from here on
    oldBridge?.close(new Error("respawning"));
    if (!session.exited) oldProc?.kill();
    session.profileId = spawnProfile.id;
    session.agentId = agentId;
    session.model = spawnModel || spawnProfile.defaultModel || "";
    session.effort = spawnEffort ?? "";
    /* The load replays the entire conversation as fresh updates, so everything
       already journaled is about to be said again. There are two ways to answer
       that duplicate, and which one is taken is the difference between a
       setting change that costs the reader nothing and one that costs them
       their transcript.

       The default is the clear: the log is emptied and the load refills it.
       Awaited, because the clear is what zeroes the seq counter the reload then
       stamps from, and fire-and-forget it was a rejection nobody saw and a
       counter nobody reset. It is also what a rewind's truncation *is*, which
       is why that caller may never ask for the other one.

       The other is to keep the log and drop the narration instead
       (`Session.quietLoad`, read in `emit`) — for a caller that knows the
       conversation coming back is the one already written down. Nothing is
       appended, no seq moves, and every peer's cursor stays valid: the socket
       that was open across the respawn simply carries on. The clear was the
       whole reason a persona change made every device rebuild its transcript
       from zero — and it took the journaled `turn_started`/`turn_ended` rows
       with it, which are what `rewindPoint`, the turn table of contents and
       every window are read from and which the load never restates. */
    if (opts.keepJournal) session.quietLoad = true;
    else await this.log.clear(session);
    resetStderr(session);
    try {
      const bridge = await this.start(session, spawnProfile, project, spawnModel, spawnEffort, {
        load: session.acpSessionId ? { acpSessionId: session.acpSessionId } : undefined,
        restore,
        ...(choices && Object.keys(choices).length > 0 ? { configChoices: choices } : {}),
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
    } finally {
      /* The load is over either way it went, and a flag left standing would
         silence the next turn's updates. */
      session.quietLoad = false;
    }
    /* A fold moved settings nobody has announced yet — `restartWith` says what
       it moved because it knows, and this spawn happened for some other reason
       entirely (a send reviving the thread, a rewind, the restart route). Said
       here, after the load, for `restartWith`'s own reason: before it, a clear
       would take the rows straight back out again. */
    if (stagedBefore) {
      this.noteConfig(session, stagedBefore, await this.configLabels(session));
      /* …and what the thread ended up on, absolute, for every peer — including
         the model a cleared one resolved to out of the new profile's defaults.
         `restartWith` sends the same event for the same reason; the two are
         mutually exclusive, since a patch it folded is one that path had
         already dropped. */
      this.emit(session, {
        ev: "spawn_config",
        profileId: session.profileId,
        model: session.model,
        effort: session.effort,
        personaId: session.personaId,
        suggestFollowups: session.suggestFollowups,
        uiBlocks: session.uiBlocks,
      });
    }
    return session;
  }

  /**
   * Roll the thread back to before `turnId`, in place — same session row,
   * same thread id, same links. Two independent halves, taken by `scope`:
   *
   *  - the **conversation**: the agent's own context, which only the runtime
   *    holds (the journal is a cache for reading, never a source for
   *    resuming). The live process is forked at the turn before the one being
   *    discarded — `bridge.forkAt` on the messageId that turn's `turn_ended`
   *    recorded — and the row's `acpSessionId` moves to the fork. Everything
   *    after that point is then dropped by the ordinary revive path: the
   *    respawn below clears the journal and a `session/load` of the fork
   *    refills it with only what is left, which is why this method adds no
   *    truncation machinery of its own.
   *  - the **files**: the worktree as it was when `turnId` began — the git
   *    tree `TurnChangesRecorder` photographed at its `turn_started`,
   *    restored by `git.restoreToTree` as a new commit, never a reset.
   *
   * A `before === null` rewind point — `turnId` is the thread's very first
   * turn — has nothing to fork *from*, so the conversation half starts the
   * agent over: `acpSessionId` is cleared and the respawn runs a plain
   * `session/new`. That is a deliberate, user-asked discard, not the
   * accidental-overwrite case "only another proven id may replace a proven
   * one" exists for — the rule guards a fallback that *guesses* the old
   * conversation is gone; here the user has said so.
   *
   * The turn-changes rows of the discarded turns are pruned once the
   * conversation has actually been cut (a files-only rewind discards no
   * turns — it moves the worktree under a transcript that stays whole, the
   * way the History drawer's restore does).
   *
   * Refusals are `HttpError`s with the status they deserve: a running turn is
   * a 409 (a rewind is never queued and never steered — there is no honest
   * answer to "rewind to before the turn that is streaming"), a workflow step
   * cannot be rewound at all (its history is the run's, not the reader's), an
   * agent with no rewind door or a boundary with no fork point is a 400, and
   * an unknown turn or a turn with no file snapshot is a 404.
   */
  async rewind(
    id: string,
    turnId: string,
    scope: "conversation" | "files" | "both",
  ): Promise<{ ok: true; acpSessionId: string | null | undefined; restored?: boolean; historyLost?: HistoryLost }> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(
      "This thread is not on this server. It may have been deleted, or the server may have restarted without it.",
    );
    if (session.deletedAt !== null)
      throw new Error(
        "This thread is in Trash. Restore it from the thread list before changing or starting it.",
      );
    if (session.parentSessionId) throw new HttpError("a workflow step cannot be rewound — rewind the thread that started the run", 409);
    if (session.bridge?.promptActive) throw new HttpError("a turn is running — cancel it before rewinding", 409);

    const profile = session.profile ?? (await getProfile(session.profileId));
    if (!profile) throw new HttpError("unknown profile", 404);
    const project = session.project ?? (await getProject(session.projectId));
    if (!project) throw new HttpError("unknown project", 404);

    const point = await this.log.rewindPoint(session.id, turnId);
    if (!point) throw new HttpError("unknown turn", 404);

    const conversational = scope === "conversation" || scope === "both";
    const physical = scope === "files" || scope === "both";
    let cut = false;

    if (conversational) {
      if ((await getAgent(session.agentId))?.rewindVia !== "acp-fork-point") {
        throw new HttpError("this agent cannot rewind its conversation — files can still be restored", 400);
      }
      if (point.before === null) {
        session.acpSessionId = undefined;
        session.acpSessionProvisional = false;
        cut = true;
      } else if (point.before.messageId === null) {
        throw new HttpError("the turn before this one has no recorded fork point, so the conversation cannot be cut there", 400);
      } else {
        const bridge = await this.whenSpawnable(session);
        if (bridge.promptActive) throw new HttpError("a turn is running — cancel it before rewinding", 409);
        const { sessionId } = await bridge.forkAt(point.before.messageId);
        // Adopted provisionally — no turn has settled on a fork — and the
        // respawn's `session/load` answers it, which is what proves an id.
        // That proof doubles as the check that the fork is loadable at all:
        // a runtime that refused it lands in history-lost, loudly, like any
        // other load that never came back.
        session.acpSessionId = sessionId;
        session.acpSessionProvisional = true;
        cut = true;
      }
    }

    let restored: boolean | undefined;
    if (physical) {
      const tree = await this.turnChanges.startTreeOf(session.id, turnId);
      if (!tree) throw new HttpError("no file snapshot for this turn", 404);
      restored = (await git.restoreToTree(session.projectId, tree)).restored;
    }

    if (cut) {
      // Configuration unchanged on every axis — only the conversation moved —
      // so the respawn gets the row's own values back, exactly as a revive of
      // an untouched thread would.
      await this.respawn(session.id, profile, session.agentId, project, session.model || undefined, session.effort || undefined);
      this.turnChanges.pruneFrom(session.id, turnId);
    }

    return {
      ok: true,
      acpSessionId: session.liveAcpSessionId ?? session.acpSessionId,
      ...(physical ? { restored } : {}),
      ...(session.historyLost ? { historyLost: session.historyLost } : {}),
    };
  }

  /**
   * Branch the thread at `turnId` — the same cut a rewind would make, taken as
   * a *new* thread instead of in place. The branch carries turns 1..N
   * inclusive, so its fork point is that turn's own `turn_ended.lastMessageId`
   * (`forkPoint`, the mirror of `rewindPoint`), and the runtime hands back a
   * fresh session id: the parent's conversation is never shared, never moved
   * and never reloaded — its journal, its peers and its process all stay
   * exactly as they are.
   *
   * The child is born the way `importSession`'s rows are — a pointer to a
   * conversation that already exists in the agent's own store — except that
   * here the process is spawned immediately, straight onto `session/load` of
   * the fork id (`start`'s `load` opt, the revive half of every respawn), so
   * the 201 the route answers means what `create`'s does: the thread exists,
   * the fork has been loaded, its prefix is journaled. Nothing is ever copied
   * out of the parent's journal — the load is the one writer, which is what
   * keeps the journal a cache rather than a second transcript to keep true.
   *
   * What the child inherits is everything a workflow step inherits: profile,
   * agent, model, effort, persona, mode, links, the project's cwd. What it
   * does not is everything that belongs to the parent's *life* rather than its
   * configuration — its queue, its turn changes, its autonomy — and the files
   * are untouched on purpose: parent and branch share one worktree, and
   * "restore the branch to turn N's tree" would rewrite the parent's working
   * state out from under it.
   *
   * The fork id is adopted provisionally, exactly as a rewind adopts its fork:
   * the load that follows is what proves it, and a runtime that refuses it
   * lands in history-lost — loudly, on the branch, with the parent untouched.
   *
   * Refusals mirror `rewind`'s: a running turn is a 409 (its last message is
   * not final, so the fork point is not either), an agent with no fork-point
   * door or a turn with no recorded message id is a 400, an unknown turn a 404.
   * A retired parent is not refused — it is revived first, the way the
   * scheduler revives a thread it has something to say to, because the fork
   * request needs a live process to ask.
   */
  async fork(
    id: string,
    turnId: string,
    opts: { id?: string; title?: string } = {},
  ): Promise<Session> {
    const session = this.sessions.get(id);
    if (!session) throw new HttpError("unknown session", 404);
    if (session.deletedAt !== null) throw new HttpError("session deleted", 409);
    /* A workflow step is not refused the way `rewind` refuses one: a rewind
       would rewrite history the run owns, while a fork only reads it. The
       branch is a plain thread — no parent of its own, visible, mortal. */
    if (session.bridge?.promptActive) throw new HttpError("a turn is running — cancel it before forking", 409);

    const profile = session.profile ?? (await getProfile(session.profileId));
    if (!profile) throw new HttpError("unknown profile", 404);
    const project = session.project ?? (await getProject(session.projectId));
    if (!project) throw new HttpError("unknown project", 404);

    const point = await this.log.forkPoint(session.id, turnId);
    if (!point) throw new HttpError("unknown turn", 404);
    if (point.messageId === null) {
      throw new HttpError("this turn has no recorded fork point, so the conversation cannot be branched there", 400);
    }
    if ((await getAgent(session.agentId))?.rewindVia !== "acp-fork-point") {
      throw new HttpError("this agent cannot fork its conversation at a turn", 400);
    }

    // A retired parent is revived, not refused — the fork request needs the
    // runtime holding the conversation, and this is the same revive a send
    // would perform (spawn + session/load of the parent's own id).
    if (!session.bridge || session.exited) {
      await this.respawn(id, profile, session.agentId, project, session.model || undefined, session.effort || undefined);
    }
    const bridge = await this.whenSpawnable(session);
    if (bridge.promptActive) throw new HttpError("a turn is running — cancel it before forking", 409);

    const { sessionId: forkId } = await bridge.forkAt(point.messageId);

    const child = this.blankSession(profile, session.agentId, project, session.links, {
      id: opts.id,
      model: session.model || undefined,
      effort: session.effort || undefined,
      modeId: session.modeId,
      personaId: session.personaId,
      suggestFollowups: session.suggestFollowups,
      uiBlocks: session.uiBlocks,
      /* A name the user did not type is still a name the sniff must not
         replace — which is why it is set here rather than left to the
         "New thread" default. */
      title: opts.title ?? `${session.title.slice(0, TITLE_MAX - 9)} (branch)`.slice(0, TITLE_MAX),
      forkedFrom: { sessionId: session.id, turnId },
    });
    /* Adopted provisionally — the load below is what proves the id, and what
       proves the fork loadable at all (see `rewind`). */
    child.acpSessionId = forkId;
    child.acpSessionProvisional = true;
    this.sessions.set(child.id, child);
    // Before the bridge, for the same reason `create` does it this way: the
    // event rows reference this row, and the load replay starts arriving the
    // moment the process answers its handshake.
    await this.createRow(child);
    await this.persistLinks(child);

    const childBridge = await this.start(child, profile, project, child.model || undefined, child.effort || undefined, {
      load: { acpSessionId: forkId },
      modeId: child.modeId ?? undefined,
    });
    this.armDeadline(child);
    try {
      await childBridge.ready;
    } catch (error) {
      if (child.bridge === childBridge) this.collapse(child, childBridge, describe(error));
      throw error;
    }
    /* Drawn, not followed: the only thing the transcript needs to say about a
       branch is where it came from, said once, above the prefix it carries. */
    this.emit(child, {
      ev: "config_notice",
      seq: 0,
      text: `Forked from “${session.title.slice(0, 80)}”`,
    });
    return child;
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
    opts: { steer?: boolean; attachmentIds?: string[]; forceLink?: boolean } = {},
  ): Promise<PromptReply> {
    const session = this.sessions.get(id);
    if (!session) throw new Error("this thread has no running agent");
    let bridge = await this.whenSpawnable(session);
    /* Claimed before the turn starts, so a row exists to sweep against — and
       before the queue branch too, since a queued message's attachments are
       just as much this thread's as a sent one's. Unknown or foreign ids are
       dropped rather than refused (attachments.ts). */
    const attachments = await claimAttachments(opts.attachmentIds ?? [], session.id);
    if (bridge.promptActive && !opts.steer) {
      /* The queue's own door, not a second copy of it: `add` writes the row on
         this thread's queue chain — so two messages typed in one breath keep
         the order they were sent in — and emits the list before answering, so
         no peer is told "queued" while holding a list without it in. It drains
         on an idle thread, which cannot happen here (`promptActive`) and is
         harmless if the turn ends in between. */
      return await this.queue.add(session, text, attachments);
    }
    /* A change picked since the last message is taken here, before the turn it
       was picked for. This is the one door every turn comes through — the
       socket's send, the scheduler, routines, autonomy — so nothing runs on
       settings the user has already moved off.

       `!promptActive` is what keeps a **steer** out of it: past the queue
       branch, a live turn means this prompt is joining one, and that is not a
       new turn to flush at. The queue's own drain never reaches here at all —
       it calls `startTurn` directly — which preserves the old `continued` rule:
       no restart between two messages the user sent together.

       **`|| bridge.paused` is the one exception, and it is the held turn's.**
       `applyConfig` refuses to *stage* onto a hold, on the grounds that a change
       parked behind a boundary the turn will never reach is a change that never
       happens — but that guard reads the hold at *pick* time, and a pick made
       while the turn was still retrying lands before the hold exists. Left
       alone, that patch is stranded exactly as the rule warns: a held turn's
       send is a **steer**, and a steer never flushes, so the user's next message
       runs on the settings they had already moved off and the pick looks like it
       did nothing. A held turn is stopped, not running — this prompt is not
       "joining" one, it is being parked at a boundary — so it is not the
       `continued` case either.

       Awaited, and the bridge re-read afterwards: the flush replaced the
       process, so `session.bridge` is a different object by now and prompting
       the one above would be talking to a killed child. */
    if (session.stagedConfig && (!bridge.promptActive || bridge.paused)) {
      await this.flushStagedNow(session);
      bridge = await this.whenSpawnable(session);
    }
    return await this.startTurn(session, bridge, text, peer, { attachments, forceLink: opts.forceLink });
  }

  /** Put a prompt on the wire. `peer` is the origin (told nothing — it already
      showed its own message); a drained prompt has none, so every peer draws
      the bubble from `turn_started`. */
  private async startTurn(
    session: Session,
    bridge: AcpBridge,
    text: string,
    peer: Peer | undefined,
    opts: { attachments?: AttachmentRef[]; forceLink?: boolean } = {},
  ): Promise<{ turnId: string; deferred?: boolean }> {
    /* One id per logical turn: steering (a second prompt while one is in
       flight) joins the turn already running rather than starting another. */
    const turnId = bridge.promptActive && bridge.currentTurnId ? bridge.currentTurnId : randomUUID();
    /* `deferred` = the words went out but their bubble is held for the step
       boundary, so the sender must not draw one of its own. */
    const { deferred } = await bridge.prompt(text, peer, turnId, opts);
    if (text && session.title === "New thread") {
      session.title = text.slice(0, TITLE_SNIFF_MAX);
      session.titleFromPrompt = session.title;
      /* The name is taken in memory — which is what every reader of the thread
         reads — and written down without holding the answer to the command that
         caused it. The reply here means "the turn started", and by this line it
         has: the prompt is on the wire. The row is the one thing that can wait,
         and on a streaming thread it does wait: the write goes in behind the
         journal's own, which is flushing this turn's updates as they arrive.
         Awaited, that was seconds of a send button still saying it was sending.
         The failure is logged rather than thrown, for the same reason it is not
         awaited — there is nobody left to tell, and the next `persist` (every
         turn ends with one) writes the title again. */
      void this.persist(session).catch((error: unknown) =>
        console.error(`[sessions] could not write ${session.id.slice(0, 8)}'s title`, error),
      );
    }
    return deferred ? { turnId, deferred } : { turnId };
  }

  // ---- the queue ----

  /** The queue block — the drain, the edits, steer and "send now" — lives in
      session-queue.ts, behind a port of exactly the two prompt-path steps it
      drives. The public methods below keep the manager's surface identical. */
  /** Loopback ports for spawns that need one (`subagentFeed`), bound ahead of
      time because `start` is synchronous — see net.ts. */
  private readonly ports = new PortPool();

  /** Per-turn worktree snapshots and their diffs — see turn-changes.ts. */
  readonly turnChanges = new TurnChangesRecorder({
    cwdOf: (id) => this.sessions.get(id)?.project?.cwd ?? null,
    emit: (id, turn) => {
      const session = this.sessions.get(id);
      if (!session) return;
      this.emit(session, { ev: "turn_changes", turn });
    },
  });

  private queue = new SessionQueue({
    emit: (session, event) => this.emit(session, event),
    whenSpawnable: (session) => this.whenSpawnable(session),
    startTurn: (session, bridge, text, peer, opts) => this.startTurn(session, bridge, text, peer, opts),
  });

  async queueAdd(id: string, text: string, attachmentIds?: string[]): Promise<PromptReply> {
    const session = this.requireSession(id);
    return await this.queue.add(session, text, await claimAttachments(attachmentIds ?? [], session.id));
  }

  async queueUpdate(id: string, itemId: string, text: string, attachmentIds?: string[]): Promise<void> {
    const session = this.requireSession(id);
    /* Re-claimed rather than trusted: an edit may name an attachment added on
       another device, and the ids on the row are already this thread's. */
    if (attachmentIds) await claimAttachments(attachmentIds, session.id);
    await this.queue.update(session, itemId, text, attachmentIds);
  }

  async queueRemove(id: string, itemId: string): Promise<void> {
    await this.queue.remove(this.requireSession(id), itemId);
  }

  async queueClear(id: string): Promise<void> {
    await this.queue.clear(this.requireSession(id));
  }

  /** Stop the running turn. `reclaim` also hands back the newest message that
      has not landed — see `SessionQueue.stop` for why the two are one call. */
  stopTurn(id: string, reclaim: boolean): Promise<CancelReply> {
    return this.queue.stop(this.requireSession(id), reclaim);
  }

  /**
   * Let a held turn go on — taking the staged change first when there is one.
   *
   * The hold is the harness's promise that a failed turn waits for a model
   * change and a Continue (`lib/thread/hold.ts`), so Continue is the one other
   * door a patch may leave by. Without this it had only `prompt`, and a user who
   * changed the model and then pressed Continue rather than typing would watch
   * the change sit there: the hold goes, the turn runs on the settings they had
   * already moved off, and the patch is still staged.
   *
   * The bridge is re-read after the flush. A change the running process can
   * take leaves it in place and the resume releases the hold; one that costs the
   * process replaces it, and the hold went with the old process — `close()`
   * already ended the turn and wrote the row saying the restart did it, so there
   * is nothing left to resume.
   */
  async resumeTurn(id: string): Promise<{ paused: boolean }> {
    const session = this.requireSession(id);
    const bridge = session.bridge;
    if (!bridge) throw new Error("this thread has no running agent");
    if (session.stagedConfig) {
      await this.flushStagedNow(session);
      if (session.bridge !== bridge) return { paused: false };
    }
    return bridge.resume();
  }

  queueSteer(id: string, itemId: string): Promise<{ turnId: string }> {
    return this.queue.steer(this.requireSession(id), itemId);
  }

  queueSendNow(id: string, itemId?: string): Promise<{ turnId: string }> {
    return this.queue.sendNow(this.requireSession(id), itemId);
  }

  private requireSession(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error(
      "This thread is not on this server. It may have been deleted, or the server may have restarted without it.",
    );
    return session;
  }

  /**
   * Stop the process but keep the thread — the opposite of purge(). The thread
   * stays readable afterwards: the log is kept and `attach` serves it.
   *
   * `reason` is what anything still waiting on this process is told, and it is
   * the caller's to give because only the caller knows which of these this is:
   * an idle sweep, a server shutting down, a backup import, a delete. It used
   * to be the literal string "thread retired" for all six callers — a phrase
   * that names the mechanism and answers none of the three questions a person
   * reading it in a transcript actually has (what stopped, why, and whether the
   * conversation survived). It reaches two places, both of which a user reads:
   * the error card `AcpBridge.close` settles an interrupted turn with, and
   * every `whenTurnSettled` waiter, via `processGone`. So it is written as a
   * sentence, and the default is the one that is true of all of them.
   */
  retire(
    session: Session,
    reason = "The agent process for this thread was stopped. The conversation is kept — sending a message starts it again.",
  ): void {
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
    /* The deadline belongs to the process it was going to cancel. Left armed it
       would sit unref'd for its full span holding a closure over a dead
       session — harmless, and still a timer nobody can explain in a heap dump. */
    if (session.deadline) clearTimeout(session.deadline);
    session.deadline = null;
    /* The log is NOT cleared here any more, and that is what makes a retired
       thread readable. Closing the bridge ends whatever turn was in flight, and
       that last event is the end of this archive — so it is journaled like the
       rest rather than thrown away with the process. What still clears the log
       is the revive (`respawnNow`), which is the only moment the agent is about
       to re-narrate the conversation and the two accounts could otherwise be
       stitched together. */
    bridge?.close(new Error(reason));
    this.log.flush();
    resetStderr(session);
    proc?.kill();
    this.processGone(session, reason);
  }

  list() {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      profileId: s.profileId,
      projectId: s.projectId,
      agentId: s.agentId,
      model: s.model,
      effort: s.effort,
      modeId: s.modeId,
      personaId: s.personaId,
      suggestFollowups: s.suggestFollowups,
      uiBlocks: s.uiBlocks,
      title: s.title,
      ...s.links,
      /* The session anything asking today would mean: a task transcript's
         directory is named after the process's session, not after the one the
         thread will settle on. The recorded id is the fallback for a thread
         with no process. */
      acpSessionId: s.liveAcpSessionId ?? s.acpSessionId,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt || s.createdAt,
      lastTurnError: s.lastTurnError,
      deletedAt: s.deletedAt,
      pinnedAt: s.pinnedAt,
      attached: s.peers.size > 0,
      peerCount: s.peers.size,
      exited: s.exited,
      promptActive: s.bridge?.promptActive ?? false,
      cursor: s.eventCount,
      parentSessionId: s.parentSessionId,
      forkedFromSessionId: s.forkedFromSessionId,
      forkedFromTurnId: s.forkedFromTurnId,
    }));
  }


  /**
   * Name a thread by hand.
   *
   * The title is the user's the moment they set one, which is what makes this
   * more than a column write: the first-prompt sniff in `startTurn` only ever
   * fires on the literal "New thread", so a renamed thread — including one
   * renamed before it was ever sent to — keeps the name through its first turn.
   * Capped rather than refused, since the sniff's own titles are a slice too;
   * an empty name is refused, because a row with no label is unreachable.
   */
  rename(id: string, title: string): string | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    const next = title.trim().slice(0, TITLE_MAX);
    if (!next) return null;
    session.title = next;
    session.titleFromPrompt = null;
    this.persist(session);
    return next;
  }

  /**
   * Pin a thread, or take the pin back. The timestamp is the order the pinned
   * group is drawn in, which is why re-pinning moves a thread to the end of it.
   */
  setPinned(id: string, pinned: boolean): number | null | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    session.pinnedAt = pinned ? Date.now() : null;
    this.persist(session);
    return session.pinnedAt;
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
    this.closePeers(session, 4000, "This thread was moved to Trash. Restoring it brings the conversation back.");
    session.deletedAt = Date.now();
    // Retiring fires onProcessGone, which is where the runner cancels the run
    // this thread was orchestrating; the steps then go to the trash with it.
    this.retire(
      session,
      "This thread was moved to Trash, so its agent process was stopped. Restoring the thread brings the conversation back.",
    );
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
  async purge(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    /* Children first: `parent_session_id` is not a foreign key on purpose (see
       schema.ts), so each step goes through this same path — its process, its
       peers, its FTS rows, its slot in the map. */
    for (const child of this.childrenOf(id)) this.purge(child.id);
    this.closePeers(session, 4000, "This thread was deleted for good and cannot be restored.");
    this.retire(session, "This thread was deleted for good, so its agent process was stopped.");
    this.sessions.delete(id);
    // ON DELETE CASCADE takes the event rows with it; the FTS rows have no
    // foreign key (virtual table), so they go by hand — and so do the
    // attachments, whose rows are deliberately not cascaded either (a cascade
    // would take a row out from under the bytes this process still owns on
    // disk). Children first, which the loop above already did.
    await db.delete(sessionsTable).where(eq(sessionsTable.id, id));
    await deleteSearchIndex([id]);
    await deleteSessionAttachments(id);
    return true;
  }

  /**
   * `reason` reaches the user: it is the `detail` under the failure card the
   * client draws from the close code (`failureFor`), so every caller writes a
   * sentence rather than the log-line phrases these used to be ("session
   * purged", "session reloaded").
   *
   * Truncated here rather than by each caller. A WebSocket close reason is
   * capped at 123 bytes by the protocol and `ws` throws over it, so a sentence
   * that grew past the limit would turn a thread being tidied up into an
   * exception on the way out. One caller already knew that (the 4001 path,
   * whose reason is agent stderr and unbounded by nature); making it the rule
   * means the next sentence written here cannot get it wrong.
   */
  private closePeers(session: Session, code: number, reason: string): void {
    const said = truncateReason(reason);
    for (const peer of session.peers) peer.ws.close(code, said);
  }

  // ---- the socket ----

  /** The wire — attach bracket, replay windowing, command dispatch — lives in
      session-socket.ts, behind a port of exactly the methods it needs. */
  private socket = new SessionSocket({
    getSession: (id) => this.sessions.get(id),
    journal: this.log,
    prompt: async (id, text, peer, opts) => await this.prompt(id, text, peer, opts),
    queueAdd: async (id, text, attachmentIds) => await this.queueAdd(id, text, attachmentIds),
    queueSendNow: async (id, itemId) => await this.queueSendNow(id, itemId),
    queueSteer: (id, itemId) => this.queueSteer(id, itemId),
    queueUpdate: (id, itemId, text, attachmentIds) => this.queueUpdate(id, itemId, text, attachmentIds),
    queueRemove: (id, itemId) => this.queueRemove(id, itemId),
    queueClear: (id) => this.queueClear(id),
    stopTurn: (id, reclaim) => this.stopTurn(id, reclaim),
    resumeTurn: (id) => this.resumeTurn(id),
    enrichError: (session, error) => enrichError(session, error),
  });

  /**
   * Attach a WebSocket. Replays journaled events from `cursor`, brackets them
   * with `attached`/`caught_up` so the client can tell history from news, then
   * hands over whatever question the agent is currently blocked on.
   *
   * Returns null on success, or why it refused — that string becomes the close
   * reason. The mechanics live in SessionSocket.attach.
   *
   * Asynchronous because the replay is: the frames are paced against the
   * socket rather than pushed at it in one run (see there). A refusal is still
   * decided before the first await, so the caller's close-with-a-reason path
   * is unchanged in everything but its shape.
   */
  async attach(
    id: string,
    ws: WebSocket,
    cursor = 0,
    batch = false,
    opts: { window?: number } = {},
  ): Promise<string | null> {
    await this.ready;
    return await this.socket.attach(id, ws, cursor, batch, opts);
  }

  /** The attach bracket as an HTTP document — what a thread is opened with
      now, before (and sometimes instead of) a socket. See `SessionSocket.snapshot`. */
  snapshot(id: string, cursor = 0, opts: { window?: number } = {}) {
    return this.socket.snapshot(id, cursor, opts);
  }

  /** One page of history, without a socket. See `SessionSocket.earlierPage`. */
  earlierPage(id: string, before: number) {
    return this.socket.earlierPage(id, before);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The model a thread may actually be moved onto — which is never a model of
 * the profile it is leaving.
 *
 * `""` is a real answer everywhere it lands: `applyConfigLive`, `respawnNow`
 * and `start` all read it as "the profile's own default", which is the honest
 * value for a thread that has just been handed credentials with a different
 * catalog behind them. Two ways a request earns it —
 *
 *  - the target profile **owns a catalog** and the id is not in it. Its ids are
 *    the only ones its gateway serves, so anything else is a 404 the user did
 *    not ask for.
 *  - the target profile **owns none** (the virtual Default is the one everybody
 *    meets) and the thread is *moving*. There the value is an id out of the
 *    agent's own selector, and the only thing that understands such an id is
 *    the selector it came from — the agent behind the profile being left. Kept
 *    when the profile is not moving: that is the same agent, and the id is its
 *    own (see `applyAgentOwned`).
 */
function modelFor(session: Session, profile: Profile, model: string | undefined): string | undefined {
  if (!model) return model;
  const catalog = profile.models ?? [];
  /* Through `bareModelId` first, for the same reason the row is written through
     it: Claude Code answers with the long-context suffix its env template
     appends, and the catalog's own id is what a menu matches on. */
  const bare = bareModelId(profile, model);
  if (catalog.length > 0) return catalog.some((entry) => entry.id === bare) ? bare : "";
  return profile.id === session.profileId ? model : "";
}

/** The durable half of a session, as the row shape. */
function rowValues(s: Session) {
  return {
    id: s.id,
    profileId: s.profileId,
    projectId: s.projectId,
    agentId: s.agentId,
    model: s.model,
    effort: s.effort,
    modeId: s.modeId,
    configChoices: s.configChoices,
    personaId: s.personaId || null,
    suggestFollowups: s.suggestFollowups,
    uiBlocks: s.uiBlocks,
    title: s.title,
    acpSessionId: s.acpSessionId ?? null,
    acpSessionProvisional: s.acpSessionProvisional,
    createdAt: s.createdAt,
    lastActivityAt: s.lastActivityAt,
    lastTurnError: s.lastTurnError,
    context: s.context,
    deletedAt: s.deletedAt,
    pinnedAt: s.pinnedAt,
    parentSessionId: s.parentSessionId,
    forkedFromSessionId: s.forkedFromSessionId,
    forkedFromTurnId: s.forkedFromTurnId,
  };
}
