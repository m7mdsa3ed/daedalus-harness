/* Boards and their columns.
 *
 * A board is a kanban; a status is one of its columns. Both are rows, which is
 * the point of this file: the four statuses used to be a TypeScript union
 * repeated across the schema, two zod files and the client, so adding one was a
 * six-file edit and a schema push. Here a status is a row with a name, and a
 * task's `statusId` points at it.
 *
 * No foreign keys, matching `tasks` (see schema.ts). SQLite would have to
 * either cascade a status delete into its tasks — silently destroying work — or
 * refuse it. Neither is the answer: deleting a column is a question ("where do
 * its tasks go?"), so `deleteStatus` takes the answer as an argument and moves
 * them. Every cascade here is written out in one transaction instead.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { boardStatuses, boards, db, tasks as tasksTable } from "./db/index.js";
import { HttpError } from "./http-error.js";

export type Board = typeof boards.$inferSelect;
export type BoardStatus = typeof boardStatuses.$inferSelect;

/** The board every install starts with, and the one legacy tasks already name. */
export const DEFAULT_BOARD_ID = "default";

/** Palette tokens a board or column may be tinted with. The client maps these
    to theme classes; the server only checks membership, so a stored value can
    never be arbitrary CSS. */
export const BOARD_COLORS = ["slate", "blue", "violet", "emerald", "amber", "rose"] as const;
export type BoardColor = (typeof BOARD_COLORS)[number];

/**
 * The columns a brand-new board is born with.
 *
 * Also the *migration*: seeded onto the default board, these ids are the exact
 * strings pre-boards tasks already hold in `tasks.status`, so the enum becomes
 * a foreign key with no row rewritten. Only the default board gets these ids —
 * every other board mints UUIDs.
 */
const SEED_STATUSES: { id: string; name: string; color: BoardColor }[] = [
  { id: "todo", name: "To do", color: "slate" },
  { id: "in_progress", name: "In progress", color: "blue" },
  { id: "blocked", name: "Blocked", color: "rose" },
  { id: "done", name: "Done", color: "emerald" },
];

// ---- input schemas ----

const BoardName = z.string().trim().min(1).max(120);
const Color = z.enum(BOARD_COLORS).nullable().optional();

export const CreateBoardSchema = z.object({
  name: BoardName,
  color: Color,
  /** Column names to start with; omitted = the four seed columns. */
  statuses: z.array(z.string().trim().min(1).max(60)).max(24).optional(),
});

export const UpdateBoardSchema = z
  .object({ name: BoardName.optional(), color: Color, order: z.number().int().min(0).optional() })
  .refine((patch) => Object.keys(patch).length > 0, "nothing to update");

export const CreateStatusSchema = z.object({
  name: z.string().trim().min(1).max(60),
  color: Color,
  /** Where to insert it; omitted = last. */
  order: z.number().int().min(0).optional(),
});

export const UpdateStatusSchema = z
  .object({ name: z.string().trim().min(1).max(60).optional(), color: Color })
  .refine((patch) => Object.keys(patch).length > 0, "nothing to update");

export const ReorderStatusesSchema = z.object({ ids: z.array(z.string().min(1)).max(64) });

export type CreateBoardInput = z.infer<typeof CreateBoardSchema>;
export type UpdateBoardInput = z.infer<typeof UpdateBoardSchema>;
export type CreateStatusInput = z.infer<typeof CreateStatusSchema>;
export type UpdateStatusInput = z.infer<typeof UpdateStatusSchema>;

/** Raised for the cases a caller can fix by asking differently — the routes
    turn these into a 400/404 rather than a 500. */
export class BoardError extends HttpError {
  constructor(message: string, status = 400) {
    super(message, status);
    this.name = "BoardError";
  }
}

// ---- reads ----

export function listBoards(): Board[] {
  return db.select().from(boards).orderBy(asc(boards.order), asc(boards.createdAt)).all();
}

export function getBoard(id: string): Board | undefined {
  return db.select().from(boards).where(eq(boards.id, id)).get();
}

/** Every status on one board, left to right. */
export function listStatuses(boardId: string): BoardStatus[] {
  return db
    .select()
    .from(boardStatuses)
    .where(eq(boardStatuses.boardId, boardId))
    .orderBy(asc(boardStatuses.order), asc(boardStatuses.createdAt))
    .all();
}

/** Every status on every board — one query, so the client can load the whole
    switcher without a request per board. */
export function listAllStatuses(): BoardStatus[] {
  return db
    .select()
    .from(boardStatuses)
    .orderBy(asc(boardStatuses.boardId), asc(boardStatuses.order), asc(boardStatuses.createdAt))
    .all();
}

export function getStatus(id: string): BoardStatus | undefined {
  return db.select().from(boardStatuses).where(eq(boardStatuses.id, id)).get();
}

/** The column a task lands in when the caller named none: the board's first. */
export function firstStatusId(boardId: string): string | undefined {
  return listStatuses(boardId)[0]?.id;
}

// ---- writes ----

function insertStatus(
  boardId: string,
  spec: { id?: string; name: string; color?: BoardColor | null; order: number },
  now: number,
): BoardStatus {
  const id = spec.id ?? randomUUID();
  db.insert(boardStatuses)
    .values({
      id,
      boardId,
      name: spec.name,
      color: spec.color ?? null,
      order: spec.order,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return getStatus(id)!;
}

/**
 * Make sure the install has a board to draw.
 *
 * Idempotent and called at boot (see index.ts), the way `seedAgents` is: an
 * install that predates boards has tasks whose `status` values are exactly the
 * ids seeded here, so creating these rows is what makes those tasks legible —
 * no data migration, and no window in which the board renders empty. It seeds
 * only into a database with *no boards at all*, so a user who renamed or
 * deleted these columns never gets them back uninvited.
 */
export function ensureDefaultBoard(): void {
  if (db.select({ id: boards.id }).from(boards).limit(1).all().length > 0) return;
  const now = Date.now();
  db.transaction(() => {
    db.insert(boards)
      .values({
        id: DEFAULT_BOARD_ID,
        name: "Tasks",
        color: null,
        order: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    SEED_STATUSES.forEach((seed, index) =>
      insertStatus(DEFAULT_BOARD_ID, { ...seed, order: index }, now),
    );
  });
}

export function createBoard(input: CreateBoardInput): Board {
  const id = randomUUID();
  const now = Date.now();
  const names = input.statuses?.length ? input.statuses : null;
  db.transaction(() => {
    db.insert(boards)
      .values({
        id,
        name: input.name,
        color: input.color ?? null,
        order: listBoards().length,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    if (names) {
      names.forEach((name, index) => insertStatus(id, { name, order: index }, now));
    } else {
      // A new board gets the seed columns by *name* only — the seed ids belong
      // to the default board, which is the one legacy tasks point at.
      SEED_STATUSES.forEach((seed, index) =>
        insertStatus(id, { name: seed.name, color: seed.color, order: index }, now),
      );
    }
  });
  return getBoard(id)!;
}

export function updateBoard(id: string, input: UpdateBoardInput): Board | null {
  if (!getBoard(id)) return null;
  const patch: Partial<Board> = { updatedAt: Date.now() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.color !== undefined) patch.color = input.color;
  if (input.order !== undefined) patch.order = input.order;
  db.update(boards).set(patch).where(eq(boards.id, id)).run();
  return getBoard(id) ?? null;
}

/**
 * Delete a board, its columns and its tasks, in one transaction.
 *
 * Refuses the last board: the app's only view of tasks is a board, so an
 * install with none is one where the page has nothing to render and no way
 * back except creating one — a state worth making unreachable rather than
 * handling.
 */
export function deleteBoard(id: string): boolean {
  if (!getBoard(id)) return false;
  if (listBoards().length <= 1) throw new BoardError("the last board cannot be deleted");
  db.transaction(() => {
    db.delete(tasksTable).where(eq(tasksTable.boardId, id)).run();
    db.delete(boardStatuses).where(eq(boardStatuses.boardId, id)).run();
    db.delete(boards).where(eq(boards.id, id)).run();
  });
  return true;
}

export function createStatus(boardId: string, input: CreateStatusInput): BoardStatus {
  if (!getBoard(boardId)) throw new BoardError("unknown board", 404);
  const existing = listStatuses(boardId);
  const at = Math.min(input.order ?? existing.length, existing.length);
  const now = Date.now();
  let created!: BoardStatus;
  db.transaction(() => {
    // Inserting in the middle pushes everything at or after `at` one right, so
    // `order` stays a dense 0..n-1 run and the board never has to sort ties.
    existing.slice(at).forEach((status, offset) => {
      db.update(boardStatuses)
        .set({ order: at + offset + 1, updatedAt: now })
        .where(eq(boardStatuses.id, status.id))
        .run();
    });
    created = insertStatus(boardId, { name: input.name, color: input.color, order: at }, now);
  });
  return created;
}

export function updateStatus(id: string, input: UpdateStatusInput): BoardStatus | null {
  if (!getStatus(id)) return null;
  const patch: Partial<BoardStatus> = { updatedAt: Date.now() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.color !== undefined) patch.color = input.color;
  db.update(boardStatuses).set(patch).where(eq(boardStatuses.id, id)).run();
  return getStatus(id) ?? null;
}

/**
 * Delete a column and rehome its tasks.
 *
 * `moveTo` is the caller's answer to "where do its tasks go?" and must name a
 * column on the same board; omitted, they go to the first remaining column.
 * Refuses the board's last column for the reason `deleteBoard` refuses the last
 * board — the tasks would have nowhere to be.
 */
export function deleteStatus(id: string, moveTo?: string): boolean {
  const status = getStatus(id);
  if (!status) return false;
  const siblings = listStatuses(status.boardId).filter((s) => s.id !== id);
  if (siblings.length === 0) throw new BoardError("a board needs at least one column");
  const target = moveTo ? siblings.find((s) => s.id === moveTo) : siblings[0];
  if (!target) throw new BoardError("moveTo must name another column on the same board");

  const now = Date.now();
  db.transaction(() => {
    // The rehomed tasks go to the end of the target column, keeping their order
    // relative to each other.
    const tail = db
      .select()
      .from(tasksTable)
      .where(and(eq(tasksTable.boardId, status.boardId), eq(tasksTable.statusId, target.id)))
      .all().length;
    const moving = db
      .select()
      .from(tasksTable)
      .where(and(eq(tasksTable.boardId, status.boardId), eq(tasksTable.statusId, id)))
      .orderBy(asc(tasksTable.order))
      .all();
    moving.forEach((task, index) => {
      db.update(tasksTable)
        .set({ statusId: target.id, order: tail + index, updatedAt: now })
        .where(eq(tasksTable.id, task.id))
        .run();
    });
    db.delete(boardStatuses).where(eq(boardStatuses.id, id)).run();
    // Close the gap the delete left, so `order` stays dense.
    siblings.forEach((sibling, index) => {
      if (sibling.order === index) return;
      db.update(boardStatuses)
        .set({ order: index, updatedAt: now })
        .where(eq(boardStatuses.id, sibling.id))
        .run();
    });
  });
  return true;
}

/** Left-to-right column order for one board, from the full list of its ids.
    Ids that are not this board's are ignored; ones left out keep their place
    at the end, so a stale client can never lose a column. */
export function reorderStatuses(boardId: string, ids: string[]): BoardStatus[] {
  const existing = listStatuses(boardId);
  const known = new Set(existing.map((s) => s.id));
  const ordered = [...ids.filter((id) => known.has(id))];
  for (const status of existing) if (!ordered.includes(status.id)) ordered.push(status.id);
  const now = Date.now();
  db.transaction(() => {
    ordered.forEach((id, index) => {
      db.update(boardStatuses)
        .set({ order: index, updatedAt: now })
        .where(eq(boardStatuses.id, id))
        .run();
    });
  });
  return listStatuses(boardId);
}

/**
 * Repair tasks pointing at a column that no longer exists.
 *
 * Nothing in this file can produce one — every delete rehomes — but a backup
 * import can (a bundle whose tasks outlive their board's columns), and a task
 * with a dangling `statusId` renders in no column at all, which reads as data
 * loss. Called after an import; cheap enough to be worth the certainty.
 */
export function reconcileTaskStatuses(): number {
  const byBoard = new Map<string, Set<string>>();
  for (const status of listAllStatuses()) {
    let set = byBoard.get(status.boardId);
    if (!set) byBoard.set(status.boardId, (set = new Set()));
    set.add(status.id);
  }
  const fallback = new Map<string, string>();
  for (const board of listBoards()) {
    const first = firstStatusId(board.id);
    if (first) fallback.set(board.id, first);
  }
  const defaultBoard = listBoards()[0];
  let repaired = 0;
  const now = Date.now();
  db.transaction(() => {
    for (const task of db.select().from(tasksTable).all()) {
      const valid = byBoard.get(task.boardId)?.has(task.statusId) ?? false;
      if (valid) continue;
      const boardId = byBoard.has(task.boardId) ? task.boardId : defaultBoard?.id;
      const statusId = boardId ? fallback.get(boardId) : undefined;
      if (!boardId || !statusId) continue;
      db.update(tasksTable)
        .set({ boardId, statusId, updatedAt: now })
        .where(eq(tasksTable.id, task.id))
        .run();
      repaired++;
    }
  });
  return repaired;
}

/** Assert a (board, status) pair the client sent is real and consistent. */
export function assertStatusOnBoard(boardId: string, statusId: string): void {
  const status = getStatus(statusId);
  if (!status) throw new BoardError("unknown status", 404);
  if (status.boardId !== boardId) throw new BoardError("that status is on another board");
}
