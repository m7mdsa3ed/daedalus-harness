/* ── The recap behind `@thread:<id>` ──
 *
 * What the agent reads for another thread: a short brief built from the
 * thread's JOURNAL (`session_events`) and its row, never from a live bridge —
 * the thread may be idle, retired or its process long gone, and the journal is
 * what the transcript the user sees was drawn from.
 *
 * Two shapes. `<id>` is the whole-thread recap (title, project, agent, times,
 * first and last message, the last answer, the files its turns changed);
 * `<id>#turn-N` (1-based) is that one turn's message and answer. Either is
 * capped (`RECAP_CAP`); a cut recap ends in a hint, and an uncut one carries
 * none.
 *
 * `buildRecap` is pure so it can be tested without a database; `loadThread`
 * is the only part that reads one.
 */
import { and, asc, eq, isNull, like, or, sql } from "drizzle-orm";
import { db, projects as projectsTable, sessionEvents, sessions as sessionsTable, sessionTurnChanges } from "../db/index.js";
import type { ChangedFile } from "../db/schema.js";

/** Characters one thread's recap may run to. */
export const RECAP_CAP = 6_000;
/** Per-section caps of the whole-thread recap; the last answer takes the rest. */
const FIRST_CAP = 900;
const LAST_CAP = 1_200;
const FILES_SHOWN = 15;
/** The cut-off hint, said only on a recap that was actually cut. */
export const TRUNCATED_HINT =
  "… (truncated — the full conversation is not available to you via the journal; ask the user if more is needed)";

export interface RecapTurn {
  turnId: string;
  /** What the user sent, without the `<context>`/`<tasks>` blocks the composer appended. */
  user: string;
  /** The thread's own answer (a subagent's chunks are not part of it). */
  answer: string;
}

export interface RecapThread {
  id: string;
  title: string;
  projectName: string;
  agentId: string;
  model: string;
  createdAt: number;
  lastActivityAt: number;
  turns: RecapTurn[];
  /** Changed files per turn id, from `session_turn_changes`. */
  files: Map<string, ChangedFile[]>;
}

/** `abc#turn-3` → `{id:"abc", turn:3}`; a malformed suffix is `turn: NaN`
    so the whole ref resolves to nothing instead of silently meaning the thread. */
export function parseThreadRef(ref: string): { id: string; turn?: number } {
  const at = ref.indexOf("#");
  if (at < 0) return { id: ref };
  const match = /^turn-(\d+)$/.exec(ref.slice(at + 1));
  return { id: ref.slice(0, at), turn: match ? Number(match[1]) : Number.NaN };
}

/** The blocks the composer appends to a sent message are the *agent's* reading
    of other things, not what the user said — and a nested thread's recap would
    otherwise compound. */
export function stripAppended(text: string): string {
  let out = text.trimEnd();
  for (;;) {
    const next = out.replace(/\n*<(context|tasks)>[\s\S]*<\/\1>$/, "").trimEnd();
    if (next === out) return out;
    out = next;
  }
}

/** `text` cut to `max` characters; the second element says whether it was. */
function clip(text: string, max: number): [string, boolean] {
  const body = text.trim();
  if (body.length <= max) return [body, false];
  return [`${body.slice(0, Math.max(max - 1, 0)).trimEnd()}…`, true];
}

const when = (at: number) => new Date(at).toISOString().replace(/:\d\d\.\d+Z$/, "Z");

function filesLine(files: ChangedFile[]): string {
  const shown = files.slice(0, FILES_SHOWN).map((f) => `${f.path} (+${f.additions} -${f.deletions})`);
  const more = files.length > FILES_SHOWN ? `, and ${files.length - FILES_SHOWN} more` : "";
  return `${shown.join(", ")}${more}`;
}

/** Distinct files over the given turns, the last status of each winning. */
function changedFiles(turns: RecapTurn[], files: Map<string, ChangedFile[]>): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  for (const turn of turns) for (const file of files.get(turn.turnId) ?? []) byPath.set(file.path, file);
  return [...byPath.values()];
}

/** The recap text, or null when the ref names a turn the thread does not have. */
export function buildRecap(thread: RecapThread, turn?: number, cap = RECAP_CAP): string | null {
  const total = thread.turns.length;
  let truncated = false;
  const part = (text: string, max: number) => {
    const [out, cut] = clip(text, max);
    truncated ||= cut;
    return out;
  };

  const header = [`Thread: ${thread.title || "Untitled"}`, `Project: ${thread.projectName}`];
  const lines: string[] = [];

  if (turn !== undefined) {
    const picked = Number.isInteger(turn) ? thread.turns[turn - 1] : undefined;
    if (!picked) return null;
    lines.push(...header, `Turn: ${turn} of ${total}`, "");
    const user = part(picked.user, Math.floor(cap / 3));
    lines.push("User message:", user || "(empty)", "");
    const files = changedFiles([picked], thread.files);
    const tail = files.length > 0 ? `\n\nFiles changed: ${filesLine(files)}` : "";
    // Cap the whole text: the answer gets what the header, message and files leave.
    const used = lines.join("\n").length + tail.length + TRUNCATED_HINT.length;
    lines.push("Assistant answer:", part(picked.answer, Math.max(cap - used, 200)) || "(no answer)");
    return finish(lines.join("\n") + tail, truncated, cap);
  }

  lines.push(
    ...header,
    `Agent: ${thread.agentId}${thread.model ? ` · ${thread.model}` : ""}`,
    `Created: ${when(thread.createdAt)}`,
    `Last activity: ${when(thread.lastActivityAt)}`,
    `Turns: ${total}`,
  );
  const files = changedFiles(thread.turns, thread.files);
  if (files.length > 0) lines.push(`Files changed: ${part(filesLine(files), 700)}`);
  if (total === 0) {
    lines.push("", "(no messages yet)");
    return finish(lines.join("\n"), truncated, cap);
  }
  const first = thread.turns[0]!;
  const last = thread.turns[total - 1]!;
  if (total === 1) {
    lines.push("", "User message:", part(first.user, LAST_CAP) || "(empty)");
  } else {
    lines.push("", "First user message:", part(first.user, FIRST_CAP) || "(empty)");
    lines.push("", "Last user message:", part(last.user, LAST_CAP) || "(empty)");
  }
  const used = lines.join("\n").length + TRUNCATED_HINT.length + 40;
  const answer = last.answer.trim();
  lines.push("", "Last assistant answer:", answer ? part(answer, Math.max(cap - used, 200)) : "(no answer)");
  return finish(lines.join("\n"), truncated, cap);
}

function finish(text: string, truncated: boolean, cap: number): string {
  if (!truncated) return text;
  return `${text.slice(0, Math.max(cap - TRUNCATED_HINT.length - 1, 0)).trimEnd()}\n${TRUNCATED_HINT}`;
}

/** The thread behind a ref's id: exact, else a unique prefix (a short id is
    what a person copies). Null for unknown or deleted. */
export async function findThreadId(id: string): Promise<string | null> {
  if (!id) return null;
  const exact = await db
    .select({ id: sessionsTable.id })
    .from(sessionsTable)
    .where(and(eq(sessionsTable.id, id), isNull(sessionsTable.deletedAt)))
    .limit(1);
  if (exact[0]) return exact[0].id;
  if (id.length < 6 || /[%_\\]/.test(id)) return null;
  const rows = await db
    .select({ id: sessionsTable.id })
    .from(sessionsTable)
    .where(and(like(sessionsTable.id, `${id}%`), isNull(sessionsTable.deletedAt)))
    .limit(2);
  return rows.length === 1 ? rows[0]!.id : null;
}

/** Read one thread from its row and its journal. Null when it is gone. */
export async function loadThread(id: string): Promise<RecapThread | null> {
  const row = (await db.select().from(sessionsTable).where(eq(sessionsTable.id, id)).limit(1))[0];
  if (!row || row.deletedAt) return null;
  const project = (await db.select({ name: projectsTable.name }).from(projectsTable).where(eq(projectsTable.id, row.projectId)).limit(1))[0];

  /* Only the rows a recap is made of: turn starts and message chunks. A thread
     is mostly tool calls, diffs and terminal pages; the `like` is decided in
     Postgres over bytes, the way `SessionJournal.turnTicks` does it, so those
     never reach this process. Everything it lets through the loop re-checks. */
  const events = await db
    .select({ payload: sessionEvents.payload })
    .from(sessionEvents)
    .where(
      and(
        eq(sessionEvents.sessionId, id),
        or(
          eq(sessionEvents.kind, "turn_started"),
          and(
            eq(sessionEvents.kind, "update"),
            sql`(${sessionEvents.payload}::text like '%agent_message_chunk%' or ${sessionEvents.payload}::text like '%user_message_chunk%')`,
          ),
        ),
      ),
    )
    .orderBy(asc(sessionEvents.seq));

  const turns: RecapTurn[] = [];
  let replayUser = false; // the last event was a replayed user chunk: the next continues it
  for (const { payload } of events) {
    const event = payload as {
      ev: string;
      turnId?: string;
      text?: string;
      sessionId?: string;
      historyReplay?: boolean;
      update?: { sessionUpdate?: string; content?: { type?: string; text?: string } };
    };
    if (event.ev === "turn_started") {
      turns.push({ turnId: event.turnId ?? `turn-${turns.length + 1}`, user: stripAppended(event.text ?? ""), answer: "" });
      replayUser = false;
      continue;
    }
    if (event.ev !== "update" || event.sessionId) continue; // a subagent's chunks are not this thread's
    const update = event.update;
    if (update?.content?.type !== "text") continue;
    const text = update.content.text ?? "";
    if (update.sessionUpdate === "user_message_chunk" && event.historyReplay) {
      // A thread refilled by `session/load` has no turn_started for its head: its user words are replayed chunks.
      if (replayUser && turns.length > 0) turns[turns.length - 1]!.user += text;
      else turns.push({ turnId: `replay-${turns.length + 1}`, user: text, answer: "" });
      replayUser = true;
    } else if (update.sessionUpdate === "agent_message_chunk") {
      replayUser = false;
      if (turns.length > 0) turns[turns.length - 1]!.answer += text;
    }
  }
  for (const turn of turns) turn.user = stripAppended(turn.user);

  const changes = await db
    .select({ turnId: sessionTurnChanges.turnId, files: sessionTurnChanges.files })
    .from(sessionTurnChanges)
    .where(eq(sessionTurnChanges.sessionId, id));

  return {
    id,
    title: row.title,
    projectName: project?.name ?? "(project removed)",
    agentId: row.agentId,
    model: row.model,
    createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt || row.createdAt,
    turns,
    files: new Map(changes.map((c) => [c.turnId, c.files])),
  };
}
