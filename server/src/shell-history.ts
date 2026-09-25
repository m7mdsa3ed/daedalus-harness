import { and, desc, eq, sql } from "drizzle-orm";
import { db, shellHistory } from "./db/index.js";

/**
 * The `!` lines a project keeps running, most used first.
 *
 * The composer's `!` completer suggests the project's saved helpers and the
 * scripts its package.json files declare — both of which are definitions
 * somebody wrote down. This is the third list and the one nobody writes: what
 * has actually been run here. A routine is re-run far more often than it is
 * defined, and retyping it was the whole cost the completer did not remove.
 *
 * Recorded by the one route that runs a line (`POST /api/sessions/:id/shell`)
 * rather than by the composer, so a line run from anywhere counts and the
 * browser is never the bookkeeper. On the send, not on the result: what the
 * menu offers is what you reach for, and a line that failed is one you are
 * about to run again with a flag fixed.
 */

export interface ShellUse {
  line: string;
  count: number;
  lastAt: number;
}

/** Count one run. An exact repeat bumps its row rather than writing a second,
    which is what makes the list an ordering by use. Keep the full command and
    every distinct line so any `!` command can be suggested again later. */
export async function recordShellRun(projectId: string, line: string): Promise<void> {
  const command = line.trim();
  if (!command) return;
  const now = Date.now();
  await db
    .insert(shellHistory)
    .values({ projectId, line: command, count: 1, lastAt: now })
    .onConflictDoUpdate({
      target: [shellHistory.projectId, shellHistory.line],
      set: { count: sql`${shellHistory.count} + 1`, lastAt: now },
    });
}

/** All recorded lines, most used first, last run breaking the tie. */
export async function listShellHistory(projectId: string): Promise<ShellUse[]> {
  const rows = await db
    .select()
    .from(shellHistory)
    .where(eq(shellHistory.projectId, projectId))
    .orderBy(desc(shellHistory.count), desc(shellHistory.lastAt));
  return rows.map((r) => ({ line: r.line, count: r.count, lastAt: r.lastAt }));
}

/** Forget one line, or — with none — everything this project has run. */
export async function clearShellHistory(projectId: string, line?: string): Promise<number> {
  const where = line
    ? and(eq(shellHistory.projectId, projectId), eq(shellHistory.line, line))
    : eq(shellHistory.projectId, projectId);
  return (await db.delete(shellHistory).where(where)).rowCount ?? 0;
}
