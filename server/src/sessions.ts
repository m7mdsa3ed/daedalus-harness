import { durable, type Handle } from "./sandbox/index.js";
import { killSessionTerminals } from "./terminals.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { WebSocket } from "ws";
import type * as acp from "./acp.js";
import { db, sessions as sessionsTable } from "./db/index.js";
import { SESSION_LINKS, emptyLinks, linksOf, readLinks, unionLinks, writeLinks, type LinkSet } from "./db/links.js";
import { ensureProjectDir, materializeModelAllowlist, materializeWorkspace, sweepSubagentRoles } from "./materialize.js";
import { commands as commandLibrary, mcpServers as mcpLibrary, skills as skillLibrary } from "./library.js";
import { isConnected as isMcpConnected } from "./mcp-oauth.js";
import { mcpProxyUrlFor } from "./mcp-shim.js";
import {
  DEFAULT_SUGGEST_KINDS,
  normalizeSuggestKinds,
  normalizeUiGroups,
  resolvePersonaSpawn,
  sameSuggestKinds,
  sameUiGroups,
  suggestKindsOf,
  UI_GROUP_IDS,
  uiGroupsOf,
} from "./personas.js";
import type { SuggestKind, SuggestableCommand } from "./personas.js";
import { listHelpers } from "./project-helpers.js";
import { listScriptsUnder } from "./project-scripts.js";
import { noteThreadLinked, noteTurnStarted, taskBrief } from "./task-threads.js";
import { globalRules, projectRules } from "./rules.js";
import type { Profile } from "./profiles.js";
import type { Project } from "./projects.js";
import { defaultProfileFor, getProfile, listProfiles, profileBaseUrl, profileSupports } from "./profiles.js";
import { agentModelId, bareModelId, getAgent, modelAllowlistFor, type AgentDef } from "./registry.js";
import type { WorkspaceLayout } from "./db/schema.js";
import { gatewayUrlFor, setGatewaySessionResolver, type GatewaySession } from "./gateway-shim.js";
import { setOtlpThreadCheck, otlpUrlFor } from "./otlp.js";
import { addTps } from "./tps.js";
import { promptPrefixOf, refreshPromptPrefix, type PromptFilesFormat } from "./prompt-files.js";
import { pauseHookUrlFor } from "./pause-hooks.js";
import { HttpError } from "./http-error.js";
import * as git from "./git.js";
import { getProject } from "./projects.js";
import { databaseUrl, getConfig, loadConfig } from "./config.js";
import { WEB_SEARCH_SERVER_NAME, toMcpServerEnv } from "./websearch.js";
import { pruneWebSearchUsage, recordWebSearchUsage } from "./websearch-usage.js";
import { KNOWLEDGE_SERVER_NAME, toKnowledgeServerEnv } from "./knowledge-db.js";
import { AcpBridge, resolveAgentSpawn, spawnProcess, toWireError, type BridgeHost, type ConfigNoticeLabel } from "./acp-bridge.js";
import { AcpPool, detachAllConnections, flushAllProcessStates, pool, type AcpConnection } from "./acp-connection.js";
import { makeBridgeHost } from "./bridge-host.js";
import { enrichError, pushStderr, resetStderr, spliceStderr } from "./stderr-ring.js";
import { checkInstalled } from "./agent-status.js";
import { SessionQueue } from "./session-queue.js";
import type { AutonomyPolicy } from "./autonomy.js";
import { AGENTS_SERVER_NAME, HARNESS_SERVER_NAME, WORKFLOW_SERVER_NAME } from "./workflow-schema.js";
import { deleteSearchIndex } from "./search.js";
import { getQuota, invalidateQuota, planReadable, setRuntimeLiveCheck } from "./quota.js";
import { profileUsage } from "./usage-api.js";
import { SessionJournal } from "./session-journal.js";
import { TurnChangesRecorder } from "./turn-changes.js";
import { SessionSocket } from "./session-socket.js";
import {
  childRequest,
  childRequestId,
  JOURNALED_EVENTS,
  type AttachmentRef,
  type HistoryLost,
  type CancelReply,
  type PendingItem,
  type PromptReply,
  type StagedConfig,
  type ThreadEvent,
  type TpsStats,
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

/** The commands a thread may recommend back to the user: its project's own —
    the saved helpers and the package.json scripts, the same union the `!`
    completer offers. Read at spawn so the trailer lists exactly the lines that
    exist today. Empty is an ordinary answer (a project that defines nothing),
    not a failure; a project directory that is gone fails the spawn elsewhere. */
async function recommendableCommands(projectId: string, cwd: string): Promise<SuggestableCommand[]> {
  const [helpers, scripts] = await Promise.all([
    listHelpers(projectId),
    listScriptsUnder(cwd),
  ]);
  return [
    ...helpers.map((helper) => ({ name: helper.name, command: helper.command })),
    ...scripts.map((script) => ({ name: script.name, command: script.command })),
  ];
}

/** What a suggestion kind has to read before its trailer can be written — the
    other half of an entry in `personas.ts`'s registry. A kind with no entry here
    needs nothing but its own fixed text. */
const SUGGEST_LOADERS: Partial<
  Record<SuggestKind, (from: { runner: WorkflowUrlSource | null; session: Session; project: Project }) => Promise<unknown>>
> = {
  commands: ({ project }) => recommendableCommands(project.id, project.cwd),
  /* The runner's own list, minus the thread's pair and any that cannot run. A
     child cannot ask, so it is offered none. */
  agents: async ({ runner, session }) =>
    runner && !session.parentSessionId
      ? (await runner.pairs(session)).filter((pair) => pair.installed && !pair.current)
      : [],
};

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

/** The profile a thread's `ask_agent` uses for each agent, by agent id. */
export type AskProfiles = Record<string, { profileId: string; model?: string }>;

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
  /** The thread's role → model assignment (`docs/model-roles.md`): one entry per
      `model_roles` row, `role` a role id and `model` a profile model id (`""` =
      the session model). A spawn input like model and effort — it builds
      `DAEDALUS_AGENT_MODEL_ROLES` and the materialised subagent files at spawn,
      so changing it costs a respawn. The column's order is the assignment. */
  helperModels: { role: string; model: string }[];
  /** Which closing blocks the agent is asked for — follow-ups, commands,
      replies, files, agents (`SUGGEST_KINDS`, `personas.ts`); empty = none.
      Same spawn-input bargain: read only at session creation/load, so
      changing it costs a respawn. */
  suggestKinds: SuggestKind[];
  /** Which component groups the drawn-answers trailer teaches (`UI_GROUP_IDS`,
      `personas.ts`): the one setting for whether the agent may answer with a
      fenced `openui-lang` block, which the client draws as real UI
      (`client/src/lib/openui/`). Empty = off; non-empty always includes
      "layout". Same spawn-input bargain as the suggestions trailer: it is
      system-prompt text, so a change costs a respawn. */
  uiGroups: string[];
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
  /** Min/max measured turn rate and its weighted-average inputs. */
  tps: TpsStats | null;
  /** Events ever journaled for this session. `cursor` is an index into this,
      not into any array — the log itself is a table (see session-journal.ts),
      so nothing about a long thread is held in memory. */
  eventCount: number;
  /** null = no live process (loaded from disk / retired); revive via respawn. */
  proc: Handle | null;
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
  /** The profile `ask_agent` uses per agent id; an agent not in it is asked about. */
  askProfiles: AskProfiles;
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
  /** Set while a respawn that *clears* the journal is running its handshake:
      the journaled events it emits are held here instead of appended, and
      the clear happens only once `bridge.ready` resolves — then they are
      replayed into the emptied log. A spawn that fails leaves the old journal
      exactly as it was. See `respawnNow`. */
  loadBuffer?: Array<[ThreadEvent, Peer | undefined, boolean]> | null;
  /** Original prompt text and attachment refs from old turn boundaries, aligned
      with user chunks while a `session/load` refills a cleared journal. */
  loadAttachmentTurns?: { text: string; attachments: AttachmentRef[] }[];
  /** The journal is this thread's conversation, whole: written live by a
      handshake that succeeded in *this* server run, not pruned since, and not
      forked from by a load that fell back to a fresh session. What lets a
      revive `session/resume` (no replay) and keep the log instead of clearing
      it for a `session/load` to refill. False at boot — an unclean stop may
      have lost the tail — so the first revive after one still loads. */
  journalClean: boolean;
  /** Takes this session's listeners off the process it is on (`wire`). */
  unwire: (() => void) | null;
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
  /** The passage an aside was started on, else null. Persisted. */
  asideQuote: string | null;
  /** The board task this thread was started on (`task-threads.ts`), else null.
      A pointer, not a foreign key: the spawn reads it fresh every time, so a
      deleted task is simply no task. Persisted. */
  taskId: string | null;
  /** The git worktree this thread runs in, project-relative, or null for the
      project's own cwd (`git.createWorktree`). Chosen on the draft, never
      moved: the agent names its conversation by the cwd it ran in. */
  worktree: string | null;
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
  /** The saved-file format that explains this runtime's prompt
      (`AgentDef.promptFiles`), read at spawn; null = inferred from the transcript. */
  promptFiles: PromptFilesFormat | null;
  /** The newest file reading whose item lists went out on a usage update, so
      the lists are said once and carried forward, as the agent's own are. */
  promptPrefixSent: number;
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
  /** The `agents` server, on the same terms: null for a thread that is itself
      a child, and for a caller with no thread behind it. */
  agents: StdioMcpServer | null = null,
  /** The `harness` server — the agent managing this harness. Top-level threads
      only, like `agents`. */
  harness: StdioMcpServer | null = null,
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
            : s.builtin === "agents"
              ? agents
              : s.builtin === "workflow"
                ? workflow
                : harness;
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

/** The harness's own `agents` MCP server: `ask_agent` and friends, over the
    workflow runner's loopback — an ask is a one-step run on another pair. */
export function agentsServer(session: Pick<Session, "id">, runner: WorkflowUrlSource): StdioMcpServer {
  return harnessMcpServer(AGENTS_SERVER_NAME, "agents-mcp", [{ name: "AGENTS_URL", value: runner.urlFor(session) }]);
}

/** The harness's own `harness` MCP server: the agent managing this harness —
    tasks and boards, profiles, projects. Its loopback is the workflow runner's
    key under `/hm`, so the tool call acts for exactly this thread. */
export function harnessServer(session: Pick<Session, "id">, source: HarnessUrlSource): StdioMcpServer {
  return harnessMcpServer(HARNESS_SERVER_NAME, "harness-mcp", [{ name: "HARNESS_URL", value: source.harnessUrlFor(session) }]);
}

export interface SessionEvents {
  /** Fired only while no client is attached — used for push notifications. */
  onPermissionRequest?: (session: Session) => void;
  /** The agent asked the user something (elicitation/create) with nobody
      attached to answer. Same push case as a permission, different sentence. */
  onElicitationRequest?: (session: Session) => void;
  /** `error` is the error the prompt failed with, when it failed. `promptText`
      is the message that opened the turn, so a notification can say what was
      asked and not merely that something finished. */
  onTurnEnd?: (session: Session, error?: unknown, promptText?: string) => void;
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
  /** The (profile, agent) pairs an ask can reach — the agents suggestion's list. */
  pairs(parent: Session): Promise<{ profileId: string; profile: string; agentId: string; agent: string; installed: boolean; models: string[]; current: boolean }[]>;
}

/** What the manager needs from the workflow runner to hand a thread the
    `harness` MCP server: the same per-boot key and port under its own path
    (`/hm`), so managing the harness rides the runner's one loopback credential
    rather than minting a second. */
export interface HarnessUrlSource {
  harnessUrlFor(session: Pick<Session, "id">): string;
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

/** A retired thread held for boot adoption (`SessionManager.claimForAdopt`). */
export interface AdoptClaim {
  sessionId: string;
  acpSessionId: string;
  release(): void;
}

/** How long a reader waits for a thread held for boot adoption to be bound. Binding is
    a `session/resume` or `session/load` per thread, in sequence, so the last thread of
    many waits for the ones before it; past this the reader gets the archived view and the
    ordinary reattach picks the live one up. */
const ADOPT_WAIT_MS = 20_000;

export class SessionManager {
  private sessions = new Map<string, Session>();
  /** Server-side subscribers to a session's events (the workflow runner
      mirroring a step into its parent). Tapped after the journal, whether or
      not a peer is attached. */
  private subscribers = new Map<string, Set<(event: ThreadEvent) => void>>();
  /** One-shot waiters for a turn to settle, by session — see `whenTurnSettled`. */
  private turnWaiters = new Map<string, { turnId: string; settle: (outcome: TurnOutcome) => void; fail: (error: Error) => void }[]>();
  /** Injected at boot; null means no thread is handed the workflow server. */
  private workflowRunner: (WorkflowUrlSource & HarnessUrlSource) | null = null;
  /** The event-journal concern — the buffered writes, the reads that flush
      first, the turn-boundary math and the replay framing — extracted to
      session-journal.ts. The manager decides when; the journal knows the table. */
  private log = new SessionJournal(db);
  /** How long a thread nobody has open keeps its process (`sweepIdle`). */
  private idleMinutes: number;

  /** The idle sweep, once: retire every thread nobody has had open for
      `idleMinutes`, except those still working. Its own method so a test can
      run it at a chosen `now`. */
  sweepIdle(now = Date.now()): void {
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
        if (now - bridge.heldSince > HELD_TURN_MAX_MS) {
          console.warn(`[${s.id.slice(0, 8)}] hold (${bridge.pausedReason}) gave up after ${Math.round(HELD_TURN_MAX_MS / 3_600_000)}h with no reader`);
          void bridge.cancel().catch(() => {});
        }
        continue;
      }
      /* Nor a thread whose children are still working (`background`: a live
         ask or workflow run, or a runtime's own background task) — retiring
         it cancels them all (`onProcessGone`), and the answer they owe it
         would have nobody to wake. */
      if (s.parentSessionId || bridge?.promptActive || bridge?.background) continue;
      if (!s.exited && s.peers.size === 0 && s.detachedAt && now - s.detachedAt > this.idleMinutes * 60_000) {
        this.retire(
          s,
          `Nobody had this thread open for ${this.idleMinutes} minutes, so its agent process was stopped to free it. The conversation is kept — sending a message starts the agent again.`,
        );
      }
    }
  }

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
      // Timed because this is the one boot phase that scales with the data (journal
      // retention, then every thread row); see boot-timing.ts for the rest.
      const pruneStart = Date.now();
      await this.pruneJournals();
      const reloadStart = Date.now();
      await this.reload();
      console.log(
        `[boot] sessions: prune ${reloadStart - pruneStart}ms, reload ${Date.now() - reloadStart}ms (${this.sessions.size} threads)`,
      );
    })().catch((error) => console.error("[sessions] boot read failed", error));

    /* What answers a `/gw/<key>/s/<id>/…` request. The shim asks per request
       rather than being told at spawn, which is the whole of "the endpoint,
       credentials and model behind a running child are still ours to change"
       — see `applyConfig`. */
    setGatewaySessionResolver(async (id) => await this.gatewayStateOf(id));
    /* A runtime's own OpenTelemetry is filed under the thread its URL names, so
       the receiver asks whether there is one before it writes a span for it. */
    setOtlpThreadCheck((id) => this.sessions.has(id));

    this.idleMinutes = idleMinutes;
    setInterval(() => this.sweepIdle(), 60_000).unref();
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
        // Rows written before the mode column existed never picked one —
        // null is the agent's default, which is exactly what they had.
        modeId: row.modeId ?? null,
        // Same for the rest of the agent's selectors: a row written before the
        // column existed never recorded one, and "none recorded" is the empty
        // set, not a reason to restore anything.
        configChoices: row.configChoices ?? {},
        // A thread that names no helper reads as the empty map — the same thing
        // a row written before the column existed was.
        helperModels: row.helperModels ?? [],
        // Null on a row from before the set existed: the old boolean decides,
        // and a row older than that never asked either way, which is on.
        suggestKinds: suggestKindsOf(row.suggestKinds, row.suggestFollowups),
        // Null on a row from before the set existed: the legacy switch decides.
        uiGroups: uiGroupsOf(row.uiGroups, row.uiBlocks),
        askProfiles: row.askProfiles ?? {},
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
        journalClean: false,
        unwire: null,
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
        promptFiles: null,
        promptPrefixSent: 0,
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
  shutdown(): Promise<void> {
    if (durable) return this.shutdownDurable();
    for (const session of this.sessions.values()) {
      /* 1001 ("going away"), not 4000: a deploy says nothing about the thread,
         so the client's ladder reattaches on its own once the server is back,
         instead of drawing a dead thread with a Revive button. */
      this.closePeers(session, 1001, "The server shut down, which stops every agent process with it.");
      if (!session.exited)
        this.retire(
          session,
          "The server shut down, which stops every agent process with it. The conversation is kept — sending a message starts the agent again.",
        );
    }
    pool.drain(); // the warm ones nobody is on
    this.log.flush();
    return Promise.resolve();
  }

  /**
   * Shutdown over a durable sandbox (`DAEDALUS_SANDBOX=hosted`): the agents
   * keep running for the next server to adopt (`adopt-boot.ts`). So nothing is
   * closed — closing a bridge rejects its in-flight prompt, and a turn that is
   * still running must stay open in the journal for `adoptTurn` to end. The
   * handles are let go (sockets closed, hosts buffering), then every row is
   * written once the wire has stopped moving, and the rows stay.
   */
  private async shutdownDurable(): Promise<void> {
    for (const session of this.sessions.values()) {
      this.closePeers(session, 1001, "The server is restarting. Its agents keep running; this thread reattaches on its own.");
    }
    detachAllConnections();
    await new Promise((resolve) => setTimeout(resolve, 50)); // frames already read finish their hop
    await flushAllProcessStates();
    await this.log.flush();
  }

  /** Bridge construction for an adopted connection (`claimForAdopt` → `bindAdopted`). */
  private readonly adopting = new Map<string, { conn: AcpConnection; made: () => void }>();
  /** Threads claimed for boot adoption and not yet bound, by session id. A reader
      that arrives in that window waits on it (`whenAdopted`) rather than being
      shown an archived thread with a turn that is about to finish. */
  private readonly adoptHolds = new Map<string, Promise<unknown>>();

  /**
   * Resolves once a thread claimed for boot adoption has its bridge (or the
   * adoption gave up), at most `ADOPT_WAIT_MS` — so a client that reconnects
   * the moment the server listens gets the live thread, and the turn that ended
   * while the server was down arrives before its first frame, not after a reload.
   * Instant for every thread that is not being adopted.
   */
  async whenAdopted(id: string): Promise<void> {
    const hold = this.adoptHolds.get(id);
    if (!hold) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      hold.catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ADOPT_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  }

  /**
   * Boot adoption, step one: take the retired thread that owns this agent
   * session, before the server listens, so a send that races the adoption
   * queues behind it (the same chain `respawn` serialises on) instead of
   * spawning a second process. Null = no such thread to bind.
   */
  claimForAdopt(acpSessionId: string): AdoptClaim | null {
    let found: Session | undefined;
    for (const s of this.sessions.values())
      if (s.acpSessionId === acpSessionId && s.exited && !s.bridge && s.deletedAt === null) found = s;
    if (!found) return null;
    const session = found;
    let open!: () => void;
    const hold = new Promise<Session>((resolve) => (open = () => resolve(session)));
    session.respawnChain = hold;
    this.adoptHolds.set(session.id, hold);
    return {
      sessionId: session.id,
      acpSessionId,
      release: () => {
        if (session.respawnChain === hold) session.respawnChain = null;
        if (this.adoptHolds.get(session.id) === hold) this.adoptHolds.delete(session.id);
        open();
      },
    };
  }

  /**
   * Step two: open the claimed thread's bridge on the adopted connection. It is
   * the ordinary revive (`respawnNow`) with the journal kept — the process is
   * live and the log is the conversation — minus the spawn. `session/resume`
   * where the journal is whole and the agent offers it, `session/load` (replay
   * dropped as `quietLoad`) otherwise. Never throws; null = the thread stays
   * retired and revives on its next send, as before.
   */
  async bindAdopted(claim: AdoptClaim, conn: AcpConnection, made: () => void): Promise<AcpBridge | null> {
    const session = this.sessions.get(claim.sessionId);
    try {
      if (!session || !session.exited || session.bridge) return null;
      const [profile, project] = await Promise.all([getProfile(session.profileId), getProject(session.projectId)]);
      if (!profile || !project) return null;
      this.adopting.set(session.id, { conn, made });
      await this.respawnNow(session, profile, session.agentId, project, session.model, session.effort, {
        keepJournal: true,
        revive: true,
      });
      return session.bridge;
    } catch (error) {
      console.warn(`[adopt] ${claim.sessionId.slice(0, 8)} could not be bound: ${describe(error)}`);
      return null;
    } finally {
      this.adopting.delete(claim.sessionId);
      made();
    }
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
  /** Each session's row writes, in the order they were asked for. Callers do
      not await `persist`, and two UPDATEs in flight on the pool are not
      ordered — an older snapshot could land last and stay. */
  private readonly writes = new Map<string, Promise<void>>();

  private async persist(session?: Session): Promise<void> {
    const rows = session ? [session] : [...this.sessions.values()];
    for (const s of rows) {
      // A thread this manager no longer holds is one it has purged; the row is
      // gone and the update would match nothing anyway. Skipped rather than
      // sent, so a purge does not answer for every stale write behind it.
      if (this.sessions.get(s.id) !== s) continue;
      const write = (this.writes.get(s.id) ?? Promise.resolve())
        .catch(() => {})
        // Read when it runs, so a queued write carries the newest values.
        .then(() => (this.sessions.get(s.id) === s ? db.update(sessionsTable).set(rowValues(s)).where(eq(sessionsTable.id, s.id)) : undefined))
        .then(() => {});
      this.writes.set(s.id, write);
      void write.finally(() => {
        if (this.writes.get(s.id) === write) this.writes.delete(s.id);
      }).catch(() => {});
      await write;
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

  /** Persist the link selection without changing what the running process uses. */
  private async writeLinkSelection(session: Session, links: LinkSet): Promise<LinkSet> {
    await db.transaction(async (tx) => await writeLinks(tx, SESSION_LINKS, session.id, links));
    return await linksOf(SESSION_LINKS, session.id);
  }

  /** The thread's active links are read from the stored, validated selection. */
  private async persistLinks(session: Session): Promise<void> {
    session.links = await this.writeLinkSelection(session, session.links);
  }

  /** Stage a full thread-link selection without mutating the running session. */
  stageLinks(id: string, key: keyof LinkSet, ids: string[]): StagedConfig {
    const session = this.sessions.get(id);
    if (!session) throw new HttpError("not found", 404);
    if (session.deletedAt !== null) throw new HttpError("session deleted", 409);
    if (session.respawnChain) throw new HttpError("the agent is restarting; try changing tools again when it is ready", 409);
    const staged = session.stagedConfig ?? {};
    const next: StagedConfig = { ...staged, [key]: [...new Set(ids)] };
    this.setStaged(session, next);
    return next;
  }

  private async applyStagedLinks(session: Session, staged: StagedConfig): Promise<void> {
    if (
      staged.mcpServerIds === undefined &&
      staged.skillIds === undefined &&
      staged.commandIds === undefined
    ) return;
    session.links = await this.writeLinkSelection(session, {
      mcpServerIds: staged.mcpServerIds ?? session.links.mcpServerIds,
      skillIds: staged.skillIds ?? session.links.skillIds,
      commandIds: staged.commandIds ?? session.links.commandIds,
    });
  }

  cancelStaged(session: Session): void {
    this.clearStaged(session);
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
    /* A worktree thread shares its directory with no one but the threads in
       the same worktree, so the union is per *thread* cwd. */
    const cwd = threadCwd(session, project);
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
      if (!other.project || threadCwd(other, other.project) !== cwd) continue;
      await add(other.agentId, this.effectiveLinks(other));
    }
    for (const { layout, sets } of layouts.values()) {
      materializeWorkspace(cwd, layout, unionLinks(...sets));
    }
    /* The attachments materialised into `<cwd>/.daedalus/attachments/` follow
       the same rule and for the same reason: the directory is shared by every
       thread of the project, so the keep-set is the union across every live
       thread in this cwd — sweeping one thread's alone would delete the file
       the thread beside it just linked. `.daedalus/` is not covered by the
       project's own gitignore (we write one into it), so this sweep is the only
       thing keeping it from growing. */
    const cwds = [session, ...this.sessions.values()].filter(
      (s) => s.deletedAt === null && (s === session || (!s.exited && !!s.project && threadCwd(s, s.project) === cwd)),
    );
    sweepMaterialisedAttachments(cwd, await claimedAttachmentIds(cwds.map((s) => s.id)));
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
      if (session) {
        session.eventCount = 0;
        session.journalClean = false;
      }
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
    const filesId = session.liveAcpSessionId ?? session.acpSessionId;
    if (session.promptFiles && filesId && event.ev === "turn_started") refreshPromptPrefix(session.promptFiles, filesId);
    if (
      event.ev === "update" &&
      !event.historyReplay &&
      !event.sessionId &&
      event.update.sessionUpdate === "usage_update"
    ) {
      const update = event.update as acp.UsageUpdate;
      const meta = update._meta && typeof update._meta === "object" ? update._meta as Record<string, unknown> : {};
      const daedalus = meta.daedalus && typeof meta.daedalus === "object"
        ? meta.daedalus as Record<string, unknown>
        : {};
      const breakdown = daedalus.breakdown && typeof daedalus.breakdown === "object"
        ? daedalus.breakdown as Record<string, unknown>
        : null;
      if (!breakdown && session.promptFiles && filesId) {
        /* The runtime does not measure its own prompt, so what its own files say
           it held: the static part (system, tools, MCP) and what they do not
           hold. The reading is the cache's; the next one is scheduled. */
        refreshPromptPrefix(session.promptFiles, filesId);
        const prefix = promptPrefixOf(session.promptFiles, filesId);
        if (prefix) {
          const fresh = prefix.version !== session.promptPrefixSent;
          session.promptPrefixSent = prefix.version;
          event = {
            ...event,
            update: {
              ...update,
              sessionUpdate: "usage_update",
              _meta: {
                ...meta,
                daedalus: {
                  ...daedalus,
                  prefix: {
                    source: "files",
                    system: prefix.system,
                    tools: prefix.tools,
                    mcp: prefix.mcp,
                    missing: prefix.missing,
                    ...(fresh ? { items: prefix.items } : {}),
                  },
                },
              },
            },
          };
        }
      }
    }
    /* Closing a bridge rejects whatever it had in flight, and those rejections
       land a microtask later — after a purge has already deleted the row the
       event rows point at. Nothing is listening for them either way. */
    if (!this.sessions.has(session.id)) return;
    /* A child thread's questions are its parent's to answer too: an ask or a
       workflow step has nobody reading it, and a question parked there was a
       turn stuck where no one would look. Repeated live on the parent — never
       journaled, like the originals — under a namespaced id the parent's
       socket routes back; the handover on attach is `childPendingEvents`. */
    if (session.parentSessionId && (event.ev === "permission" || event.ev === "elicitation" || event.ev === "request_answered")) {
      const parent = this.sessions.get(session.parentSessionId);
      if (parent) this.emit(parent, forwardedRequest(session, event));
    }
    /* A respawn that kept the journal is being handed the conversation back by
       `session/load`, and every word of it is already a row in that journal.
       Dropped here rather than by clearing the log first, because the clear is
       what made a config change cost every peer a reattach and a rebuild — and
       what took the turn boundaries with it, which `rewindPoint`, the turn
       table of contents and every window are read from. See `respawnNow`. */
    if (session.quietLoad && event.ev === "update" && event.historyReplay) return;
    if (
      session.loadAttachmentTurns &&
      event.ev === "update" &&
      event.historyReplay &&
      event.update.sessionUpdate === "user_message_chunk" &&
      event.update.content.type === "text"
    ) {
      const text = event.update.content.text;
      const match = session.loadAttachmentTurns.findIndex((turn) =>
        turn.attachments.length > 0 &&
        turn.attachments.every((ref) => text.includes(`[attached: ${ref.name}`)),
      );
      if (match >= 0) {
        const turn = session.loadAttachmentTurns.splice(match, 1)[0];
        event = {
          ...event,
          historyText: turn.text,
          historyAttachments: turn.attachments,
        };
      }
    }
    if (session.loadBuffer && JOURNALED.has(event.ev)) {
      session.loadBuffer.push([event, except, mirrored]);
      return;
    }
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
      if (event.ev === "turn_started") {
        this.turnChanges.begin(session.id, event.turnId);
        void noteTurnStarted(session).catch((err) => console.warn(`[${session.id.slice(0, 8)}] task move failed: ${String(err)}`));
      }
      else this.turnChanges.end(session.id, event.turnId);
      /* And how that turn went, in the same write. A turn beginning clears the
         last one's failure — the thread is being worked on again, and a row
         that still said "failed" would be describing a turn two ago — and a
         turn ending states its own verdict, which for a clean or cancelled one
         is null. Only a top-level turn: a workflow step's `turn_ended` is
         never mirrored onto its parent, so a failed step marks the step. */
      const failedAs = event.ev === "turn_ended"
        ? event.error?.message ?? (event.failure?.severity === "error" ? event.failure.title : undefined)
        : undefined;
      session.lastTurnError = failedAs ? failedAs.slice(0, LAST_ERROR_MAX) : null;
      if (event.ev === "turn_ended" && event.usage) {
        session.tps = addTps(session.tps, {
          outputTokens: event.usage.outputTokens,
          durationMs: event.durationMs,
          toolDurationMs: event.toolDurationMs,
          generation: event.generation,
        });
      }
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

  /** The workflow runner saying whether a thread still has live asks or runs:
      background work, so the thread does not read done between turns. */
  setRunsActive(id: string, active: boolean): void {
    this.sessions.get(id)?.bridge?.setRunsActive(active);
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
    setImmediate(() => this.turnChanges.processGone(session.id));
    setImmediate(() => {
      const list = this.turnWaiters.get(session.id);
      if (!list) return;
      this.turnWaiters.delete(session.id);
      for (const w of list) w.fail(new Error(reason));
    });
  }

    /** The spawn-time facts for each suggestion kind the thread has on: one loader
      per kind that needs any (`SUGGEST_LOADERS`), so a new kind that must name
      something real is a loader here and nothing in the spawn path. */
  private async loadSuggestData(session: Session, project: Project): Promise<Partial<Record<SuggestKind, unknown>>> {
    const data: Partial<Record<SuggestKind, unknown>> = {};
    await Promise.all(
      session.suggestKinds.map(async (kind) => {
        const load = SUGGEST_LOADERS[kind];
        if (load) data[kind] = await load({ runner: this.workflowRunner, session, project });
      }),
    );
    return data;
  }

/** The live children of a thread — its workflow steps. */
  /** The questions a thread's live children are blocked on, as the events its
      own peers get for them — the attach handover's half of the forwarding in
      `emit`. */
  childPendingEvents(id: string): ThreadEvent[] {
    return this.childrenOf(id).flatMap((child) =>
      (child.bridge?.pendingEvents() ?? []).map((event) => forwardedRequest(child, event as ThreadEvent & { requestId: string })),
    );
  }

  /** Answer a child's question from its parent's socket. Null when the id is
      not a child's, or the request is gone (a slower answerer). */
  answerChild(parentId: string, id: string, response: unknown): { toolCallId?: string } | null {
    const at = childRequest(id);
    const child = at ? this.sessions.get(at.childId) : undefined;
    if (!at || !child || child.parentSessionId !== parentId) return null;
    return child.bridge?.answer(at.requestId, response) ?? null;
  }

  childrenOf(id: string): Session[] {
    return [...this.sessions.values()].filter((s) => s.parentSessionId === id);
  }

  setWorkflowRunner(runner: WorkflowUrlSource & HarnessUrlSource): void {
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
  private wire(session: Session, proc: Handle, bridge: AcpBridge, profileName: string, shared: boolean): void {
    const onStderr = (chunk: Buffer) => {
      const text = chunk.toString().trimEnd();
      // A shared process is logged once, by the pool, not once per thread on it.
      if (!shared) console.error(`[${session.id.slice(0, 8)}:${profileName}]`, text);
      if (session.bridge !== bridge) return;
      pushStderr(session, text);
    };
    proc.stderr.on("data", onStderr);
    // spawn() reports a missing binary, a bad cwd or a permissions problem
    // asynchronously — and an unhandled 'error' on a ChildProcess takes the
    // whole server down with it. Treat it as an immediate exit and tell the
    // client what the OS said, which is the only useful thing anyone has.
    const onError = (error: NodeJS.ErrnoException) => {
      if (session.bridge !== bridge) return;
      const reason = `agent failed to start: ${error.code ?? error.name} — ${error.message}`;
      console.error(`[${session.id.slice(0, 8)}:${profileName}]`, reason);
      pushStderr(session, reason);
      this.collapse(session, bridge, reason);
    };
    proc.on("error", onError);
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
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (session.bridge !== bridge) return;
      session.exited = true;
      setTimeout(() => finish(code, signal), EXIT_DRAIN_MS).unref();
    };
    proc.on("exit", onExit);
    proc.on("close", finish);
    /* Taken off again when the session leaves the process: a shared one
       outlives many threads, and each would otherwise leave four listeners
       behind on it. */
    session.unwire = () => {
      proc.stderr.off("data", onStderr);
      proc.off("error", onError);
      proc.off("exit", onExit);
      proc.off("close", finish);
      if (session.unwire) session.unwire = null;
    };
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
    /* Once per bridge: a failed handshake and the process's own error/close
       handlers can each report the same death. */
    if (this.collapsed.has(bridge)) return;
    this.collapsed.add(bridge);
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

  private collapsed = new WeakSet<AcpBridge>();

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
      /** Whether the agent should close answers with follow-up suggestions —
          picked on the draft, and free there: nothing is
          running yet, so there is no respawn to pay for. */
      suggestKinds?: string[];
      /** Whether answers may carry a drawn view — the same draft-picked,
          spawn-input bargain as the suggestions toggle. */
      /** Which component groups the drawn-answers lane teaches; absent = all. */
      uiGroups?: string[];
      /** Profile per agent id for `ask_agent`, picked on the draft; absent = ask. */
      askProfiles?: AskProfiles;
      /** The thread's role → model assignment, picked on the draft
          (`docs/model-roles.md`) — a spawn input like model and effort: written
          on the row and read at spawn, so a later change costs a respawn.
          Absent reads as no helpers. */
      helperModels?: { role: string; model: string }[];
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
      /** Run in a git worktree: `true` makes one for this thread
          (`git.createWorktree`), a string is an existing one (project-relative)
          — a workflow step working in its parent's. */
      worktree?: boolean | string;
      /** An aside of that thread, started on this passage. */
      aside?: { of: string; quote: string };
      /** The board task this thread works on — its trailer, its card's
          history and the card moving when a turn starts all follow it. */
      taskId?: string;
    } = {},
  ): Promise<Session> {
    await this.ready;
    /* Made before anything else exists, so a refusal (not a repository, not
       its root, an unborn branch) is a failed create with git's own words and
       no half-made thread behind it. The id is needed to name it, so it is
       minted here when the caller did not. */
    const threadId = id ?? randomUUID();
    const madeWorktree = opts.worktree === true;
    const worktree = madeWorktree
      ? await git.createWorktree(project.cwd, threadId)
      : typeof opts.worktree === "string"
        ? opts.worktree
        : null;
    /* A failed create leaves nothing behind: no map entry (a retry would be a
       409), no row (a ghost "New thread"), no worktree this call made. */
    const undoWorktree = () => {
      if (madeWorktree && worktree) void git.removeWorktree(project.cwd, worktree, true).catch(() => {});
    };
    let session: Session;
    try {
      session = this.blankSession(profile, agentId, project, links, {
        worktree,
        id: threadId,
        model,
        effort,
        modeId: opts.modeId,
        suggestKinds: opts.suggestKinds,
        uiGroups: opts.uiGroups,
        askProfiles: opts.askProfiles,
        helperModels: opts.helperModels,
        title: opts.title,
        parentSessionId: opts.parentSessionId,
        autonomy: opts.autonomy,
        taskId: opts.taskId,
        ...(opts.aside ? { forkedFrom: { sessionId: opts.aside.of, turnId: null }, asideQuote: opts.aside.quote } : {}),
      });
    } catch (error) {
      undoWorktree();
      throw error;
    }
    /* Re-checked after the awaits above, and synchronously with the set: a
       caller's "is it free" was asked before them, and two creates for one id
       both passing it used to overwrite the map — leaking the first thread's
       process where nothing could reach it again. Refused before anything is
       ours to undo: the id's owner keeps its row, links and worktree. */
    if (this.sessions.has(session.id)) throw new HttpError("session already exists", 409);
    this.sessions.set(session.id, session);
    try {
      // Before the bridge: the event rows reference this one, so the session has
      // to exist by the time the agent's first update arrives.
      await this.createRow(session);
      await this.persistLinks(session);
      const bridge = await this.start(session, profile, project, model, effort, {
        configChoices,
        restore: opts.restore,
        modeId: opts.modeId,
      });
      /* The handshake is part of creating: a thread whose agent never answered
         is not one. */
      await bridge.ready;
    } catch (error) {
      const message = spliceStderr(session, describe(error));
      this.sessions.delete(session.id);
      if (!session.exited) this.retire(session, message);
      await db.delete(sessionsTable).where(eq(sessionsTable.id, session.id)).catch(() => {});
      undoWorktree();
      if (error instanceof HttpError) throw new HttpError(message, error.status);
      throw new Error(message);
    }
    /* Again, now that the handshake has answered. What it answered with — the
       agent's session id above all — is written by a callback whose own write
       is not awaited by anything (`onAcpSessionId`), so it is only as durable
       as whatever the connection pool is doing. `create` returning is the
       moment a caller is entitled to assume the row matches the thread, and an
       id that never reached the row is a conversation the next boot cannot
       find. */
    await this.persist(session);
    // A marker on the card's history; the thread exists either way if it fails.
    void noteThreadLinked(session).catch((err) => console.warn(`[${session.id.slice(0, 8)}] task link note failed: ${String(err)}`));
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
      suggestKinds?: string[];
      uiGroups?: string[];
      /** Profile per agent id for `ask_agent`, picked on the draft; absent = ask. */
      askProfiles?: AskProfiles;
      helperModels?: { role: string; model: string }[];
      title?: string;
      parentSessionId?: string;
      autonomy?: AutonomyPolicy;
      /** Where a forked thread was branched from — the parent's id and the
          turn the branch carries through. Provenance only; see `Session`. */
      forkedFrom?: { sessionId: string; turnId: string | null };
      /** An aside: a thread started from a passage selected in another. */
      asideQuote?: string;
      /** The board task this thread works on. */
      taskId?: string;
      /** Project-relative worktree this thread runs in. */
      worktree?: string | null;
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
      /* A draft's role → model assignment is a spawn input like model and
         effort (not a selector the agent confirms), so it is written here
         rather than left for `onSpawnStateChange`. */
      helperModels: opts.helperModels ?? [],
      suggestKinds: opts.suggestKinds ? normalizeSuggestKinds(opts.suggestKinds) : [...DEFAULT_SUGGEST_KINDS],
      uiGroups: opts.uiGroups ? normalizeUiGroups(opts.uiGroups) : [...UI_GROUP_IDS],
      title: opts.title ?? "New thread",
      titleFromPrompt: null,
      acpSessionProvisional: false,
      liveAcpSessionId: null,
      historyLost: null,
      createdAt: opts.createdAt ?? now,
      lastActivityAt: opts.createdAt ?? now,
      lastTurnError: null,
      context: null,
      tps: null,
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
      askProfiles: opts.askProfiles ?? {},
      exited: false,
      respawnChain: null,
      quietLoad: false,
      journalClean: false,
      unwire: null,
      stagedConfig: null,
      queueChain: null,
      parentSessionId: opts.parentSessionId ?? null,
      forkedFromSessionId: opts.forkedFrom?.sessionId ?? null,
      forkedFromTurnId: opts.forkedFrom?.turnId ?? null,
      asideQuote: opts.asideQuote ?? null,
      taskId: opts.taskId ?? null,
      worktree: opts.worktree ?? null,
      autonomy: opts.autonomy ?? null,
      deadline: null,
      autonomyBlocked: 0,
      cancelReason: null,
      spawnProfileId: profile.id,
      viaGateway: false,
      promptFiles: null,
      promptPrefixSent: 0,
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
      load?: { acpSessionId: string; resume?: boolean };
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
    /* Independent reads, taken together: each is a query, and in series they
       were the part of a spawn that happens before the process even exists.
       The materialisation is among them and awaited: a failure to write the
       workspace (or a project directory that is gone) fails the spawn. */
    const [agent, rules, servers] = await Promise.all([
      getAgent(session.agentId),
      Promise.all([globalRules(), projectRules(project.id)]).then(([global, local]) => [...global, ...local]),
      this.serversFor(session, profile, project),
      this.materializeFor(session, profile, project),
    ]);
    /* Measured, not assumed: a missing binary fails here naming the agent and
       its own install line, not later as an ENOENT naming the command. */
    if (agent) assertInstalled(agent, session, project);
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
      materializeModelAllowlist(threadCwd(session, project), allowlist, modelAllowlistFor(agent, profile, await listProfiles()));
    }
    /* Helper models used to reach Claude Code as per-role agent files; they
       are our runtime's alone now, so the files that wrote are taken back. */
    if (allowlist) sweepSubagentRoles(threadCwd(session, project), allowlist);
    session.spawnProfileId = profile.id;
    session.viaGateway = !!gatewayUrlFor(profile.id, session.agentId, profileBaseUrl(profile, session.agentId), session.id);
    session.promptFiles = agent?.promptFiles ?? null;
    session.promptPrefixSent = 0;
    /* Resolved once and handed to both halves, because which half uses it is
       the agent's business and not this one's: `spawnAgent` places it in the
       env for an `"env"` agent, `AcpBridge` puts it in the handshake `_meta`
       for an `"acp-meta"` one, and each ignores it for the other kind. Called
       unconditionally — a thread that has just had its persona removed needs
       the stale prompt file cleared as much as one that gained a persona needs
       it written. */
    /* Nobody in front of a workflow step or a scheduled run: `autonomy` is null
       exactly for the thread with a human at it (see `Session.autonomy`). */
    const unattended = !!session.parentSessionId || session.autonomy !== null;
    const persona = await resolvePersonaSpawn(
      session.id,
      agent,
      {
        suggestKinds: session.suggestKinds,
        /* A drawn view is read by a person; an unattended run's output goes to
           a log and wants prose it can grep. */
        uiGroups: unattended ? [] : session.uiGroups,
        /* What each enabled suggestion kind needs to know to be asked well,
           read now so a respawn sees today's commands and agents. Only the kinds
           the thread asked for are loaded — one that is off pays no query. */
        suggestData: await this.loadSuggestData(session, project),
        /* Read now, not remembered: a respawn tells the agent where the card is
           and what it is called today. A workflow step has no harness MCP to
           act on it with, so it is told nothing. */
        task: session.parentSessionId ? null : await taskBrief(session.taskId),
      },
      rules,
    );
    const adoptedBy = this.adopting.get(session.id);
    this.adopting.delete(session.id);
    const spec = await resolveAgentSpawn(
        profile,
        session.agentId,
        /* The agent runs where the thread does — its worktree, when it has one. */
        { ...project, cwd: threadCwd(session, project) },
        ownsCatalog ? model : undefined,
        ownsCatalog ? effort : undefined,
        session.id,
        persona,
        /* Nobody is going to change the model for a workflow step or a scheduled
           run, and `whenTurnSettled` is what both wait on — so a held turn there
           is a run that never reports. */
        unattended,
        /* The thread's role → model map, read off the session: a spawn input
           like model and effort, so `start` places it and a revive from the row
           alone carries it. */
        session.helperModels,
      );
    /* A runtime that takes env per session (`AgentDef.sharedProcess`) is
       spawned with none of the thread's: all of it — gateway URL, key, model
       vars — rides this session's `_meta` instead, so every thread in this cwd
       keys the same process and a warm one is simply handed over. */
    const shared = agent?.sharedProcess === "acp-meta";
    const sessionEnv = shared ? spec.env : undefined;
    if (shared) spec.env = {};
    const conn = adoptedBy?.conn ?? await pool.acquire(session.agentId, shared ? AcpPool.key(spec) : null, () => spawnProcess(spec));
    const proc = conn.proc;
    const { mcpServers, websearchViaMcp, workflowViaMcp } = servers;
    session.websearchViaMcp = websearchViaMcp;
    session.websearchCalls = new Set(); // in-flight calls went with the old process
    // Both belong to the process about to be replaced, and the handshake below
    // is what fills them in again — a stale "history lost" would outlive the
    // load that failed and mark a thread that has just been restored fine.
    session.liveAcpSessionId = null;
    session.historyLost = null;
    const bridge = new AcpBridge(this.hostFor(session), conn, {
      cwd: threadCwd(session, project),
      mcpServers,
      sessionEnv,
      ...opts,
      agentOwned: ownsCatalog ? undefined : { model, effort },
      websearchViaMcp,
      workflowViaMcp,
      /* Which of the runtime's own tools the two servers above stand in for,
         and how to switch them off. The bridge used to hold the answer for one
         runtime as two literal name lists; it is the row's, so an agent with
         no entry keeps its built-ins and one that grows a switch can say so. */
      builtinTools: agent?.builtinTools ?? null,
      persona: agent?.personaVia === "acp-meta" || agent?.personaVia === "air-meta" ? persona : undefined,
      personaVia: agent?.personaVia === "air-meta" ? "air-meta" : "acp-meta",
      /* A runtime with no pause of its own is held by the harness's hooks when
         its row names the door; the URL names the thread, not the process, so
         a shared process's sessions are held one at a time. */
      pauseHookUrl: agent?.pauseVia === "acp-meta" ? pauseHookUrlFor(session.id) || undefined : undefined,
      otlpTraced: !!agent?.telemetryVia && !!otlpUrlFor(session.id),
      /* The profile may opt out of Codex's fallback-metadata notice; the
         bridge is where it is dropped, so this is where the flag lands (see
         acp-bridge.ts). */
      suppressModelMetadataWarning: profile.suppressModelMetadataWarning === true,
    });
    session.proc = proc;
    session.bridge = bridge; // flips the generation guard
    session.exited = false;
    adoptedBy?.made();
    /* A failed handshake is collapsed HERE, for every caller — create, respawn,
       fork. Only respawn and fork used to, so a `session/new` that errored or
       timed out on a new thread left it `exited:false` on a dead bridge: every
       send failed on it and its child lived until the idle sweep. The real
       awaiter still sees the rejection; this handler also keeps it from
       surfacing as an unhandled one. */
    bridge.ready.then(
      () => {
        if (session.bridge === bridge && !session.historyLost) session.journalClean = true;
      },
      (error: unknown) => {
        if (session.bridge === bridge && !session.exited) this.collapse(session, bridge, spliceStderr(session, describe(error)));
      },
    );
    this.wire(session, proc, bridge, profile.name, conn.shared);
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
       (`AIR_META` in acp-bridge.ts, `nativeWorkflowRun` in the
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
    /* Asking another agent is one level too, but not the workflow engine's
       rival: Claude Code keeps its own Workflow and still gets this. */
    const agents = this.workflowRunner && !session.parentSessionId ? agentsServer(session, this.workflowRunner) : null;
    /* Managing the harness is one level too: a workflow step or a subagent is
       not the actor a person handed the harness to. */
    const harness = this.workflowRunner && !session.parentSessionId ? harnessServer(session, this.workflowRunner) : null;
    const links = this.effectiveLinks(session, profile);
    const { servers: mcpServers, skipped } = await mcpServersFor(
      links,
      project,
      getConfig(),
      workflow,
      agents,
      harness,
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
   *  - the **suggestions / drawn-UI** toggles, which are read only as a
   *    session is created or loaded (their trailers are folded into the spawn
   *    text, `personas.ts`), so there is no live path. The respawn is cheap in
   *    the way that matters — it ends in `session/load`, so the conversation
   *    comes back with it.
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
      suggestKinds?: string[];
      uiGroups?: string[];
      helperModels?: { role: string; model: string }[];
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
    /* Before anything moves — including `applyConfigLive`'s own writes — so the rows can be the difference
       between two readings rather than a guess from the request. */
    const before = await this.configLabels(session);
    /* **A pick is held, not taken — live-capable or not.** What the running
       process could take without a restart (model, effort, a gateway move) used
       to be applied on the spot, mid-turn included, which is a steer nobody
       approved: the answer under way changed model beneath the reader. Now the
       pick is staged like every other, and what takes it is a turn starting, a
       spawn, or the reader's own approval (`approveStaged`). `defer: false` is
       that approval, a **held** turn is waiting for exactly this change, and an
       **agent** change is a different runtime — none of them can wait. */
    const bridge = session.bridge;
    const movesAgent = next.agentId !== session.agentId;
    if (opts.defer !== false && !bridge?.paused && !movesAgent) {
      return { live: false, staged: this.stageConfig(session, next) };
    }
    if (await this.applyConfigLive(session, next)) {
      /* Whatever was waiting for the boundary has just been overtaken for the
         fields this call names — leaving them staged would move the setting
         back the moment the turn ended. */
      this.dropStaged(session, next);
      this.noteConfig(session, before, await this.configLabels(session));
      return { live: true };
    }
    /* Nothing live could be done, so this costs the process — taken now,
       because staging was refused above (see the three exclusions there). */
    /* The row moves before the respawn rather than being passed to it, because
       the toggles are not spawn arguments the way model and effort are:
       `start` reads them off the session (it has to, since a revive with no
       caller spawns from the row alone). Written here so the process that
       comes back is the one the user asked for. */
    if (next.suggestKinds !== undefined) session.suggestKinds = normalizeSuggestKinds(next.suggestKinds);
    if (next.uiGroups !== undefined) session.uiGroups = normalizeUiGroups(next.uiGroups);
    /* The role → model map is spawn-time like the toggles above: written here so
       the process that comes back reads it off the session at spawn. */
    if (next.helperModels !== undefined) session.helperModels = next.helperModels;
    /* Everything staged is about to be superseded by a process spawned on these
       settings — and it is dropped before the restart is announced, so a peer
       that reattaches at `ready` cannot be handed a stale one on `caught_up`. */
    this.clearStaged(session);
    const restart = this.restartWith(session, next, next.effort, before);
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
      /* The agent's own words for why it would not come up — the same splice
         the respawn route and a ready rejection make. */
      const wire = toWireError(error);
      this.emit(session, { ev: "restart", state: "failed", error: { ...wire, message: spliceStderr(session, wire.message) } });
      return error;
    }
    /* Every setting this restart moved, one row each, journaled so they replay
       and reach every peer on reattach. Said after the respawn, once the
       restored conversation is journaled again — before it, the clear would
       take them straight back out.

       This used to be the profile alone, which is the setting a restart is
       *least* likely to be about. */
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
      suggestKinds: session.suggestKinds,
      uiGroups: session.uiGroups,
      helperModels: session.helperModels,
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
      suggestKinds?: string[];
      uiGroups?: string[];
      helperModels?: { role: string; model: string }[];
    },
  ): StagedConfig {
    const staged: StagedConfig = {
      ...(session.stagedConfig ?? {}),
      profileId: next.profile.id,
      ...(next.model !== undefined ? { model: next.model } : {}),
      ...(next.effort !== undefined ? { effort: next.effort } : {}),
      ...(next.suggestKinds !== undefined ? { suggestKinds: next.suggestKinds } : {}),
      ...(next.uiGroups !== undefined ? { uiGroups: normalizeUiGroups(next.uiGroups) } : {}),
      ...(next.helperModels !== undefined ? { helperModels: next.helperModels } : {}),
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
    /* On a live process, a patch that is only the agent's own selectors needs
       no spawn: apply it directly. With no process, continue through the
       respawn path so those picks can be applied to the revived bridge. */
    if (
      !hasSpawnFields(staged) &&
      !hasLinks(staged) &&
      session.bridge &&
      !session.exited
    ) {
      return this.takePicks(session, staged);
    }
    try {
      /* Thread links are fixed when the runtime session is created. Even an
         agent whose model can move live must respawn to receive staged MCP,
         skill, or command picks. Keep the patch intact for respawnNow to fold
         (including the link rows) rather than routing through applyConfig,
         which can accept the unchanged/live model and clear it without a spawn. */
      if (hasLinks(staged)) {
        const previousLinks = session.links;
        try {
          await this.respawn(session.id, profile, session.agentId, project, model, effort);
        } catch (error) {
          if (session.links !== previousLinks) {
            session.links = await this.writeLinkSelection(session, previousLinks);
          }
          if (session.stagedConfig !== staged) this.setStaged(session, staged);
          throw error;
        }
        return;
      }
      await this.applyConfig(
        session.id,
        {
          profile,
          agentId: session.agentId,
          project,
          model,
          effort,
          ...(staged.suggestKinds !== undefined ? { suggestKinds: staged.suggestKinds } : {}),
          ...(staged.uiGroups !== undefined ? { uiGroups: staged.uiGroups } : {}),
          ...(staged.helperModels !== undefined ? { helperModels: staged.helperModels } : {}),
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
    /* After the spawn, on the process that is there now — `applyConfig` dropped
       the whole patch (picks included) before it restarted, so `staged` is the
       copy that still names them. */
    await this.takePicks(session, staged);
  }

  /** Take the agent-selector half of a staged patch on the running process and
      forget it. Taken *out* of the patch first, so a peer is never told a
      change is waiting that is already on its way. */
  private async takePicks(session: Session, staged: StagedConfig): Promise<void> {
    const { modeId, options } = staged;
    if (modeId === undefined && !options) return;
    const rest: StagedConfig = { ...(session.stagedConfig ?? {}) };
    delete rest.modeId;
    delete rest.options;
    if (session.stagedConfig) {
      if (Object.keys(rest).length === 0) this.clearStaged(session);
      else this.setStaged(session, rest);
    }
    if (session.bridge && !session.exited) await session.bridge.applyPicks({ modeId, options });
  }

  /** Stage a pick of the agent's own — the mode, or any option it advertises. */
  stagePick(id: string, pick: { modeId?: string; options?: Record<string, string | boolean> }): StagedConfig {
    const session = this.sessions.get(id);
    if (!session) throw new HttpError("not found", 404);
    if (session.deletedAt !== null) throw new HttpError("session deleted", 409);
    const staged = session.stagedConfig ?? {};
    const next: StagedConfig = {
      ...staged,
      ...(pick.modeId !== undefined ? { modeId: pick.modeId } : {}),
      ...(pick.options ? { options: { ...staged.options, ...pick.options } } : {}),
    };
    this.setStaged(session, next);
    return next;
  }

  /**
   * The reader's approval of what is staged, now.
   *
   * **A running turn is steered, never restarted**: only what the process can
   * take as it is — the agent's selectors, and a model/effort/gateway move its
   * live path accepts — and whatever needs a spawn stays staged for the next
   * turn. A thread nobody is running is not mid-anything, so there the whole
   * patch is taken, spawn included (the same flush a send makes).
   */
  async approveStaged(id: string): Promise<StagedConfig | null> {
    const session = this.requireSession(id);
    if (!session.stagedConfig) return null;
    await session.respawnChain?.catch(() => {});
    const bridge = session.bridge && !session.exited ? await this.whenSpawnable(session) : null;
    if (!bridge || !bridge.promptActive || bridge.paused) await this.flushStagedNow(session);
    else await this.steerStaged(session);
    return session.stagedConfig;
  }

  /** The live-only half of `flushStagedNow`. Never throws and never respawns —
      it is called at a drained message's start and by a steer-approval, neither
      of which can pay for a restart or fail over a setting. */
  private async steerStaged(session: Session): Promise<void> {
    const staged = session.stagedConfig;
    if (!staged) return;
    try {
      await this.takePicks(session, staged);
      if (staged.profileId === undefined && staged.model === undefined && staged.effort === undefined) return;
      const profile = await getProfile(staged.profileId ?? session.profileId);
      const project = await getProject(session.projectId);
      if (!profile || !project || !profileSupports(profile, session.agentId)) return;
      const moving = profile.id !== session.profileId;
      const next = {
        profile,
        agentId: session.agentId,
        project,
        model: modelFor(session, profile, staged.model ?? (moving ? "" : session.model)),
        effort: staged.effort ?? (moving ? "" : session.effort),
      };
      const before = await this.configLabels(session);
      if (await this.applyConfigLive(session, next)) {
        this.dropStaged(session, next);
        this.noteConfig(session, before, await this.configLabels(session));
      }
    } catch (error) {
      console.warn("couldn't steer the staged change", error);
    }
  }

  /* ── Saying what changed ───────────────────────────────────────────────────
   *
   * One reading per setting, in the words the menu uses, taken before the
   * change and again after it. The rows are the difference, and taking them
   * this way rather than from the request is what makes them honest: a menu
   * sends model and effort on *every* call (they fall back to the row for what
   * the user did not pick), a profile move deliberately clears both, and a model the agent
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
    "Follow-ups",
    "Drawn UI",
    "MCP",
    "Skills",
    "Commands",
  ];

  private async configLabels(session: Session): Promise<Record<ConfigNoticeLabel, string>> {
    const agent = await getAgent(session.agentId);
    /* The catalog's label where the profile owns one, the raw id where it does
       not — the same fallback `selectValueName` makes, for the same reason: an
       id nobody can name is still better than saying nothing changed. */
    const model = session.profile?.models?.find((m) => m.id === session.model);
    return {
      Profile: session.profile?.name ?? session.profileId,
      Agent: agent?.name ?? session.agentId,
      Model: model?.label || session.model || "Default",
      Effort: session.effort || "Default",
      "Follow-ups": session.suggestKinds.length ? session.suggestKinds.join(", ") : "Off",
      "Drawn UI": !session.uiGroups.length
        ? "Off"
        : session.uiGroups.length < UI_GROUP_IDS.length
          ? `${session.uiGroups.length} of ${UI_GROUP_IDS.length} groups`
          : "All",
      // Never diffed here: the mode travels its own door and writes its own row
      // (`AcpBridge.setMode`). Present so the record is total.
      Mode: session.modeId ?? "",
      ...(await this.linkLabels(session)),
    };
  }

  /** A thread's tool links as words for a config row — one reading per kind,
      the ids resolved against the library so `MCP: none → Workflow` names a
      server rather than a uuid. Read off `session.links`, which is the active
      selection: `applyStagedLinks` writes it before the notices are taken, so
      the diff is between two readings and never a guess from the patch. An
      emptied set reads `none`, matching the menus' own word for it. */
  private async linkLabels(session: Session): Promise<{ MCP: string; Skills: string; Commands: string }> {
    const [mcp, skills, commands] = await Promise.all([
      mcpLibrary.list(),
      skillLibrary.list(),
      commandLibrary.list(),
    ]);
    const names = (list: { id: string; name: string }[], ids: string[]): string =>
      ids.length === 0 ? "none" : ids.map((id) => list.find((item) => item.id === id)?.name ?? id).join(", ");
    return {
      MCP: names(mcp, session.links.mcpServerIds),
      Skills: names(skills, session.links.skillIds),
      Commands: names(commands, session.links.commandIds),
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
      suggestKinds?: string[];
      uiGroups?: string[];
      helperModels?: { role: string; model: string }[];
    },
  ): Promise<boolean> {
    const agent = await getAgent(session.agentId);
    if (!agent?.liveConfig) return false;
    if (next.agentId !== session.agentId) return false;
    /* The role → model map is spawn text (`DAEDALUS_AGENT_MODEL_ROLES`) and a
       materialised set of files, both read once at spawn — so a thread that
       moves it needs the new process, exactly like a profile move. */
    if (next.helperModels !== undefined) return false;
    /* Nothing to be clever about: `_meta` is read at `session/new`/`session/load`
       and codex's config is read at spawn. The suggestions trailer is spawn text, so a
       thread that flips it needs the new process rather than a live patch. */
    if (next.suggestKinds !== undefined && !sameSuggestKinds(next.suggestKinds, session.suggestKinds)) return false;
    /* As are the drawn-UI lane's instructions, for the same reason. */
    if (next.uiGroups !== undefined && !sameUiGroups(next.uiGroups, session.uiGroups)) return false;
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
      suggestKinds: session.suggestKinds,
      uiGroups: session.uiGroups,
      helperModels: session.helperModels,
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
    opts: { keepJournal?: boolean; clear?: boolean; revive?: boolean } = {},
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
    opts: { keepJournal?: boolean; clear?: boolean; revive?: boolean } = {},
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
    /* A revive of a thread that is already live is answered with the live
       thread. Two devices opening the same retired thread each ask for one;
       the second, queued behind the first, used to kill the process the first
       had just brought up. Only a revive (`opts.revive`) — a restart asked for
       by name may be about a setting that is not an argument here
       — and only with nothing to change. */
    if (
      opts.revive &&
      !opts.clear &&
      !session.stagedConfig &&
      session.bridge &&
      !session.exited &&
      profile.id === session.profileId &&
      agentId === session.agentId &&
      (!model || model === session.model) &&
      (!effort || effort === session.effort)
    ) {
      await session.bridge.ready;
      return session;
    }
    /* What `start` would refuse, refused before anything is torn down: an
       unknown agent, a profile not configured for it, a binary that is not
       there. Failing after the close below left a thread with no process and
       a row naming settings nothing ever ran on. */
    const agentDef = await getAgent(agentId);
    if (!agentDef) throw new Error(`unknown agent: ${agentId}`);
    if (!profileSupports(profile, agentId)) {
      throw new Error(`profile "${profile.name}" is not configured for ${agentId}`);
    }
    assertInstalled(agentDef, session, project);
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
      /* The row moves before the spawn rather than being passed to it: the
         toggles are not spawn arguments the way model and effort are, `start`
         reads them off the session. Same bargain as `applyConfig`'s. */
      if (staged.suggestKinds !== undefined) session.suggestKinds = normalizeSuggestKinds(staged.suggestKinds);
      if (staged.uiGroups !== undefined) session.uiGroups = normalizeUiGroups(staged.uiGroups);
      if (staged.helperModels !== undefined) session.helperModels = staged.helperModels;
      await this.applyStagedLinks(session, staged);
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
    const oldBridge = session.bridge;
    /* Put back if the spawn fails: the row must name what is actually running
       — or, with nothing running, what last did. */
    const prev = { profileId: session.profileId, agentId: session.agentId, model: session.model, effort: session.effort };
    session.bridge = null; // stale generation from here on
    session.unwire?.();
    /* Closing the bridge is what ends the process — or, on a shared one, this
       session on it (`AcpConnection.detach`). */
    oldBridge?.close(new Error("respawning"));
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
    /* A journal known to be the whole conversation is kept on a revive too,
       not only on a live restart, and the agent is asked to `session/resume`
       it — no narration at all. `clear` is the rewind's: truncating is what it
       is for. */
    const keep = !opts.clear && (opts.keepJournal || (session.journalClean && session.eventCount > 0));
    session.journalClean = false; // until this spawn's handshake says otherwise
    /* The clear is not taken until the new process has proven itself: the
       load's narration is held (`loadBuffer`) and written into the emptied log
       once `ready` resolves. A spawn that fails — a crash, a refused handshake
       — used to have already destroyed the only readable copy of the thread. */
    if (keep) session.quietLoad = true;
    else {
      session.loadAttachmentTurns = await this.log.turnAttachments(session.id);
      /* The old bridge's close lands a microtask or two later, and the turn it
         interrupted ends in the log being *kept* until this spawn proves
         itself — the same tick `processGone` waits for. */
      await new Promise((resolve) => setImmediate(resolve));
      session.loadBuffer = [];
    }
    resetStderr(session);
    try {
      const bridge = await this.start(session, spawnProfile, project, spawnModel, spawnEffort, {
        load: session.acpSessionId ? { acpSessionId: session.acpSessionId, resume: keep } : undefined,
        restore,
        ...(choices && Object.keys(choices).length > 0 ? { configChoices: choices } : {}),
      });
      this.persist(session);
      // A handshake that never finished leaves a thread that needs reviving —
      // `start` has collapsed it, and the caller turns this into an {error}.
      await bridge.ready;
      if (session.loadBuffer) {
        await this.log.clear(session);
        const held = session.loadBuffer;
        session.loadBuffer = null;
        for (const [event, except, mirrored] of held) this.emit(session, event, except, mirrored);
      }
    } catch (error) {
      /* Never leave `bridge: null, exited: false` behind — every path that
         asks "is this thread live" reads `exited`, and a send then failed
         inside a bridge that did not exist instead of reviving. */
      const failed = session.bridge;
      if (failed && !session.exited) this.collapse(session, failed, spliceStderr(session, describe(error)));
      else if (!failed) {
        session.exited = true;
        session.proc = null;
        this.processGone(session, describe(error));
      }
      Object.assign(session, prev);
      this.persist(session);
      throw error;
    } finally {
      /* The load is over either way it went, and a flag left standing would
         silence the next turn's updates or apply stale attachment refs. */
      session.quietLoad = false;
      session.loadBuffer = null;
      session.loadAttachmentTurns = undefined;
    }
    /* A fold moved settings nobody has announced yet — `restartWith` says what
       it moved because it knows, and this spawn happened for some other reason
       entirely (a send reviving the thread, a rewind, the restart route). Said
       here, after the load, for `restartWith`'s own reason: before it, a clear
       would take the rows straight back out again. */
    if (staged && (staged.modeId !== undefined || staged.options)) {
      /* Re-read off the map: `session.bridge` was assigned null above, and
         control flow has not heard that `start` put another there. */
      await this.sessions.get(session.id)?.bridge?.applyPicks({ modeId: staged.modeId, options: staged.options });
    }
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
        suggestKinds: session.suggestKinds,
        uiGroups: session.uiGroups,
        helperModels: session.helperModels,
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
      /* A worktree thread's snapshots are of its own checkout. */
      restored = (await git.restoreToTree(session.projectId, tree, { repo: session.worktree || undefined })).restored;
    }

    if (cut) {
      // Configuration unchanged on every axis — only the conversation moved —
      // so the respawn gets the row's own values back, exactly as a revive of
      // an untouched thread would.
      await this.respawn(session.id, profile, session.agentId, project, session.model || undefined, session.effort || undefined, {
        clear: true,
      });
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
      suggestKinds: session.suggestKinds,
      uiGroups: session.uiGroups,
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
    /* A branch of a worktree thread is in the same worktree: its conversation
       names that cwd, and so do the files the fork point describes. */
    child.worktree = session.worktree;
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
    await childBridge.ready; // collapsed by `start` if it fails
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

  /** Every question any live agent is blocked on, oldest first — the
      cross-thread inbox. Built from each bridge's `pending` map and nothing
      else: a permission is never journaled, so there is no second source. */
  pendingAll(): PendingItem[] {
    const items: PendingItem[] = [];
    for (const s of this.sessions.values()) {
      if (!s.bridge || s.deletedAt !== null) continue;
      for (const entry of s.bridge.pending.values()) {
        const base = {
          sessionId: s.id,
          parentSessionId: s.parentSessionId ?? null,
          projectId: s.projectId,
          agentId: s.agentId,
          threadTitle: s.title,
          requestId: entry.requestId,
          askedAt: entry.askedAt,
        };
        items.push(
          entry.kind === "permission"
            ? { ...base, kind: "permission", request: entry.payload as acp.RequestPermissionRequest }
            : { ...base, kind: "elicitation", request: entry.payload as acp.CreateElicitationRequest },
        );
      }
    }
    return items.sort((a, b) => a.askedAt - b.askedAt);
  }

  /** Answer a permission with one of the options the agent offered, from a
      surface with no socket (the inbox). It is `bridge.answer` with no origin
      peer — the door the socket's `answer_permission` takes — so first answer
      wins exactly as there, and `request_answered` fans out to every peer,
      since none of them caused it. `"gone"` is a slower answerer losing the
      race (or a request that never existed); `"bad"` an option the agent did
      not offer, or an elicitation, whose fields are drawn in its thread. */
  answerPending(id: string, requestId: string, optionId: string): "ok" | "gone" | "bad" {
    const bridge = this.sessions.get(id)?.bridge;
    const entry = bridge?.pending.get(requestId);
    if (!bridge || !entry) return "gone";
    if (entry.kind !== "permission") return "bad";
    const offered = (entry.payload as acp.RequestPermissionRequest).options.some((o) => o.optionId === optionId);
    if (!offered) return "bad";
    return bridge.answer(requestId, { outcome: { outcome: "selected", optionId } }) ? "ok" : "gone";
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
    // A collapsed process keeps its bridge; it is no more live than none.
    if (!bridge || session.exited) throw new Error("this thread has no running agent");
    await bridge.ready;
    if (session.bridge !== bridge || session.exited) throw new Error("the agent process is gone");
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
  /** Per-turn worktree snapshots and their diffs — see turn-changes.ts. */
  readonly turnChanges = new TurnChangesRecorder({
    cwdOf: (id) => {
      const s = this.sessions.get(id);
      return s?.project ? threadCwd(s, s.project) : null;
    },
    emit: (id, turn) => {
      const session = this.sessions.get(id);
      if (!session) return;
      this.emit(session, { ev: "turn_changes", turn });
      /* A child thread's turn is part of its parent's work, and the parent's
         Changes list includes it (`TurnChangesRecorder.list`). */
      const parent = session.parentSessionId ? this.sessions.get(session.parentSessionId) : undefined;
      if (parent) this.emit(parent, { ev: "turn_changes", turn: { ...turn, sessionId: id } });
    },
    projectOf: (id) => {
      const s = this.sessions.get(id);
      return s?.project ? { id: s.project.id, cwd: s.project.cwd } : null;
    },
    ownerOf: (id) => this.sessions.get(id)?.parentSessionId ?? id,
  });

  private queue = new SessionQueue({
    emit: (session, event) => this.emit(session, event),
    whenSpawnable: (session) => this.whenSpawnable(session),
    /* A drained message is the next turn: what is staged and needs no restart
       is taken here, and what does waits for a message of the reader's own. */
    startTurn: async (session, bridge, text, peer, opts) => {
      await this.steerStaged(session);
      return this.startTurn(session, bridge, text, peer, opts);
    },
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

  async queueReorder(id: string, ids: string[]): Promise<void> {
    await this.queue.reorder(this.requireSession(id), ids);
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
    /* Behind any respawn in flight, and never against a dead process: a
       hook-held bridge answers `resume` from its own state, so a collapsed one
       would report success for a turn nothing is running. */
    const bridge = await this.whenSpawnable(session);
    if (session.stagedConfig) {
      await this.flushStagedNow(session);
      if (session.bridge !== bridge) return { paused: false };
    }
    const result = await bridge.resume();
    if (session.bridge !== bridge || session.exited) throw new Error("the agent process is gone");
    return result;
  }

  queueSteer(id: string, itemId: string): Promise<{ turnId: string }> {
    return this.queue.steer(this.requireSession(id), itemId);
  }

  queueSendNow(id: string, itemIds?: string[]): Promise<{ turnId: string }> {
    return this.queue.sendNow(this.requireSession(id), itemIds);
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
    session.unwire?.();
    bridge?.close(new Error(reason)); // ends the process too, unless it is shared
    this.log.flush();
    resetStderr(session);
    this.processGone(session, reason);
  }

  /**
   * Remove a thread's worktree — the thread menu's door. Archiving leaves it
   * (the work is in it); this is the deliberate second step. A running turn
   * refuses, and so does uncommitted work unless `force` (`git.removeWorktree`
   * names what would go). The branch stays, and so does the column: the
   * thread is still the record of that work, and a revive into a directory
   * that is gone fails on it rather than quietly moving the agent elsewhere.
   */
  async removeWorktree(id: string, force: boolean): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (!session.worktree) throw new HttpError("this thread has no worktree", 400);
    if (session.bridge?.promptActive) throw new HttpError("a turn is running — stop it before removing its worktree", 409);
    const project = session.project ?? (await getProject(session.projectId));
    if (!project) throw new HttpError("this thread's project no longer exists", 409);
    session.project = project;
    await git.removeWorktree(project.cwd, session.worktree, force);
    if (!session.exited)
      this.retire(session, "This thread's worktree was removed, so its agent process was stopped.");
    return true;
  }

  /** Undo one ended turn's files in the working tree (`TurnChangesRecorder.revert`).
      Refused while a turn runs: the agent would be writing the same paths. */
  async revertTurn(id: string, turnId: string, force: boolean, partial?: Record<string, git.OwnEdit[]>) {
    const session = this.sessions.get(id);
    if (!session) throw new HttpError("not found", 404);
    if (session.bridge?.promptActive) throw new HttpError("a turn is running — stop it before reverting one", 409);
    return this.turnChanges.revert(id, turnId, force, partial);
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
      helperModels: s.helperModels,
      suggestKinds: s.suggestKinds,
      uiGroups: s.uiGroups,
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
      askProfiles: s.askProfiles,
      attached: s.peers.size > 0,
      peerCount: s.peers.size,
      /* A collapsed process keeps its bridge object (the generation token),
         so `exited` alone is the answer — but a thread mid-respawn has no
         bridge at all, and neither can take a prompt. */
      exited: s.exited || !s.bridge,
      promptActive: s.bridge?.promptActive ?? false,
      /* Live state for a list that has never opened the thread (the agents
         dashboard): read off the bridge, never stored. A permission or a
         question the agent is blocked on, a turn held at a failure, and the
         newest context reading. */
      waiting: (s.bridge?.pending.size ?? 0) > 0,
      held: !!s.bridge?.paused && s.bridge.pausedReason === "error",
      /* Work this thread started that is still going with no turn open — a
         Claude Code workflow, which answers its prompt at "launched" and runs
         on. A list with no socket to the thread has nothing else to go on, and
         without it the thread reads done while its workflow works. */
      backgroundActive: s.bridge?.background ?? false,
      context: s.context ? { used: s.context.used, size: s.context.size } : null,
      cursor: s.eventCount,
      parentSessionId: s.parentSessionId,
      forkedFromSessionId: s.forkedFromSessionId,
      forkedFromTurnId: s.forkedFromTurnId,
      asideQuote: s.asideQuote,
      taskId: s.taskId,
      /* The thread's own checkout, when it was isolated: where it is, the
         branch it was made on, and whether it is still there (a removed one
         keeps the column — a revive then fails on the missing cwd, loudly).
         ponytail: `exists` is only known for a thread whose project has been
         resolved (it has spawned since boot); unknown is left out and read as
         there — removing is idempotent, so the worst case is a menu row that
         prunes nothing. */
      worktree: s.worktree
        ? {
            path: s.worktree,
            branch: git.worktreeBranch(s.worktree),
            ...(s.project ? { exists: existsSync(threadCwd(s, s.project)) } : {}),
          }
        : null,
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
   * Replace which profile `ask_agent` uses for each agent on this thread. Only
   * a pair `ask` could reach is accepted — the list the asker sees — so a
   * stale id can never be stored.
   */
  async setAskProfiles(id: string, askProfiles: AskProfiles): Promise<AskProfiles | undefined> {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    const known = (await this.workflowRunner?.pairs(session)) ?? [];
    for (const [agentId, { profileId, model }] of Object.entries(askProfiles)) {
      const hit = known.find((p) => p.profileId === profileId && p.agentId === agentId);
      if (!hit) throw new HttpError(`profile "${profileId}" cannot run agent "${agentId}"`, 400);
      if (model && !hit.models.includes(model)) throw new HttpError(`${hit.profile} has no model "${model}"`, 400);
    }
    session.askProfiles = { ...askProfiles };
    this.persist(session);
    return session.askProfiles;
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
    killSessionTerminals(id);
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

  /**
   * Move every thread off a profile that is being deleted, onto its agent's
   * virtual Default — profile, model and effort, all back to the agent's own.
   *
   * The confirmed half of profile deletion (`DELETE …?force=1`): the plain
   * delete names the threads, the user confirms, and this is what the
   * confirmation runs. Transcripts stay — the journal is untouched and
   * `acpSessionId` still names the agent's own record — so the next send
   * revives the thread on Default exactly like any retired thread. A staged
   * change dies with the profile it was staged for, and helper models (profile
   * catalog ids) are cleared with the model they belonged to; the agent's own
   * selectors (`modeId`, `configChoices`) survive, because on a Default
   * profile those are the agent's and were never the profile's.
   *
   * All or nothing across running turns: a thread mid-turn cannot be moved
   * without killing the turn under it, so one busy thread refuses the whole
   * reset and names who is busy. Trashed threads are already on their way out
   * and are left alone.
   */
  async resetThreadsFromProfile(
    profileId: string,
  ): Promise<{ moved: string[]; busy: { id: string; title: string }[] }> {
    const targets = [...this.sessions.values()].filter((s) => s.profileId === profileId && s.deletedAt === null);
    const busy = targets
      .filter((s) => s.bridge?.promptActive)
      .map((s) => ({ id: s.id, title: s.title }));
    if (busy.length > 0) return { moved: [], busy };
    const former = await getProfile(profileId);
    const moved: string[] = [];
    for (const session of targets) {
      /* A pick waiting for the next spawn names the profile being left — it
         dies with it rather than landing on Default. */
      this.clearStaged(session);
      const profile = defaultProfileFor(session.agentId);
      if (!session.exited) {
        this.retire(
          session,
          `The “${former?.name ?? "profile"}” profile was deleted, so its agent process was stopped. The conversation is kept — sending a message starts the agent again on its Default profile.`,
        );
      }
      session.profileId = profile.id;
      session.profile = profile;
      session.model = "";
      session.effort = "";
      session.helperModels = [];
      await this.persist(session);
      /* Absolute, to every peer including a device only reading: the menus a
         device holds still name the deleted profile until this lands. */
      this.emit(session, {
        ev: "spawn_config",
        profileId: session.profileId,
        model: "",
        effort: "",
        suggestKinds: session.suggestKinds,
        uiGroups: session.uiGroups,
        helperModels: [],
      });
      moved.push(session.id);
    }
    return { moved, busy: [] };
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
    killSessionTerminals(id);
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
    childPendingEvents: (id) => this.childPendingEvents(id),
    answerChild: (parentId, requestId, response) => this.answerChild(parentId, requestId, response),
    whenAdopted: (id) => this.whenAdopted(id),
    journal: this.log,
    prompt: async (id, text, peer, opts) => await this.prompt(id, text, peer, opts),
    queueAdd: async (id, text, attachmentIds) => await this.queueAdd(id, text, attachmentIds),
    queueSendNow: async (id, itemIds) => await this.queueSendNow(id, itemIds),
    queueSteer: (id, itemId) => this.queueSteer(id, itemId),
    queueUpdate: (id, itemId, text, attachmentIds) => this.queueUpdate(id, itemId, text, attachmentIds),
    queueRemove: (id, itemId) => this.queueRemove(id, itemId),
    queueReorder: (id, ids) => this.queueReorder(id, ids),
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

/** Measured, not assumed: a missing binary fails naming the agent and its own
    install line, not later as an ENOENT naming the command. */
function assertInstalled(agent: AgentDef, session: Session, project: Project): void {
  const found = checkInstalled(agent, { ...project, cwd: threadCwd(session, project) });
  if (!found.installed) {
    throw new HttpError(
      `${agent.name} is not installed (missing ${found.missing})${agent.install ? ` — install it with: ${agent.install}` : ""}`,
      424,
    );
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
/** Whether a patch names a setting only a spawn (or a live move) can place —
    as opposed to the agent's own selectors, which `takePicks` hands over. */
function hasSpawnFields(staged: StagedConfig): boolean {
  return (
    staged.profileId !== undefined ||
    staged.model !== undefined ||
    staged.effort !== undefined ||
    staged.suggestKinds !== undefined ||
    staged.uiGroups !== undefined ||
    staged.helperModels !== undefined
  );
}

function hasLinks(staged: StagedConfig): boolean {
  return staged.mcpServerIds !== undefined || staged.skillIds !== undefined || staged.commandIds !== undefined;
}

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

/** A child's request event as its parent's peers get it. */
function forwardedRequest(child: Session, event: ThreadEvent & { requestId: string }): ThreadEvent {
  const requestId = childRequestId(child.id, event.requestId);
  return event.ev === "request_answered"
    ? { ...event, requestId }
    : ({ ...event, requestId, from: { sessionId: child.id, title: child.title } } as ThreadEvent);
}

/** The durable half of a session, as the row shape. */
/** Where a thread's agent runs: its worktree, or the project's own cwd. */
export function threadCwd(session: Pick<Session, "worktree">, project: Pick<Project, "cwd">): string {
  return session.worktree ? join(project.cwd, session.worktree) : project.cwd;
}

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
    helperModels: s.helperModels,
    suggestKinds: s.suggestKinds,
    uiGroups: normalizeUiGroups(s.uiGroups),
    title: s.title,
    worktree: s.worktree,
    acpSessionId: s.acpSessionId ?? null,
    acpSessionProvisional: s.acpSessionProvisional,
    createdAt: s.createdAt,
    lastActivityAt: s.lastActivityAt,
    lastTurnError: s.lastTurnError,
    context: s.context,
    tps: s.tps,
    deletedAt: s.deletedAt,
    pinnedAt: s.pinnedAt,
    askProfiles: s.askProfiles,
    parentSessionId: s.parentSessionId,
    forkedFromSessionId: s.forkedFromSessionId,
    forkedFromTurnId: s.forkedFromTurnId,
    asideQuote: s.asideQuote,
    taskId: s.taskId,
  };
}
