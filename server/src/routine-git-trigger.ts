/* ── Routine git triggers ──
 *
 * The third front door onto `RoutineEngine.fire`, and the only one with no
 * clock and no caller: a routine fires because the repository under its project
 * moved. Everything after the fire — the run row, the overlap policy, the live
 * cap, the quota floor, the untrusted payload wrapper — is unchanged and lives
 * in `routines.ts`. This file decides *when*, and nothing else.
 *
 * Four rules, and they are the whole file:
 *
 * **Only projects that have a reason are watched.** A recursive `fs.watch` on a
 * source tree is an inotify handle per directory; a project nobody has pointed
 * a git trigger at must not cost one. The set is reconciled from the rows, so a
 * trigger being disabled or deleted releases the handle and the last one
 * leaving closes it (`workspace-watch.ts` ref-counts for exactly this).
 *
 * **One fire per debounce window, trailing edge, never reset.** A rebase, a
 * `pull --rebase`, a branch switch and a `git commit --amend` each move HEAD
 * several times inside a second, and every one of those writes is a separate
 * inotify event. The window opens on the first signal and closes `debounceMs`
 * later whatever else arrives — *not* reset per event, which under a continuous
 * writer (a long rebase, a `pnpm install` in a watched path) would postpone the
 * fire indefinitely and is the classic way a debounce becomes a starvation bug.
 *
 * **A ref move is read off the watcher, not off a plumbing command we invent.**
 * `git.ts` exposes discovery and status but no commit oid, and a project may
 * hold several repositories, so "did the HEAD of `main` in `packages/app` move"
 * cannot be answered by asking the project's own directory. It can be answered
 * by *where the write landed*: git records a moved branch by writing
 * `<repo>/.git/refs/heads/<branch>`, `<repo>/.git/packed-refs` or, for a
 * checkout, `<repo>/.git/HEAD` — all of which arrive as ordinary watcher paths
 * naming both the repository and the ref. Nothing here parses a git file; the
 * path is the whole signal, and `git.repositories()` (cached) supplies the
 * branch name a bare `HEAD` write does not carry.
 *
 * **A signal is not yet a fire.** `.git` is written for a great many reasons
 * that are not a commit, so a ref move in the project's own repository is
 * confirmed against `projectHeadOid` before anything spawns: an oid equal to
 * the one the last fire recorded means the tree churned and the history did
 * not. A sub-repository has no such second opinion available, and gets the
 * benefit of the doubt rather than a silently dropped trigger.
 */
import { and, eq } from "drizzle-orm";
import { db, routineTriggers as triggersTable } from "./db/index.js";
import { repositories, type GitRepo } from "./git.js";
import {
  getRoutine,
  getTrigger,
  markTriggerError,
  markTriggerFired,
  projectHeadOid,
  type RoutineEngine,
  type RoutineTrigger,
} from "./routines.js";
import { watchProject, type WatchBatch } from "./workspace-watch.js";

/**
 * How often the watched set is re-read from the rows.
 *
 * A poll rather than a hook, because trigger CRUD is four exported functions in
 * `routines.ts` and a route file, and threading a notification through all of
 * them to save a `SELECT … WHERE kind = 'git'` every half minute — one indexed
 * scan of a table that holds tens of rows — would be a lot of coupling bought
 * with nothing. It is also what heals a watcher that tore itself down after an
 * `fs.watch` error, and what picks a project back up after it was deleted and
 * re-created.
 */
const RECONCILE_MS = 30_000;

/** Floor under a trigger's own `debounce_ms`. A window shorter than this is not
    a debounce — the writes of one `git commit` are not reliably inside it, and
    the routine fires twice for one commit. */
const MIN_DEBOUNCE_MS = 1_000;

/** How long `git.repositories()` is trusted for. Discovery is a directory walk
    plus one `rev-parse` per repository, and it answers a question — where are
    the checkouts, and what branch is each on — that changes on the order of a
    branch switch, not of a keystroke. */
const REPOS_TTL_MS = 60_000;

/** Paths named in a fire's payload before it says "and N more". The payload is
    context for the agent, not a changelog. */
const PAYLOAD_PATHS = 20;

/**
 * A `.git` write that means a branch moved, with the repository and the ref it
 * names captured.
 *
 * Deliberately narrow. `ORIG_HEAD`, `FETCH_HEAD`, `index`, `index.lock`,
 * `COMMIT_EDITMSG` and everything under `logs/` are written constantly by reads
 * and by commands that change no history, and a trigger that fired on them
 * would fire on `git status`. `refs/remotes/…` is excluded for the same reason:
 * a fetch is not work landing in this project's tree.
 */
const REF_WRITE = /(?:^|\/)\.git\/(HEAD|packed-refs|refs\/heads\/(.+))$/;

/** Anything inside a repository's private directory. Never a "path changed". */
const INSIDE_GIT = /(?:^|\/)\.git(?:\/|$)/;

interface RefMove {
  /** Project-relative directory of the repository, `""` for the project's own. */
  repo: string;
  /** The branch the write named, or null when only `HEAD`/`packed-refs` moved
      and the current branch has to be looked up. */
  ref: string | null;
}

/** What one debounce window has collected for one trigger. */
interface Window {
  timer: ReturnType<typeof setTimeout>;
  refs: RefMove[];
  paths: Set<string>;
  /** The watcher stopped enumerating (`WatchBatch.overflow`) — more changed than
      it could name. */
  unknownPaths: boolean;
}

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

const compiled = new Map<string, RegExp>();

/**
 * A path glob, compiled.
 *
 * `*` does not cross a separator and `**` does, which is the convention every
 * ignore file and CI path filter already uses, so a pattern a person types from
 * habit means what they expect. `**` followed by a separator also matches zero
 * segments, so `**\/*.ts` matches `index.ts` at the root — without that, the
 * most obvious pattern anyone writes silently misses the top level. A trailing
 * `/` means "anything under this directory".
 *
 * Hand-rolled rather than a dependency: this is the whole of what is needed,
 * and a glob library is a parser reading strings out of the database.
 */
function globToRegExp(pattern: string): RegExp {
  const cached = compiled.get(pattern);
  if (cached) return cached;
  const source = pattern.endsWith("/") ? `${pattern}**` : pattern;
  let out = "";
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (c === "*") {
      if (source[i + 1] === "*") {
        i += 1;
        if (source[i + 1] === "/") {
          i += 1;
          out += "(?:.*/)?";
        } else out += ".*";
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  const re = new RegExp(`^${out}$`);
  /* Patterns come from rows a person wrote, so the cache is bounded by the
     library and not by traffic — but a routine edited in a loop would still
     grow it forever, and a cleared cache costs one recompile. */
  if (compiled.size > 500) compiled.clear();
  compiled.set(pattern, re);
  return re;
}

const matchesAny = (path: string, patterns: string[]): boolean =>
  patterns.some((p) => globToRegExp(p).test(path));

// ---------------------------------------------------------------------------

export interface GitTriggerDeps {
  engine: RoutineEngine;
}

/**
 * The watcher half of the `git` trigger kind.
 *
 * One instance per process, started from `index.ts` after the engine. It owns
 * no timers a caller has to know about and no state that survives it: `stop()`
 * releases every subscription, which is what lets the shutdown path close the
 * underlying watchers without racing a resubscribe.
 */
export class RoutineGitTriggers {
  private engine: RoutineEngine;
  /** Unsubscribe per watched project. The key set IS the watched set. */
  private watching = new Map<string, () => void>();
  /** Open debounce window per trigger id. */
  private windows = new Map<string, Window>();
  private repos = new Map<string, { at: number; list: GitRepo[] }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(deps: GitTriggerDeps) {
    this.engine = deps.engine;
  }

  /** Begin watching. Idempotent; one loop for the whole process. */
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.reconcile();
    this.timer = setInterval(() => this.reconcile(), RECONCILE_MS);
    /* Unref'd like every other sweep here: a file watcher must never be the
       reason the process refuses to exit. */
    this.timer.unref();
  }

  /** Release every watcher and every open window. Called before
      `stopWatching()` in the shutdown path, so nothing resubscribes behind it. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const window of this.windows.values()) clearTimeout(window.timer);
    this.windows.clear();
    for (const unsubscribe of this.watching.values()) unsubscribe();
    this.watching.clear();
    this.repos.clear();
  }

  /**
   * Bring the watched set in line with the rows.
   *
   * A project is watched when it has at least one enabled `git` trigger whose
   * routine is itself enabled — a routine switched off keeps its triggers and
   * costs nothing, which is the same bargain the scheduler makes for a disabled
   * routine's clock.
   */
  reconcile(): void {
    if (this.stopped) return;
    const wanted = new Set<string>();
    for (const trigger of this.enabledTriggers()) {
      const routine = getRoutine(trigger.routineId);
      if (routine?.enabled) wanted.add(routine.projectId);
    }

    for (const [projectId, unsubscribe] of [...this.watching]) {
      if (wanted.has(projectId)) continue;
      unsubscribe();
      this.watching.delete(projectId);
      this.repos.delete(projectId);
    }

    for (const projectId of wanted) {
      if (this.watching.has(projectId)) continue;
      try {
        this.watching.set(
          projectId,
          watchProject(
            projectId,
            (batch) => this.onBatch(batch),
            /* Torn down under us — an `fs.watch` error, or the project going
               away. Forget it rather than resubscribing here: an immediate
               retry against a watcher that just failed is a hot loop, and the
               next reconcile is at most `RECONCILE_MS` away and re-reads the
               rows on the way, so a project that is genuinely gone is not
               picked back up at all. */
            () => {
              this.watching.delete(projectId);
              this.repos.delete(projectId);
            },
          ),
        );
      } catch (error) {
        /* An unknown project or a directory that has moved. Not fatal and not
           worth a line every thirty seconds — it is recorded on each of the
           project's triggers instead, where the form can print it, and only
           when the message changed. */
        const message = describe(error);
        for (const trigger of this.triggersForProject(projectId)) {
          if (trigger.lastError !== message) markTriggerError(trigger.id, message);
        }
      }
    }
  }

  /** Watched project ids. For tests and for reasoning about the handle count. */
  watchedProjects(): string[] {
    return [...this.watching.keys()];
  }

  // ---- collecting ----

  private enabledTriggers(): RoutineTrigger[] {
    return db
      .select()
      .from(triggersTable)
      .where(and(eq(triggersTable.kind, "git"), eq(triggersTable.enabled, true)))
      .all();
  }

  private triggersForProject(projectId: string): RoutineTrigger[] {
    return this.enabledTriggers().filter((t) => {
      const routine = getRoutine(t.routineId);
      return routine?.enabled === true && routine.projectId === projectId;
    });
  }

  /**
   * One batch of file events, fanned out to the project's triggers.
   *
   * The two signals are separated here rather than at fire time because they
   * are answered differently: a ref move names a repository and a branch and is
   * checked against the trigger's `branch`, while a path change is matched
   * against its globs. A trigger interested in neither collects nothing and
   * never opens a window.
   */
  private onBatch(batch: WatchBatch): void {
    if (this.stopped) return;
    const refs: RefMove[] = [];
    const paths: string[] = [];
    for (const event of batch.events) {
      const match = REF_WRITE.exec(event.path);
      if (match) {
        const repo = event.path.slice(0, Math.max(0, event.path.lastIndexOf(".git/") - 1));
        refs.push({ repo, ref: match[2] ?? null });
        continue;
      }
      if (!INSIDE_GIT.test(event.path)) paths.push(event.path);
    }
    if (refs.length === 0 && paths.length === 0 && !batch.overflow) return;

    for (const trigger of this.triggersForProject(batch.projectId)) {
      const wantsPaths = trigger.paths.length > 0;
      const hitPaths = wantsPaths ? paths.filter((p) => matchesAny(p, trigger.paths)) : [];
      /* An overflowed batch stopped naming paths, so a path-filtered trigger
         cannot prove it was missed and cannot prove it was hit. It is counted
         as a hit: two hundred paths inside one batch is a checkout, an install
         or a build, and a trigger that watches a directory almost certainly
         wanted to hear about it. A trigger with no path filter is unaffected —
         it still needs a ref to have moved. */
      const overflowHit = wantsPaths && batch.overflow;
      if (refs.length === 0 && hitPaths.length === 0 && !overflowHit) continue;
      this.collect(trigger, refs, hitPaths, overflowHit);
    }
  }

  /** Add to a trigger's open window, opening one if this is the first signal. */
  private collect(
    trigger: RoutineTrigger,
    refs: RefMove[],
    paths: string[],
    unknownPaths: boolean,
  ): void {
    let window = this.windows.get(trigger.id);
    if (!window) {
      const wait = Math.max(MIN_DEBOUNCE_MS, trigger.debounceMs);
      window = { timer: setTimeout(() => void this.evaluate(trigger.id), wait), refs: [], paths: new Set(), unknownPaths: false };
      window.timer.unref();
      this.windows.set(trigger.id, window);
    }
    window.refs.push(...refs);
    for (const path of paths) window.paths.add(path);
    window.unknownPaths ||= unknownPaths;
  }

  // ---- deciding ----

  /**
   * A debounce window closed: decide whether this is a fire, and fire it.
   *
   * Every row is re-read rather than carried in the window. A minute is a long
   * time in this file — the debounce may be five of them — and the trigger, the
   * routine and the project are all editable while it is open, so acting on the
   * row that opened the window would fire a routine somebody had just disabled.
   */
  private async evaluate(triggerId: string): Promise<void> {
    const window = this.windows.get(triggerId);
    this.windows.delete(triggerId);
    if (!window || this.stopped) return;

    const trigger = getTrigger(triggerId);
    if (!trigger || !trigger.enabled || trigger.kind !== "git") return;
    const routine = getRoutine(trigger.routineId);
    /* A disabled routine keeps its triggers and runs nothing — and deliberately
       writes no `skipped` run, exactly as the scheduler decides for a disabled
       routine's slot: a state is not an event, and a project worked in all week
       would otherwise accumulate a row per commit saying it was switched off. */
    if (!routine?.enabled) return;

    let refHit: RefMove[] = [];
    try {
      refHit = await this.movedRefs(routine.projectId, window.refs, trigger.branch);
    } catch (error) {
      const message = describe(error);
      if (trigger.lastError !== message) markTriggerError(trigger.id, message);
      return;
    }
    const pathHit = window.unknownPaths || window.paths.size > 0;
    if (refHit.length === 0 && !pathHit) return;

    /* Best effort, and only ever a second opinion: null is an ordinary answer
       (not a repository, no commits yet, a directory that has moved) and every
       one of those means the check cannot say "nothing happened". */
    const headOid = await projectHeadOid(routine.projectId);
    /* The confirmation. A write under the project's own `.git` that left the
       project's HEAD exactly where the last fire found it changed the tree and
       not the history — a `git gc`, a `packed-refs` rewrite, a checkout of the
       commit already checked out. Applied only when the refs that moved are all
       the project's own repository (a sub-repository's oid is not this one, so
       equality here says nothing about it) and only when nothing else fired. */
    const onlyRoot = refHit.every((r) => r.repo === "");
    if (!pathHit && onlyRoot && headOid !== null && headOid === trigger.lastSeen) return;

    try {
      /* Not through `authorizeFire`: that rate limit is about the shape of
         traffic at an unauthenticated door, and this door is a file watcher
         inside the process. The debounce window is this path's own ceiling. */
      await this.engine.fire(routine.id, {
        source: "git",
        triggerId: trigger.id,
        headOid,
        text: describeFire(refHit, window),
      });
      /* `nextFireAt` stays null: a git trigger has no clock, and the scheduler's
         sweep only ever selects `kind = "schedule"`, so nothing else reads it. */
      markTriggerFired(trigger.id, Date.now(), null, headOid);
    } catch (error) {
      /* `fire` only throws for a routine that no longer exists; everything it
         decides is a `skipped` row it wrote itself. */
      markTriggerError(trigger.id, describe(error));
    }
  }

  /**
   * The ref moves that this trigger's `branch` cares about.
   *
   * A null branch is "any", which is every collected move. A named branch keeps
   * the writes that named it outright, plus a bare `HEAD`/`packed-refs` write in
   * a repository whose current branch *is* it — that second case is what makes a
   * `git commit` on `main` fire a `main` trigger when git chose to update the
   * packed refs rather than the loose one, and what keeps switching *away* from
   * `main` from firing it.
   */
  private async movedRefs(
    projectId: string,
    refs: RefMove[],
    branch: string | null,
  ): Promise<RefMove[]> {
    if (refs.length === 0 || branch === null) return refs;
    const named = refs.filter((r) => r.ref === branch);
    const bare = refs.filter((r) => r.ref === null);
    if (bare.length === 0) return named;
    const list = await this.repositories(projectId);
    const current = new Map(list.map((repo) => [repo.path, repo.branch]));
    return [...named, ...bare.filter((r) => current.get(r.repo) === branch)];
  }

  /** `git.repositories()`, cached — see `REPOS_TTL_MS`. */
  private async repositories(projectId: string): Promise<GitRepo[]> {
    const hit = this.repos.get(projectId);
    if (hit && Date.now() - hit.at < REPOS_TTL_MS) return hit.list;
    const list = await repositories(projectId);
    this.repos.set(projectId, { at: Date.now(), list });
    return list;
  }
}

/**
 * What the run's thread is told about why it woke up.
 *
 * Context, not instruction: it travels as `fire`'s `text`, which the engine
 * wraps in `FIRE_PAYLOAD_OPEN`/`_CLOSE` with the untrusted-data preamble like
 * any other caller's words. Branch names and paths are attacker-influenceable
 * in a repository with contributors, so none of it is interpolated into the
 * routine's own prompt and none of it is ever parsed back.
 */
function describeFire(refs: RefMove[], window: Window): string {
  const lines: string[] = [];
  const moved = [
    ...new Set(
      refs.map((r) => {
        const where = r.repo === "" ? "" : ` in ${r.repo}`;
        return `${r.ref ?? "HEAD"}${where}`;
      }),
    ),
  ];
  if (moved.length > 0) lines.push(`Branches that moved: ${moved.join(", ")}`);
  if (window.unknownPaths) {
    lines.push("Too many files changed at once to list them.");
  } else if (window.paths.size > 0) {
    const paths = [...window.paths];
    const shown = paths.slice(0, PAYLOAD_PATHS).join(", ");
    const rest = paths.length - PAYLOAD_PATHS;
    lines.push(`Files that changed: ${shown}${rest > 0 ? ` (and ${rest} more)` : ""}`);
  }
  return lines.join("\n");
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
