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
 *
 * The one exception is the `@` search (`searchEntries`), and it says so where it
 * is defined: it is an *input affordance* rather than a panel, and the query
 * names its own scope (`~/`, absolute, or relative to the cwd), because people
 * point agents at files outside the project. It only ever *lists* names — it
 * reads no bytes and writes nothing.
 */
import {
  createReadStream,
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent,
  type Stats,
} from "node:fs";
import {
  readFile as readFileAsync,
  readFile as readFileBufferAsync,
  readdir as readdirAsync,
  stat as statAsync,
} from "node:fs/promises";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";

import { getProject } from "./projects.js";
import { HttpError } from "./http-error.js";

/** A refusal with the HTTP status it deserves — the route maps it straight. */
export class WorkspaceError extends HttpError {
  declare status: 400 | 403 | 404 | 409 | 413;
  constructor(message: string, status: 400 | 403 | 404 | 409 | 413) {
    super(message, status);
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

/** The id a panel with no project carries — the client spells the same string. */
export const HOME_PROJECT_ID = "home";

/** The project's canonical `cwd`. Canonical, so a project rooted at a symlink
    does not fail its own containment check on every request. */
export async function projectRoot(projectId: string): Promise<string> {
  // A panel opened with no thread routed has no project: it lands in $HOME.
  if (projectId === HOME_PROJECT_ID) return realpathSync(homedir());
  const project = await getProject(projectId);
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

/**
 * A *stored* relative path → an absolute one inside the project, clamped.
 *
 * `resolveInProject` above throws, because there the path came off a request
 * and a client that sent a bad one is confused. This one is for a path that
 * was saved earlier — a helper's working directory — where the reader is a
 * spawn, not a route, and where the row can arrive from an imported bundle or
 * an edited database. Refusing to run at all is worse than running where the
 * label promised, so an absolute path, a `..` that climbs out, and a symlink
 * pointing away all fall back to the root instead of throwing.
 */
export function containedPath(root: string, relative: string | undefined | null): string {
  const raw = (relative ?? "").trim();
  if (raw === "" || raw === "." || raw.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(raw)) return root;
  const target = resolve(root, normalize(raw));
  if (!within(root, target)) return root;
  try {
    // Only when it exists: a helper naming a directory its own command creates
    // is asked for by name, and the spawn's own ENOENT is the honest answer.
    if (existsSync(target) && !within(root, realpathSync(target))) return root;
  } catch {
    return root;
  }
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

async function statOfAsync(path: string): Promise<Stats> {
  try {
    return await statAsync(path);
  } catch {
    throw fail(404, "no such file or directory");
  }
}

/** How many filesystem calls a listing or a walk keeps in flight. Enough to
    hide latency, few enough that one broad search does not monopolise the
    thread pool the rest of the process reads files on. */
const FS_CONCURRENCY = 16;

/** `fn` over `items`, at most `limit` in flight, results in item order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
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

export async function listDir(
  projectId: string,
  path: string | undefined,
  options: ListOptions = {},
): Promise<WorkspaceListing> {
  const root = await projectRoot(projectId);
  const dir = resolveInProject(root, path);
  const stat = await statOfAsync(dir);
  if (!stat.isDirectory()) throw fail(400, "not a directory");

  const ignores = options.ignores ?? DEFAULT_IGNORES;
  const kept: { dirent: Dirent; hidden: boolean; ignored: boolean }[] = [];
  let seen = 0;
  let truncated = false;

  for (const dirent of await readdirAsync(dir, { withFileTypes: true })) {
    const hidden = isHidden(dirent.name);
    const ignored = isIgnored(dirent.name, ignores);
    if (hidden && !options.hidden) continue;
    if (ignored && !options.ignored) continue;

    seen += 1;
    if (seen > MAX_ENTRIES) {
      truncated = true;
      continue;
    }
    kept.push({ dirent, hidden, ignored });
  }

  const entries = await mapLimit(kept, FS_CONCURRENCY, async ({ dirent, hidden, ignored }) => {
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
        const resolved = await statAsync(absolute);
        type = resolved.isDirectory() ? "dir" : "file";
        size = resolved.isFile() ? resolved.size : undefined;
      } catch {
        type = "file";
      }
    } else {
      type = dirent.isDirectory() ? "dir" : "file";
      if (dirent.isFile()) {
        try {
          size = (await statAsync(absolute)).size;
        } catch {
          /* vanished between readdir and stat — report it without a size */
        }
      }
    }

    return {
      name: dirent.name,
      path: relativePath(root, absolute),
      type,
      ...(size !== undefined ? { size } : {}),
      ...(link ? { link: true } : {}),
      ...(ignored ? { ignored: true } : {}),
      ...(hidden ? { hidden: true } : {}),
    } satisfies WorkspaceEntry;
  });

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

/** One line a content search matched. */
export interface WorkspaceContentMatch {
  /** Project-relative, POSIX-separated. */
  path: string;
  /** 1-based line number, as an editor counts. */
  line: number;
  /** The line's text, trimmed of trailing whitespace and cut to `MATCH_TEXT_MAX`. */
  text: string;
}

export interface WorkspaceContentSearch {
  matches: WorkspaceContentMatch[];
  /** The walk hit a budget, or there were more matches than `limit`. */
  truncated: boolean;
}

/** Matches returned for one content search, across all files. */
const CONTENT_DEFAULT_LIMIT = 100;
const CONTENT_MAX_LIMIT = 500;
/** Files opened before a content search gives up. Reading bytes is far more
    expensive than statting names, so this budget is smaller than the walk's. */
const CONTENT_FILE_LIMIT = 4000;
/** Directories listed before a content search gives up — separate from the
    file budget, because a tree of empty folders reads no file and would
    otherwise walk forever. */
const CONTENT_DIR_LIMIT = 4000;
/** A single file larger than this is skipped rather than read: a content
    search is a glance, and a minified bundle in it is pure cost. */
const CONTENT_MAX_FILE_BYTES = 1024 * 1024;
/** How much of a matched line is handed back for the result row. */
const MATCH_TEXT_MAX = 200;

/**
 * Every line containing a term, best-effort and bounded.
 *
 * This is the IDE's "search in files", and it is deliberately **not** a shell
 * out to `rg` or `git grep`: a project need not be a repository and neither
 * binary is something the harness may assume, the same reasoning `searchEntries`
 * gives for walking rather than listing. It is also not the `@` menu's search —
 * that one names a scope on the whole machine and lists *names*; this one reads
 * bytes and cannot leave the project, so the panel that opens its results can
 * always open the file they came from.
 *
 * Case-insensitive substring, whole line returned: matching a regex here would
 * mean an unvalidated pattern reaching a walk over somebody else's repository,
 * and substring is what a reader typing into an IDE search box means most of the
 * time. Ignores are the explorer's own (`DEFAULT_IGNORES`), so a search never
 * finds something the tree would not show.
 */
export async function searchContents(
  projectId: string,
  rawQuery: string | undefined,
  options: { limit?: number } = {},
): Promise<WorkspaceContentSearch> {
  const root = await projectRoot(projectId);
  const term = (rawQuery ?? "").trim().toLowerCase();
  const limit = Math.min(Math.max(options.limit ?? CONTENT_DEFAULT_LIMIT, 1), CONTENT_MAX_LIMIT);
  if (!term) return { matches: [], truncated: false };

  const matches: WorkspaceContentMatch[] = [];
  let truncated = false;

  const queue: string[] = [root];
  let filesRead = 0;
  /* Directories are budgeted too, and separately: a tree of ten thousand empty
     folders is a stat storm that reads no file at all, and the file budget
     would never notice it. */
  let dirsRead = 0;

  while (queue.length > 0 && !truncated) {
    if (++dirsRead > CONTENT_DIR_LIMIT) break;
    const dir = queue.shift() as string;
    let dirents: Dirent[];
    try {
      dirents = await readdirAsync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      if (isIgnored(dirent.name, DEFAULT_IGNORES)) continue;
      /* Hidden files are skipped here without the "did the query type a dot"
         escape `searchEntries` offers: a content search is over source, and
         `.git`-adjacent noise is not source even when it matches. */
      if (isHidden(dirent.name)) continue;
      const absolute = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        queue.push(absolute);
        continue;
      }
      /* A symlink is never followed — the same cycle-and-containment bargain
         the name walk makes. */
      if (!dirent.isFile()) continue;
      if (++filesRead > CONTENT_FILE_LIMIT) {
        truncated = true;
        break;
      }

      let content: string;
      try {
        const info = await statAsync(absolute);
        if (info.size > CONTENT_MAX_FILE_BYTES) continue;
        content = await readFileAsync(absolute, "utf8");
      } catch {
        /* Unreadable, or not text at all: skipped. */
        continue;
      }
      /* A NUL in the first chunk is the same binary signal `looksBinary` uses,
         which saves decoding a megabyte of something that has no lines. */
      if (content.includes("\0")) continue;

      const lines = content.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const text = lines[index];
        if (!text.toLowerCase().includes(term)) continue;
        if (matches.length >= limit) {
          truncated = true;
          break;
        }
        matches.push({
          path: relative(root, absolute).split(sep).join("/"),
          line: index + 1,
          text: text.trimEnd().slice(0, MATCH_TEXT_MAX),
        });
      }
      if (truncated) break;
    }
  }

  return { matches, truncated };
}

/**
 * Fuzzy subsequence score for `query` against a path (relative to whatever
 * directory is being searched), or `null` when the query is not a subsequence
 * of it at all.
 *
 * Greedy leftmost matching — not the optimal alignment, which costs a DP table
 * per candidate and buys an ordering nobody can perceive. What it does buy is
 * the signals that make a file picker feel right: an exact or prefix hit on the
 * basename is almost always what was meant, so it is scored far above a
 * scattered subsequence; a run of adjacent characters beats a scattered one; a
 * character right after a separator beats one mid-word; a hit in the basename
 * beats one in the directories. So `cfg` finds `vite.config.ts` before
 * `src/config/rc/legacy.ts`, and `index` finds `index.ts` first. Case is a
 * tiebreak, not a gate — a match in the case that was typed is a hair better
 * than one that only matches case-insensitively.
 */
function fuzzyScore(query: string, path: string): number | null {
  const q = query.toLowerCase();
  if (q === "") return 0;
  const p = path.toLowerCase();
  const baseStart = p.lastIndexOf("/") + 1;
  const base = p.slice(baseStart);
  const bonus = base === q ? 60 : base.startsWith(q) ? 30 : 0;

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
    if (path[i] === query[qi]) score += 2;
    prev = i;
    qi++;
  }
  if (qi < q.length) return null;
  // Shorter and shallower wins among equals: the file you meant is rarely the
  // one buried deepest.
  return score + bonus - p.length * 0.15 - (p.split("/").length - 1) * 0.5;
}

/* ── Search scope ───────────────────────────────────────────────────────────
 *
 * A `@` query names *where* to look as well as *what* to look for. The text
 * through the last `/` is the directory and the rest is the fuzzy term, so
 * `src/com` searches `src/` for `com`, and a `~/` or `/` prefix searches the
 * home directory or an absolute one. That is what lets a mention reach **any
 * path on the machine**, not only the project's cwd — pointing an agent at a log
 * file, a dot config or a sibling checkout should not require moving it in
 * first. A bare relative query still resolves against the cwd, so the common
 * case is unchanged.
 *
 * `prefix` is put back in front of every result, so the menu completes the path
 * the person is already typing (`/etc/hosts`, `~/.config/nvim/…`) rather than a
 * re-rooted one they would have to reconcile.
 */
interface SearchScope {
  /** Absolute directory to search. */
  base: string;
  /** Textual prefix (ending in `/`) prepended to each result's path. */
  prefix: string;
  /** Fuzzy term within `base`; `""` asks for the directory's own listing. */
  term: string;
  /** True when the query is relative, i.e. resolved against the project. */
  relative: boolean;
}

function parseSearchScope(root: string, query: string): SearchScope {
  /* `~` and `~/…`: the home directory, named the way a shell names it. */
  if (query === "~" || query.startsWith("~/")) {
    const rest = query.slice(1).replace(/^\/+/, "");
    const cut = rest.lastIndexOf("/");
    const dir = cut < 0 ? "" : rest.slice(0, cut);
    return {
      base: dir === "" ? homedir() : join(homedir(), dir),
      prefix: dir === "" ? "~/" : `~/${dir}/`,
      term: cut < 0 ? rest : rest.slice(cut + 1),
      relative: false,
    };
  }
  /* An absolute path names its own base; the project only supplies the relative
     case. `lastIndexOf("/") <= 0` means the base is the filesystem root. */
  if (query.startsWith("/")) {
    const cut = query.lastIndexOf("/");
    const dir = cut <= 0 ? "/" : query.slice(0, cut);
    return {
      base: dir,
      prefix: dir === "/" ? "/" : `${dir}/`,
      term: query.slice(cut + 1),
      relative: false,
    };
  }
  /* Relative to the project — and it may still climb out with `../`. */
  const cut = query.lastIndexOf("/");
  if (cut < 0) return { base: root, prefix: "", term: query, relative: true };
  const dir = query.slice(0, cut);
  return {
    base: resolve(root, normalize(dir)),
    prefix: `${dir}/`,
    term: query.slice(cut + 1),
    relative: true,
  };
}

/**
 * Every path that fuzzy-matches a `@` query, best first.
 *
 * This is what the composer's `@` menu and the IDE's file finder both read. The
 * query names a scope (`~`, absolute, or relative to the project — see
 * `parseSearchScope`), and the search over it is deliberately a *walk* and not a
 * shell out to `git ls-files` or `rg --files`: a project need not be a
 * repository, and neither binary is something the harness may assume.
 *
 * Inside the project the walk is breadth-first and budgeted at
 * `SEARCH_VISIT_LIMIT`, so a truncated one still returns the shallow paths — the
 * ones a person is most likely to have meant — rather than whatever branch was
 * deepest. A directory *outside* the project is browsed **one level at a time**
 * instead of walked: recursing from `/home` or `/` on every keystroke is a stat
 * storm nothing asked for, and drilling a segment at a time is how a path
 * completer is used anyway. An empty term is always that one-level listing, so
 * `@src/` shows `src`'s children and opening the menu shows the root's.
 *
 * Ignored directories (`node_modules`, `.git`, …) are skipped outright and
 * hidden ones only when the query asks for them by typing the dot, which is the
 * same bargain `listDir` makes with its flags.
 */
export async function searchEntries(
  projectId: string,
  rawQuery: string | undefined,
  options: { limit?: number } = {},
): Promise<WorkspaceSearch> {
  const root = await projectRoot(projectId);
  const query = (rawQuery ?? "").trim();
  const limit = Math.min(Math.max(options.limit ?? SEARCH_DEFAULT_LIMIT, 1), SEARCH_MAX_LIMIT);
  const scope = parseSearchScope(root, query);

  let { base, prefix, term } = scope;
  let baseReal: string | null;
  try {
    baseReal = statSync(base).isDirectory() ? realpathSync(base) : null;
  } catch {
    baseReal = null;
  }
  if (baseReal === null) {
    /* A prefix that is not a directory (or does not exist yet) has nothing to
       search under it. Inside the project, fall back to the whole tree so
       `sr/ind` still finds `src/index.ts`; outside it, a half-typed absolute
       path has no parent worth guessing at. */
    if (!scope.relative) return { entries: [], truncated: false };
    baseReal = root;
    prefix = "";
    term = query;
  }

  const wantHidden = query.includes(".");
  const inside = within(root, baseReal);
  const scored: { entry: WorkspaceEntry; score: number }[] = [];
  let truncated = false;

  if (term === "" || !inside) {
    /* One directory, filtered by `term`: the drill-down (`@src/`) and every
       scope outside the project, which is browsed rather than walked. */
    let dirents: Dirent[];
    try {
      dirents = await readdirAsync(baseReal, { withFileTypes: true });
    } catch {
      dirents = [];
    }
    let seen = 0;
    for (const dirent of dirents) {
      if (isIgnored(dirent.name, DEFAULT_IGNORES)) continue;
      if (isHidden(dirent.name) && !wantHidden) continue;
      if (++seen > MAX_ENTRIES) {
        truncated = true;
        break;
      }
      const score = term === "" ? 0 : fuzzyScore(term, dirent.name);
      if (score === null) continue;
      const link = dirent.isSymbolicLink();
      scored.push({
        entry: {
          name: dirent.name,
          path: `${prefix}${dirent.name}`,
          type: !link && dirent.isDirectory() ? "dir" : "file",
          ...(link ? { link: true } : {}),
        },
        score,
      });
    }
  } else {
    /* Inside the project: the bounded breadth-first walk, rooted at the query's
       base and matching the term against each path relative to it. */
    const queue: string[] = [baseReal];
    let visited = 0;
    while (queue.length > 0 && !truncated) {
      /* One wave: readdir the front of the queue concurrently, then fold the
         answers back in queue order — that keeps the walk breadth-first and the
         visit budget deterministic, so a truncated search still keeps exactly
         the shallow paths the sequential walk kept. */
      const wave = queue.splice(0, FS_CONCURRENCY);
      const listings = await Promise.all(
        wave.map(async (dir) => {
          try {
            return await readdirAsync(dir, { withFileTypes: true });
          } catch {
            // A directory that vanished or cannot be read is skipped, not fatal:
            // a search is best-effort over a tree somebody else is editing.
            return null;
          }
        }),
      );
      for (let w = 0; w < wave.length && !truncated; w++) {
        const dirents = listings[w];
        if (dirents === null) continue;
        const dir = wave[w];
        for (const dirent of dirents) {
          if (isIgnored(dirent.name, DEFAULT_IGNORES)) continue;
          if (isHidden(dirent.name) && !wantHidden) continue;
          if (++visited > SEARCH_VISIT_LIMIT) {
            truncated = true;
            break;
          }
          const absolute = join(dir, dirent.name);
          /* A symlink is listed as a file and never descended: following one is
             how a walk finds a cycle, and its target may be outside the project
             — which the read routes would refuse anyway. */
          const link = dirent.isSymbolicLink();
          const type: "dir" | "file" = !link && dirent.isDirectory() ? "dir" : "file";
          const rel = relative(baseReal, absolute).split(sep).join("/");
          const score = fuzzyScore(term, rel);
          if (score !== null)
            scored.push({
              entry: {
                name: dirent.name,
                path: `${prefix}${rel}`,
                type,
                ...(link ? { link: true } : {}),
              },
              score,
            });
          if (type === "dir") queue.push(absolute);
        }
      }
    }
  }

  /* Dirs first among equal scores, so an empty term (the drill-down) reads like
     a listing while a ranked search keeps its ranking. Then shorter and shallower
     wins: the file you meant is rarely the one buried deepest. */
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (a.entry.type === b.entry.type ? 0 : a.entry.type === "dir" ? -1 : 1) ||
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
  const root = await projectRoot(projectId);
  const absolute = resolveInProject(root, path);
  const stat = await statOfAsync(absolute);
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
  const root = await projectRoot(projectId);
  const absolute = resolveInProject(root, path);
  const stat = await statOfAsync(absolute);
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
  const root = await projectRoot(projectId);
  const absolute = resolveInProject(root, path);
  const stat = await statOfAsync(absolute);
  if (stat.isDirectory()) throw fail(400, "not a file");
  const ext = absolute.toLowerCase().split(".").pop() ?? "";
  if (stat.size > (ext in VIDEO_TYPES ? MAX_VIDEO_BYTES : MAX_READ_BYTES)) throw fail(413, "file is too large to read");
  const contentType = IMAGE_TYPES[ext] ?? VIDEO_TYPES[ext] ?? "application/octet-stream";
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

/** Video for the Preview panel's player. Its own ceiling: a product-video draft
    aims under 24 MB (docs/video.md), far past the 2 MB a text read allows. */
const VIDEO_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  ogv: "video/ogg",
};
const MAX_VIDEO_BYTES = 25 * 1024 * 1024;

export async function writeFile(
  projectId: string,
  path: string,
  content: string,
  options: WriteOptions = {},
): Promise<WorkspaceStat> {
  const root = await projectRoot(projectId);
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

export async function createEntry(
  projectId: string,
  path: string,
  type: "dir" | "file",
): Promise<WorkspaceEntry> {
  const root = await projectRoot(projectId);
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

export async function renameEntry(projectId: string, from: string, to: string): Promise<WorkspaceEntry> {
  const root = await projectRoot(projectId);
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

export async function deleteEntry(projectId: string, path: string): Promise<{ path: string }> {
  const root = await projectRoot(projectId);
  const absolute = resolveInProject(root, path);
  if (absolute === root) throw fail(400, "cannot delete the project root");
  statOf(absolute);
  /* No `force`: a delete of something that is not there should say so rather
     than report success, or the explorer will show a row it cannot remove. */
  rmSync(absolute, { recursive: true });
  return { path: relativePath(root, absolute) };
}
