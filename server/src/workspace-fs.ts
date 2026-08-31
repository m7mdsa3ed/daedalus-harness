/* ── Project-scoped filesystem ──
 *
 * The workspace file API. Deliberately NOT `fs.ts`: that one is unrestricted
 * path autocomplete for the project form, and it is unrestricted on purpose —
 * the server already spawns arbitrary agent processes for whoever holds the
 * bearer token, so hiding `ls` from that token would be theatre. This is a
 * different bargain. These routes are driven by panels that a page can open
 * with an id from a URL, so the id decides what is reachable, and every path is
 * a *relative* one resolved against the project's own `cwd`.
 *
 * Containment is checked twice, because once is not enough:
 *
 *   1. Lexically, after normalizing — catches `../../etc/passwd`.
 *   2. Against the real path, after resolving symlinks — catches a link inside
 *      the project that points outside it. For a path that does not exist yet
 *      (a file about to be created) the check walks up to the nearest ancestor
 *      that does, because that is the directory the write will actually land
 *      in. A project whose own `cwd` is a symlink is fine: the root is
 *      canonicalized first, so both sides of every comparison are real.
 *
 * Every listing, read and write is bounded. An unbounded read of whatever a
 * path happens to point at is how a file API becomes a way to allocate a
 * gigabyte from a browser.
 */
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import { readFile as readFileBufferAsync } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";

import { getProject } from "./projects.js";

/** A refusal with the HTTP status it deserves — the route maps it straight. */
export class WorkspaceError extends Error {
  status: 400 | 403 | 404 | 409 | 413;
  constructor(message: string, status: 400 | 403 | 404 | 409 | 413) {
    super(message);
    this.status = status;
  }
}

const fail = (status: 400 | 403 | 404 | 409 | 413, message: string) =>
  new WorkspaceError(message, status);

/** Directory entries returned for one listing. Beyond this the client is told
    it was cut rather than being handed a tree it cannot render anyway. */
const MAX_ENTRIES = 1000;
/** Whole-file read ceiling. Past it the file is described, not returned. */
export const MAX_READ_BYTES = 2 * 1024 * 1024;
/** Write ceiling. An editor buffer larger than this is not an editor buffer. */
export const MAX_WRITE_BYTES = 8 * 1024 * 1024;
/** How much of a file is sniffed for NUL bytes to call it binary. */
const SNIFF_BYTES = 8192;

/** Skipped unless the caller asks for them. Not a security boundary — a path
    naming one still resolves — just the noise that makes a tree unreadable. */
export const DEFAULT_IGNORES = [
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  "coverage",
  ".DS_Store",
];

export interface WorkspaceEntry {
  name: string;
  /** Project-relative, POSIX-separated. Never absolute — an absolute server
      path is not part of the client contract. */
  path: string;
  type: "dir" | "file";
  size?: number;
  /** True when the entry is a symlink (resolved for `type`). */
  link?: boolean;
  ignored?: boolean;
  hidden?: boolean;
}

export interface WorkspaceListing {
  path: string;
  entries: WorkspaceEntry[];
  /** True when the listing was cut at MAX_ENTRIES. */
  truncated: boolean;
}

export interface WorkspaceStat {
  path: string;
  type: "dir" | "file";
  size: number;
  /** Opaque token for stale-write detection; changes when the file changes. */
  version: string;
  binary: boolean;
  tooLarge: boolean;
}

export interface WorkspaceFile extends WorkspaceStat {
  /** Absent for binary or oversized files — see `binary` / `tooLarge`. */
  content?: string;
}

/* ── Paths ─────────────────────────────────────────────────────────────────── */

const within = (root: string, path: string) => path === root || path.startsWith(root + sep);

/** The project's canonical `cwd`. Canonical, so a project rooted at a symlink
    does not fail its own containment check on every request. */
export function projectRoot(projectId: string): string {
  const project = getProject(projectId);
  if (!project) throw fail(404, "unknown project");
  try {
    return realpathSync(project.cwd);
  } catch {
    throw fail(404, `the project directory is missing: ${project.cwd}`);
  }
}

/**
 * A client-supplied relative path → an absolute one inside the project.
 *
 * `""` is the root. Absolute inputs are refused outright rather than silently
 * re-rooted: a client that sent one is confused about the contract, and
 * quietly reinterpreting it is how a bug becomes a surprise.
 */
export function resolveInProject(root: string, rawPath: string | undefined | null): string {
  const raw = (rawPath ?? "").trim();
  if (raw.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(raw))
    throw fail(400, "path must be relative to the project");
  if (raw === "" || raw === ".") return root;

  const target = resolve(root, normalize(raw));
  if (!within(root, target)) throw fail(403, "path escapes the project");

  /* Symlinks. Resolve the deepest part of the path that exists — for a file
     being created that is its parent directory, which is the thing the write
     lands in — and require the real answer to still be inside. A link out of
     the project is neither readable nor writable through these routes. */
  let probe = target;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) throw fail(403, "path escapes the project");
    probe = parent;
  }
  const real = realpathSync(probe);
  if (!within(root, real)) throw fail(403, "path escapes the project");
  return target;
}

/** Absolute → the project-relative form the client speaks. */
export function relativePath(root: string, absolute: string): string {
  const rel = relative(root, absolute);
  return rel === "" ? "" : rel.split(sep).join("/");
}

const isHidden = (name: string) => name.startsWith(".");
const isIgnored = (name: string, ignores: string[]) => ignores.includes(name);

/* ── Reading ───────────────────────────────────────────────────────────────── */

function statOf(path: string): Stats {
  try {
    return statSync(path);
  } catch {
    throw fail(404, "no such file or directory");
  }
}

/**
 * `mtimeNs-size`. Changes on every write that matters, which is what it is for
 * — catching "somebody else changed this while you were editing". Not a hash:
 * hashing every file on every read costs more than the conflict it prevents.
 *
 * **Nanoseconds, not `mtimeMs`.** Millisecond resolution is not enough: two
 * writes inside the same millisecond that land on the same byte count produce
 * an identical version, so the next stale-write check passes and silently
 * overwrites the change it was meant to catch. That is not hypothetical — it is
 * what the "version a write returns" test caught, on writes a program made back
 * to back. Nanosecond mtime comes from a `bigint` stat and is what ext4, APFS
 * and NTFS actually store.
 *
 * The residual caveat, stated rather than hidden: a filesystem with coarse
 * timestamp granularity (some network mounts round to the second) can still
 * collide. `statSync` failing at all falls back to the millisecond form, which
 * is no worse than what it replaced.
 */
function versionOf(path: string, stat: Stats): string {
  try {
    const precise = statSync(path, { bigint: true });
    return `${precise.mtimeNs}-${precise.size}`;
  } catch {
    return `${Math.floor(stat.mtimeMs)}-${stat.size}`;
  }
}

export interface ListOptions {
  hidden?: boolean;
  ignored?: boolean;
  ignores?: string[];
}

export function listDir(
  projectId: string,
  path: string | undefined,
  options: ListOptions = {},
): WorkspaceListing {
  const root = projectRoot(projectId);
  const dir = resolveInProject(root, path);
  const stat = statOf(dir);
  if (!stat.isDirectory()) throw fail(400, "not a directory");

  const ignores = options.ignores ?? DEFAULT_IGNORES;
  const entries: WorkspaceEntry[] = [];
  let seen = 0;
  let truncated = false;

  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const hidden = isHidden(dirent.name);
    const ignored = isIgnored(dirent.name, ignores);
    if (hidden && !options.hidden) continue;
    if (ignored && !options.ignored) continue;

    seen += 1;
    if (seen > MAX_ENTRIES) {
      truncated = true;
      continue;
    }

    const absolute = join(dir, dirent.name);
    const link = dirent.isSymbolicLink();
    let type: "dir" | "file";
    let size: number | undefined;
    if (link) {
      /* A link is described by what it points at, but a broken one — or one
         pointing out of the project — is still listed as a file rather than
         hidden. It cannot be opened; that refusal belongs to the read, where
         the reason can be given. */
      try {
        const resolved = statSync(absolute);
        type = resolved.isDirectory() ? "dir" : "file";
        size = resolved.isFile() ? resolved.size : undefined;
      } catch {
        type = "file";
      }
    } else {
      type = dirent.isDirectory() ? "dir" : "file";
      if (dirent.isFile()) {
        try {
          size = statSync(absolute).size;
        } catch {
          /* vanished between readdir and stat — report it without a size */
        }
      }
    }

    entries.push({
      name: dirent.name,
      path: relativePath(root, absolute),
      type,
      ...(size !== undefined ? { size } : {}),
      ...(link ? { link: true } : {}),
      ...(ignored ? { ignored: true } : {}),
      ...(hidden ? { hidden: true } : {}),
    });
  }

  entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
  );
  return { path: relativePath(root, dir), entries, truncated };
}

/* ── Search ────────────────────────────────────────────────────────────────── */

/** Entries walked before a search gives up and says it was cut. A repository
    the size of a monorepo is walked in a few tens of milliseconds at this
    budget; past it the query is too broad to be worth the stat storm. */
const SEARCH_VISIT_LIMIT = 20000;
const SEARCH_DEFAULT_LIMIT = 30;
const SEARCH_MAX_LIMIT = 100;

export interface WorkspaceSearch {
  entries: WorkspaceEntry[];
  /** The walk hit its budget, or there were more matches than `limit`. */
  truncated: boolean;
}

/**
 * Fuzzy subsequence score for `query` against a project-relative path, or
 * `null` when the query is not a subsequence of it at all.
 *
 * Greedy leftmost matching — not the optimal alignment, which costs a DP table
 * per candidate and buys an ordering nobody can perceive. What it does buy is
 * the three signals that make a file picker feel right: a run of adjacent
 * characters beats a scattered one, a character right after a separator beats
 * one mid-word, and a hit in the basename beats one in the directories, so
 * `cfg` finds `vite.config.ts` before `src/config/rc/legacy.ts`.
 */
function fuzzyScore(query: string, path: string): number | null {
  const q = query.toLowerCase();
  const p = path.toLowerCase();
  const baseStart = p.lastIndexOf("/") + 1;
  let qi = 0;
  let score = 0;
  let prev = -2;
  let run = 0;
  for (let i = 0; i < p.length && qi < q.length; i++) {
    if (p[i] !== q[qi]) continue;
    run = prev === i - 1 ? run + 1 : 0;
    score += 10 + run * 6;
    if (i === 0 || "/-_. ".includes(p[i - 1])) score += 8;
    if (i >= baseStart) score += 4;
    prev = i;
    qi++;
  }
  if (qi < q.length) return null;
  // Shorter and shallower wins among equals: the file you meant is rarely the
  // one buried deepest.
  return score - p.length * 0.15 - (p.split("/").length - 1) * 0.5;
}

/**
 * Every path in the project that fuzzy-matches `query`, best first.
 *
 * This is what the composer's `@` menu reads. It is deliberately a *walk* and
 * not a shell out to `git ls-files` or `rg --files`: a project need not be a
 * repository, and neither binary is something the harness may assume. The walk
 * is breadth-first so a truncated one still returns the shallow paths — the
 * ones a person is most likely to have meant — rather than whatever branch was
 * deepest.
 *
 * An empty query answers with the project root's own listing, so opening the
 * menu shows something to arrow through before a single character is typed.
 * Ignored directories (`node_modules`, `.git`, …) are skipped outright and
 * hidden ones only when the query asks for them by typing the dot, which is the
 * same bargain `listDir` makes with its flags.
 */
export function searchEntries(
  projectId: string,
  rawQuery: string | undefined,
  options: { limit?: number } = {},
): WorkspaceSearch {
  const root = projectRoot(projectId);
  const query = (rawQuery ?? "").trim();
  const limit = Math.min(Math.max(options.limit ?? SEARCH_DEFAULT_LIMIT, 1), SEARCH_MAX_LIMIT);

  if (query === "") {
    const listing = listDir(projectId, "", {});
    return {
      entries: listing.entries.slice(0, limit),
      truncated: listing.truncated || listing.entries.length > limit,
    };
  }

  const wantHidden = query.includes(".");
  const scored: { entry: WorkspaceEntry; score: number }[] = [];
  const queue: string[] = [root];
  let visited = 0;
  let truncated = false;

  while (queue.length > 0 && !truncated) {
    const dir = queue.shift() as string;
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      // A directory that vanished or cannot be read is skipped, not fatal: a
      // search is best-effort over a tree somebody else is editing.
      continue;
    }
    for (const dirent of dirents) {
      if (isIgnored(dirent.name, DEFAULT_IGNORES)) continue;
      if (isHidden(dirent.name) && !wantHidden) continue;
      if (++visited > SEARCH_VISIT_LIMIT) {
        truncated = true;
        break;
      }
      const absolute = join(dir, dirent.name);
      /* A symlink is listed as a file and never descended: following one is how
         a walk finds a cycle, and its target may be outside the project — which
         the read routes would refuse anyway. */
      const link = dirent.isSymbolicLink();
      const type: "dir" | "file" = !link && dirent.isDirectory() ? "dir" : "file";
      const path = relativePath(root, absolute);
      const score = fuzzyScore(query, path);
      if (score !== null)
        scored.push({
          entry: { name: dirent.name, path, type, ...(link ? { link: true } : {}) },
          score,
        });
      if (type === "dir") queue.push(absolute);
    }
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.entry.path.length - b.entry.path.length ||
      a.entry.path.localeCompare(b.entry.path),
  );
  return {
    entries: scored.slice(0, limit).map((s) => s.entry),
    truncated: truncated || scored.length > limit,
  };
}

/** True when the first few KB contain a NUL. The same heuristic git uses, and
    it is the one that matters here: what it decides is whether the bytes can
    be handed to a text editor at all. */
async function looksBinary(path: string, size: number): Promise<boolean> {
  if (size === 0) return false;
  const stream = createReadStream(path, { start: 0, end: Math.min(size, SNIFF_BYTES) - 1 });
  try {
    for await (const chunk of stream) {
      if ((chunk as Buffer).includes(0)) return true;
    }
  } finally {
    stream.destroy();
  }
  return false;
}

export async function statFile(projectId: string, path: string): Promise<WorkspaceStat> {
  const root = projectRoot(projectId);
  const absolute = resolveInProject(root, path);
  const stat = statOf(absolute);
  const type = stat.isDirectory() ? "dir" : "file";
  return {
    path: relativePath(root, absolute),
    type,
    size: stat.size,
    version: versionOf(absolute, stat),
    binary: type === "file" ? await looksBinary(absolute, stat.size) : false,
    tooLarge: type === "file" && stat.size > MAX_READ_BYTES,
  };
}

/**
 * A file's text, or a description of why there isn't any.
 *
 * Binary and oversized files come back as metadata with no `content` rather
 * than as a 400 or as mojibake: the panel that asked needs to render *something*
 * for them, and "here is what this is" is more useful than an error.
 */
export async function readFile(projectId: string, path: string): Promise<WorkspaceFile> {
  const root = projectRoot(projectId);
  const absolute = resolveInProject(root, path);
  const stat = statOf(absolute);
  if (stat.isDirectory()) throw fail(400, "not a file");

  const info: WorkspaceStat = {
    path: relativePath(root, absolute),
    type: "file",
    size: stat.size,
    version: versionOf(absolute, stat),
    binary: await looksBinary(absolute, stat.size),
    tooLarge: stat.size > MAX_READ_BYTES,
  };
  if (info.binary || info.tooLarge) return info;
  return { ...info, content: await readFileAsync(absolute, "utf8") };
}

/* ── Writing ───────────────────────────────────────────────────────────────── */

export interface WriteOptions {
  /** The version the client last saw. A mismatch is a 409, not an overwrite. */
  expectedVersion?: string;
  /** Skip the version check — the "overwrite anyway" branch of the conflict
      dialog, which is a decision the user made and not a default. */
  force?: boolean;
}

/**
 * A file's raw bytes, for the things text cannot carry — an image in the
 * editor's preview mode, mainly.
 *
 * Same containment and the same size ceiling as `readFile`; what differs is
 * that the bytes come back as bytes. No content sniffing beyond the extension
 * the caller asked about: this returns `application/octet-stream` unless it
 * recognises an image type, so nothing here can be talked into serving HTML
 * that a browser would then execute in the app's own origin.
 */
export async function readFileBytes(
  projectId: string,
  path: string,
): Promise<{ bytes: Buffer; contentType: string; path: string }> {
  const root = projectRoot(projectId);
  const absolute = resolveInProject(root, path);
  const stat = statOf(absolute);
  if (stat.isDirectory()) throw fail(400, "not a file");
  if (stat.size > MAX_READ_BYTES) throw fail(413, "file is too large to read");

  const ext = absolute.toLowerCase().split(".").pop() ?? "";
  const contentType = IMAGE_TYPES[ext] ?? "application/octet-stream";
  return { bytes: await readFileBufferAsync(absolute), contentType, path: relativePath(root, absolute) };
}

/** The only types served with a real content-type. Everything else downloads
    as an opaque blob rather than being rendered by the browser. */
const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

export function writeFile(
  projectId: string,
  path: string,
  content: string,
  options: WriteOptions = {},
): WorkspaceStat {
  const root = projectRoot(projectId);
  const absolute = resolveInProject(root, path);
  if (absolute === root) throw fail(400, "not a file");

  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_WRITE_BYTES) throw fail(413, "file is too large to write");

  const existing = existsSync(absolute) ? statSync(absolute) : null;
  if (existing?.isDirectory()) throw fail(400, "not a file");
  if (!options.force && options.expectedVersion !== undefined) {
    const current = existing ? versionOf(absolute, existing) : null;
    if (current !== options.expectedVersion)
      throw fail(409, "the file changed on disk since it was read");
  }

  /* Atomic: write a sibling temp file and rename over the target, so a failure
     halfway leaves the old file intact rather than a truncated one. The temp
     has to be a sibling — rename is only atomic within a filesystem, and /tmp
     is frequently a different one. */
  const temp = join(dirname(absolute), `.daedalus-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(temp, content, "utf8");
    renameSync(temp, absolute);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
  return {
    path: relativePath(root, absolute),
    type: "file",
    size: bytes,
    version: versionOf(absolute, statSync(absolute)),
    binary: false,
    tooLarge: false,
  };
}

export function createEntry(
  projectId: string,
  path: string,
  type: "dir" | "file",
): WorkspaceEntry {
  const root = projectRoot(projectId);
  const absolute = resolveInProject(root, path);
  if (absolute === root) throw fail(400, "cannot create the project root");
  if (existsSync(absolute)) throw fail(409, "already exists");

  if (type === "dir") mkdirSync(absolute, { recursive: true });
  else {
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, "", { flag: "wx" });
  }
  return { name: absolute.split(sep).pop()!, path: relativePath(root, absolute), type };
}

export function renameEntry(projectId: string, from: string, to: string): WorkspaceEntry {
  const root = projectRoot(projectId);
  const source = resolveInProject(root, from);
  const target = resolveInProject(root, to);
  if (source === root || target === root) throw fail(400, "cannot rename the project root");
  const stat = statOf(source);
  if (existsSync(target)) throw fail(409, "already exists");

  mkdirSync(dirname(target), { recursive: true });
  renameSync(source, target);
  return {
    name: target.split(sep).pop()!,
    path: relativePath(root, target),
    type: stat.isDirectory() ? "dir" : "file",
  };
}

export function deleteEntry(projectId: string, path: string): { path: string } {
  const root = projectRoot(projectId);
  const absolute = resolveInProject(root, path);
  if (absolute === root) throw fail(400, "cannot delete the project root");
  statOf(absolute);
  /* No `force`: a delete of something that is not there should say so rather
     than report success, or the explorer will show a row it cannot remove. */
  rmSync(absolute, { recursive: true });
  return { path: relativePath(root, absolute) };
}
