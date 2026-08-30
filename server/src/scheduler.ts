import { randomUUID } from "node:crypto";
import { and, asc, eq, lt, lte } from "drizzle-orm";
import { db, scheduledMessages as scheduledTable } from "./db/index.js";
import { getProfile } from "./profiles.js";
import { getProject } from "./projects.js";
import type { SessionManager } from "./sessions.js";

/**
 * A scheduled message: the server delivers `text` to a thread's agent at
 * `nextAt`, and — for a recurring row — again every `everyMs` until cancelled.
 *
 * Delivery is the SERVER's job, not a browser tab's. The PWA's whole bargain is
 * "the server is the ACP client", and a scheduled turn has to happen when
 * nobody is looking; the sweep below is the same periodic-loop shape as the
 * idle-retirement one in SessionManager, and it fires even while every client
 * is closed (the thread's peers just get the resulting `turn_started`/`update`
 * events, exactly the way a push would).
 */

export type ScheduledMessage = typeof scheduledTable.$inferSelect;

export interface ScheduledMessageInput {
  sessionId: string;
  text: string;
  /** Epoch ms of the next fire. */
  nextAt: number;
  /** Recurrence interval in ms; null = one-shot. */
  everyMs?: number | null;
}

export function listScheduled(): ScheduledMessage[] {
  return db.select().from(scheduledTable).orderBy(asc(scheduledTable.nextAt)).all();
}

export function createScheduled(input: ScheduledMessageInput): ScheduledMessage {
  const row: ScheduledMessage = {
    id: randomUUID(),
    sessionId: input.sessionId,
    text: input.text,
    nextAt: input.nextAt,
    everyMs: input.everyMs ?? null,
    enabled: 1,
    skippedAt: null,
    lastError: null,
    skipCount: 0,
    createdAt: Date.now(),
  };
  db.insert(scheduledTable).values(row).run();
  return row;
}

export interface ScheduledPatch {
  text?: string;
  nextAt?: number;
  /** null clears the recurrence (one-shot from here on). */
  everyMs?: number | null;
  enabled?: boolean;
}

/**
 * Edit a schedule in place. Any edit also resets the skip state — the user
 * touching the row is the signal that whatever made it undeliverable (a
 * trashed thread, a typo'd time) has been dealt with, so the sweep tries again.
 */
export function updateScheduled(id: string, patch: ScheduledPatch): ScheduledMessage | undefined {
  const set: Partial<ScheduledMessage> = { skippedAt: null, lastError: null, skipCount: 0 };
  if (patch.text !== undefined) set.text = patch.text;
  if (patch.nextAt !== undefined) set.nextAt = patch.nextAt;
  if (patch.everyMs !== undefined) set.everyMs = patch.everyMs;
  if (patch.enabled !== undefined) set.enabled = patch.enabled ? 1 : 0;
  const changed = db.update(scheduledTable).set(set).where(eq(scheduledTable.id, id)).run().changes;
  if (changed === 0) return undefined;
  return db.select().from(scheduledTable).where(eq(scheduledTable.id, id)).get();
}

export function deleteScheduled(id: string): boolean {
  return db.delete(scheduledTable).where(eq(scheduledTable.id, id)).run().changes > 0;
}

/**
 * One due row. Consume a one-shot, or roll a recurring one forward to its next
 * future slot — and only then try to deliver it. Rolling forward before firing
 * keeps a slow respawn from delaying the recurrence, and skipping the overdue
 * slots means a server that was down overnight fires a daily schedule once on
 * boot rather than replaying every missed interval.
 *
 * A trashed or vanished thread does NOT get scheduled turns: the row is left
 * where it is (not advanced, not consumed) so the user can fix the thread or
 * cancel the schedule, rather than the server silently firing forever at a
 * thread nobody can see. Each such sweep stamps `skippedAt`/`lastError` and
 * counts the skip; past MAX_SCHEDULE_SKIPS the sweep stops selecting the row
 * (it stays listable, and any PATCH resets the count) instead of re-matching
 * it every 15 seconds forever.
 */
export const MAX_SCHEDULE_SKIPS = 20;

function deliver(row: ScheduledMessage, manager: SessionManager): void {
  const session = manager.get(row.sessionId);
  if (!session || session.deletedAt !== null) {
    db.update(scheduledTable)
      .set({
        skippedAt: Date.now(),
        lastError: session ? "the thread is in the trash" : "the thread no longer exists",
        skipCount: row.skipCount + 1,
      })
      .where(eq(scheduledTable.id, row.id))
      .run();
    return;
  }

  if (row.everyMs !== null) {
    let nextAt = row.nextAt + row.everyMs;
    while (nextAt <= Date.now()) nextAt += row.everyMs;
    db.update(scheduledTable)
      .set({ nextAt, skippedAt: null, lastError: null, skipCount: 0 })
      .where(eq(scheduledTable.id, row.id))
      .run();
  } else {
    db.delete(scheduledTable).where(eq(scheduledTable.id, row.id)).run();
  }

  void fire(row.sessionId, row.text, manager);
}

/** Send one prompt, reviving the thread's process first if it has no live one.
    A prompt that lands mid-turn is queued behind it (see SessionManager.prompt). */
async function fire(sessionId: string, text: string, manager: SessionManager): Promise<void> {
  const session = manager.get(sessionId);
  if (!session || session.deletedAt !== null) return;
  try {
    if (session.bridge && !session.exited) {
      // A live bridge may still be booting (acpSessionId unset until session/new
      // answers). `ready` is the handshake's own promise; awaiting it is cheap
      // when it has already resolved. It never rejects as unhandled — start()
      // attached a catch handler when the bridge was created.
      await session.bridge.ready;
      await manager.prompt(sessionId, text);
      return;
    }
    // Idle-retired or pre-restart: revive the way the client's "open a closed
    // thread" does — respawn + session/load — then send.
    const profile = getProfile(session.profileId);
    const project = getProject(session.projectId);
    if (!profile || !project) return;
    await manager.respawn(sessionId, profile, session.agentId, project, session.model, session.effort);
    const revived = manager.get(sessionId);
    if (revived?.bridge && !revived.exited) {
      await revived.bridge.ready;
      await manager.prompt(sessionId, text);
    }
  } catch (error) {
    console.error(`[scheduler] failed to deliver to ${sessionId}`, error);
  }
}

const SWEEP_MS = 15_000;
let timer: ReturnType<typeof setInterval> | null = null;

/** Start the delivery sweep. Idempotent; one loop for the whole process. */
export function startScheduler(manager: SessionManager): void {
  if (timer) return;
  const sweep = () => {
    try {
      const due = db
        .select()
        .from(scheduledTable)
        .where(and(
          lte(scheduledTable.nextAt, Date.now()),
          eq(scheduledTable.enabled, 1),
          lt(scheduledTable.skipCount, MAX_SCHEDULE_SKIPS),
        ))
        .orderBy(asc(scheduledTable.nextAt))
        .all();
      for (const row of due) deliver(row, manager);
    } catch (error) {
      console.error("[scheduler] sweep failed", error);
    }
  };
  // Run once on boot: schedules that came due while the server was down fire now.
  sweep();
  timer = setInterval(sweep, SWEEP_MS).unref();
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
