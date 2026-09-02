import { randomUUID } from "node:crypto";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { db, sessionQueue as queueTable } from "./db/index.js";
import { listAttachments, refOf } from "./attachments.js";
import type { AttachmentRef, QueuedMessage } from "./protocol.js";

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
  const rows = db
    .select({
      id: queueTable.id,
      text: queueTable.text,
      attachmentIds: queueTable.attachmentIds,
      createdAt: queueTable.createdAt,
    })
    .from(queueTable)
    .where(eq(queueTable.sessionId, sessionId))
    .orderBy(asc(queueTable.position))
    .all();
  /* The rows carry ids; the wire carries refs, so a queued message can draw its
     chips with nothing else fetched. Resolved here rather than stored, because
     a name or a size is the attachment row's to state and copying it into the
     queue row would be a second answer that can drift. */
  return rows.map((row) => {
    const ids = row.attachmentIds ?? [];
    const attachments = ids.length > 0 ? listAttachments(ids).map(refOf) : [];
    return {
      id: row.id,
      text: row.text,
      createdAt: row.createdAt,
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  });
}

/** The ids a queued message carries — what a drain hands the prompt path. */
export function queuedAttachmentIds(items: QueuedMessage[]): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    for (const ref of item.attachments ?? []) seen.add(ref.id);
  }
  return [...seen];
}

/** Blank is refused — a blank prompt sent to an agent is a turn that does
    nothing and a queue entry nobody can see — UNLESS the message carries
    attachments, which is the same rule the composer's own empty-prompt guard
    follows: an image with no sentence is a real prompt. */
function requireText(text: string, attachments: AttachmentRef[] = []): string {
  const trimmed = text.trim();
  if (!trimmed && attachments.length === 0) throw new Error("a queued message cannot be empty");
  return trimmed;
}

export function enqueue(
  sessionId: string,
  text: string,
  attachments: AttachmentRef[] = [],
): QueuedMessage {
  const body = requireText(text, attachments);
  const row = {
    id: randomUUID(),
    sessionId,
    position: nextPosition(sessionId),
    text: body,
    attachmentIds: attachments.length > 0 ? attachments.map((ref) => ref.id) : null,
    createdAt: Date.now(),
  };
  db.insert(queueTable).values(row).run();
  return {
    id: row.id,
    text: row.text,
    createdAt: row.createdAt,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

function nextPosition(sessionId: string): number {
  const row = db
    .select({ max: sql<number | null>`max(${queueTable.position})` })
    .from(queueTable)
    .where(eq(queueTable.sessionId, sessionId))
    .get();
  return (row?.max ?? 0) + 1;
}

/** `attachmentIds` omitted means "leave them alone"; an empty array clears
    them, which is how a queued item's chip is removed. */
export function updateQueued(
  sessionId: string,
  itemId: string,
  text: string,
  attachmentIds?: string[],
): boolean {
  const kept = attachmentIds === undefined ? undefined : listAttachments(attachmentIds).map(refOf);
  const existing = kept
    ? kept
    : listQueue(sessionId).find((item) => item.id === itemId)?.attachments ?? [];
  const body = requireText(text, existing);
  return (
    db
      .update(queueTable)
      .set({
        text: body,
        ...(kept ? { attachmentIds: kept.length > 0 ? kept.map((ref) => ref.id) : null } : {}),
      })
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
    are already trimmed, so a blank line is an unambiguous seam — and a message
    that was nothing but an image contributes no line at all rather than an
    empty one. Its attachments still travel: `queuedAttachmentIds` unions the
    lists in row order, because a drain is one prompt and so is one attachment
    set. */
export function combineQueued(items: QueuedMessage[]): string {
  return items
    .map((item) => item.text)
    .filter((text) => text !== "")
    .join("\n\n");
}
