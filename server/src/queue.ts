import { randomUUID } from "node:crypto";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { db, sessionQueue as queueTable } from "./db/index.js";
import type { QueuedMessage } from "./protocol.js";

/**
 * A thread's queued prompts — what was typed while a turn was running.
 *
 * Storage only: this module knows nothing about bridges or peers. The
 * orchestration (when the queue drains, what "send now" means, who is told)
 * lives in SessionManager; what is here is the row shape and the one rule
 * about the text — blank is refused, because a blank prompt sent to an agent is
 * a turn that does nothing and a queue entry nobody can see.
 *
 * Synchronous, like everything on better-sqlite3: `hasQueued` is read on the
 * turn-settle path and a promise there would reorder the drain against the
 * `turn_ended` it has to follow.
 */

export function listQueue(sessionId: string): QueuedMessage[] {
  return db
    .select({ id: queueTable.id, text: queueTable.text, createdAt: queueTable.createdAt })
    .from(queueTable)
    .where(eq(queueTable.sessionId, sessionId))
    .orderBy(asc(queueTable.position))
    .all();
}

function requireText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("a queued message cannot be empty");
  return trimmed;
}

export function enqueue(sessionId: string, text: string): QueuedMessage {
  const body = requireText(text);
  const row = {
    id: randomUUID(),
    sessionId,
    position: nextPosition(sessionId),
    text: body,
    createdAt: Date.now(),
  };
  db.insert(queueTable).values(row).run();
  return { id: row.id, text: row.text, createdAt: row.createdAt };
}

function nextPosition(sessionId: string): number {
  const row = db
    .select({ max: sql<number | null>`max(${queueTable.position})` })
    .from(queueTable)
    .where(eq(queueTable.sessionId, sessionId))
    .get();
  return (row?.max ?? 0) + 1;
}

export function updateQueued(sessionId: string, itemId: string, text: string): boolean {
  const body = requireText(text);
  return (
    db
      .update(queueTable)
      .set({ text: body })
      .where(sql`${queueTable.id} = ${itemId} and ${queueTable.sessionId} = ${sessionId}`)
      .run().changes > 0
  );
}

export function removeQueued(sessionId: string, itemId: string): boolean {
  return (
    db
      .delete(queueTable)
      .where(sql`${queueTable.id} = ${itemId} and ${queueTable.sessionId} = ${sessionId}`)
      .run().changes > 0
  );
}

export function removeQueuedMany(sessionId: string, ids: string[]): void {
  if (ids.length === 0) return;
  db.delete(queueTable)
    .where(sql`${queueTable.sessionId} = ${sessionId} and ${inArray(queueTable.id, ids)}`)
    .run();
}

export function clearQueue(sessionId: string): void {
  db.delete(queueTable).where(eq(queueTable.sessionId, sessionId)).run();
}

/** What a drain sends: every queued text, in order, as one prompt. The items
    are already trimmed and non-blank, so a blank line is an unambiguous seam. */
export function combineQueued(items: QueuedMessage[]): string {
  return items.map((item) => item.text).join("\n\n");
}
