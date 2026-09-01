import { inArray } from "drizzle-orm";
import * as acp from "@agentclientprotocol/sdk";
import { db, sessions as sessionsTable } from "./db/index.js";
import { withAgentConnection } from "./probe.js";
import type { Profile } from "./profiles.js";
import type { Project } from "./projects.js";

/*
 * What a runtime already has, and the harness does not.
 *
 * Work started in `claude`, `codex` or `opencode` outside the harness is a real
 * conversation in that agent's own store with no pointer to it here — and a
 * pointer is the whole of what a thread is (`sessions.acp_session_id`, loaded
 * back through `session/load` on revive). So importing one is: ask the runtime
 * what it has, write the row, and let the ordinary revive path do the rest.
 *
 * The asking is ACP's own `session/list`, never a runtime's files: all three
 * agents implement it (claude-agent-acp over the SDK's session store, codex-acp
 * over codex's thread list, opencode's bridge over its database), and reading
 * `~/.claude/projects/*.jsonl` or a rollout directory would be exactly the
 * per-agent knowledge the client half of this codebase refuses to carry.
 */

/** Pages are followed inside the one spawned process; these bound how far. */
const MAX_LIST_PAGES = 10;
const MAX_LIST_SESSIONS = 500;
/** The counts bound rows, not size — nothing in the protocol bounds a title,
    so a broken or hostile agent could answer 500 sessions of megabytes each.
    Approximate on purpose: the cut lands after the page that crossed it. */
const MAX_LIST_BYTES = 4 * 1024 * 1024;

export interface ImportableSession {
  acpSessionId: string;
  /** The directory the conversation ran in — what decides which project it
      belongs to here, and the only thing the harness groups the list by. */
  cwd: string;
  title: string | null;
  updatedAt: string | null;
  /** Already a thread here, so the UI offers Open (or says Trash) rather than
      importing it a second time. */
  existing?: { sessionId: string; deleted: boolean };
}

export interface SessionListing {
  /** False when the runtime cannot enumerate its sessions at all — an older
      binary, or an agent that never implemented `session/list`. That is an
      answer, not a failure: the dialog says so in words. */
  supported: boolean;
  sessions: ImportableSession[];
  /** The page budget ran out before the agent did. */
  truncated: boolean;
}

/** Two tabs scanning the same pair at once spawn one agent, not two. There is
    no cache beyond that: a session list is stale the moment it is read. */
const inflight = new Map<string, Promise<SessionListing>>();

export function listAgentSessions(
  profile: Profile,
  agentId: string,
  project: Project,
): Promise<SessionListing> {
  const key = `${profile.id}:${agentId}`;
  const running = inflight.get(key);
  if (running) return running;
  const run = runListing(profile, agentId, project).finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

async function runListing(
  profile: Profile,
  agentId: string,
  project: Project,
): Promise<SessionListing> {
  const listing = await withAgentConnection(
    profile,
    agentId,
    project,
    /* No `materialize`: this never opens a session, so it has no business
       writing skills or a model allowlist into anybody's workspace. */
    { name: "daedalus-import" },
    async (agent, init) => {
      // The capability is the agent saying whether the question can be asked at
      // all. Absent means no, and no is a sentence the UI prints.
      if (!init.agentCapabilities?.sessionCapabilities?.list) {
        return { supported: false, sessions: [], truncated: false };
      }
      const found: acp.SessionInfo[] = [];
      let cursor: string | null = null;
      let truncated = false;
      let bytes = 0;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        /* No `cwd` filter: the dialog lists everything on the machine and
           groups it by directory, so a conversation from a project the harness
           has never heard of is offered too (with a project to create). */
        const response: acp.ListSessionsResponse = await agent.request(
          acp.methods.agent.session.list,
          { cursor },
        );
        found.push(...response.sessions);
        bytes += JSON.stringify(response.sessions).length;
        cursor = response.nextCursor ?? null;
        if (!cursor) break;
        if (found.length >= MAX_LIST_SESSIONS || bytes >= MAX_LIST_BYTES || page === MAX_LIST_PAGES - 1) {
          truncated = true;
          break;
        }
      }
      /* Newest first, whatever order the runtime answered in — the page was cut
         in the agent's own order (all three answer newest first, which is what
         makes a truncated list the *recent* half), and sorting after that cut
         only settles how the kept ones are drawn. */
      const sessions = found
        .slice(0, MAX_LIST_SESSIONS)
        .map(toImportable)
        .sort((a, b) => (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0));
      return { supported: true, sessions, truncated: truncated || found.length > MAX_LIST_SESSIONS };
    },
  ).catch((error: unknown) => {
    /* An agent that advertised the capability and then refused the method is
       saying the same thing the missing capability says. Anything else is a
       real failure and belongs to the caller. */
    if (error instanceof acp.RequestError && error.code === -32601) {
      return { supported: false, sessions: [], truncated: false };
    }
    throw error;
  });

  return listing.sessions.length ? { ...listing, sessions: markExisting(listing.sessions) } : listing;
}

function toImportable(info: acp.SessionInfo): ImportableSession {
  return {
    acpSessionId: info.sessionId,
    cwd: info.cwd,
    title: info.title ?? null,
    updatedAt: info.updatedAt ?? null,
  };
}

/** One query for the whole page: which of these the harness already holds.
    Deleted threads count — a conversation sitting in Trash must read as Trash
    rather than be offered for a second import that would duplicate it. */
function markExisting(list: ImportableSession[]): ImportableSession[] {
  const rows = db
    .select({
      id: sessionsTable.id,
      acpSessionId: sessionsTable.acpSessionId,
      deletedAt: sessionsTable.deletedAt,
    })
    .from(sessionsTable)
    .where(inArray(sessionsTable.acpSessionId, list.map((s) => s.acpSessionId)))
    .all();
  const byAcpId = new Map(rows.map((row) => [row.acpSessionId, row]));
  return list.map((session) => {
    const row = byAcpId.get(session.acpSessionId);
    return row
      ? { ...session, existing: { sessionId: row.id, deleted: row.deletedAt !== null } }
      : session;
  });
}
