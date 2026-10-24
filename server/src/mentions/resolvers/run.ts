/* Resolver for `@run:<id>`: the result of a workflow run or a routine run of
   this project — status, what failed, the final output, and for a workflow the
   outcome of each step. The ref is a unique prefix of the run's id in either
   table (the menu inserts eight characters). A run of another project answers
   nothing. */
import { and, desc, eq, like } from "drizzle-orm";
import { db, routineRuns, routines, wfEvents, wfRuns } from "../../db/index.js";
import type { MentionResolver } from "../types.js";

const ID_PREFIX = /^[0-9a-f-]{6,36}$/i;
const STEP_CAP = 700;

const when = (ms: number | null) => (ms == null ? "…" : new Date(ms).toISOString().replace("T", " ").slice(0, 19));
const text = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 1));
const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max)}…` : value);

export interface RunSummary {
  id: string;
  kind: "workflow" | "routine";
  name: string;
  status: string;
  at: number;
}

/** The project's most recent runs of both kinds, newest first. */
export async function recentRuns(projectId: string, limit = 12): Promise<RunSummary[]> {
  const wf = await db
    .select({ id: wfRuns.id, name: wfRuns.name, status: wfRuns.status, at: wfRuns.createdAt })
    .from(wfRuns)
    .where(eq(wfRuns.projectId, projectId))
    .orderBy(desc(wfRuns.createdAt))
    .limit(limit);
  const routine = await db
    .select({ id: routineRuns.id, name: routines.name, status: routineRuns.status, at: routineRuns.startedAt })
    .from(routineRuns)
    .innerJoin(routines, eq(routines.id, routineRuns.routineId))
    .where(eq(routines.projectId, projectId))
    .orderBy(desc(routineRuns.startedAt))
    .limit(limit);
  return [
    ...wf.map((r) => ({ ...r, kind: "workflow" as const })),
    ...routine.map((r) => ({ ...r, kind: "routine" as const })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}

async function workflowBody(projectId: string, ref: string, share: number): Promise<string | null | undefined> {
  const rows = await db
    .select()
    .from(wfRuns)
    .where(and(eq(wfRuns.projectId, projectId), like(wfRuns.id, `${ref.toLowerCase()}%`)))
    .limit(2);
  if (rows.length === 0) return undefined;
  if (rows.length > 1) return null;
  const run = rows[0]!;
  const steps = await db.select({ payload: wfEvents.payload }).from(wfEvents).where(eq(wfEvents.runId, run.id)).orderBy(wfEvents.seq);
  const lines: string[] = [];
  for (const { payload } of steps) {
    if (payload.kind === "step_completed") lines.push(`- ${String(payload.name)}: completed — ${clip(text(payload.output ?? ""), STEP_CAP)}`);
    else if (payload.kind === "step_failed") lines.push(`- ${String(payload.name)}: FAILED — ${clip(String(payload.error ?? ""), STEP_CAP)}`);
  }
  const head = [
    `Workflow run "${run.name}" (${run.id})`,
    `Status: ${run.status} · started ${when(run.createdAt)} · ended ${when(run.endedAt)}`,
    run.error ? `Error: ${run.error}` : "",
  ].filter(Boolean);
  const result = run.result == null ? "" : `\nResult:\n${clip(text(run.result), Math.max(share - 1_000, 500))}`;
  return `${head.join("\n")}${lines.length ? `\n\nSteps:\n${lines.join("\n")}` : ""}${result}`;
}

async function routineBody(projectId: string, ref: string, share: number): Promise<string | null | undefined> {
  const rows = await db
    .select({ run: routineRuns, name: routines.name })
    .from(routineRuns)
    .innerJoin(routines, eq(routines.id, routineRuns.routineId))
    .where(and(eq(routines.projectId, projectId), like(routineRuns.id, `${ref.toLowerCase()}%`)))
    .limit(2);
  if (rows.length === 0) return undefined;
  if (rows.length > 1) return null;
  const { run, name } = rows[0]!;
  const lines = [
    `Routine run "${name}" (${run.id})`,
    `Status: ${run.status} · source ${run.source} · started ${when(run.startedAt)} · ended ${when(run.endedAt)}`,
    run.error ? `${run.status === "skipped" ? "Skipped" : "Error"}: ${run.error}` : "",
    run.verdict == null ? "" : `Verdict:\n${clip(text(run.verdict), 2_000)}`,
    run.output ? `Output:\n${clip(run.output, Math.max(share - 1_000, 500))}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

export const runResolver: MentionResolver = {
  kind: "run",
  async resolve(refs, ctx) {
    const blocks = [];
    const share = Math.max(Math.floor(ctx.budget / Math.max(refs.length, 1)), 1_000);
    for (const ref of refs) {
      if (!ID_PREFIX.test(ref)) continue;
      const body = (await workflowBody(ctx.projectId, ref, share)) ?? (await routineBody(ctx.projectId, ref, share));
      if (body) blocks.push({ ref, body, readMore: "the run's own thread in the app" });
    }
    return { blocks, claimed: [...refs] };
  },
};
