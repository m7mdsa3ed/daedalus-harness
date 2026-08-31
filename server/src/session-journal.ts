import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db as defaultDb, sessionEvents as eventsTable } from "./db/index.js";
import { deleteSearchIndex, indexEventRow } from "./search.js";
import {
  EARLIER_PAGE_STEPS,
  REPLAY_CHUNK_BYTES,
  REPLAY_CHUNK_SIZE,
  type EarlierPage,
  type JournaledEvent,
  type ThreadEvent,
} from "./protocol.js";

/** The one thing an append needs from its session: identity and the monotonic
    seq counter it stamps from. `Session` satisfies it; the counter is mutated
    in place so the manager's copy is always the truth. */
export interface JournalOwner {
  id: string;
  eventCount: number;
}

type DbHandle = typeof defaultDb;

/**
 * The event-journal concern, on its own: the buffered writes, the reads that
 * flush first, the turn-boundary math and the replay framing. The manager owns
 * one instance and decides *when* — this class only knows the table.
 */
export class SessionJournal {
  constructor(private db: DbHandle = defaultDb) {}

  /**
   * Journaled events not yet written to SQLite.
   *
   * The seq is assigned synchronously in `append` and the row is written a
   * tick later, which is safe because nothing reads the log through anything but
   * `flush` first — and worth doing because a streaming turn is thousands
   * of events. One INSERT each is one transaction each: cheap individually under
   * WAL, but the surrounding work (building the statement, serializing the
   * payload) is per-event too, and a turn's worth of it lands on the same tick
   * as the fan-out the browser is waiting for. Batched, a turn is a handful of
   * commits and the serialization happens off the emit path.
   *
   * The exposure is one tick of events on a hard crash. That was already the
   * bargain (`synchronous = NORMAL` trades the fsync for the OS's word), and the
   * journal is a cache for reading, not the conversation — the agent still has
   * that, and a revive re-reads it.
   */
  private pendingWrites: (typeof eventsTable.$inferInsert)[] = [];
  private flushScheduled = false;

  /** Append one event to the session's log and stamp it with its seq. */
  append(session: JournalOwner, event: ThreadEvent): ThreadEvent {
    const seq = session.eventCount++;
    const stamped = { ...event, seq } as ThreadEvent;
    this.pendingWrites.push({
      sessionId: session.id,
      seq,
      kind: event.ev,
      payload: stamped,
      at: Date.now(),
    });
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      setImmediate(() => this.flush()).unref();
    }
    return stamped;
  }

  /**
   * Land the buffered rows. Called before every read of the log and before every
   * delete from it, so no caller can observe a journal that is missing its most
   * recent events — and on the next tick after an append, so an idle server is
   * never holding one.
   */
  flush(): void {
    this.flushScheduled = false;
    if (this.pendingWrites.length === 0) return;
    const rows = this.pendingWrites;
    this.pendingWrites = [];
    try {
      this.db.transaction((tx) => {
        for (const row of rows) {
          tx.insert(eventsTable).values(row).run();
          // The search index rides the same commit: a streaming turn indexes
          // at the flush cadence, and a rolled-back event indexes nothing.
          indexEventRow(tx, row);
        }
      });
    } catch {
      /* One bad row must not cost every other thread its tick. A batch is a
         transaction, so a single failure rolls the whole thing back — and the
         rows in it belong to whatever threads happened to be streaming at the
         same moment, which is the wrong blast radius for a fault that is always
         about one session. The usual cause is a thread purged between the
         append and this flush: its rows went with it (the foreign key cascades)
         and nothing is owed an error, because the log they belonged to no
         longer exists. So retry row by row and report only what actually fails.
         A throw here would be an uncaught exception — this runs on a
         setImmediate, with no caller to catch it. */
      for (const row of rows) {
        try {
          this.db.insert(eventsTable).values(row).run();
          // Only after the event landed — a row refused above (its session
          // purged between append and flush) must not leave an FTS orphan,
          // since the virtual table has no foreign key to cascade it away.
          indexEventRow(this.db, row);
        } catch (error) {
          console.error(
            `[journal] dropped event ${row.seq} of session ${row.sessionId.slice(0, 8)}`,
            error,
          );
        }
      }
    }
  }

  /** Events in `[from, from + limit)`, in order. A range scan on (session_id,
      seq). Parsed — the replay path deliberately does not use this; see
      `replayFrames`. */
  eventsFrom(sessionId: string, from: number, limit?: number): JournaledEvent[] {
    this.flush();
    const query = this.db
      .select({ payload: eventsTable.payload })
      .from(eventsTable)
      .where(and(eq(eventsTable.sessionId, sessionId), gte(eventsTable.seq, from)))
      .orderBy(asc(eventsTable.seq));
    const rows = limit === undefined ? query.all() : query.limit(limit).all();
    return rows.map((row) => row.payload as JournaledEvent);
  }

  /**
   * The replay, as frames ready to put on a socket.
   *
   * Two things are deliberate here. The rows come back as **text**, not as
   * parsed objects: the payload column already holds exactly the JSON the
   * browser needs, so parsing it to re-serialize it once per peer is work with
   * no reader. And the scan is **paged**, so a long thread's replay is bounded
   * by a page rather than by the thread — `.all()` over the whole range put the
   * entire transcript in memory at attach time, which is the cost the table was
   * introduced to remove, merely moved from steady-state to connect-time.
   *
   * A frame is cut on whichever budget runs out first, count or bytes. Bytes is
   * the one that matters for a thread full of terminal output or large diffs;
   * count is what keeps a chatty-but-small thread from being one frame.
   */
  *replayFrames(sessionId: string, from: number, batch: boolean): Generator<string> {
    this.flush();
    let cursor = from;
    let frame: string[] = [];
    let bytes = 0;
    const cut = function* (): Generator<string> {
      if (frame.length === 0) return;
      yield `{"ev":"replay","events":[${frame.join(",")}]}`;
      frame = [];
      bytes = 0;
    };
    for (;;) {
      const page = this.db
        .select({ payload: sql<string>`cast(${eventsTable.payload} as text)` })
        .from(eventsTable)
        .where(and(eq(eventsTable.sessionId, sessionId), gte(eventsTable.seq, cursor)))
        .orderBy(asc(eventsTable.seq))
        .limit(REPLAY_CHUNK_SIZE)
        .all();
      if (page.length === 0) break;
      cursor += page.length;
      for (const row of page) {
        // A client that did not ask for bulk gets the events one at a time; it
        // would drop a `replay` frame it does not know, and `caught_up` rides
        // inside that frame, so the thread would never finish connecting.
        if (!batch) {
          yield row.payload;
          continue;
        }
        if (frame.length >= REPLAY_CHUNK_SIZE || bytes + row.payload.length > REPLAY_CHUNK_BYTES) {
          yield* cut();
        }
        frame.push(row.payload);
        bytes += row.payload.length;
      }
      if (page.length < REPLAY_CHUNK_SIZE) break;
    }
    yield* cut();
  }

  /* ---- step-paging ---- */

  /** A **step** is a turn, and a turn begins at its journaled `turn_started` —
      the one structural event the server interprets without parsing an update
      payload. `from`/`before` are therefore always the seq of a `turn_started`,
      so a replay or a page is whole turns, never a cut inside one. */

  /** The `turn_started` seqs strictly before `before`, newest first, capped at
      `limit`. */
  private turnStartsBefore(sessionId: string, before: number, limit: number): number[] {
    this.flush();
    return this.db
      .select({ seq: eventsTable.seq })
      .from(eventsTable)
      .where(and(
        eq(eventsTable.sessionId, sessionId),
        eq(eventsTable.kind, "turn_started"),
        lt(eventsTable.seq, before),
      ))
      .orderBy(desc(eventsTable.seq))
      .limit(limit)
      .all()
      .map((row) => row.seq);
  }

  /** How many turns the log holds. */
  turnCount(sessionId: string): number {
    this.flush();
    const row = this.db
      .select({ count: sql<number>`count(*)` })
      .from(eventsTable)
      .where(and(eq(eventsTable.sessionId, sessionId), eq(eventsTable.kind, "turn_started")))
      .get();
    return Number(row?.count ?? 0);
  }

  /** How many turns lie before `before`. */
  countTurnsBefore(sessionId: string, before: number): number {
    this.flush();
    const row = this.db
      .select({ count: sql<number>`count(*)` })
      .from(eventsTable)
      .where(and(
        eq(eventsTable.sessionId, sessionId),
        eq(eventsTable.kind, "turn_started"),
        lt(eventsTable.seq, before),
      ))
      .get();
    return Number(row?.count ?? 0);
  }

  /** The seq of the `index`-th `turn_started` (0-based, oldest first), or null
      when the log has fewer than `index + 1` turns. */
  turnStartAt(sessionId: string, index: number): number | null {
    this.flush();
    const row = this.db
      .select({ seq: eventsTable.seq })
      .from(eventsTable)
      .where(and(eq(eventsTable.sessionId, sessionId), eq(eventsTable.kind, "turn_started")))
      .orderBy(asc(eventsTable.seq))
      .offset(index)
      .limit(1)
      .get();
    return row?.seq ?? null;
  }

  /** The page of whole turns immediately before `before`, plus how many turns
      are still behind it. Empty when `before` is already the head of the log.
   *
   * A log need not begin with a `turn_started`: a revive clears the journal and
   * refills it from the `session/load` replay, which is the prior conversation
   * with no turn boundaries in it. That head is not a turn and so can never be
   * a page of its own — the page that reaches the oldest turn takes it, which
   * is also the only way it is ever reachable. `earlier` is turns, so it is 0
   * either way and the client stops asking at the same point. */
  earlierPage(sessionId: string, before: number): EarlierPage {
    if (before <= 0) return { events: [], earlier: 0 };
    const starts = this.turnStartsBefore(sessionId, before, EARLIER_PAGE_STEPS).reverse();
    const earlier = starts.length === 0 ? 0 : this.countTurnsBefore(sessionId, starts[0]);
    // No turns left behind this page: whatever precedes it is that head, and
    // it belongs to the oldest turn shown rather than being stranded below it.
    const first = starts.length === 0 || earlier === 0 ? 0 : starts[0];
    if (first >= before) return { events: [], earlier: 0 };
    return { events: this.eventsFrom(sessionId, first, before - first), earlier };
  }

  /** Wipe one session's log — its buffered rows included — and zero its
      counter. The revive path (`respawnNow`) is the caller that matters. */
  clear(session: JournalOwner): void {
    /* Drop this session's buffered rows rather than writing them: they belong
       to the log being thrown away, and landing them after the delete would
       leave orphans that the next append then collides with on seq. */
    this.pendingWrites = this.pendingWrites.filter((row) => row.sessionId !== session.id);
    this.db.delete(eventsTable).where(eq(eventsTable.sessionId, session.id)).run();
    deleteSearchIndex([session.id]);
    session.eventCount = 0;
  }

  /** Where each session's log left off — `max(seq) + 1` per session, which is
      what `eventCount` restarts from on reload. Restoring it is not
      bookkeeping: `append` stamps from it and the (session_id, seq) index is
      unique, so a count that restarted at 0 would collide on the first event
      of the revive. */
  nextSeqBySession(): Map<string, number> {
    this.flush();
    return new Map(
      this.db
        .select({ sessionId: eventsTable.sessionId, next: sql<number>`max(${eventsTable.seq}) + 1` })
        .from(eventsTable)
        .groupBy(eventsTable.sessionId)
        .all()
        .map((row) => [row.sessionId, row.next] as const),
    );
  }

  /** When each session's log was last written — `max(at)` per session. What
      backfills `Session.lastActivityAt` for a thread whose row predates that
      column, so ordering by activity is right for threads that existed before
      anything recorded it. One grouped scan at boot, not per thread. */
  lastActivityBySession(): Map<string, number> {
    this.flush();
    return new Map(
      this.db
        .select({ sessionId: eventsTable.sessionId, at: sql<number>`max(${eventsTable.at})` })
        .from(eventsTable)
        .groupBy(eventsTable.sessionId)
        .all()
        .map((row) => [row.sessionId, row.at] as const),
    );
  }

  /**
   * Drop whole logs whose newest event predates `cutoff`, skipping the ids in
   * `liveIds` (a running thread's log is what its peers are attached to).
   * Returns the session ids whose archives were dropped, so the manager can
   * zero their counters.
   */
  prune(cutoff: number, liveIds: string[]): string[] {
    this.flush();
    const stale = this.db
      .select({ sessionId: eventsTable.sessionId, newest: sql<number>`max(${eventsTable.at})` })
      .from(eventsTable)
      .groupBy(eventsTable.sessionId)
      .having(sql`max(${eventsTable.at}) < ${cutoff}`)
      .all()
      .map((row) => row.sessionId)
      .filter((id) => !liveIds.includes(id));
    if (stale.length > 0) {
      this.db.delete(eventsTable).where(inArray(eventsTable.sessionId, stale)).run();
      deleteSearchIndex(stale);
      console.log(`[journal] dropped ${stale.length} retired thread archive(s)`);
    }
    return stale;
  }
}
