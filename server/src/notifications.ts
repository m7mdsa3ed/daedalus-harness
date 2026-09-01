import { randomUUID } from "node:crypto";
import { and, count, desc, eq, lt } from "drizzle-orm";
import { db, notifications as notificationsTable } from "./db/index.js";

/**
 * The durable notification inbox behind the client's notification pill.
 *
 * The server already tells *devices* about four thread events over FCM push
 * (push.ts). This is the bite the device never sees — the same events, saved so
 * a client can show them however far in the past they happened, with or without
 * FCM configured and after a push was dismissed. Recording happens exactly
 * where the push fires, because those are the moments the harness has decided
 * "a human should know about this."
 *
 * Read/unread is one flag on the server (which the pill's unread count reads),
 * deliberately not a per-device journal: `markRead` is "someone looked at the
 * inbox," and a second device seeing a notice as already-read is the ordinary
 * case, not a privacy leak.
 */

export type NotificationKind = "permission" | "question" | "turn_finished" | "turn_failed";

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  sessionId: string | null;
  threadTitle: string | null;
  body: string | null;
  read: boolean;
  createdAt: number;
}

/** How many notices the newest-first listing returns for `GET /api/notifications`. */
const NOTIFICATIONS_LIMIT = 200;

const row = (r: typeof notificationsTable.$inferSelect): AppNotification => ({
  id: r.id,
  kind: r.kind as NotificationKind,
  sessionId: r.sessionId,
  threadTitle: r.threadTitle,
  body: r.body,
  read: r.read,
  createdAt: r.createdAt,
});

/**
 * Record one notification. `session` is the thread's (the "where"); `body` is
 * the event's own line, exactly as a push would carry it.
 */
export function addNotification(
  kind: NotificationKind,
  session: { id: string; title: string },
  body?: string,
): void {
  db.insert(notificationsTable)
    .values({
      id: randomUUID(),
      kind,
      sessionId: session.id,
      threadTitle: session.title,
      body: body || null,
      read: false,
      createdAt: Date.now(),
    })
    .run();
}

/** The newest `limit` notifications, newest first. */
export function listNotifications(limit: number = NOTIFICATIONS_LIMIT): AppNotification[] {
  return db
    .select()
    .from(notificationsTable)
    .orderBy(desc(notificationsTable.createdAt), desc(notificationsTable.id))
    .limit(limit)
    .all()
    .map(row);
}

/** How many notifications have not been read — the pill's badge. */
export function unreadNotifications(): number {
  return db
    .select({ n: count() })
    .from(notificationsTable)
    .where(eq(notificationsTable.read, false))
    .all()[0].n;
}

/**
 * Mark notifications read. `null` means every notification — the pill's "Mark
 * all read" and a thread being opened. Otherwise only the given ids are marked,
 * and only if they still exist. An empty array marks nothing (the client never
 * sends one; the distinction guards a round-trip that lost its ids).
 */
export function markNotificationsRead(ids: readonly string[] | null): void {
  if (ids == null) {
    db.update(notificationsTable).set({ read: true }).run();
    return;
  }
  if (ids.length === 0) return;
  const where = and(...ids.map((id) => eq(notificationsTable.id, id)));
  const found = db.select({ id: notificationsTable.id }).from(notificationsTable).where(where).all();
  if (found.length === 0) return;
  db.update(notificationsTable)
    .set({ read: true })
    .where(and(...found.map((r) => eq(notificationsTable.id, r.id))))
    .run();
}

/** Delete notifications written strictly before `before` (ms), or everything
    when `before` is omitted (a "clear" action). Returns how many were removed. */
export function clearNotifications(before?: number): number {
  const q = db.delete(notificationsTable);
  const stmt = before === undefined ? q : q.where(lt(notificationsTable.createdAt, before));
  return stmt.run().changes;
}
