import { randomUUID } from "node:crypto";
import { desc, eq, lt, notInArray } from "drizzle-orm";
import { db, composerHistory as historyTable } from "./db/index.js";

/**
 * The composer's prompt history — every message the user has actually sent.
 *
 * Up in the composer used to walk the *thread's* transcript, which is a
 * different list on every thread: the phrase you type into every new thread was
 * the one thing recall could never give you back. This is that list made
 * global, and server-side so it is the same list on the phone and the desktop.
 *
 * Recorded on the send that reached the server, never on the one that came back
 * into the box — a message that failed to leave is still in the composer, and a
 * history that already holds it offers it twice.
 *
 * The rules are a shell's, because that is the thing being imitated:
 * a repeat does not get a second row (it moves to the newest instead), and the
 * list is capped so it cannot grow without end.
 */

export interface ComposerHistoryEntry {
  id: string;
  text: string;
  sessionId: string | null;
  threadTitle: string | null;
  createdAt: number;
}

/** How many entries `GET /api/composer-history` returns, and how many rows the
    table is trimmed back to on write. Big enough that Up reaches last week,
    small enough that the whole list is one cheap read the client can hold. */
const HISTORY_LIMIT = 500;

/** A prompt longer than this is a pasted document, not a sentence someone will
    want to arrow back to; recording it whole would put a megabyte behind every
    read of the list. Truncated rather than dropped — the opening line is still
    worth finding by search. */
const MAX_TEXT = 8_000;

const row = (r: typeof historyTable.$inferSelect): ComposerHistoryEntry => ({
  id: r.id,
  text: r.text,
  sessionId: r.sessionId,
  threadTitle: r.threadTitle,
  createdAt: r.createdAt,
});

/**
 * Record one sent prompt, and answer with the row that now represents it.
 *
 * An exact repeat is *moved*, not duplicated: the existing rows with this text
 * are deleted and one new row is written, so the list reads as "when you last
 * said this" and a phrase sent daily occupies one line instead of thirty. That
 * also makes the call idempotent enough for two devices racing the same send.
 */
export function addComposerHistory(entry: {
  text: string;
  sessionId?: string | null;
  threadTitle?: string | null;
}): ComposerHistoryEntry | null {
  const text = entry.text.trim().slice(0, MAX_TEXT);
  // An attachment-only send has no words to recall.
  if (!text) return null;

  const value = {
    id: randomUUID(),
    text,
    sessionId: entry.sessionId ?? null,
    threadTitle: entry.threadTitle ?? null,
    createdAt: Date.now(),
  };

  db.transaction((tx) => {
    tx.delete(historyTable).where(eq(historyTable.text, text)).run();
    tx.insert(historyTable).values(value).run();
    /* Trim to the cap by keeping the newest ids rather than deleting by age:
       an `OFFSET` delete is what SQLite will not take directly, and the newest
       N is the thing actually being defended. */
    const keep = tx
      .select({ id: historyTable.id })
      .from(historyTable)
      .orderBy(desc(historyTable.createdAt), desc(historyTable.id))
      .limit(HISTORY_LIMIT)
      .all()
      .map((r) => r.id);
    if (keep.length >= HISTORY_LIMIT) {
      tx.delete(historyTable).where(notInArray(historyTable.id, keep)).run();
    }
  });

  return row(value);
}

/** The newest `limit` prompts, newest first — the order the panel lists and
    the order Up walks (from the end). */
export function listComposerHistory(limit: number = HISTORY_LIMIT): ComposerHistoryEntry[] {
  return db
    .select()
    .from(historyTable)
    .orderBy(desc(historyTable.createdAt), desc(historyTable.id))
    .limit(Math.min(limit, HISTORY_LIMIT))
    .all()
    .map(row);
}

/** Forget one entry (`id`), everything older than `before` (ms), or — with
    neither — the whole history. Returns how many rows went. */
export function clearComposerHistory(opts: { id?: string; before?: number } = {}): number {
  if (opts.id) return db.delete(historyTable).where(eq(historyTable.id, opts.id)).run().changes;
  if (opts.before !== undefined) {
    return db.delete(historyTable).where(lt(historyTable.createdAt, opts.before)).run().changes;
  }
  return db.delete(historyTable).run().changes;
}
