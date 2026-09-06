import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";

import { attachments as table, db } from "./db/index.js";
import { DATA_DIR } from "./config.js";
import { HttpError } from "./http-error.js";
import type { AttachmentRef } from "./protocol.js";

/**
 * The attachment store: rows here, bytes on disk, and nothing in between.
 *
 * The directory is flat because the alternative — one per session — would have
 * to be *moved* on claim: an attachment is owned by nobody at upload time,
 * since a draft thread has no session row for a route to be scoped to. See the
 * table's own comment in db/schema.ts for why `session_id` is not a foreign
 * key.
 *
 * A file is named by its **content hash**, not by the row's id, and the two
 * rules that decides between are both wanted: bytes are written once (the same
 * screenshot dropped into five threads costs one file), while rows stay one per
 * claim (a claim is a thread's, a file is content's — and a row carries exactly
 * one `session_id`). So the sweep deletes bytes only when no row still
 * references that hash.
 */
const DIR = join(DATA_DIR, "attachments");

/** Per file. The harness will not hold more than this — a real refusal (413). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Per prompt, and it is a *budget*, not a refusal.
 *
 * An ACP prompt is a single JSON-RPC frame written to the child's stdin, base64
 * is 4/3, and a 60MB line is a stall in a place with no backpressure story. But
 * a file that would overrun it degrades to a path (see `resolveDelivery`),
 * which costs the frame nothing — so the user is only ever refused for
 * something the harness genuinely cannot deliver.
 */
export const MAX_INLINE_PROMPT_BYTES = 20 * 1024 * 1024;

/** Per prompt. Past this it is not a message with attachments, it is a upload. */
export const MAX_ATTACHMENTS = 10;

/** Unclaimed uploads older than this are swept: an upload whose prompt was
    never sent is a draft the user abandoned. */
const UNCLAIMED_TTL_MS = 24 * 60 * 60 * 1000;

export interface AttachmentRow {
  id: string;
  sessionId: string | null;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  createdAt: number;
  claimedAt: number | null;
}

export const refOf = (row: AttachmentRow): AttachmentRef => ({
  id: row.id,
  name: row.name,
  mimeType: row.mimeType,
  size: row.size,
});

/** Where a row's bytes live. Content-addressed — see the note above. */
export const attachmentPath = (sha256: string): string => join(DIR, sha256);

function ensureDir(): void {
  mkdirSync(DIR, { recursive: true });
}

/** A filename is display text, never a path: it reaches disk only as part of a
    materialised name (attachment-blocks.ts), and it reaches the agent's prose. */
function safeName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[/\\]/g, "_").trim();
  return cleaned.slice(0, 200) || "file";
}

/**
 * Store bytes and answer the row.
 *
 * Idempotent on content: a client that hashes before uploading — or simply
 * retries — gets back the row it already has, and the bytes are written once.
 * The id is the client's, like a session id, so a retry after a failed response
 * is a no-op on the wire rather than a second file.
 */
export function putAttachment(opts: {
  id: string;
  name: string;
  mimeType: string;
  bytes: Buffer;
}): AttachmentRow {
  if (!/^[0-9a-f-]{36}$/i.test(opts.id)) throw new HttpError("an attachment id must be a UUID", 400);
  if (opts.bytes.length === 0) throw new HttpError("that file is empty", 400);
  if (opts.bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new HttpError(`that file is larger than ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB`, 413);
  }
  const sha256 = createHash("sha256").update(opts.bytes).digest("hex");

  /* Same id twice is the client retrying — after a response that never
     arrived, or after a failed upload the chip offered a retry for. It is a
     no-op rather than a second file. A *different* id carrying the same bytes
     is a new row over the file that is already here. */
  const existing = getAttachment(opts.id);
  if (existing && existing.sha256 === sha256) return existing;
  if (existing) throw new HttpError("that attachment id is already taken by another file", 409);

  ensureDir();
  const path = attachmentPath(sha256);
  if (!existsSync(path)) writeFileSync(path, opts.bytes);

  const row: AttachmentRow = {
    id: opts.id,
    sessionId: null,
    name: safeName(opts.name),
    mimeType: opts.mimeType || "application/octet-stream",
    size: opts.bytes.length,
    sha256,
    createdAt: Date.now(),
    claimedAt: null,
  };
  db.insert(table).values(row).run();
  return row;
}

export function getAttachment(id: string): AttachmentRow | undefined {
  return db.select().from(table).where(eq(table.id, id)).get();
}

export function listAttachments(ids: string[]): AttachmentRow[] {
  if (ids.length === 0) return [];
  const rows = db.select().from(table).where(inArray(table.id, ids)).all();
  const byId = new Map(rows.map((row) => [row.id, row]));
  // The caller's order is the order the user attached them in, which is the
  // order the prompt names them in.
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

/** The bytes, or undefined when the row outlived its file (a backup restore —
    attachment rows are deliberately excluded from a bundle, so a replayed
    transcript's chips resolve to a "missing" state rather than to an image). */
export function readAttachment(row: AttachmentRow): Buffer | undefined {
  try {
    return readFileSync(attachmentPath(row.sha256));
  } catch {
    return undefined;
  }
}

/**
 * Bind attachments to the thread that referenced them, and answer the refs a
 * prompt may actually carry.
 *
 * Unknown ids, and ids already claimed by *another* session, are **dropped
 * rather than rejected**: a stale draft id must not fail a send whose text is
 * fine. The drop is warned about, because a silent drop with no trace is the
 * failure mode this codebase's error convention exists to avoid.
 */
export function claimAttachments(ids: string[], sessionId: string): AttachmentRef[] {
  if (ids.length === 0) return [];
  const capped = ids.slice(0, MAX_ATTACHMENTS);
  if (capped.length < ids.length) {
    console.warn(`[attachments] ${sessionId}: dropped ${ids.length - capped.length} past the cap of ${MAX_ATTACHMENTS}`);
  }
  const rows = listAttachments(capped);
  const kept: AttachmentRow[] = [];
  const dropped: string[] = [];
  for (const id of capped) {
    const row = rows.find((entry) => entry.id === id);
    if (!row) {
      dropped.push(id);
      continue;
    }
    if (row.sessionId !== null && row.sessionId !== sessionId) {
      dropped.push(id);
      continue;
    }
    kept.push(row);
  }
  if (dropped.length > 0) {
    console.warn(`[attachments] ${sessionId}: dropped ${dropped.length} unknown or foreign id(s): ${dropped.join(", ")}`);
  }
  const now = Date.now();
  const unclaimed = kept.filter((row) => row.sessionId === null).map((row) => row.id);
  if (unclaimed.length > 0) {
    db.update(table)
      .set({ sessionId, claimedAt: now })
      .where(inArray(table.id, unclaimed))
      .run();
  }
  return kept.map(refOf);
}

/**
 * Delete rows and — only when nothing else still points at the same content —
 * the bytes underneath. A claim is a thread's, a file is content's.
 */
export function deleteAttachments(ids: string[]): void {
  if (ids.length === 0) return;
  const rows = listAttachments(ids);
  if (rows.length === 0) return;
  db.delete(table).where(inArray(table.id, rows.map((row) => row.id))).run();
  for (const row of rows) {
    const stillReferenced = db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.sha256, row.sha256), ne(table.id, row.id)))
      .get();
    if (stillReferenced) continue;
    try {
      rmSync(attachmentPath(row.sha256), { force: true });
    } catch {
      // A file already gone is the state we were asking for.
    }
  }
}

/** The ids every one of these threads has claimed — the keep-set for the
    materialised-file sweep (attachment-blocks.ts). */
export function claimedAttachmentIds(sessionIds: string[]): string[] {
  if (sessionIds.length === 0) return [];
  return db
    .select({ id: table.id })
    .from(table)
    .where(inArray(table.sessionId, sessionIds))
    .all()
    .map((row) => row.id);
}

/** Everything a thread claimed — what `purge` takes with the row. */
export function deleteSessionAttachments(sessionId: string): void {
  const rows = db.select({ id: table.id }).from(table).where(eq(table.sessionId, sessionId)).all();
  deleteAttachments(rows.map((row) => row.id));
}

/**
 * Unclaimed uploads past their day, and rows whose file is missing.
 *
 * Runs on the same idle timer the session sweep uses. A claimed row is kept for
 * as long as its thread is: the journaled `turn_started` refs are what make a
 * replayed user bubble still show what was attached.
 */
export function sweepAttachments(): number {
  const stale = db
    .select({ id: table.id })
    .from(table)
    .where(and(isNull(table.sessionId), lt(table.createdAt, Date.now() - UNCLAIMED_TTL_MS)))
    .all();
  deleteAttachments(stale.map((row) => row.id));

  /* A row whose bytes are gone can never answer, and it is what a restored
     backup is full of — but only the *unclaimed* ones are swept here. A claimed
     row is what draws a chip in a replayed transcript, and a chip that says
     "missing" is honest where a chip that is simply absent makes the transcript
     lie about what the user sent. */
  const orphans = db
    .select({ id: table.id, sha256: table.sha256 })
    .from(table)
    .where(isNull(table.sessionId))
    .all()
    .filter((row) => {
      try {
        return !statSync(attachmentPath(row.sha256)).isFile();
      } catch {
        return true;
      }
    });
  deleteAttachments(orphans.map((row) => row.id));
  return stale.length + orphans.length;
}

/** How many rows exist — the one number the backup page and tests want. */
export function countAttachments(): number {
  return db.select({ n: sql<number>`count(*)` }).from(table).get()?.n ?? 0;
}
