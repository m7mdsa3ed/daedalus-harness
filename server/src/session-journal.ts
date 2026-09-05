import { and, asc, desc, eq, gte, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { db as defaultDb, sessionEvents as eventsTable } from "./db/index.js";
import { deleteSearchIndex, indexEventRow } from "./search.js";
import {
  EARLIER_PAGE_STEPS,
  REPLAY_CHUNK_BYTES,
  REPLAY_CHUNK_SIZE,
  TURN_TICK_REPLY,
  TURN_TICK_TEXT,
  type EarlierPage,
  type JournaledEvent,
  type ThreadEvent,
  type TurnTick,
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
  *replayFrames(sessionId: string, from: number, batch: boolean, to?: number): Generator<string> {
    this.flush();
    let cursor = from;
    let frame: string[] = [];
    let bytes = 0;
    /* How many rows to ask SQLite for at a time. It starts at the frame's own
       count budget and then follows what the thread turns out to be made of:
       the frame cut already knows a page of events can be worth far more than
       `REPLAY_CHUNK_BYTES`, and the DB page — which is where the memory
       actually lands — was the one place that still counted only rows. Five
       hundred rows of streamed text is a page worth two frames; five hundred
       rows of terminal output is 25MB fetched to emit five frames of five, and
       the peak the paging exists to bound is back. So each page is sized from
       the last one's average row: enough rows for about two frames' worth of
       bytes, never fewer than a handful (a single enormous event must still
       make progress) and never more than the count budget. */
    let pageSize = REPLAY_CHUNK_SIZE;
    const cut = function* (): Generator<string> {
      if (frame.length === 0) return;
      yield `{"ev":"replay","events":[${frame.join(",")}]}`;
      frame = [];
      bytes = 0;
    };
    for (;;) {
      /* `to` bounds the replay to the window the `attached` event named, so the
         events a turn journals *while* the archive is going out are left to
         reach the peer as the live events they are (see `Peer.pending`) instead
         of being sent twice — once by this trailing page and once by the
         buffer. Unbounded when the caller names none. */
      const limit = to === undefined ? pageSize : Math.min(pageSize, to - cursor);
      if (limit <= 0) break;
      const page = this.db
        .select({ payload: sql<string>`cast(${eventsTable.payload} as text)` })
        .from(eventsTable)
        .where(and(eq(eventsTable.sessionId, sessionId), gte(eventsTable.seq, cursor)))
        .orderBy(asc(eventsTable.seq))
        .limit(limit)
        .all();
      if (page.length === 0) break;
      cursor += page.length;
      const pageBytes = page.reduce((sum, row) => sum + row.payload.length, 0);
      pageSize = Math.max(
        8,
        Math.min(REPLAY_CHUNK_SIZE, Math.ceil((2 * REPLAY_CHUNK_BYTES) / Math.max(1, pageBytes / page.length))),
      );
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
      // Short page: the range is exhausted. Compared against the limit that was
      // actually used, not the constant — the page size moves now.
      if (page.length < limit) break;
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

  /**
   * Every turn the log holds, oldest first, with preview excerpts — the
   * thread's table of contents, carried on `attached` so the turn rail can
   * draw all its ticks without paging history in first.
   *
   * One scan, and only over the rows that can contribute: the tool calls,
   * diffs and terminal pages that make a replay heavy are refused by the SQL
   * below and never reach this process. Reply text stops accumulating per turn
   * once the excerpt is full, so a build-log turn costs its prefix, not its
   * megabytes. A subagent's chunks carry the
   * child's session id on the event and are skipped — the rail counts the
   * thread's own answers, the way it skips `parentId` items client-side.
   */
  turnTicks(sessionId: string): TurnTick[] {
    this.flush();
    const rows = this.db
      .select({ payload: eventsTable.payload })
      .from(eventsTable)
      .where(
        and(
          eq(eventsTable.sessionId, sessionId),
          /* The only `update` this reads is an `agent_message_chunk`, and on a
             long thread it is one row in a hundred — the rest are tool calls,
             diffs and terminal pages, fetched whole and JSON.parsed here only
             to be dropped by the loop below. The `like` is a superset of what
             the loop keeps (every chunk names the discriminant in its payload)
             and it is decided inside SQLite, over bytes, instead of in V8 over
             objects: on this install's largest thread it is 1.2k rows in place
             of 97k, and ~50ms in place of ~300ms of the attach. Everything the
             loop refuses — a subagent's chunks, a non-text content block — it
             still refuses, because the filter only ever removes rows the loop
             was going to remove too. */
          or(
            eq(eventsTable.kind, "turn_started"),
            and(
              eq(eventsTable.kind, "update"),
              sql`${eventsTable.payload} like '%agent_message_chunk%'`,
            ),
          ),
        ),
      )
      .orderBy(asc(eventsTable.seq))
      .all();
    const ticks: TurnTick[] = [];
    for (const row of rows) {
      const event = row.payload as JournaledEvent;
      if (event.ev === "turn_started") {
        ticks.push({
          turnId: event.turnId,
          seq: event.seq,
          text: (event.text ?? "").slice(0, TURN_TICK_TEXT),
          reply: "",
        });
      } else if (event.ev === "update" && ticks.length > 0) {
        if (event.sessionId) continue;
        const update = event.update as {
          sessionUpdate?: string;
          content?: { type?: string; text?: string };
        };
        if (update.sessionUpdate !== "agent_message_chunk" || update.content?.type !== "text") continue;
        const tick = ticks[ticks.length - 1];
        if (tick.reply.length >= TURN_TICK_REPLY) continue;
        const piece = update.content.text ?? "";
        tick.reply = (tick.reply ? `${tick.reply}\n${piece}` : piece).slice(0, TURN_TICK_REPLY);
      }
    }
    return ticks;
  }

  /* ---- rewind ---- */

  /**
   * What a rewind TO `turnId` needs: the seq where that turn's own
   * `turn_started` sits, and — from the turn immediately before it, if any —
   * the ACP messageId a conversation fork should cut at.
   *
   * The messageId is read off the earlier turn's `turn_ended`
   * (`lastMessageId`, the last content chunk that turn produced), because the
   * two fork-point dialects this serves both cut *inclusive* of the id they
   * are given — Claude up to the message, Codex up to its turn — so forking at
   * the previous turn's last id is what leaves the previous turn in and the
   * target turn out. `before: null` means `turnId` is the thread's very first
   * turn: there is nothing to fork from, and a rewind there means starting
   * over, not forking. A `before` whose `messageId` is null is a real answer
   * too — the earlier turn predates the field, or never produced an assistant
   * chunk — and the caller refuses on it rather than forking at nothing.
   *
   * Null on the whole call: no such turn in this log (the route answers 404).
   * The `turnId` is inside the payload, not a column, so the lookups go
   * through `json_extract` — turn boundaries are the one place a value other
   * than `seq`/`kind` has to be queried, and the table has no index worth
   * adding a generated column for at a rate of one rewind per click.
   */
  rewindPoint(
    sessionId: string,
    turnId: string,
  ): { turnSeq: number; before: { messageId: string | null } | null } | null {
    this.flush();
    const turnSeq = this.db
      .select({ seq: eventsTable.seq })
      .from(eventsTable)
      .where(
        and(
          eq(eventsTable.sessionId, sessionId),
          eq(eventsTable.kind, "turn_started"),
          sql`json_extract(${eventsTable.payload}, '$.turnId') = ${turnId}`,
        ),
      )
      .get()?.seq;
    if (turnSeq === undefined) return null;
    const prev = this.db
      .select({ payload: eventsTable.payload })
      .from(eventsTable)
      .where(
        and(
          eq(eventsTable.sessionId, sessionId),
          eq(eventsTable.kind, "turn_started"),
          lt(eventsTable.seq, turnSeq),
        ),
      )
      .orderBy(desc(eventsTable.seq))
      .limit(1)
      .get();
    if (!prev) return { turnSeq, before: null };
    const prevTurnId = (prev.payload as { turnId?: string } | null)?.turnId;
    if (!prevTurnId) return { turnSeq, before: { messageId: null } };
    const ended = this.db
      .select({ payload: eventsTable.payload })
      .from(eventsTable)
      .where(
        and(
          eq(eventsTable.sessionId, sessionId),
          eq(eventsTable.kind, "turn_ended"),
          sql`json_extract(${eventsTable.payload}, '$.turnId') = ${prevTurnId}`,
        ),
      )
      .get();
    const lastMessageId = (ended?.payload as { lastMessageId?: string } | null)?.lastMessageId;
    return { turnSeq, before: { messageId: lastMessageId ?? null } };
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

  /**
   * Where an unresumed attach should start: the oldest turn boundary that fits
   * **both** budgets, or 0 when the whole log fits and nothing is withheld.
   *
   * The step budget alone was the older rule and it measured the wrong thing.
   * A step is a turn, and a turn is anything from one sentence to a build log
   * streamed through `_meta.terminal_output_delta` — so sixty of them is a
   * screenful on one thread and several megabytes on the next, and it is the
   * second one that leaves someone watching a spinner. Bytes is the budget the
   * frame cut in `replayFrames` already runs on, for the same reason and on the
   * same payloads; the window simply never had one.
   *
   * The steps are applied first, so the byte pass never scans more than the
   * step window would have sent anyway, and it reads `seq`/`kind`/`length()`
   * rather than the payloads themselves — the size of the replay is measured
   * without materializing it. The window function accumulates each row's tail
   * (descending order, default frame), and the answer is the *oldest*
   * `turn_started` whose tail still fits.
   *
   * The floor is a whole turn even when that turn alone busts the budget: the
   * cut is only ever made at a `turn_started` (a transcript that begins mid-turn
   * re-folds into a half turn the reducer never saw opened), so one enormous
   * turn is sent whole and the budget is missed rather than the rule broken.
   */
  windowStart(sessionId: string, steps: number, maxBytes: number): number {
    if (steps <= 0) return 0;
    this.flush();
    const skip = this.turnCount(sessionId) - steps;
    const stepFloor = skip > 0 ? this.turnStartAt(sessionId, skip) ?? 0 : 0;
    const row = this.db
      .all<{ seq: number }>(sql`
        select seq from (
          select seq, kind,
                 sum(length(payload)) over (order by seq desc) as tail
            from session_events
           where session_id = ${sessionId} and seq >= ${stepFloor}
        )
        where kind = 'turn_started' and tail <= ${maxBytes}
        order by seq asc
        limit 1
      `)
      .at(0);
    /* Not one whole turn fits: send the newest on its own. A window of no turns
       at all would be a blank transcript for a thread that has one, and there
       is nothing below the floor to fall back to. */
    const cut = row
      ? Math.max(stepFloor, row.seq)
      : this.turnStartsBefore(sessionId, Number.MAX_SAFE_INTEGER, 1).at(0) ?? stepFloor;
    /* The cut is made only when a turn is genuinely being withheld. Jumping to
       the first turn of the window unconditionally looks equivalent and is not:
       a log need not begin with a `turn_started`, because a revive clears it and
       refills it from the `session/load` replay — the whole prior conversation,
       with no turn boundaries in it. Starting at the oldest turn there would
       drop everything the load put back while `earlier` said 0 (no whole turns
       lie behind it), so nothing would offer it back either. Same rule as
       `earlierPage`: the window that reaches the oldest turn takes the head
       along, which is the only way that head is ever read. */
    return this.countTurnsBefore(sessionId, cut) === 0 ? 0 : cut;
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

  /**
   * One number per session, driven from the `sessions` table rather than from
   * a GROUP BY over the events.
   *
   * Both callers are `reload`, which reads the answer by session row — so the
   * only ids that can ever be looked up are the ones this drives from, and an
   * orphaned event's group was work with no reader. The difference is what the
   * shape costs: `group by session_id` is a walk of all 1M index entries to
   * emit 466 rows, while a correlated `max()` over the same index's leading
   * column is 466 seeks straight to the last entry of each range. Sub-millisecond
   * against ~600ms for the pair, on a boot path that blocks the first spawn.
   *
   * `max(seq)` rides the (session_id, seq) index and `max(at)` the
   * (session_id, at) one, both index-only.
   */
  private perSessionMax(agg: SQL): Map<string, number> {
    const rows = this.db.all<{ id: string; value: number | null }>(sql`
      select s.id as id,
             (select ${agg} from session_events e where e.session_id = s.id) as value
        from sessions s
    `);
    const out = new Map<string, number>();
    for (const row of rows) if (row.value !== null) out.set(row.id, row.value);
    return out;
  }

  /** Where each session's log left off — `max(seq) + 1` per session, which is
      what `eventCount` restarts from on reload. Restoring it is not
      bookkeeping: `append` stamps from it and the (session_id, seq) index is
      unique, so a count that restarted at 0 would collide on the first event
      of the revive. */
  nextSeqBySession(): Map<string, number> {
    this.flush();
    return this.perSessionMax(sql`max(seq) + 1`);
  }

  /** When each session's log was last written — `max(at)` per session. What
      backfills `Session.lastActivityAt` for a thread whose row predates that
      column, so ordering by activity is right for threads that existed before
      anything recorded it. One query at boot, not per thread — see
      `perSessionMax` for why it is not a GROUP BY. */
  lastActivityBySession(): Map<string, number> {
    this.flush();
    return this.perSessionMax(sql`max(at)`);
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
