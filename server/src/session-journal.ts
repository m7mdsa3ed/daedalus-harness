import { and, asc, desc, eq, gte, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { db as defaultDb, scrubJson, sessionEvents as eventsTable } from "./db/index.js";
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
   * Journaled events not yet written to Postgres.
   *
   * The seq is assigned synchronously in `append` and the row is written a
   * tick later, which is safe because nothing reads the log through anything but
   * `flush` first — and worth doing because a streaming turn is thousands
   * of events. One INSERT each is one transaction each: cheap individually,
   * but the surrounding work (building the statement, serializing the
   * payload) is per-event too, and a turn's worth of it lands on the same tick
   * as the fan-out the browser is waiting for. Batched, a turn is a handful of
   * commits and the serialization happens off the emit path.
   *
   * The exposure is one tick of events on a hard crash. That was always the
   * bargain, and the journal is a cache for reading, not the conversation — the
   * agent still has that, and a revive re-reads it.
   */
  private pendingWrites: (typeof eventsTable.$inferInsert)[] = [];
  private flushScheduled = false;
  /**
   * The flush currently in the air, or null.
   *
   * The driver is asynchronous now, so two flushes can overlap where the
   * SQLite one could not: a read's `await this.flush()` lands on the same tick
   * as the `setImmediate` one an append scheduled, and both take the same rows
   * off `pendingWrites`. Chaining on this makes the second wait for the first
   * — which is also what makes `await flush()` mean what every reader below
   * assumes it means: *the log is written*, not *a write has started*.
   */
  private flushing: Promise<void> | null = null;

  /** Append one event to the session's log and stamp it with its seq. */
  append(session: JournalOwner, event: ThreadEvent): ThreadEvent {
    const seq = session.eventCount++;
    const stamped = { ...event, seq } as ThreadEvent;
    /* Postgres cannot represent a NUL in `text` or inside a `jsonb` string
       (22P05), and a transcript quoting code carries them as data - a NUL
       separator in a tool result is enough. Unscrubbed, the insert throws, the
       batch rolls back and the row-by-row retry drops the event: the turn plays
       on screen and is gone on reload. Scrubbed here rather than at the insert
       so the search index, built from this same payload, is clean too; the
       peers' copy keeps the character, because JSON over a socket can carry it.

       The test is `scrubJson`'s own and never `includes("\\0")`: once
       serialised the character is the six-character escape, not a NUL byte, and
       only the former is what reaches the driver. */
    const raw = JSON.stringify(stamped);
    const clean = scrubJson(raw);
    this.pendingWrites.push({
      sessionId: session.id,
      seq,
      kind: event.ev,
      payload: clean === raw ? stamped : (JSON.parse(clean) as ThreadEvent),
      at: Date.now(),
    });
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      setImmediate(() => void this.flush()).unref();
    }
    return stamped;
  }

  /**
   * Land the buffered rows. Called before every read of the log and before every
   * delete from it, so no caller can observe a journal that is missing its most
   * recent events — and on the next tick after an append, so an idle server is
   * never holding one.
   */
  flush(): Promise<void> {
    this.flushScheduled = false;
    const previous = this.flushing ?? Promise.resolve();
    const next = previous.then(() => this.flushOnce());
    this.flushing = next;
    // Whoever finishes last clears the chain, so an idle journal is not holding
    // a settled promise for the life of the process.
    void next.finally(() => {
      if (this.flushing === next) this.flushing = null;
    });
    return next;
  }

  private async flushOnce(): Promise<void> {
    if (this.pendingWrites.length === 0) return;
    const rows = this.pendingWrites;
    this.pendingWrites = [];
    try {
      await this.db.transaction(async (tx) => {
        for (const row of rows) {
          await tx.insert(eventsTable).values(row);
          // The search index rides the same commit: a streaming turn indexes
          // at the flush cadence, and a rolled-back event indexes nothing.
          await indexEventRow(tx, row);
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
          await this.db.insert(eventsTable).values(row);
          // Only after the event landed — a row refused above (its session
          // purged between append and flush) must not leave an index orphan,
          // since the index table has no foreign key to cascade it away.
          await indexEventRow(this.db, row);
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
  async eventsFrom(sessionId: string, from: number, limit?: number): Promise<JournaledEvent[]> {
    await this.flush();
    const query = this.db
      .select({ payload: eventsTable.payload })
      .from(eventsTable)
      .where(and(eq(eventsTable.sessionId, sessionId), gte(eventsTable.seq, from)))
      .orderBy(asc(eventsTable.seq));
    const rows = limit === undefined ? await query : await query.limit(limit);
    return rows.map((row) => row.payload as JournaledEvent);
  }

  /* ---- coalescing ---- */

  /**
   * A journaled event that is one delta of a streamed run: an
   * `agent_message_chunk` or `agent_thought_chunk` carrying text.
   *
   * These are the rows a replay is made of and almost none of its meaning. A
   * model streams its reasoning a few characters at a time, and every delta is
   * journaled as a whole event — on this install's largest thread, one turn is
   * 81,686 thought chunks holding 0.33MB of text inside 15.1MB of envelope, an
   * average of 4.1 characters each. The client folds every one of them back
   * into the single item they came from (`appendText`), so the entire cost is
   * paid to rebuild something the log already knows the shape of.
   */
  private static readonly RUN_CHUNK = sql`kind = 'update'
      and payload->'update'->>'sessionUpdate' in ('agent_message_chunk', 'agent_thought_chunk')
      and payload->'update'->'content'->>'type' = 'text'`;

  /**
   * What makes two chunks the same run: everything about the event except its
   * `seq` and the text itself.
   *
   * Spelled as three fragments rather than a list of fields because the list is
   * the thing that goes stale — a runtime that starts sending a new key on a
   * chunk (`messageId` was one, `_meta` another) would otherwise merge two
   * chunks that differ in it. Each fragment serializes only what is left after
   * the text is removed, so the comparison never touches the bytes it exists to
   * avoid moving: the top level minus `seq` and `update` (`ev`,
   * `historyReplay`, a subagent's `sessionId`), the update minus its content
   * (`sessionUpdate`, `messageId`, `_meta`), and the content minus its text
   * (`type`, `annotations`, its own `_meta`).
   */
  private static readonly RUN_SIGNATURE = sql`(payload - 'seq' - 'update')::text
      || ((payload->'update') - 'content')::text
      || ((payload->'update'->'content') - 'text')::text`;

  /**
   * One page of the log, with each run of streamed chunks merged into the one
   * event it draws.
   *
   * The merge is computed per request from rows nothing has touched, which is
   * the whole reason it is done here and not at `append`. A journal that
   * merged on the way in would have to answer a socket resuming *inside* a run
   * — the cursor is an event count, and a merged row is one row for many of
   * them — and every way of answering that either loses the tail of the run or
   * repeats its head. Reading from `from` forward, a resume simply merges what
   * it is asking for: the run is cut where the cursor is, exactly.
   *
   * Postgres decides the boundaries (`lag` over the signature), so the only
   * rows that ship their envelope are the ones that open a run and the ones
   * that are not runs at all — the rest send their text and 32 bytes of
   * comparison. On that same thread the page goes from 17.9MB to 1.3MB, and
   * from 82,978 events to 282: the transcript is identical, and it is the
   * client's `JSON.parse` and 82,978 reducer folds that stop happening.
   */
  private async coalescedPage(
    sessionId: string,
    from: number,
    limit: number,
  ): Promise<{ rows: number; bytes: number; events: string[] }> {
    const page = await this.db.execute<{ seq: number; txt: string | null; body: string | null }>(sql`
      select seq, txt,
             /* The envelope, and only where one is needed: a row that is not a
                chunk at all, or the first chunk of a run. A continuation ships
                its text alone. The case is out here, past the subquery, so the
                cast a replay used to pay for on every row is evaluated only for
                the few hundred that are actually sent. */
             case when sig is null or sig is distinct from lag(sig) over (order by seq)
                  then payload::text end as body
        from (
          select seq, payload,
                 case when ${SessionJournal.RUN_CHUNK} then ${SessionJournal.RUN_SIGNATURE} end as sig,
                 case when ${SessionJournal.RUN_CHUNK} then payload->'update'->'content'->>'text' end as txt
            from session_events
           where session_id = ${sessionId} and seq >= ${from}
           order by seq
           limit ${limit}
        ) chunks
       order by seq
    `);

    const events: string[] = [];
    let bytes = 0;
    /* The open run's head, still parsed, and the text it has collected. Held
       apart from `template` so a run that hits the size cap can be closed and
       reopened from the same envelope — its continuations carry no envelope of
       their own and would otherwise have nothing to be folded into. */
    let run: { head: JournaledEvent; texts: string[]; lastSeq: number; size: number } | null = null;
    let template: string | null = null;
    const close = () => {
      if (!run) return;
      /* The merged event stands at the seq of its LAST chunk, because the
         client advances its cursor to `seq + 1` and everything up to that seq
         is now in this event. Stamping the run's first seq would make a
         reconnect ask for chunks it already holds. */
      const head = run.head as JournaledEvent & { seq: number; update: { content: { text: string } } };
      head.seq = run.lastSeq;
      head.update.content.text = run.texts.join("");
      events.push(JSON.stringify(head));
      run = null;
    };
    for (const row of page.rows) {
      if (row.body !== null) bytes += row.body.length;
      if (row.txt !== null) bytes += row.txt.length;
      // Not a chunk: it ends whatever run was open and goes out as it is.
      if (row.txt === null) {
        close();
        template = null;
        if (row.body !== null) events.push(row.body);
        continue;
      }
      // A chunk carrying an envelope opens a run; one without continues the
      // open one, or reopens the template a size cut just closed.
      if (row.body !== null) {
        close();
        template = row.body;
      }
      if (!run) {
        if (template === null) continue; // unreachable: a page's first row always ships a body
        run = { head: JSON.parse(template) as JournaledEvent, texts: [], lastSeq: row.seq, size: 0 };
      }
      run.texts.push(row.txt);
      run.lastSeq = row.seq;
      run.size += row.txt.length;
      /* A run is still bounded. A turn that thinks for an hour is one item on
         screen either way, but it must not become one string this process
         holds whole, and a frame is cut on this budget anyway. */
      if (run.size >= REPLAY_CHUNK_BYTES) close();
    }
    close();
    return { rows: page.rows.length, bytes, events };
  }

  /**
   * The replay, as frames ready to put on a socket.
   *
   * Three things are deliberate here. Runs of streamed chunks are **merged**
   * into the event they draw (`coalescedPage`) — the transcript is the same and
   * the wire is two orders of magnitude smaller. Everything else comes back as
   * **text**, not as parsed objects: the payload column already holds exactly
   * the JSON the browser needs, so parsing it to re-serialize it once per peer
   * is work with no reader. And the scan is **paged**, so a long thread's
   * replay is bounded by a page rather than by the thread — `.all()` over the
   * whole range put the entire transcript in memory at attach time, which is
   * the cost the table was introduced to remove, merely moved from
   * steady-state to connect-time.
   *
   * A frame is cut on whichever budget runs out first, count or bytes. Bytes is
   * the one that matters for a thread full of terminal output or large diffs;
   * count is what keeps a chatty-but-small thread from being one frame.
   */
  async *replayFrames(
    sessionId: string,
    from: number,
    batch: boolean,
    to?: number,
  ): AsyncGenerator<string> {
    await this.flush();
    let cursor = from;
    let frame: string[] = [];
    let bytes = 0;
    /* How many rows to ask Postgres for at a time. It starts at the frame's own
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
      /* Rows in, events out — a page of chunk deltas comes back as the handful
         of events it draws, and everything else comes back as the text it is
         stored as (`coalescedPage`). `rows` is what the cursor moves by, and it
         is still the row count rather than the event count: seq is a position
         in the log, and merging is something this read does to what it sends,
         never to what the log holds. */
      const page = await this.coalescedPage(sessionId, cursor, limit);
      if (page.rows === 0) break;
      cursor += page.rows;
      pageSize = Math.max(
        8,
        Math.min(REPLAY_CHUNK_SIZE, Math.ceil((2 * REPLAY_CHUNK_BYTES) / Math.max(1, page.bytes / page.rows))),
      );
      for (const event of page.events) {
        // A client that did not ask for bulk gets the events one at a time; it
        // would drop a `replay` frame it does not know, and `caught_up` rides
        // inside that frame, so the thread would never finish connecting.
        if (!batch) {
          yield event;
          continue;
        }
        if (frame.length >= REPLAY_CHUNK_SIZE || bytes + event.length > REPLAY_CHUNK_BYTES) {
          yield* cut();
        }
        frame.push(event);
        bytes += event.length;
      }
      // Short page: the range is exhausted. Compared against the limit that was
      // actually used, not the constant — the page size moves now.
      if (page.rows < limit) break;
    }
    yield* cut();
  }

  /* ---- step-paging ---- */

  /** A **step** is a turn, and a turn begins at its journaled `turn_started` —
      the one structural event the server interprets without parsing an update
      payload. `from`/`before` are therefore always the seq of a `turn_started`,
      so a replay or a page is whole turns, never a cut inside one. */

  /** The `turn_started` seqs strictly before `before`, newest first, capped at
      `limit`. `before` omitted means the newest ones, unbounded — and that is
      why it is an omission rather than a sentinel: `seq` is a 32-bit column,
      so a `MAX_SAFE_INTEGER` upper bound is out of range for the type and the
      query is rejected before it can match anything. */
  private async turnStartsBefore(
    sessionId: string,
    before: number | undefined,
    limit: number,
  ): Promise<number[]> {
    await this.flush();
    const rows = await this.db
      .select({ seq: eventsTable.seq })
      .from(eventsTable)
      .where(and(
        eq(eventsTable.sessionId, sessionId),
        eq(eventsTable.kind, "turn_started"),
        ...(before === undefined ? [] : [lt(eventsTable.seq, before)]),
      ))
      .orderBy(desc(eventsTable.seq))
      .limit(limit);
    return rows.map((row) => row.seq);
  }

  /** How many turns the log holds. */
  async turnCount(sessionId: string): Promise<number> {
    await this.flush();
    const [row] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(eventsTable)
      .where(and(eq(eventsTable.sessionId, sessionId), eq(eventsTable.kind, "turn_started")));
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
  async turnTicks(sessionId: string): Promise<TurnTick[]> {
    await this.flush();
    const rows = await this.db
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
             and it is decided inside Postgres, over bytes, instead of in V8 over
             objects: on this install's largest thread it is 1.2k rows in place
             of 97k, and ~50ms in place of ~300ms of the attach. Everything the
             loop refuses — a subagent's chunks, a non-text content block — it
             still refuses, because the filter only ever removes rows the loop
             was going to remove too. */
          or(
            eq(eventsTable.kind, "turn_started"),
            and(
              eq(eventsTable.kind, "update"),
              sql`${eventsTable.payload}::text like '%agent_message_chunk%'`,
            ),
          ),
        ),
      )
      .orderBy(asc(eventsTable.seq));
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
   * The `turnId` is inside the payload, not a column, so the lookups reach it
   * with `->>` — turn boundaries are the one place a value other than
   * `seq`/`kind` has to be queried, and the table has no index worth adding an
   * expression index for at a rate of one rewind per click.
   */
  async rewindPoint(
    sessionId: string,
    turnId: string,
  ): Promise<{ turnSeq: number; before: { messageId: string | null } | null } | null> {
    await this.flush();
    const [started] = await this.db
      .select({ seq: eventsTable.seq })
      .from(eventsTable)
      .where(
        and(
          eq(eventsTable.sessionId, sessionId),
          eq(eventsTable.kind, "turn_started"),
          sql`${eventsTable.payload}->>'turnId' = ${turnId}`,
        ),
      );
    const turnSeq = started?.seq;
    if (turnSeq === undefined) return null;
    const [prev] = await this.db
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
      .limit(1);
    if (!prev) return { turnSeq, before: null };
    const prevTurnId = (prev.payload as { turnId?: string } | null)?.turnId;
    if (!prevTurnId) return { turnSeq, before: { messageId: null } };
    const [ended] = await this.db
      .select({ payload: eventsTable.payload })
      .from(eventsTable)
      .where(
        and(
          eq(eventsTable.sessionId, sessionId),
          eq(eventsTable.kind, "turn_ended"),
          sql`${eventsTable.payload}->>'turnId' = ${prevTurnId}`,
        ),
      );
    const lastMessageId = (ended?.payload as { lastMessageId?: string } | null)?.lastMessageId;
    return { turnSeq, before: { messageId: lastMessageId ?? null } };
  }

  /* ---- fork ---- */

  /**
   * What a fork AT `turnId` needs: the ACP messageId that turn's own
   * `turn_ended` recorded, or null when it recorded none.
   *
   * The mirror image of `rewindPoint`, and the difference is the whole point:
   * a rewind *discards* `turnId`, so it cuts at the messageId of the turn
   * *before* it; a fork *keeps* `turnId` — the branch carries turns 1..N
   * inclusive — so it cuts at the turn's own last id. Both fork-point dialects
   * cut inclusive of the id they are given, which is what makes the same
   * extension serve both.
   *
   * A null messageId is a real answer — the turn predates the field, or ended
   * without ever producing an assistant chunk — and the caller refuses on it
   * rather than forking at nothing. Null on the whole call: no such turn.
   */
  async forkPoint(
    sessionId: string,
    turnId: string,
  ): Promise<{ turnSeq: number; messageId: string | null } | null> {
    await this.flush();
    const [started] = await this.db
      .select({ seq: eventsTable.seq })
      .from(eventsTable)
      .where(
        and(
          eq(eventsTable.sessionId, sessionId),
          eq(eventsTable.kind, "turn_started"),
          sql`${eventsTable.payload}->>'turnId' = ${turnId}`,
        ),
      );
    const turnSeq = started?.seq;
    if (turnSeq === undefined) return null;
    const [ended] = await this.db
      .select({ payload: eventsTable.payload })
      .from(eventsTable)
      .where(
        and(
          eq(eventsTable.sessionId, sessionId),
          eq(eventsTable.kind, "turn_ended"),
          sql`${eventsTable.payload}->>'turnId' = ${turnId}`,
        ),
      );
    const lastMessageId = (ended?.payload as { lastMessageId?: string } | null)?.lastMessageId;
    return { turnSeq, messageId: lastMessageId ?? null };
  }

  /** How many turns lie before `before` — every one of them when it is
      omitted. The omission is the "all" spelling and not a sentinel, for the
      reason `turnStartsBefore` gives: `seq` is a 32-bit column, so a
      `MAX_SAFE_INTEGER` upper bound is out of range for the type and the query
      is rejected before it can count anything. */
  async countTurnsBefore(sessionId: string, before?: number): Promise<number> {
    await this.flush();
    const [row] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(eventsTable)
      .where(and(
        eq(eventsTable.sessionId, sessionId),
        eq(eventsTable.kind, "turn_started"),
        ...(before === undefined ? [] : [lt(eventsTable.seq, before)]),
      ));
    return Number(row?.count ?? 0);
  }

  /** The seq of the `index`-th `turn_started` (0-based, oldest first), or null
      when the log has fewer than `index + 1` turns. */
  async turnStartAt(sessionId: string, index: number): Promise<number | null> {
    await this.flush();
    const [row] = await this.db
      .select({ seq: eventsTable.seq })
      .from(eventsTable)
      .where(and(eq(eventsTable.sessionId, sessionId), eq(eventsTable.kind, "turn_started")))
      .orderBy(asc(eventsTable.seq))
      .offset(index)
      .limit(1);
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
   * step window would have sent anyway, and it reads `seq`/`kind`/the payload's
   * *size* rather than the payloads themselves — the size of the replay is measured
   * without materializing it. The window function accumulates each row's tail
   * (descending order, default frame), and the answer is the *oldest*
   * `turn_started` whose tail still fits.
   *
   * The floor is a whole turn even when that turn alone busts the budget: the
   * cut is only ever made at a `turn_started` (a transcript that begins mid-turn
   * re-folds into a half turn the reducer never saw opened), so one enormous
   * turn is sent whole and the budget is missed rather than the rule broken.
   */
  async windowStart(sessionId: string, steps: number, maxBytes: number): Promise<number> {
    if (steps <= 0) return 0;
    await this.flush();
    const skip = (await this.turnCount(sessionId)) - steps;
    const stepFloor = skip > 0 ? (await this.turnStartAt(sessionId, skip)) ?? 0 : 0;
    /* The bytes the replay will actually put on the socket, which since
       `coalescedPage` is no longer the bytes the row holds: a run of chunk
       deltas is sent as its text with one envelope in front of the whole run,
       so counting each delta's envelope here measured a cost nothing pays and
       withheld turns that would have fitted many times over. Everything else is
       still `octet_length(payload::text)` — it is sent verbatim. The derived
       table is named because Postgres requires it to be. */
    const result = await this.db.execute<{ seq: number }>(sql`
        select seq from (
          select seq, kind,
                 sum(case when ${SessionJournal.RUN_CHUNK}
                          then coalesce(octet_length(payload->'update'->'content'->>'text'), 0)
                          else octet_length(payload::text) end)
                   over (order by seq desc) as tail
            from session_events
           where session_id = ${sessionId} and seq >= ${stepFloor}
        ) tails
        where kind = 'turn_started' and tail <= ${maxBytes}
        order by seq asc
        limit 1
      `);
    const row = result.rows.at(0);
    /* Not one whole turn fits: send the newest on its own. A window of no turns
       at all would be a blank transcript for a thread that has one, and there
       is nothing below the floor to fall back to. */
    const cut = row
      ? Math.max(stepFloor, row.seq)
      : (await this.turnStartsBefore(sessionId, undefined, 1)).at(0) ?? stepFloor;
    /* The cut is made only when a turn is genuinely being withheld. Jumping to
       the first turn of the window unconditionally looks equivalent and is not:
       a log need not begin with a `turn_started`, because a revive clears it and
       refills it from the `session/load` replay — the whole prior conversation,
       with no turn boundaries in it. Starting at the oldest turn there would
       drop everything the load put back while `earlier` said 0 (no whole turns
       lie behind it), so nothing would offer it back either. Same rule as
       `earlierPage`: the window that reaches the oldest turn takes the head
       along, which is the only way that head is ever read. */
    if ((await this.countTurnsBefore(sessionId, cut)) === 0) return 0;
    /* The cut is a `turn_started`, and everything between the previous turn's
       end and it belongs to no turn at all — a `!` command, a config notice.
       Starting the window *at* the turn would strand those rows above it: the
       reader made them, nothing the window counts owns them, and the only way
       back would be to page a whole turn down. The gap is bounded by the two
       turns around it (a turn's own updates all live between its `turn_started`
       and its `turn_ended`), so it is taken whole. */
    const prevEnd = await this.turnEndBefore(sessionId, cut);
    const gapStart = prevEnd === null ? cut : Math.max(prevEnd + 1, 1);
    /* A `!` command is the one row the reader put in the transcript themselves,
       and it belongs to no turn — so a window cut on a turn boundary would drop
       it for good, where a message inside a turn the window refuses is merely
       older and `earlierPage` offers it back. It is never withheld: the window
       opens at the thread's oldest one, whatever that costs. The cost is real,
       but it is bounded by the thread's own size and most of it never reaches
       the wire — a run of streamed chunks goes as the one event it draws (see
       `coalescedPage`). The range has to stay contiguous, so the events between
       that command and the cut come along; they are the thread's own history,
       which is what a replay is for. */
    const firstShell = await this.firstShell(sessionId);
    return firstShell === null ? gapStart : Math.min(gapStart, firstShell);
  }

  /** The seq of the `turn_ended` immediately before `before`, or null when no
      turn has ended above it — the wall between the gap and the turn before. */
  private async turnEndBefore(sessionId: string, before: number): Promise<number | null> {
    await this.flush();
    const [row] = await this.db
      .select({ seq: eventsTable.seq })
      .from(eventsTable)
      .where(
        and(
          eq(eventsTable.sessionId, sessionId),
          eq(eventsTable.kind, "turn_ended"),
          lt(eventsTable.seq, before),
        ),
      )
      .orderBy(desc(eventsTable.seq))
      .limit(1);
    return row?.seq ?? null;
  }

  /** The seq of a thread's oldest `!` command, or null when it has none — the
      one row a window may never cut away. */
  private async firstShell(sessionId: string): Promise<number | null> {
    await this.flush();
    const [row] = await this.db
      .select({ seq: eventsTable.seq })
      .from(eventsTable)
      .where(
        and(
          eq(eventsTable.sessionId, sessionId),
          eq(eventsTable.kind, "update"),
          sql`${eventsTable.payload}->'update'->>'sessionUpdate' = '_daedalus/shell'`,
        ),
      )
      .orderBy(asc(eventsTable.seq))
      .limit(1);
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
  async earlierPage(sessionId: string, before: number): Promise<EarlierPage> {
    if (before <= 0) return { events: [], from: 0, earlier: 0 };
    const starts = (await this.turnStartsBefore(sessionId, before, EARLIER_PAGE_STEPS)).reverse();
    const earlier = starts.length === 0 ? 0 : await this.countTurnsBefore(sessionId, starts[0]);
    // No turns left behind this page: whatever precedes it is that head, and
    // it belongs to the oldest turn shown rather than being stranded below it.
    const first = starts.length === 0 || earlier === 0 ? 0 : starts[0];
    if (first >= before) return { events: [], from: before, earlier: 0 };
    /* Through the replay's own reader, unbatched — a page of history is the
       same events a replay of that range would send, chunk runs merged and all,
       and the button that asks for it is paging back through turns of exactly
       the kind windowing withheld. Parsed here because `EarlierPage` is a JSON
       body rather than a stream of pre-serialized frames; after the merge that
       is a few hundred objects rather than the tens of thousands
       `eventsFrom` used to hand back. */
    const events: JournaledEvent[] = [];
    for await (const line of this.replayFrames(sessionId, first, false, before)) {
      events.push(JSON.parse(line) as JournaledEvent);
    }
    return { events, from: first, earlier };
  }

  /** Wipe one session's log — its buffered rows included — and zero its
      counter. The revive path (`respawnNow`) is the caller that matters. */
  async clear(session: JournalOwner): Promise<void> {
    /* Drop this session's buffered rows rather than writing them: they belong
       to the log being thrown away, and landing them after the delete would
       leave orphans that the next append then collides with on seq. */
    this.pendingWrites = this.pendingWrites.filter((row) => row.sessionId !== session.id);
    await this.db.delete(eventsTable).where(eq(eventsTable.sessionId, session.id));
    /* The counter is the correctness half and the index is a cache, so the
       cache is never allowed to cost the counter: a failed delete here used to
       skip the reset below, and the conversation the respawn then reloaded was
       journaled from the old high-water mark — a transcript every client is
       told to attach to from 0, starting at seq 56 with nothing before it. */
    session.eventCount = 0;
    await deleteSearchIndex([session.id]).catch((error) =>
      console.warn(`[${session.id.slice(0, 8)}] couldn't drop the search index of a cleared log`, error),
    );
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
  private async perSessionMax(agg: SQL): Promise<Map<string, number>> {
    const rows = await this.db.execute<{ id: string; value: number | null }>(sql`
      select s.id as "id",
             (select ${agg} from session_events e where e.session_id = s.id) as "value"
        from sessions s
    `);
    const out = new Map<string, number>();
    for (const row of rows.rows) if (row.value !== null) out.set(row.id, Number(row.value));
    return out;
  }

  /** Where each session's log left off — `max(seq) + 1` per session, which is
      what `eventCount` restarts from on reload. Restoring it is not
      bookkeeping: `append` stamps from it and the (session_id, seq) index is
      unique, so a count that restarted at 0 would collide on the first event
      of the revive. */
  async nextSeqBySession(): Promise<Map<string, number>> {
    await this.flush();
    return this.perSessionMax(sql`max(seq) + 1`);
  }

  /** When each session's log was last written — `max(at)` per session. What
      backfills `Session.lastActivityAt` for a thread whose row predates that
      column, so ordering by activity is right for threads that existed before
      anything recorded it. One query at boot, not per thread — see
      `perSessionMax` for why it is not a GROUP BY. */
  async lastActivityBySession(): Promise<Map<string, number>> {
    await this.flush();
    return this.perSessionMax(sql`max(at)`);
  }

  /**
   * Drop whole logs whose newest event predates `cutoff`, skipping the ids in
   * `liveIds` (a running thread's log is what its peers are attached to).
   * Returns the session ids whose archives were dropped, so the manager can
   * zero their counters.
   */
  async prune(cutoff: number, liveIds: string[]): Promise<string[]> {
    await this.flush();
    const rows = await this.db
      .select({ sessionId: eventsTable.sessionId, newest: sql<number>`max(${eventsTable.at})` })
      .from(eventsTable)
      .groupBy(eventsTable.sessionId)
      .having(sql`max(${eventsTable.at}) < ${cutoff}`);
    const stale = rows
      .map((row) => row.sessionId)
      .filter((id) => !liveIds.includes(id));
    if (stale.length > 0) {
      await this.db.delete(eventsTable).where(inArray(eventsTable.sessionId, stale));
      await deleteSearchIndex(stale);
      console.log(`[journal] dropped ${stale.length} retired thread archive(s)`);
    }
    return stale;
  }
}
