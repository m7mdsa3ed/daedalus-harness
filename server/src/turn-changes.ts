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
import { and, eq } from "drizzle-orm";

import { db, sessionTurnChanges } from "./db/index.js";
import * as git from "./git.js";
import type { ChangedFile, TurnChanges } from "./protocol.js";

export type Scope = { kind: "turn"; turnId: string } | { kind: "uncommitted" };

export interface TurnChangesDeps {
  /** The project's cwd, or null when the session's project is gone. */
  cwdOf: (sessionId: string) => string | null;
  /** Tell the thread's peers a row moved. */
  emit: (sessionId: string, turn: TurnChanges) => void;
}

export class TurnChangesRecorder {
  private readonly deps: TurnChangesDeps;
  /** Start snapshots in flight, so an end that arrives first can wait. */
  private readonly starting = new Map<string, Promise<string | null>>();

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
      const tree = dir ? await git.snapshotTree(dir).catch(warn("start snapshot")) ?? null : null;
      db.insert(sessionTurnChanges)
        .values({ sessionId, turnId, startTree: tree, endTree: null, files: [], startedAt, endedAt: null })
        .onConflictDoUpdate({
          target: [sessionTurnChanges.sessionId, sessionTurnChanges.turnId],
          set: { startTree: tree },
        })
        .run();
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
      const startTree = started ? await started : this.row(sessionId, turnId)?.startTree ?? null;
      const dir = await this.repoDirOf(sessionId);
      const endTree = dir && startTree ? await git.snapshotTree(dir).catch(warn("end snapshot")) ?? null : null;
      const files = dir && startTree && endTree ? await git.diffTrees(dir, startTree, endTree).catch(warn("diff")) ?? [] : [];
      const endedAt = Date.now();
      const existing = this.row(sessionId, turnId);
      const startedAt = existing?.startedAt ?? endedAt;
      db.insert(sessionTurnChanges)
        .values({ sessionId, turnId, startTree, endTree, files, startedAt, endedAt })
        .onConflictDoUpdate({
          target: [sessionTurnChanges.sessionId, sessionTurnChanges.turnId],
          set: { endTree, files, endedAt },
        })
        .run();
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
  list(sessionId: string): TurnChanges[] {
    return db
      .select()
      .from(sessionTurnChanges)
      .where(eq(sessionTurnChanges.sessionId, sessionId))
      .orderBy(sessionTurnChanges.startedAt)
      .all()
      .map((row) => ({
        turnId: row.turnId,
        files: row.files,
        ended: row.endedAt !== null,
        unavailable: row.startTree === null || (row.endedAt !== null && row.endTree === null),
        startedAt: row.startedAt,
      }));
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
    const row = this.row(sessionId, scope.turnId);
    if (!row?.startTree) return { unavailable: "This turn was not measured — the project was not a repository when it ran." };
    if (!(await git.hasObject(dir, row.startTree)))
      return { unavailable: "This turn's snapshot has been pruned by git and can no longer be compared." };
    const to = row.endTree && (await git.hasObject(dir, row.endTree)) ? row.endTree : await git.snapshotTree(dir);
    return { dir, from: row.startTree, to };
  }

  private row(sessionId: string, turnId: string) {
    return db
      .select()
      .from(sessionTurnChanges)
      .where(and(eq(sessionTurnChanges.sessionId, sessionId), eq(sessionTurnChanges.turnId, turnId)))
      .get();
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

/** git's well-known empty tree, the base an unborn branch diffs against. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const warn = (what: string) => (err: unknown) => {
  console.warn(`[turn-changes] ${what} failed:`, err instanceof Error ? err.message : err);
  return undefined;
};
