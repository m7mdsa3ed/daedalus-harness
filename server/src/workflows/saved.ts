/*
 * Saved workflows, v2: the library.
 *
 * The source of truth is the `wf_saved` table. The script files Claude Code
 * reads — `<project cwd>/.claude/workflows/*.js` and `~/.claude/workflows/*.js`
 * (under `CLAUDE_CONFIG_DIR` when set) — are an import/export mirror: a save
 * writes the file, and `importFromFiles` reads edits made by Claude Code back
 * in. A workflow is named by its `meta.name`, never its file name, and a
 * project one shadows a personal one of the same name.
 *
 * The file-mirror half (names, containment, symlinks, directory scans) is
 * plain functions over explicit directories and an injected `readMeta`, so it
 * is tested against a temp dir; the database is imported lazily by the
 * functions that need it, so importing this module opens no connection.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { SCRIPT_LIMITS, type ScriptMeta } from "./types.js";

export type SavedScope = "project" | "personal";

export interface ProjectRef {
  id: string;
  cwd: string;
}

/** A library entry as the list and the Run form see it (no source). */
export interface SavedWorkflow {
  id: string;
  name: string;
  scope: SavedScope;
  projectId: string | null;
  description: string;
  whenToUse?: string;
  /** First 16 hex of sha256(source). */
  version: string;
  /** `meta.inputs` (JSON Schema for `args`), or null. */
  inputs: Record<string, unknown> | null;
  updatedAt: number;
}

export type SavedWorkflowWithSource = SavedWorkflow & { source: string };

export type ReadMeta = (source: string) => ScriptMeta;

// ---- pure / filesystem half -------------------------------------------------

export const versionOf = (source: string): string => createHash("sha256").update(source).digest("hex").slice(0, 16);

/** `<dir>` of one scope. `home` is `CLAUDE_CONFIG_DIR` or `~/.claude`. */
export function workflowDir(scope: SavedScope, projectCwd: string | null, home = claudeHome()): string | null {
  if (scope === "personal") return join(home, "workflows");
  return projectCwd ? join(projectCwd, ".claude", "workflows") : null;
}

export function claudeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/**
 * A file name (with `.js`) for a workflow name. A name that is already
 * file-safe maps to itself; any other gets its unsafe runs replaced with `-`
 * and a short hash of the original, so two different names never share a file.
 */
export function mirrorFileName(name: string): string {
  const safe = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) && name.length <= 100 && !name.endsWith(".");
  if (safe) return `${name}.js`;
  const cleaned =
    name
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9_.-]+/g, "-")
      .replace(/^[^A-Za-z0-9]+/, "")
      .replace(/[.-]+$/, "")
      .slice(0, 60) || "workflow";
  const tag = createHash("sha256").update(name).digest("hex").slice(0, 6);
  return `${cleaned}-${tag}.js`;
}

/** Throws when any of the paths exists and is a symlink. */
export async function refuseSymlinks(paths: string[]): Promise<void> {
  for (const p of paths) {
    const s = await lstat(p).catch(() => null);
    if (s?.isSymbolicLink()) throw new Error(`refusing to save through a symlink: ${p}`);
  }
}

/** True when `child` is `root` or below it (lexically; resolve symlinks first). */
export function isInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes(".."));
}

/**
 * Write the mirror file. The guarded paths (the directories that must not be
 * links, in outer-to-inner order) are checked first; the file itself is opened
 * with O_NOFOLLOW so a link planted between the check and the write is refused
 * by the kernel. Mode 0644.
 */
export async function writeMirrorFile(dir: string, fileName: string, source: string, guard: string[] = []): Promise<string> {
  const path = join(dir, fileName);
  await refuseSymlinks([...guard, dir, path]);
  await mkdir(dir, { recursive: true });
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(`refusing to save through a symlink: ${path}`);
    throw error;
  }
  try {
    await handle.writeFile(source.endsWith("\n") ? source : `${source}\n`);
    await handle.chmod(0o644);
  } finally {
    await handle.close();
  }
  return path;
}

export interface ScannedFile {
  file: string;
  path: string;
  source: string;
  meta: ScriptMeta;
  mtimeMs: number;
}

export interface ScanOptions {
  /** A symlinked file is read only when true. Project directories (checked out
      from a repo) say false; the personal one may be dotfiles-managed. */
  followSymlinks?: boolean;
  maxBytes?: number;
}

/** Every `*.js` in `dir` whose `meta` parses. Anything else is named in `skipped`. */
export async function scanDirectory(
  dir: string,
  readMeta: ReadMeta,
  opts: ScanOptions = {},
): Promise<{ found: ScannedFile[]; skipped: string[] }> {
  const maxBytes = opts.maxBytes ?? SCRIPT_LIMITS.sourceBytes;
  const found: ScannedFile[] = [];
  const skipped: string[] = [];
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".js")).sort();
  for (const file of files) {
    const path = join(dir, file);
    try {
      const link = await lstat(path);
      if (link.isSymbolicLink() && !opts.followSymlinks) {
        skipped.push(`${path}: symlink`);
        continue;
      }
      const s = await stat(path);
      if (!s.isFile()) {
        skipped.push(`${path}: not a regular file`);
        continue;
      }
      if (s.size > maxBytes) {
        skipped.push(`${path}: larger than ${maxBytes} bytes`);
        continue;
      }
      const source = await readFile(path, "utf8");
      let meta: ScriptMeta;
      try {
        meta = readMeta(source);
      } catch (error) {
        skipped.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      found.push({ file, path, source, meta, mtimeMs: s.mtimeMs });
    } catch (error) {
      skipped.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { found, skipped };
}

/**
 * Read a script by path for `workflow({scriptPath})`. A relative path is read
 * against `baseCwd`; the real path (every link resolved) must lie inside one
 * of `roots` (also resolved), so a link pointing out of the project is refused.
 */
export async function readScriptPath(scriptPath: string, baseCwd: string, roots: string[], maxBytes = SCRIPT_LIMITS.sourceBytes): Promise<string> {
  const wanted = isAbsolute(scriptPath) ? scriptPath : resolve(baseCwd, scriptPath);
  const real = await realpath(wanted).catch(() => {
    throw new Error(`cannot read the workflow script at ${wanted}`);
  });
  const realRoots: string[] = [];
  for (const r of roots) {
    const rr = await realpath(r).catch(() => null);
    if (rr) realRoots.push(rr);
  }
  if (!realRoots.some((r) => isInside(r, real))) {
    throw new Error(`workflow script ${wanted} is outside the project and thread directories`);
  }
  const s = await stat(real);
  if (!s.isFile()) throw new Error(`workflow script ${wanted} is not a file`);
  if (s.size > maxBytes) throw new Error(`workflow script ${wanted} is larger than ${maxBytes} bytes`);
  return await readFile(real, "utf8");
}

/** Delete mirror files in `dir` whose meta name is `name` (regular files only,
    never a link), so the next import does not bring a deleted workflow back. */
export async function removeMirrorFiles(dir: string, name: string, readMeta: ReadMeta, opts: ScanOptions = {}): Promise<string[]> {
  const removed: string[] = [];
  const { found } = await scanDirectory(dir, readMeta, opts);
  for (const f of found) {
    if (f.meta.name !== name) continue;
    const s = await lstat(f.path).catch(() => null);
    if (!s?.isFile()) continue;
    await unlink(f.path).then(() => removed.push(f.path)).catch(() => {});
  }
  return removed;
}

/** At most one `true` per key per `ms`. */
export function makeThrottle(ms: number, now: () => number = Date.now) {
  const last = new Map<string, number>();
  return {
    take(key: string): boolean {
      const t = now();
      const prev = last.get(key);
      if (prev !== undefined && t - prev < ms) return false;
      last.set(key, t);
      return true;
    },
    reset(key?: string) {
      if (key === undefined) last.clear();
      else last.delete(key);
    },
  };
}

// ---- database half ----------------------------------------------------------

/** The sandbox's parser, loaded on first use so the file-mirror half above
    imports (and tests) without the vm sandbox. */
async function defaultReadMeta(): Promise<ReadMeta> {
  return (await import("./sandbox.js")).extractMeta;
}

const IMPORT_EVERY_MS = 30_000;
const importThrottle = makeThrottle(IMPORT_EVERY_MS);

async function store() {
  const m = await import("../db/index.js");
  return { db: m.db, wfSaved: m.wfSaved };
}
type Row = Awaited<ReturnType<typeof store>>["wfSaved"]["$inferSelect"];

let chain: Promise<unknown> = Promise.resolve();
/** Writes are serialised: the unique index treats a NULL project id as distinct,
    so two concurrent personal saves of one name could both insert. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

const toSaved = (r: Row): SavedWorkflow => ({
  id: r.id,
  name: r.name,
  scope: r.scope,
  projectId: r.projectId,
  description: r.description,
  ...(r.whenToUse ? { whenToUse: r.whenToUse } : {}),
  version: r.version,
  inputs: r.inputs ?? null,
  updatedAt: r.updatedAt,
});

function checkSize(source: string): void {
  if (Buffer.byteLength(source, "utf8") > SCRIPT_LIMITS.sourceBytes) {
    throw new Error(`workflow source is larger than ${SCRIPT_LIMITS.sourceBytes} bytes`);
  }
}

async function findExact(name: string, scope: SavedScope, projectId: string | null): Promise<Row | null> {
  const { db, wfSaved } = await store();
  const rows = await db
    .select()
    .from(wfSaved)
    .where(
      and(eq(wfSaved.name, name), eq(wfSaved.scope, scope), projectId === null ? isNull(wfSaved.projectId) : eq(wfSaved.projectId, projectId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Insert or update by (name, scope, projectId). An unchanged version keeps `updatedAt`. */
async function upsert(args: {
  source: string;
  meta: ScriptMeta;
  scope: SavedScope;
  projectId: string | null;
}): Promise<{ row: Row; changed: boolean }> {
  const { db, wfSaved } = await store();
  const { source, meta, scope, projectId } = args;
  const version = versionOf(source);
  const existing = await findExact(meta.name, scope, projectId);
  const fields = {
    description: meta.description,
    whenToUse: meta.whenToUse ?? null,
    source,
    version,
    inputs: meta.inputs ?? null,
  };
  const now = Date.now();
  if (existing) {
    const changed = existing.version !== version || existing.description !== fields.description || (existing.whenToUse ?? null) !== fields.whenToUse;
    if (!changed) return { row: existing, changed: false };
    const row = { ...existing, ...fields, updatedAt: now };
    await db.update(wfSaved).set({ ...fields, updatedAt: now }).where(eq(wfSaved.id, existing.id));
    return { row, changed: true };
  }
  const row: Row = { id: randomUUID(), name: meta.name, scope, projectId, ...fields, createdAt: now, updatedAt: now };
  await db.insert(wfSaved).values(row);
  return { row, changed: true };
}

/** Rows the project can see: its own project-scope ones and every personal one. */
async function visibleRows(project: ProjectRef | null): Promise<Row[]> {
  const { db, wfSaved } = await store();
  const rows = await db.select().from(wfSaved);
  return rows.filter((r) => r.scope === "personal" || (project !== null && r.projectId === project.id));
}

/** Project scope first, then personal; within a scope newest first. */
const byPrecedence = (a: Row, b: Row): number =>
  (a.scope === b.scope ? 0 : a.scope === "project" ? -1 : 1) || b.updatedAt - a.updatedAt || a.name.localeCompare(b.name);

/** Resolve an id or a name; a project workflow wins a name clash. */
function pick(rows: Row[], nameOrId: string, scope?: SavedScope): Row | null {
  const inScope = scope ? rows.filter((r) => r.scope === scope) : rows;
  const byId = inScope.find((r) => r.id === nameOrId);
  if (byId) return byId;
  return inScope.filter((r) => r.name === nameOrId).sort(byPrecedence)[0] ?? null;
}

/**
 * Scan the project and personal directories and import every file whose meta
 * parses and whose name/version is new or changed. Never deletes a row. A file
 * older than the row it would replace is skipped (the library was edited since
 * the mirror was written), so a stale mirror cannot undo an edit.
 * `readMeta` is injectable for tests; the default is the sandbox's.
 */
export async function importFromFiles(
  project: ProjectRef | null,
  readMeta?: ReadMeta,
): Promise<{ imported: number; skipped: string[] }> {
  const parse = readMeta ?? (await defaultReadMeta());
  const targets: { scope: SavedScope; dir: string; projectId: string | null; followSymlinks: boolean }[] = [];
  const personal = workflowDir("personal", null)!;
  if (project) targets.push({ scope: "project", dir: workflowDir("project", project.cwd)!, projectId: project.id, followSymlinks: false });
  targets.push({ scope: "personal", dir: personal, projectId: null, followSymlinks: true });

  let imported = 0;
  const skipped: string[] = [];
  for (const t of targets) {
    const scan = await scanDirectory(t.dir, parse, { followSymlinks: t.followSymlinks });
    skipped.push(...scan.skipped);
    for (const f of scan.found) {
      await serial(async () => {
        const existing = await findExact(f.meta.name, t.scope, t.projectId);
        if (existing && existing.version === versionOf(f.source)) return;
        if (existing && f.mtimeMs < existing.updatedAt) {
          skipped.push(`${f.path}: older than the library's copy of "${f.meta.name}"`);
          return;
        }
        const { changed } = await upsert({ source: f.source, meta: f.meta, scope: t.scope, projectId: t.projectId });
        if (changed) imported += 1;
      });
    }
  }
  return { imported, skipped };
}

/** `importFromFiles`, at most once per 30 s per directory pair; never throws. */
async function importLazily(project: ProjectRef | null): Promise<void> {
  const key = `${project?.cwd ?? ""}|${workflowDir("personal", null)}`;
  if (!importThrottle.take(key)) return;
  try {
    await importFromFiles(project);
  } catch (error) {
    console.warn("[workflows] saved-workflow import failed", error);
  }
}

/** Every workflow the project can run, project ones first; a personal one of
    a name a project one already has is shadowed. No source. `threadCwd` is not
    scanned: only the project's own directory is the project mirror. */
export async function listSaved(project: ProjectRef | null, _threadCwd: string | null = null): Promise<SavedWorkflow[]> {
  await importLazily(project);
  const rows = (await visibleRows(project)).sort(byPrecedence);
  const seen = new Set<string>();
  const out: SavedWorkflow[] = [];
  for (const r of rows) {
    if (seen.has(r.name)) continue;
    seen.add(r.name);
    out.push(toSaved(r));
  }
  return out;
}

/** One workflow with its source, by name (project shadows personal) or id. */
export async function getSaved(project: ProjectRef | null, nameOrId: string): Promise<SavedWorkflowWithSource | null> {
  let row = pick(await visibleRows(project), nameOrId);
  if (!row) {
    // A name not yet known may be a file Claude Code just wrote.
    await importLazily(project);
    row = pick(await visibleRows(project), nameOrId);
  }
  return row ? { ...toSaved(row), source: row.source } : null;
}

/**
 * Save (create or update) a workflow: the row first, then the mirror file.
 * A symlink in the way of the mirror is refused before anything is stored;
 * any other write failure leaves the row saved and is logged.
 * `project` is required for scope "project"; `projectCwd` is where its mirror
 * goes (normally `project.cwd`).
 */
export async function saveWorkflow(args: {
  source: string;
  scope: SavedScope;
  project: ProjectRef | null;
  projectCwd?: string | null;
}): Promise<SavedWorkflow> {
  const { source, scope, project } = args;
  checkSize(source);
  const meta = (await defaultReadMeta())(source);
  if (scope === "project" && !project) throw new Error("a project workflow needs a project");
  const projectCwd = args.projectCwd ?? project?.cwd ?? null;
  const dir = workflowDir(scope, projectCwd);
  const fileName = mirrorFileName(meta.name);
  const guard = scope === "project" && projectCwd ? [join(projectCwd, ".claude")] : [];
  if (dir) await refuseSymlinks([...guard, dir, join(dir, fileName)]);

  const saved = await serial(async () => {
    const { row } = await upsert({ source, meta, scope, projectId: scope === "project" ? project!.id : null });
    return toSaved(row);
  });
  if (dir) {
    try {
      await writeMirrorFile(dir, fileName, source, guard);
    } catch (error) {
      if (error instanceof Error && /symlink/.test(error.message)) throw error;
      console.warn(`[workflows] could not write the mirror for "${meta.name}"`, error);
    }
  }
  return saved;
}

/** Delete by id or name (within `scope` when given) and remove its mirror
    file(s). Returns false when nothing matched. */
export async function deleteSaved(project: ProjectRef | null, nameOrId: string, scope?: SavedScope): Promise<boolean> {
  const row = pick(await visibleRows(project), nameOrId, scope);
  if (!row) return false;
  const { db, wfSaved } = await store();
  await serial(async () => {
    await db.delete(wfSaved).where(eq(wfSaved.id, row.id));
  });
  const dir = workflowDir(row.scope, row.scope === "project" ? (project?.cwd ?? null) : null);
  if (dir) {
    await removeMirrorFiles(dir, row.name, await defaultReadMeta(), { followSymlinks: row.scope === "personal" }).catch(() => {});
    importThrottle.reset();
  }
  return true;
}

/**
 * The source behind `workflow(ref)` or a run by name. A string is a saved
 * workflow's name or id; `{scriptPath}` is a file inside the project's or the
 * thread's directory (relative paths are read against the thread's cwd).
 */
export async function loadSaved(
  project: ProjectRef | null,
  threadCwd: string | null,
  ref: string | { scriptPath: string },
): Promise<string> {
  if (typeof ref !== "string") {
    const roots = [project?.cwd, threadCwd].filter((r): r is string => !!r);
    const base = threadCwd ?? project?.cwd;
    if (!base) throw new Error("no directory to read the workflow script from");
    return await readScriptPath(ref.scriptPath, base, roots);
  }
  const hit = await getSaved(project, ref);
  if (!hit) throw new Error(`no saved workflow is named "${ref}"`);
  return hit.source;
}
