import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db, pmColumns, pmSprints, pmTasks } from "../db/index.js";
import type { SprintRow } from "./schema.js";

/*
 * Report aggregates — SQL group-bys, never load-all-and-reduce (the point of
 * moving off JSON storage). Each function returns a series or a stat object,
 * not task rows; routes.ts serves them verbatim.
 */

const DAY_MS = 86_400_000;

/** Epoch ms → UTC day bucket. All series bucket by UTC day — good enough for
    a chart axis, and it keeps the grouping a pure integer division in SQL. */
const dayOf = (ms: number) => Math.floor(ms / DAY_MS);

// ---------------------------------------------------------------------------
// Burndown

export interface BurndownPoint {
  /** Epoch ms of the day's UTC midnight. */
  date: number;
  /** Points completed up to and including this day. */
  completed: number;
  /** Committed − completed. */
  remaining: number;
  /** Linear reference line from full commitment to zero. */
  ideal: number;
}

export interface Burndown {
  sprint: SprintRow;
  totalPoints: number;
  totalTasks: number;
  series: BurndownPoint[];
}

/**
 * Daily remaining-points series over the sprint window, reconstructed from the
 * CURRENT sprint membership + each task's completedAt.
 *
 * Approximation, documented per plan: the scope is today's membership, so a
 * task added mid-sprint appears as if it were committed from day one (there is
 * no membership history to say otherwise), and a task moved out of the sprint
 * vanishes from the whole series. Velocity avoids this by freezing a snapshot
 * at /complete; the burndown of a live sprint is inherently a reconstruction.
 *
 * Returns undefined for an unknown sprint; a sprint without both dates gets an
 * empty series (no window to walk) but real totals. Trashed tasks are excluded;
 * archived ones still count — archiving done work must not un-burn it.
 */
export function burndown(boardId: string, sprintId: string): Burndown | undefined {
  const sprint = db
    .select()
    .from(pmSprints)
    .where(and(eq(pmSprints.id, sprintId), eq(pmSprints.boardId, boardId)))
    .get();
  if (!sprint) return undefined;

  const inSprint = and(
    eq(pmTasks.boardId, boardId),
    eq(pmTasks.sprintId, sprintId),
    isNull(pmTasks.deletedAt),
  );
  const totals = db
    .select({
      points: sql<number>`coalesce(sum(${pmTasks.storyPoints}), 0)`,
      tasks: sql<number>`count(*)`,
    })
    .from(pmTasks)
    .where(inSprint)
    .get()!;

  if (sprint.startDate === null || sprint.endDate === null) {
    return { sprint, totalPoints: totals.points, totalTasks: totals.tasks, series: [] };
  }

  // Points completed per UTC day — one GROUP BY, cumulated in JS while walking
  // the window. Tasks without points burn 0 (they still show in totalTasks).
  const dayExpr = sql<number>`${pmTasks.completedAt} / ${DAY_MS}`;
  const perDay = db
    .select({ day: dayExpr, points: sql<number>`coalesce(sum(${pmTasks.storyPoints}), 0)` })
    .from(pmTasks)
    .where(and(inSprint, isNotNull(pmTasks.completedAt)))
    .groupBy(dayExpr)
    .all();

  const startDay = dayOf(sprint.startDate);
  const endDay = dayOf(sprint.endDate);
  const byDay = new Map<number, number>();
  for (const row of perDay) {
    // Completions outside the window clamp to its edges so the series still
    // sums to the truth (early completion → day one, late → last day).
    const day = Math.min(Math.max(row.day, startDay), endDay);
    byDay.set(day, (byDay.get(day) ?? 0) + row.points);
  }

  const span = Math.max(endDay - startDay, 1);
  const series: BurndownPoint[] = [];
  let completed = 0;
  for (let day = startDay; day <= endDay; day++) {
    completed += byDay.get(day) ?? 0;
    series.push({
      date: day * DAY_MS,
      completed,
      remaining: totals.points - completed,
      ideal: totals.points * (1 - (day - startDay) / span),
    });
  }
  return { sprint, totalPoints: totals.points, totalTasks: totals.tasks, series };
}

// ---------------------------------------------------------------------------
// Velocity

export interface VelocityEntry {
  sprintId: string;
  name: string;
  /** When the sprint was completed (snapshot stamp, else endDate, else null). */
  completedAt: number | null;
  committedPoints: number;
  completedPoints: number;
  committedTasks: number;
  completedTasks: number;
  /** true = from the frozen /complete snapshot; false = reconstructed from
      current task rows, subject to the same scope drift as burndown. */
  exact: boolean;
}

/**
 * Per completed sprint: the frozen snapshot verbatim when there is one (exact
 * even after the tasks move on), otherwise reconstructed from current rows —
 * one grouped query for every snapshotless sprint, not a query per sprint.
 */
export function velocity(boardId: string): VelocityEntry[] {
  const sprints = db
    .select()
    .from(pmSprints)
    .where(and(eq(pmSprints.boardId, boardId), eq(pmSprints.state, "completed")))
    .all();

  const fallback = new Map<
    string,
    { committedPoints: number; completedPoints: number; committedTasks: number; completedTasks: number }
  >();
  if (sprints.some((s) => s.snapshot === null)) {
    const rows = db
      .select({
        sprintId: pmTasks.sprintId,
        committedPoints: sql<number>`coalesce(sum(${pmTasks.storyPoints}), 0)`,
        completedPoints: sql<number>`coalesce(sum(case when ${pmTasks.completedAt} is not null then ${pmTasks.storyPoints} end), 0)`,
        committedTasks: sql<number>`count(*)`,
        completedTasks: sql<number>`count(${pmTasks.completedAt})`,
      })
      .from(pmTasks)
      .where(and(eq(pmTasks.boardId, boardId), isNotNull(pmTasks.sprintId), isNull(pmTasks.deletedAt)))
      .groupBy(pmTasks.sprintId)
      .all();
    for (const row of rows) fallback.set(row.sprintId!, row);
  }

  const entries = sprints.map((sprint): VelocityEntry => {
    const snap = sprint.snapshot;
    const stats = snap ??
      fallback.get(sprint.id) ?? {
        committedPoints: 0,
        completedPoints: 0,
        committedTasks: 0,
        completedTasks: 0,
      };
    return {
      sprintId: sprint.id,
      name: sprint.name,
      completedAt: snap?.completedAt ?? sprint.endDate,
      committedPoints: stats.committedPoints,
      completedPoints: stats.completedPoints,
      committedTasks: stats.committedTasks,
      completedTasks: stats.completedTasks,
      exact: snap !== null,
    };
  });
  // Chart order: oldest completed first; undated sprints sink to the end.
  return entries.sort((a, b) => (a.completedAt ?? Infinity) - (b.completedAt ?? Infinity));
}

// ---------------------------------------------------------------------------
// Dashboard

export interface DashboardStats {
  totalTasks: number;
  /** Live task counts by their column's category. */
  byCategory: { open: number; active: number; done: number };
  /** Live, not done, dueDate strictly before now. */
  overdue: number;
  pointsTotal: number;
  pointsDone: number;
  /** Descending by count; a task with n assignees counts once per assignee. */
  byAssignee: Array<{ assignee: string; count: number }>;
}

/** Stat aggregates for the dashboard view — live tasks only (not trashed, not
    archived), each stat its own GROUP BY / aggregate query. */
export function dashboard(boardId: string): DashboardStats {
  const live = and(
    eq(pmTasks.boardId, boardId),
    isNull(pmTasks.deletedAt),
    isNull(pmTasks.archivedAt),
  );

  const byCategory = { open: 0, active: 0, done: 0 };
  for (const row of db
    .select({ category: pmColumns.category, count: sql<number>`count(*)` })
    .from(pmTasks)
    .innerJoin(pmColumns, eq(pmTasks.columnId, pmColumns.id))
    .where(live)
    .groupBy(pmColumns.category)
    .all()) {
    byCategory[row.category] = row.count;
  }

  const points = db
    .select({
      total: sql<number>`coalesce(sum(${pmTasks.storyPoints}), 0)`,
      done: sql<number>`coalesce(sum(case when ${pmTasks.completedAt} is not null then ${pmTasks.storyPoints} end), 0)`,
      tasks: sql<number>`count(*)`,
      overdue: sql<number>`count(case when ${pmTasks.dueDate} < ${Date.now()} and ${pmTasks.completedAt} is null then 1 end)`,
    })
    .from(pmTasks)
    .where(live)
    .get()!;

  // assignees is a json array column, so the per-assignee GROUP BY goes through
  // json_each — still one query, still aggregated in SQLite.
  const byAssignee = db.all<{ assignee: string; count: number }>(sql`
    select je.value as assignee, count(*) as count
    from ${pmTasks}, json_each(${pmTasks.assignees}) as je
    where ${pmTasks.boardId} = ${boardId}
      and ${pmTasks.deletedAt} is null
      and ${pmTasks.archivedAt} is null
    group by je.value
    order by count desc, assignee asc
  `);

  return {
    totalTasks: points.tasks,
    byCategory,
    overdue: points.overdue,
    pointsTotal: points.total,
    pointsDone: points.done,
    byAssignee,
  };
}
