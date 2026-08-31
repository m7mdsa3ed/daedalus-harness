import { sql } from "drizzle-orm";
import { db } from "./db/index.js";

/*
 * Full-text search across thread transcripts.
 *
 * The index (`session_events_fts`, created at boot by `db/index.ts` — a
 * virtual table, which drizzle-kit can neither model nor push) holds the
 * *user-and-agent-visible prose* of the journal, never the raw JSON: what the
 * user typed, what the agent answered and thought, and a tool call's title.
 * Tool rawInput/rawOutput stay out — a terminal dump or a diff would drown
 * every real match in noise and triple the index for text nobody searches by.
 *
 * Writes ride the same transaction cadence as the journal itself:
 * session-journal.ts calls `indexEventRow` from its buffered flush, so a
 * streaming turn costs one FTS insert per *prose* event inside the commit that
 * was happening anyway. Deletes are by session (`deleteSearchIndex`) from the
 * same three places the journal is cleared: a revive's `SessionJournal.clear`,
 * the retention sweep, and purge.
 */

/** Snippet markers — private-use codepoints that cannot appear in real prose,
    so the client can split on them without ever trusting markup. The client's
    copies live in client/src/lib/search.ts (protocol.ts must stay type-only
    importable, and these are runtime values). */
export const SNIPPET_START = "\u{E000}";
export const SNIPPET_END = "\u{E001}";

/** How many hits one thread may contribute — without a cap, one chatty thread
    that says the word fifty times is the entire first page. */
const PER_SESSION_CAP = 3;

export const SEARCH_LIMIT = 50;

interface EventRow {
  sessionId: string;
  seq: number;
  kind: string;
  payload: unknown;
  /** Optional to match the journal's insert type (the column defaults to 0);
      appendEvent always stamps it in practice. */
  at?: number;
}

/**
 * The searchable text of one journaled event, or null when it has none.
 *
 * `payload` is the journaled event object (`{ev, seq, ...}` — see protocol.ts).
 * Prose only: user/agent message chunks, thought chunks, the prompt a turn
 * started with, and a tool call's title. Everything else — tool inputs and
 * outputs, config, plans, terminal bytes — is deliberately not indexed.
 */
export function extractSearchText(kind: string, payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const event = payload as Record<string, unknown>;
  if (kind === "turn_started") {
    return asText(event.text);
  }
  if (kind !== "update") return null;
  const update = event.update as Record<string, unknown> | undefined;
  if (!update || typeof update !== "object") return null;
  switch (update.sessionUpdate) {
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const content = update.content as Record<string, unknown> | undefined;
      if (!content || typeof content !== "object" || content.type !== "text") return null;
      return asText(content.text);
    }
    // The title only ("Search the web for …"), never rawInput/rawOutput.
    case "tool_call":
      return asText(update.title);
    default:
      return null;
  }
}

const asText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/** The least a caller must be able to do — both `db` and a drizzle transaction
    qualify, which is what lets the journal flush index inside its own commit. */
interface SqlRunner {
  run(query: ReturnType<typeof sql>): unknown;
}

/** Index one journaled event. A no-op for events with no prose; returns
    whether a row was written. */
export function indexEventRow(runner: SqlRunner, row: EventRow): boolean {
  /* A workflow step's events are mirrored onto its parent's log carrying the
     step's `sessionId` (workflows.ts); they are indexed once, under the step's
     own thread, or every search hit in a step would come back twice. */
  if (row.kind === "update" && (row.payload as { sessionId?: unknown }).sessionId) return false;
  const text = extractSearchText(row.kind, row.payload);
  if (!text) return false;
  runner.run(
    sql`insert into session_events_fts (text, session_id, seq, at)
        values (${text}, ${row.sessionId}, ${row.seq}, ${row.at ?? 0})`,
  );
  return true;
}

/** Drop every indexed row of the given sessions — the mirror of the three
    places session_events rows are deleted (there is no FK to cascade for a
    virtual table). */
export function deleteSearchIndex(sessionIds: string[]): void {
  for (const id of sessionIds) {
    db.run(sql`delete from session_events_fts where session_id = ${id}`);
  }
}

/**
 * User input → an FTS5 MATCH expression that cannot 500.
 *
 * FTS5 gives `"foo AND`, `NEAR(`, `col:x` and a lone `*` syntax meaning (or a
 * syntax error). Every whitespace-separated term is therefore wrapped as a
 * quoted phrase with inner quotes doubled, and the final term gets `*` so the
 * word still being typed matches as a prefix. Null when nothing is left.
 */
export function ftsQuery(raw: string): string | null {
  const terms = raw
    .split(/\s+/)
    .map((term) => term.replace(/"/g, '""'))
    // A term that was only quotes/whitespace contributes nothing.
    .filter((term) => term.replace(/"/g, "").length > 0);
  if (terms.length === 0) return null;
  return terms.map((term, i) => (i === terms.length - 1 ? `"${term}"*` : `"${term}"`)).join(" ");
}

export interface SearchResult {
  sessionId: string;
  seq: number;
  /** Prose with matches bracketed by SNIPPET_START/SNIPPET_END. */
  snippet: string;
  title: string;
  projectId: string;
  projectName: string;
  at: number;
}

/**
 * Search every live (non-trashed) thread's transcript, newest hits first.
 * Title and project are resolved here — the client's session list may not hold
 * a thread whose journal still does.
 */
export function searchEvents(raw: string, limit = SEARCH_LIMIT): SearchResult[] {
  const match = ftsQuery(raw);
  if (!match) return [];
  const capped = Math.max(1, Math.min(limit, SEARCH_LIMIT));
  const rows = db.all<{
    sessionId: string;
    seq: number;
    snippet: string;
    at: number;
    title: string;
    projectId: string;
    projectName: string | null;
  }>(sql`
    with hits as materialized (
      -- MATERIALIZED, and no window function in here: snippet() only runs
      -- inside the full-text query itself — flattened into a join, or mixed
      -- with row_number() in the same SELECT, SQLite refuses ("unable to use
      -- function snippet in the requested context").
      select session_id as sessionId, seq, at,
             snippet(session_events_fts, 0, ${SNIPPET_START}, ${SNIPPET_END}, '…', 12) as snippet
      from session_events_fts
      where session_events_fts match ${match}
    ),
    ranked as (
      select hits.*,
             row_number() over (partition by sessionId order by at desc, seq desc) as rn
      from hits
    )
    select f.sessionId as sessionId, f.seq as seq, f.snippet as snippet, f.at as at,
           s.title as title, s.project_id as projectId, p.name as projectName
    from ranked f
    join sessions s on s.id = f.sessionId and s.deleted_at is null
    left join projects p on p.id = s.project_id
    where f.rn <= ${PER_SESSION_CAP}
    order by f.at desc, f.seq desc
    limit ${capped}
  `);
  return rows.map((row) => ({ ...row, projectName: row.projectName ?? "" }));
}

/**
 * Index everything journaled before the index existed. Runs at boot, before
 * the server listens (so nothing streams while it walks), and once: progress
 * is a rowid cursor in `search_meta`, advanced per page inside each page's
 * transaction, with a terminal "done" marker — so a crash mid-backfill resumes
 * where it stopped instead of double-indexing, and a finished install pays one
 * SELECT per boot.
 */
export function backfillSearchIndex(): void {
  const state = db.get<{ value: string } | undefined>(
    sql`select value from search_meta where key = 'fts_backfill'`,
  );
  if (state?.value === "done") return;
  let cursor = state ? Number(state.value) || 0 : 0;
  const PAGE = 2000;
  let indexed = 0;
  for (;;) {
    const page = db.all<{ rowid: number; sessionId: string; seq: number; kind: string; payload: string; at: number }>(sql`
      select rowid, session_id as sessionId, seq, kind, payload, at
      from session_events
      where rowid > ${cursor}
      order by rowid
      limit ${PAGE}
    `);
    if (page.length === 0) break;
    cursor = page[page.length - 1].rowid;
    db.transaction((tx) => {
      for (const row of page) {
        let payload: unknown;
        try {
          payload = JSON.parse(row.payload);
        } catch {
          continue; // an unreadable payload has no searchable prose
        }
        if (indexEventRow(tx, { ...row, payload })) indexed += 1;
      }
      tx.run(sql`
        insert into search_meta (key, value) values ('fts_backfill', ${String(cursor)})
        on conflict(key) do update set value = excluded.value
      `);
    });
    if (page.length < PAGE) break;
  }
  db.run(sql`
    insert into search_meta (key, value) values ('fts_backfill', 'done')
    on conflict(key) do update set value = 'done'
  `);
  if (indexed > 0) console.log(`[search] backfilled ${indexed} journaled event(s) into the index`);
}
