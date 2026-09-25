/**
 * What each turn did to the project's working tree, measured by git.
 *
 * The transcript knows the edits a *tool* declared. It does not know what a
 * shell command did, and an agent that runs `sed`, a codemod or its own
 * script has changed the project just as much as one that called Edit. So a
 * turn's changes are read off the worktree, not the transcript: a tree object
 * is written when the turn starts and another when it ends
 * (`git.snapshotTree`), and the difference between the two is the turn's
 * footprint. Both trees live in the repository's own object store, so the
 * review panel can ask for the hunks of any turn for as long as git keeps
 * them (dangling objects are pruned after git's grace period, a fortnight by
 * default), and `files` — the summary — is kept in the row for the
 * transcript's "3 files changed" chip, which must not cost a git run per row.
 *
 * Snapshots are taken off the prompt path. `turn_started` is emitted
 * synchronously deep inside the bridge, and a queue drain starts the next
 * turn in the same tick the last one ended, so this module is told about a
 * turn and does its work on the next tick. The agent needs a model round-trip
 * before it can touch a file, and a snapshot from a stat-cached index takes
 * milliseconds; the window is real and it is documented, not hidden. A turn
 * that ends before its start snapshot finished waits for it (`starting`).
 *
 * A project that is not a git repository has no trees and the row says so
 * (`unavailable`), which the panel renders as a sentence rather than a
 * failure — see CLAUDE.md, "An error a surface could render as emptiness
 * must be rendered as an error".
 */
import { and, asc, eq, gte, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { join, relative, sep } from "node:path";

import { db, sessionTurnChanges, sessions as sessionsTable } from "./db/index.js";
import * as git from "./git.js";
import { HttpError } from "./http-error.js";
import type { ChangedFile, TurnChanges } from "./protocol.js";
import { watchProject, type WatchBatch } from "./workspace-watch.js";

/** What a review reads: one turn; the whole thread (its first measured
    turn's start tree → the worktree now); `uncommitted` (HEAD → now); or
    `branch` (the merge-base with the default branch → now). */
export type Scope =
  | { kind: "turn"; turnId: string }
  | { kind: "thread" }
  | { kind: "uncommitted" }
  | { kind: "branch" };

export interface TurnChangesDeps {
  /** The project's cwd, or null when the session's project is gone. */
  cwdOf: (sessionId: string) => string | null;
  /** Tell the thread's peers a row moved. */
  emit: (sessionId: string, turn: TurnChanges) => void;
  /** The project the thread runs in (its id and root), for the watcher. */
  projectOf: (sessionId: string) => { id: string; cwd: string } | null;
  /** The thread a turn's work belongs to: a child thread's (a workflow step)
      is its parent's, so a parent and its own subagents never count as two
      authors. */
  ownerOf: (sessionId: string) => string;
}

/**
 * A turn that is running, as the attribution sees it.
 *
 * git measures a window, not an author: two threads with turns open in one
 * repository both see each other's writes in their diff. The window cannot be
 * narrowed after the fact, but *while* it is open the project watcher says
 * when each path was written, and at that instant it is known which turns were
 * running in that repository. A write with one owner running is that owner's;
 * a write with several is `shared` among them and the file says so, naming the
 * others. It is measured, never read off the transcript — the client, which
 * does hold the transcript, is who may break the tie.
 */
interface LiveTurn {
  sessionId: string;
  owner: string;
  projectId: string;
  /** The repository the turn is measured in (absolute). */
  dir: string;
  /** Repo-relative path → the other owners that were running when it was written. */
  shared: Map<string, Set<string>>;
  /** Repo-relative paths written while this owner was the only one running. */
  mine: Set<string>;
  /** Every other owner whose turn overlapped this one in `dir`. */
  peers: Set<string>;
}

export class TurnChangesRecorder {
  private readonly deps: TurnChangesDeps;
  /** Start snapshots in flight, so an end that arrives first can wait. */
  private readonly starting = new Map<string, Promise<string | null>>();
  private readonly live = new Map<string, LiveTurn>();
  /** One watcher subscription per project with a turn running in it. */
  private readonly watching = new Map<string, Promise<(() => void) | null>>();

  constructor(deps: TurnChangesDeps) {
    this.deps = deps;
  }

  /** Called on the journaled `turn_started`. Fire-and-forget by design. */
  begin(sessionId: string, turnId: string): void {
    const key = `${sessionId}:${turnId}`;
    if (this.starting.has(key)) return; // a steer joins the running turn
    const startedAt = Date.now();
    const work = (async () => {
      const dir = await this.repoDirOf(sessionId);
      if (dir) this.track(key, sessionId, dir);
      const tree = dir ? await git.snapshotTree(dir).catch(warn("start snapshot")) ?? null : null;
      await db.insert(sessionTurnChanges)
        .values({ sessionId, turnId, startTree: tree, endTree: null, files: [], startedAt, endedAt: null })
        .onConflictDoUpdate({
          target: [sessionTurnChanges.sessionId, sessionTurnChanges.turnId],
          set: { startTree: tree },
        });
      this.deps.emit(sessionId, {
        turnId,
        files: [],
        ended: false,
        unavailable: tree === null,
        startedAt,
      });
      return tree;
    })().catch((err) => {
      warn("turn start")(err);
      return null;
    });
    this.starting.set(key, work);
  }

  /** Called on the journaled `turn_ended`. Fire-and-forget by design. */
  end(sessionId: string, turnId: string): void {
    const key = `${sessionId}:${turnId}`;
    const started = this.starting.get(key);
    this.starting.delete(key);
    void (async () => {
      const startTree = started ? await started : (await this.row(sessionId, turnId))?.startTree ?? null;
      const dir = await this.repoDirOf(sessionId);
      const endTree = dir && startTree ? await git.snapshotTree(dir).catch(warn("end snapshot")) ?? null : null;
      const measured = dir && startTree && endTree ? await git.diffTrees(dir, startTree, endTree).catch(warn("diff")) ?? [] : [];
      const files = annotate(measured, this.untrack(key));
      const endedAt = Date.now();
      const existing = await this.row(sessionId, turnId);
      const startedAt = existing?.startedAt ?? endedAt;
      await db.insert(sessionTurnChanges)
        .values({ sessionId, turnId, startTree, endTree, files, startedAt, endedAt })
        .onConflictDoUpdate({
          target: [sessionTurnChanges.sessionId, sessionTurnChanges.turnId],
          set: { endTree, files, endedAt },
        });
      this.deps.emit(sessionId, {
        turnId,
        files,
        ended: true,
        unavailable: startTree === null || endTree === null,
        startedAt,
      });
    })().catch(warn("turn end"));
  }

  /** Every recorded turn of a thread, oldest first. */
  async list(sessionId: string): Promise<TurnChanges[]> {
    return (await db
      .select()
      .from(sessionTurnChanges)
      .where(inArray(sessionTurnChanges.sessionId, await this.family(sessionId)))
      .orderBy(sessionTurnChanges.startedAt))
      .map((row) => ({
        turnId: row.turnId,
        files: row.files,
        ended: row.endedAt !== null,
        unavailable: row.startTree === null || (row.endedAt !== null && row.endTree === null),
        startedAt: row.startedAt,
        ...(row.sessionId !== sessionId ? { sessionId: row.sessionId } : {}),
      }));
  }

  /**
   * Close the rows a dead process left open. A turn's end is only ever
   * recorded off its `turn_ended`, and a server restart (or a bridge that
   * died mid-turn) never sends one — so the row said "running" forever and
   * `revert` refused it forever. Called once at boot, before any turn can
   * start: nothing is running yet, so every open row is an orphan. The end
   * tree stays null — nobody knows what the worktree looked like when it
   * stopped — so the turn reads live (start → now) and cannot be reverted.
   */
  async closeOrphans(): Promise<void> {
    await db.update(sessionTurnChanges)
      .set({ endedAt: Date.now() })
      .where(isNull(sessionTurnChanges.endedAt));
  }

  /** The same, for one thread whose process died without a `turn_ended`
      (called a tick after the process is gone, so a turn the close itself
      ended has already reached `end`, which took it out of `starting`). */
  processGone(sessionId: string): void {
    const prefix = `${sessionId}:`;
    const keys = [...this.starting.keys()].filter((key) => key.startsWith(prefix));
    if (keys.length === 0) return;
    for (const key of keys) {
      this.starting.delete(key);
      this.untrack(key);
    }
    void db.update(sessionTurnChanges)
      .set({ endedAt: Date.now() })
      .where(and(eq(sessionTurnChanges.sessionId, sessionId), isNull(sessionTurnChanges.endedAt)))
      .catch(warn("close open turns"));
  }

  /** The thread and its child threads: a subagent run as a thread (a
      workflow step) is part of the parent's work. One level, never a tree. */
  private async family(sessionId: string): Promise<string[]> {
    const children = await db
      .select({ id: sessionsTable.id })
      .from(sessionsTable)
      .where(eq(sessionsTable.parentSessionId, sessionId));
    return [sessionId, ...children.map((c) => c.id)];
  }

  /**
   * The files a scope covers, read live. A finished turn is its two recorded
   * trees; a running one (or one whose end snapshot failed) is its start tree
   * against the worktree right now; `uncommitted` is HEAD against the worktree
   * — including untracked files, which `git diff HEAD` alone would not show.
   */
  async files(sessionId: string, scope: Scope): Promise<{ files: ChangedFile[]; unavailable?: string }> {
    const sides = await this.sides(sessionId, scope);
    if ("unavailable" in sides) return { files: [], unavailable: sides.unavailable };
    return { files: await git.diffTrees(sides.dir, sides.from, sides.to) };
  }

  /** The unified patch for one path (or everything) under a scope. */
  async patch(sessionId: string, scope: Scope, path?: string): Promise<{ patch: string; unavailable?: string }> {
    const sides = await this.sides(sessionId, scope);
    if ("unavailable" in sides) return { patch: "", unavailable: sides.unavailable };
    return { patch: await git.patchBetween(sides.dir, sides.from, sides.to, path) };
  }

  /** One side of one file under a scope, whole — what a diff editor puts on
      its left (`before`) or right (`after`). */
  async file(
    sessionId: string,
    scope: Scope,
    path: string,
    side: "before" | "after",
  ): Promise<{ content: string; missing: boolean; unavailable?: string }> {
    const sides = await this.sides(sessionId, scope);
    if ("unavailable" in sides) return { content: "", missing: true, unavailable: sides.unavailable };
    return git.blobAt(sides.dir, side === "before" ? sides.from : sides.to, path);
  }

  private async sides(
    sessionId: string,
    scope: Scope,
  ): Promise<{ dir: string; from: string; to: string } | { unavailable: string }> {
    const dir = await this.repoDirOf(sessionId);
    if (!dir) return { unavailable: "This project is not a git repository." };
    if (scope.kind === "uncommitted") {
      const head = await git.hasObject(dir, "HEAD").then((ok) => (ok ? "HEAD" : null));
      const to = await git.snapshotTree(dir);
      /* No commit yet: everything is new, and the empty tree is what git
         compares an unborn branch against. */
      return { dir, from: head ?? EMPTY_TREE, to };
    }
    if (scope.kind === "branch") {
      const found = await git.branchBase(dir);
      if ("unavailable" in found) return found;
      return { dir, from: found.base, to: await git.snapshotTree(dir) };
    }
    if (scope.kind === "thread") {
      const [first] = await db
        .select({ startTree: sessionTurnChanges.startTree })
        .from(sessionTurnChanges)
        .where(and(eq(sessionTurnChanges.sessionId, sessionId), isNotNull(sessionTurnChanges.startTree)))
        .orderBy(asc(sessionTurnChanges.startedAt))
        .limit(1);
      if (!first?.startTree) return { unavailable: "No turn of this thread has been measured yet." };
      if (!(await git.hasObject(dir, first.startTree)))
        return { unavailable: "The thread's first snapshot has been pruned by git and can no longer be compared." };
      return { dir, from: first.startTree, to: await git.snapshotTree(dir) };
    }
    const row = await this.row(sessionId, scope.turnId);
    if (!row?.startTree) return { unavailable: "This turn was not measured — the project was not a repository when it ran." };
    if (!(await git.hasObject(dir, row.startTree)))
      return { unavailable: "This turn's snapshot has been pruned by git and can no longer be compared." };
    const to = row.endTree && (await git.hasObject(dir, row.endTree)) ? row.endTree : await git.snapshotTree(dir);
    return { dir, from: row.startTree, to };
  }

  /**
   * Put one ended turn's paths back as its start tree had them, in the
   * working tree only (`git.revertTurn`). Non-empty `conflicts` with nothing
   * `reverted` means refused: those paths moved since the turn ended. The
   * caller refuses a running thread — this only knows trees.
   */
  async revert(
    sessionId: string,
    turnId: string,
    force: boolean,
  ): Promise<{ reverted: string[]; conflicts: string[] }> {
    const dir = await this.repoDirOf(sessionId);
    if (!dir) throw new HttpError("This project is not a git repository.", 409);
    const row = await this.row(sessionId, turnId);
    if (!row) throw new HttpError("unknown turn", 404);
    if (row.endedAt === null) throw new HttpError("this turn is still running", 409);
    if (!row.startTree || !row.endTree) throw new HttpError("This turn was not measured, so it cannot be reverted.", 409);
    for (const tree of [row.startTree, row.endTree])
      if (!(await git.hasObject(dir, tree)))
        throw new HttpError("This turn's snapshot has been pruned by git, so it cannot be reverted.", 409);
    return git.revertTurn(dir, row.startTree, row.endTree, force);
  }

  /** A turn of this thread or of one of its child threads — turn ids are
      minted uuids, so a parent reading its step's turn cannot collide. */
  private async row(sessionId: string, turnId: string) {
    return (await db
      .select()
      .from(sessionTurnChanges)
      .where(and(
        eq(sessionTurnChanges.turnId, turnId),
        or(
          eq(sessionTurnChanges.sessionId, sessionId),
          inArray(sessionTurnChanges.sessionId, db
            .select({ id: sessionsTable.id })
            .from(sessionsTable)
            .where(eq(sessionsTable.parentSessionId, sessionId))),
        ),
      ))
      .limit(1))[0];
  }

  /** Start attributing writes to a turn — see `LiveTurn`. */
  private track(key: string, sessionId: string, dir: string): void {
    const project = this.deps.projectOf(sessionId);
    if (!project) return;
    const turn: LiveTurn = {
      sessionId,
      owner: this.deps.ownerOf(sessionId),
      projectId: project.id,
      dir,
      shared: new Map(),
      mine: new Set(),
      peers: new Set(),
    };
    for (const other of this.live.values()) {
      if (other.dir !== dir || other.owner === turn.owner) continue;
      other.peers.add(turn.owner);
      turn.peers.add(other.owner);
    }
    this.live.set(key, turn);
    if (!this.watching.has(project.id)) {
      const root = project.cwd;
      this.watching.set(project.id, watchProject(
        project.id,
        (batch) => this.observe(root, batch),
        () => this.watching.delete(project.id),
      ).catch((err) => {
        warn("watch")(err);
        this.watching.delete(project.id);
        return null;
      }));
    }
  }

  /** Stop attributing; hands back what was seen. Releases the project's
      watcher when this was its last running turn. */
  private untrack(key: string): LiveTurn | undefined {
    const turn = this.live.get(key);
    if (!turn) return undefined;
    this.live.delete(key);
    if ([...this.live.values()].some((t) => t.projectId === turn.projectId)) return turn;
    const stop = this.watching.get(turn.projectId);
    this.watching.delete(turn.projectId);
    void stop?.then((unsubscribe) => unsubscribe?.());
    return turn;
  }

  private observe(root: string, batch: WatchBatch): void {
    for (const event of batch.events) {
      const abs = join(root, event.path);
      const running = [...this.live.values()].filter((t) => t.projectId === batch.projectId && abs.startsWith(t.dir + sep));
      const owners = new Set(running.map((t) => t.owner));
      for (const turn of running) {
        const rel = relative(turn.dir, abs).split(sep).join("/");
        if (owners.size === 1) {
          turn.mine.add(rel);
          continue;
        }
        const others = turn.shared.get(rel) ?? new Set<string>();
        for (const owner of owners) if (owner !== turn.owner) others.add(owner);
        turn.shared.set(rel, others);
      }
    }
    /* Too much at once to enumerate: every running turn in the project had a
       peer writing at the same moment, and nothing better is known. */
    if (batch.overflow) for (const turn of this.live.values())
      if (turn.projectId === batch.projectId && turn.peers.size > 0) turn.shared.set("*", new Set(turn.peers));
  }

  /** The tree the worktree was photographed as when `turnId` began — a
      rewind's file half restores to it. Null when the turn was never
      measured (no repository at the time, or the row is gone); the caller
      refuses on that rather than guessing. */
  async startTreeOf(sessionId: string, turnId: string): Promise<string | null> {
    return (await this.row(sessionId, turnId))?.startTree ?? null;
  }

  /**
   * Drop every turn-changes row from `turnId` onward (inclusive) — called
   * once a rewind to `turnId` has committed, because those rows describe
   * turns the journal no longer holds.
   *
   * `startedAt` is stamped per `begin()`, so within a session it orders the
   * turns exactly as their seqs do, and the sweep is one range delete on it.
   * A missing target row is a no-op, not an error: the turn may never have
   * been measured, or an earlier rewind may already have taken it.
   */
  async pruneFrom(sessionId: string, turnId: string): Promise<void> {
    const target = await this.row(sessionId, turnId);
    if (!target) return;
    await db.delete(sessionTurnChanges)
      .where(and(eq(sessionTurnChanges.sessionId, sessionId), gte(sessionTurnChanges.startedAt, target.startedAt)));
  }


  private async repoDirOf(sessionId: string): Promise<string | null> {
    const cwd = this.deps.cwdOf(sessionId);
    if (!cwd) return null;
    try {
      return await git.repoDirAt(cwd);
    } catch {
      return null;
    }
  }
}

/**
 * Mark the files another thread may have written. A turn nobody overlapped is
 * left alone. One that did: a path the watcher saw written while a peer ran is
 * `shared` with the peers that were running; one seen only while this owner
 * ran alone is its own; one never seen (ignored by the watcher, lost in an
 * overflow, written before the watch was up) is shared with every peer,
 * because not knowing is not the same as knowing it was ours.
 */
export function annotate(
  files: ChangedFile[],
  turn: Pick<LiveTurn, "shared" | "mine" | "peers"> | undefined,
): ChangedFile[] {
  if (!turn || turn.peers.size === 0) return files;
  const everyone = turn.shared.get("*");
  return files.map((file) => {
    const others = everyone ?? turn.shared.get(file.path);
    if (others) return { ...file, shared: [...others] };
    if (turn.mine.has(file.path)) return file;
    return { ...file, shared: [...turn.peers] };
  });
}

/** git's well-known empty tree, the base an unborn branch diffs against. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const warn = (what: string) => (err: unknown) => {
  console.warn(`[turn-changes] ${what} failed:`, err instanceof Error ? err.message : err);
  return undefined;
};
