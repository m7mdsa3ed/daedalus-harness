/* Resolver for `@term:<id>` and `@term:last`: the output of a `!` command run in
   this project. Those are the only terminal output the server keeps — each run
   is a journaled `_daedalus/shell` update — so a shell opened in the terminal
   panel is not mentionable, and that is said rather than faked. `last` is the
   newest run in this thread (else in the project); an id is a unique prefix of
   a run's `shellId`. The tail is what is kept when the output is cut: the end
   of a log is where the failure is. */
import { and, desc, eq, sql } from "drizzle-orm";
import { db, sessionEvents, sessions } from "../../db/index.js";
import type { MentionResolver } from "../types.js";

export interface ShellRun {
  shellId: string;
  sessionId: string;
  command: string;
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  at: number;
}

/** How many journal rows are scanned for runs; a settled run is one row, so this
    is about as many runs. */
const SCAN = 200;

/** Settled `!` runs of a project, newest first; only this thread's when `sessionId` is given. */
export async function recentShellRuns(projectId: string, sessionId?: string, limit = 12): Promise<ShellRun[]> {
  const rows = await db
    .select({ payload: sessionEvents.payload, sessionId: sessionEvents.sessionId, at: sessionEvents.at })
    .from(sessionEvents)
    .innerJoin(sessions, eq(sessions.id, sessionEvents.sessionId))
    .where(
      and(
        eq(sessions.projectId, projectId),
        eq(sessionEvents.kind, "update"),
        sessionId ? eq(sessionEvents.sessionId, sessionId) : undefined,
        sql`${sessionEvents.payload}->'update'->>'sessionUpdate' = '_daedalus/shell'`,
        sql`${sessionEvents.payload}->'update'->>'status' = 'done'`,
      ),
    )
    .orderBy(desc(sessionEvents.at), desc(sessionEvents.seq))
    .limit(SCAN);
  const seen = new Set<string>();
  const out: ShellRun[] = [];
  for (const row of rows) {
    const update = (row.payload as { update?: Record<string, unknown> }).update ?? {};
    const shellId = String(update.shellId ?? "");
    if (!shellId || seen.has(shellId)) continue;
    seen.add(shellId);
    out.push({
      shellId,
      sessionId: row.sessionId,
      command: String(update.command ?? ""),
      output: typeof update.output === "string" ? update.output : "",
      exitCode: typeof update.exitCode === "number" ? update.exitCode : null,
      timedOut: update.timedOut === true,
      at: row.at,
    });
    if (out.length >= limit) break;
  }
  return out;
}

function describe(run: ShellRun, share: number): string {
  const status = run.timedOut ? "timed out" : run.exitCode === null ? "could not start" : `exit ${run.exitCode}`;
  const room = Math.max(share - run.command.length - 80, 500);
  const tail = run.output.length > room ? `… (earlier output omitted)\n${run.output.slice(-room)}` : run.output;
  return `$ ${run.command}\n(${status})\n\n${tail.trim() || "(no output)"}`;
}

export const termResolver: MentionResolver = {
  kind: "term",
  async resolve(refs, ctx) {
    const blocks = [];
    const share = Math.max(Math.floor(ctx.budget / Math.max(refs.length, 1)), 1_000);
    const runs = await recentShellRuns(ctx.projectId, undefined, 50);
    for (const ref of refs) {
      let run: ShellRun | undefined;
      if (ref === "last") run = runs.find((r) => r.sessionId === ctx.sessionId) ?? runs[0];
      else if (/^[0-9a-f-]{6,36}$/i.test(ref)) {
        const hits = runs.filter((r) => r.shellId.toLowerCase().startsWith(ref.toLowerCase()));
        if (hits.length === 1) run = hits[0];
      }
      if (run) blocks.push({ ref, body: describe(run, share) });
    }
    return { blocks, claimed: [...refs] };
  },
};
