/* ── What a project has added up to ──
 *
 * The client already knows a project's *live* half — `state.sessions` carries
 * every thread with its process state, so counting threads, or telling a
 * running turn from an idle one, needs no round trip and stays correct as the
 * socket moves. What it cannot know is the part that only exists in the
 * database: how many turns those threads have taken, when the last one was,
 * what the project has learned, what is scheduled against it. That is this
 * module, and it is deliberately the *whole* of the extra: one query set, one
 * route, one answer — a page that asked six routes would redraw six times.
 *
 * Everything here is a read. Nothing is cached: the numbers move with every
 * turn, the queries are indexed range scans over one project's rows, and a
 * stale overview is worse than a slightly more expensive one.
 *
 * Turns, not events, are the unit that means anything to a person: an event is
 * a streaming chunk and a long turn is thousands of them, so "1.2M events" says
 * nothing about how much work happened here. `session_events.kind =
 * "turn_started"` is journaled exactly once per turn (see SessionManager), which
 * makes it the countable one.
 */
import { existsSync } from "node:fs";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import {
  db,
  knowledge as knowledgeTable,
  projectPreviews,
  scheduledMessages,
  sessionEvents,
  sessions as sessionsTable,
  webSearchUsage,
  workflowRuns,
} from "./db/index.js";
import { getProject } from "./projects.js";
import { WorkspaceError } from "./workspace-fs.js";

/** How far back the activity strip goes. A month is what a sparkline the width
    of a card can show a day at a time and still be read. */
export const ACTIVITY_DAYS = 30;

const DAY_MS = 86_400_000;

export interface ProjectStats {
  projectId: string;
  /** Does the working directory still exist on the server? A project pointing
      at a moved or unmounted path is the one piece of "is this healthy" the
      overview can answer, and every thread started in it would fail to spawn. */
  cwdExists: boolean;
  threads: {
    /** Top-level, not trashed — what the sidebar lists. */
    total: number;
    trashed: number;
    /** Workflow steps: real threads, hidden from the lists, counted apart. */
    steps: number;
    /** Epoch ms the project's first and newest threads were created. */
    firstAt: number | null;
    newestAt: number | null;
  };
  /** Journaled `turn_started`s across every thread of the project, steps
      included — a step is work the project did. */
  turns: number;
  /** Epoch ms of the newest journaled event, or null for a project nothing has
      run in yet. The journal is pruned by retention, so this is "as far back as
      the archive goes", never older than it. */
  lastActivityAt: number | null;
  /** Turns per local day, oldest first, one entry per day with any — days with
      none are absent, and the client fills the gaps it draws. */
  activity: { day: string; turns: number }[];
  /** Threads per agent and per profile, biggest first: what this project is
      actually worked on with. Ids, not names — the client has both lists. */
  byAgent: { id: string; threads: number }[];
  byProfile: { id: string; threads: number }[];
  knowledge: number;
  previews: number;
  /** Harness web-search MCP calls made from this project's threads. */
  webSearch: { searches: number; fetches: number };
  scheduled: { total: number; enabled: number };
  workflows: { total: number; running: number; failed: number };
}

/** Every session row of the project, trashed and steps included: the ids the
    journal, queue and schedule tables are keyed by. */
function sessionIdsOf(projectId: string): string[] {
  return db
    .select({ id: sessionsTable.id })
    .from(sessionsTable)
    .where(eq(sessionsTable.projectId, projectId))
    .all()
    .map((row) => row.id);
}

const countOf = (rows: { n: number }[]): number => rows[0]?.n ?? 0;

/**
 * The project's numbers. Throws a 404-shaped `WorkspaceError` for a project
 * that does not exist, so the route can hand it to the same `workspace()`
 * wrapper every other project-scoped read uses.
 */
export function projectStats(projectId: string, now = Date.now()): ProjectStats {
  const project = getProject(projectId);
  if (!project) throw new WorkspaceError("unknown project", 404);

  const rows = db
    .select({
      id: sessionsTable.id,
      agentId: sessionsTable.agentId,
      profileId: sessionsTable.profileId,
      createdAt: sessionsTable.createdAt,
      deletedAt: sessionsTable.deletedAt,
      parentSessionId: sessionsTable.parentSessionId,
    })
    .from(sessionsTable)
    .where(eq(sessionsTable.projectId, projectId))
    .all();

  /* One pass. Everything below is a tally over the same rows — the counts, the
     created-at extremes and the per-agent/per-profile breakdowns — and
     `Math.min(...rows)` on a project with tens of thousands of threads is a
     spread wide enough to overflow the argument limit as well as a third walk. */
  const ids: string[] = [];
  const byAgentCounts = new Map<string, number>();
  const byProfileCounts = new Map<string, number>();
  let topCount = 0;
  let liveCount = 0;
  let firstAt: number | null = null;
  let newestAt: number | null = null;
  for (const row of rows) {
    ids.push(row.id);
    if (row.parentSessionId) continue;
    topCount += 1;
    if (row.deletedAt !== null) continue;
    liveCount += 1;
    if (firstAt === null || row.createdAt < firstAt) firstAt = row.createdAt;
    if (newestAt === null || row.createdAt > newestAt) newestAt = row.createdAt;
    byAgentCounts.set(row.agentId, (byAgentCounts.get(row.agentId) ?? 0) + 1);
    byProfileCounts.set(row.profileId, (byProfileCounts.get(row.profileId) ?? 0) + 1);
  }
  const ranked = (counts: Map<string, number>) =>
    [...counts]
      .map(([id, threads]) => ({ id, threads }))
      .sort((a, b) => b.threads - a.threads || a.id.localeCompare(b.id));

  /* An empty `inArray` is not a query drizzle will build, and a project with no
     threads at all is the ordinary state of a new one — so the journal half is
     skipped rather than guarded inside each query. */
  const journal = ids.length > 0 ? journalStats(ids, now) : emptyJournal();

  return {
    projectId,
    cwdExists: existsSync(project.cwd),
    threads: {
      total: liveCount,
      trashed: topCount - liveCount,
      steps: rows.length - topCount,
      firstAt,
      newestAt,
    },
    ...journal,
    byAgent: ranked(byAgentCounts),
    byProfile: ranked(byProfileCounts),
    knowledge: countOf(
      db
        .select({ n: sql<number>`count(*)` })
        .from(knowledgeTable)
        .where(eq(knowledgeTable.projectId, projectId))
        .all(),
    ),
    previews: countOf(
      db
        .select({ n: sql<number>`count(*)` })
        .from(projectPreviews)
        .where(eq(projectPreviews.projectId, projectId))
        .all(),
    ),
    /* `web_search_usage` snapshots its own project id (it has to outlive the
       project it names), so this one does not go through the id list. */
    webSearch: {
      searches: countOf(
        db
          .select({ n: sql<number>`count(*)` })
          .from(webSearchUsage)
          .where(and(eq(webSearchUsage.projectId, projectId), eq(webSearchUsage.tool, "search")))
          .all(),
      ),
      fetches: countOf(
        db
          .select({ n: sql<number>`count(*)` })
          .from(webSearchUsage)
          .where(and(eq(webSearchUsage.projectId, projectId), eq(webSearchUsage.tool, "fetch")))
          .all(),
      ),
    },
    scheduled:
      ids.length > 0
        ? {
            total: countOf(
              db
                .select({ n: sql<number>`count(*)` })
                .from(scheduledMessages)
                .where(inArray(scheduledMessages.sessionId, ids))
                .all(),
            ),
            enabled: countOf(
              db
                .select({ n: sql<number>`count(*)` })
                .from(scheduledMessages)
                .where(and(inArray(scheduledMessages.sessionId, ids), eq(scheduledMessages.enabled, 1)))
                .all(),
            ),
          }
        : { total: 0, enabled: 0 },
    workflows: ids.length > 0 ? workflowStats(ids) : { total: 0, running: 0, failed: 0 },
  };
}

const emptyJournal = () => ({
  turns: 0,
  lastActivityAt: null as number | null,
  activity: [] as { day: string; turns: number }[],
});

/** The three readings that come out of `session_events`, in one place because
    they share the id list and the same index. */
function journalStats(ids: string[], now: number): ReturnType<typeof emptyJournal> {
  const turns = countOf(
    db
      .select({ n: sql<number>`count(*)` })
      .from(sessionEvents)
      .where(and(inArray(sessionEvents.sessionId, ids), eq(sessionEvents.kind, "turn_started")))
      .all(),
  );
  const last = db
    .select({ at: sql<number | null>`max(${sessionEvents.at})` })
    .from(sessionEvents)
    .where(inArray(sessionEvents.sessionId, ids))
    .all()[0]?.at;

  /* Grouped in SQLite rather than in JS: a busy project's month is tens of
     thousands of rows and none of them is wanted here except as a count.
     `unixepoch`/`localtime` puts a turn in the day the person who took it was
     living in — a UTC bucket cuts every evening in half for half the world. */
  const since = now - ACTIVITY_DAYS * DAY_MS;
  const activity = db
    .select({
      day: sql<string>`date(${sessionEvents.at} / 1000, 'unixepoch', 'localtime')`,
      turns: sql<number>`count(*)`,
    })
    .from(sessionEvents)
    .where(
      and(
        inArray(sessionEvents.sessionId, ids),
        eq(sessionEvents.kind, "turn_started"),
        gte(sessionEvents.at, since),
      ),
    )
    .groupBy(sql`1`)
    .orderBy(sql`1`)
    .all();

  return { turns, lastActivityAt: last ?? null, activity };
}

function workflowStats(ids: string[]): ProjectStats["workflows"] {
  const rows = db
    .select({ status: workflowRuns.status, n: sql<number>`count(*)` })
    .from(workflowRuns)
    .where(inArray(workflowRuns.parentSessionId, ids))
    .groupBy(workflowRuns.status)
    .all();
  const at = (status: string) => rows.find((row) => row.status === status)?.n ?? 0;
  return {
    total: rows.reduce((sum, row) => sum + row.n, 0),
    running: at("running"),
    failed: at("failed"),
  };
}
