import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";

import { db, files as table } from "./db/index.js";
import { HttpError } from "./http-error.js";
import { putAttachment, MAX_ATTACHMENT_BYTES } from "./attachments.js";
import { DEFAULT_PROVIDER, providerFor } from "./storage/provider.js";

/**
 * The file library — folders and files in one tree. Names, parents and mime
 * types are here; bytes are the provider's (`storage/provider.ts`).
 */

export type FileRow = typeof table.$inferSelect;

export const FOLDER_MIME = "inode/directory";
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

function cleanName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[/\\]/g, "_").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") throw new HttpError("that name is not allowed", 400);
  return cleaned.slice(0, 200);
}

export async function getFile(id: string): Promise<FileRow | undefined> {
  return (await db.select().from(table).where(eq(table.id, id)).limit(1))[0];
}

const inFolder = (parentId: string | null) => (parentId === null ? isNull(table.parentId) : eq(table.parentId, parentId));

async function requireFolder(parentId: string | null): Promise<void> {
  if (parentId === null) return;
  const parent = await getFile(parentId);
  if (!parent || parent.kind !== "folder") throw new HttpError("no such folder", 404);
}

/** A name nobody in this folder has: `a.txt` → `a (2).txt`. */
async function freeName(parentId: string | null, wanted: string, except?: string): Promise<string> {
  const taken = new Set(
    (await db.select({ id: table.id, name: table.name }).from(table).where(inFolder(parentId)))
      .filter((row) => row.id !== except)
      .map((row) => row.name.toLowerCase()),
  );
  if (!taken.has(wanted.toLowerCase())) return wanted;
  const dot = wanted.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [wanted.slice(0, dot), wanted.slice(dot)] : [wanted, ""];
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** Folders first, then by name — the order a file explorer draws. */
export async function listFolder(parentId: string | null): Promise<FileRow[]> {
  await requireFolder(parentId);
  const rows = await db.select().from(table).where(inFolder(parentId));
  return rows.sort((a, b) =>
    a.kind !== b.kind ? (a.kind === "folder" ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
}

/** Root → the folder itself, for a breadcrumb. */
export async function pathOf(id: string | null): Promise<{ id: string; name: string }[]> {
  const path: { id: string; name: string }[] = [];
  for (let cursor = id, guard = 0; cursor && guard < 100; guard++) {
    const row = await getFile(cursor);
    if (!row) break;
    path.unshift({ id: row.id, name: row.name });
    cursor = row.parentId;
  }
  return path;
}

export async function makeFolder(parentId: string | null, name: string): Promise<FileRow> {
  await requireFolder(parentId);
  const now = Date.now();
  const row: FileRow = {
    id: randomUUID(),
    parentId,
    kind: "folder",
    name: await freeName(parentId, cleanName(name)),
    mimeType: FOLDER_MIME,
    size: 0,
    sha256: null,
    provider: null,
    key: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(table).values(row);
  return row;
}

export async function putFile(opts: { parentId: string | null; name: string; mimeType: string; bytes: Buffer }): Promise<FileRow> {
  await requireFolder(opts.parentId);
  if (opts.bytes.length === 0) throw new HttpError("that file is empty", 400);
  if (opts.bytes.length > MAX_FILE_BYTES) {
    throw new HttpError(`that file is larger than ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB`, 413);
  }
  const sha256 = createHash("sha256").update(opts.bytes).digest("hex");
  const name = await freeName(opts.parentId, cleanName(opts.name));
  const mimeType = opts.mimeType || "application/octet-stream";
  const provider = providerFor(DEFAULT_PROVIDER);
  /* Bytes already held for this content by the same provider are not written
     again; the new row simply points at them. */
  const [same] = await db
    .select()
    .from(table)
    .where(and(eq(table.sha256, sha256), eq(table.provider, provider.id)))
    .limit(1);
  const key = same?.key ?? (await provider.put({ sha256, bytes: opts.bytes, mimeType, name }));
  const now = Date.now();
  const row: FileRow = {
    id: randomUUID(),
    parentId: opts.parentId,
    kind: "file",
    name,
    mimeType,
    size: opts.bytes.length,
    sha256,
    provider: provider.id,
    key,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(table).values(row);
  return row;
}

export async function readFile(row: FileRow): Promise<Buffer> {
  if (row.kind !== "file" || !row.provider || !row.key) throw new HttpError("that is a folder", 400);
  try {
    return await providerFor(row.provider).get(row.key);
  } catch {
    throw new HttpError("that file's bytes are gone", 404);
  }
}

export async function updateFile(id: string, patch: { name?: string; parentId?: string | null }): Promise<FileRow> {
  const row = await getFile(id);
  if (!row) throw new HttpError("no such file", 404);
  const parentId = patch.parentId === undefined ? row.parentId : patch.parentId;
  if (parentId !== row.parentId) {
    await requireFolder(parentId);
    /* A folder cannot move into itself or anything under it. */
    if (row.kind === "folder" && (await pathOf(parentId)).some((step) => step.id === id)) {
      throw new HttpError("a folder cannot move into itself", 400);
    }
  }
  const name = await freeName(parentId, cleanName(patch.name ?? row.name), id);
  await db.update(table).set({ name, parentId, updatedAt: Date.now() }).where(eq(table.id, id));
  return { ...row, name, parentId, updatedAt: Date.now() };
}

/** A folder takes everything under it with it; each file's bytes are released
    through the provider that holds them, unless another row still points at
    the same bytes. */
export async function removeFile(id: string): Promise<void> {
  const row = await getFile(id);
  if (!row) throw new HttpError("no such file", 404);
  const doomed: FileRow[] = [row];
  for (let i = 0; i < doomed.length; i++) {
    if (doomed[i].kind === "folder") doomed.push(...(await db.select().from(table).where(eq(table.parentId, doomed[i].id))));
  }
  await db.delete(table).where(inArray(table.id, doomed.map((r) => r.id)));
  for (const file of doomed) {
    if (file.kind !== "file" || !file.provider || !file.key) continue;
    const [still] = await db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.provider, file.provider), eq(table.key, file.key)))
      .limit(1);
    if (!still) await providerFor(file.provider).delete(file.key).catch(() => {});
  }
}

/** A library file as a prompt attachment: the same bytes, handed to the
    attachment store under a fresh id, so the composer treats it like any other
    upload (claimed by the prompt, swept if unsent). */
export async function attachmentFor(row: FileRow) {
  const bytes = await readFile(row);
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new HttpError(`that file is larger than ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB, the most a prompt can carry`, 413);
  }
  return putAttachment({ id: randomUUID(), name: row.name, mimeType: row.mimeType, bytes });
}
