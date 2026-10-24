/*
 * Workflow engine v2: the journal's database layer (`wf_runs`, `wf_events`).
 *
 * `fold.ts` is the pure half; this file only moves rows. Appends are serialised
 * per run (one promise chain) and take their seq from a cached max inside that
 * chain, so the log has no gaps and no two writers can pick the same number.
 */
import { and, asc, desc, eq, gt, inArray, max } from "drizzle-orm";
import { db, wfEvents, wfRuns } from "../db/index.js";
import { foldRun } from "./fold.js";
import type { JournalEvent, JournalPayload, RunSpec, RunStatus, RunView } from "./types.js";

export interface RunHeader {
  id: string;
  parentSessionId: string;
  projectId: string | null;
  name: string;
  spec: RunSpec;
  status: RunStatus;
  error: string | null;
  result: unknown;
  notify: boolean;
  createdAt: number;
  endedAt: number | null;
}

type RunRow = typeof wfRuns.$inferSelect;
type EventRow = typeof wfEvents.$inferSelect;

function toHeader(row: RunRow): RunHeader {
  return {
    id: row.id,
    parentSessionId: row.parentSessionId,
    projectId: row.projectId,
    name: row.name,
    spec: row.spec as unknown as RunSpec,
    status: row.status,
    error: row.error,
    result: row.result,
    notify: row.notify,
    createdAt: row.createdAt,
    endedAt: row.endedAt,
  };
}

function toEvent(row: EventRow): JournalEvent {
  return {
    runId: row.runId,
    seq: row.seq,
    at: row.at,
    key: row.key,
    payload: row.payload as unknown as JournalPayload,
  };
}

/**
 * Postgres `jsonb` rejects U+0000 (in a string value or an object key) and the whole insert
 * fails, which would lose the event — a step's output or a command's stdout can hold a NUL.
 * Replace it with U+FFFD in everything that is written. Read-side payloads are returned as
 * stored: `events()` does not touch them.
 */
const NUL = /\u0000/g;
export function scrubNul<T>(value: T): T {
  if (typeof value === "string") return (value.includes("\u0000") ? value.replace(NUL, "\uFFFD") : value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => scrubNul(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k.includes("\u0000") ? k.replace(NUL, "\uFFFD") : k] = scrubNul(v);
    return out as T;
  }
  return value;
}

/* Module state, so two `Journal` instances in one process still share one chain
   and one seq per run. */
const chains = new Map<string, Promise<unknown>>();
const lastSeq = new Map<string, number>();

export class Journal {
  /** Insert the run (status running) and its `run_started` event in one transaction. */
  static async createRun(row: {
    id: string;
    parentSessionId: string;
    projectId: string | null;
    name: string;
    spec: RunSpec;
    notify: boolean;
    createdAt: number;
  }): Promise<JournalEvent> {
    const spec = scrubNul(row.spec);
    const payload: JournalPayload = { kind: "run_started", spec };
    await db.transaction(async (tx) => {
      await tx.insert(wfRuns).values({
        id: row.id,
        parentSessionId: row.parentSessionId,
        projectId: row.projectId,
        name: scrubNul(row.name),
        spec: spec as unknown as Record<string, unknown>,
        status: "running",
        notify: row.notify,
        createdAt: row.createdAt,
      });
      await tx.insert(wfEvents).values({
        runId: row.id,
        seq: 1,
        at: row.createdAt,
        key: null,
        kind: payload.kind,
        payload: payload as unknown as Record<string, unknown>,
      });
    });
    lastSeq.set(row.id, 1);
    return { runId: row.id, seq: 1, at: row.createdAt, key: null, payload };
  }

  /** Append one event. Returns it with the seq it was given. */
  append(runId: string, key: string | null, payload: JournalPayload): Promise<JournalEvent> {
    const clean = scrubNul(payload);
    const cleanKey = key === null ? null : scrubNul(key);
    const write = async (): Promise<JournalEvent> => {
      try {
        let seq = lastSeq.get(runId);
        if (seq === undefined) {
          const rows = await db.select({ top: max(wfEvents.seq) }).from(wfEvents).where(eq(wfEvents.runId, runId));
          seq = rows[0]?.top ?? 0;
        }
        const next = seq + 1;
        const at = Date.now();
        await db.insert(wfEvents).values({
          runId,
          seq: next,
          at,
          key: cleanKey,
          kind: clean.kind,
          payload: clean as unknown as Record<string, unknown>,
        });
        lastSeq.set(runId, next);
        return { runId, seq: next, at, key: cleanKey, payload: clean };
      } catch (error) {
        // Forget the cached seq: the next append re-reads the truth from the table.
        lastSeq.delete(runId);
        console.error(`[workflows] could not append ${payload.kind} to run ${runId.slice(0, 8)}`, error);
        throw error;
      }
    };
    const result = (chains.get(runId) ?? Promise.resolve()).then(write);
    // The chain carries order, never failure: a rejected write must not poison the next one.
    const tail = result.then(
      () => {},
      () => {},
    );
    chains.set(runId, tail);
    void tail.then(() => {
      if (chains.get(runId) === tail) {
        chains.delete(runId);
        if (payload.kind === "run_finished") lastSeq.delete(runId);
      }
    });
    return result;
  }

  async events(runId: string, sinceSeq = 0): Promise<JournalEvent[]> {
    const rows = await db
      .select()
      .from(wfEvents)
      .where(and(eq(wfEvents.runId, runId), gt(wfEvents.seq, sinceSeq)))
      .orderBy(asc(wfEvents.seq));
    return rows.map(toEvent);
  }

  async header(runId: string): Promise<RunHeader | null> {
    const row = (await db.select().from(wfRuns).where(eq(wfRuns.id, runId)).limit(1))[0];
    return row ? toHeader(row) : null;
  }

  /** `result` is left alone when omitted. */
  async setStatus(
    runId: string,
    status: RunStatus,
    error: string | null,
    endedAt: number | null,
    result?: unknown,
  ): Promise<void> {
    const set: Partial<typeof wfRuns.$inferInsert> = { status, error: error === null ? null : scrubNul(error), endedAt };
    if (result !== undefined) set.result = scrubNul(result);
    await db.update(wfRuns).set(set).where(eq(wfRuns.id, runId));
  }

  async listRunsForParent(parentSessionId: string, limit: number): Promise<RunHeader[]> {
    const rows = await db
      .select()
      .from(wfRuns)
      .where(eq(wfRuns.parentSessionId, parentSessionId))
      .orderBy(desc(wfRuns.createdAt))
      .limit(limit);
    return rows.map(toHeader);
  }

  /** Runs that were live when the server stopped: the boot recovery's list. */
  async runningRuns(): Promise<RunHeader[]> {
    const rows = await db
      .select()
      .from(wfRuns)
      .where(inArray(wfRuns.status, ["running", "paused"]))
      .orderBy(asc(wfRuns.createdAt));
    return rows.map(toHeader);
  }

  async view(runId: string): Promise<RunView | null> {
    const header = await this.header(runId);
    if (!header) return null;
    const view = foldRun(header, await this.events(runId));
    if (view.result === undefined && header.result !== null && header.result !== undefined) view.result = header.result;
    return view;
  }
}
