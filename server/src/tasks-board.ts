/* Tasks-board resource for the harness's REST API.
 *
 * Standalone, as the board is intended to be: tasks are a top-level resource
 * with no foreign keys to sessions, projects or agents. Nothing here knows what
 * a thread is, which is the point — wiring the board to agent turns is a later,
 * additive step.
 *
 * Mirrors knowledge.ts / scheduler.ts: thin Drizzle operations behind zod input
 * schemas, called from routes/tasks.ts. A task's column is `statusId`, a row in
 * `board_statuses` (see boards.ts) rather than a member of a fixed union, so a
 * status can be added, renamed and reordered without a schema change; `boardId`
 * says which kanban that column is on.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { db, tasks as tasksTable } from "./db/index.js";
import {
  BoardError,
  DEFAULT_BOARD_ID,
  assertStatusOnBoard,
  firstStatusId,
  getBoard,
  getStatus,
} from "./boards.js";

export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** The shape both create and update accept. Update treats every field as
    optional, but a task needs a title to be born. */
const TaskFields = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().max(50_000).optional().nullable(),
  boardId: z.string().min(1).optional(),
  statusId: z.string().min(1).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  labels: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  assignee: z.string().trim().max(200).optional().nullable(),
  dueAt: z.number().int().min(0).optional().nullable(),
  note: z.string().max(2000).optional().nullable(),
  order: z.number().int().min(0).optional(),
});

export const CreateTaskSchema = TaskFields.extend({
  title: z.string().trim().min(1).max(500),
});

/** Update = any subset of fields, plus a null/absent distinction handled by
    dropping undefined keys before write. */
export const UpdateTaskSchema = TaskFields.partial();

export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;
type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;

export type Task = typeof tasksTable.$inferSelect;

/** A single move or reorder: one task to a (status, position) on a board. */
export const ReorderEntrySchema = z.object({
  id: z.string().min(1),
  statusId: z.string().min(1),
  /** New within-column position; 0 = first. */
  order: z.number().int().min(0),
  boardId: z.string().min(1).optional(),
});
export type ReorderEntry = z.infer<typeof ReorderEntrySchema>;

/** Every task, or one board's. Ordered so the client can group without sorting
    (it re-sorts anyway, since a drag reorders locally before the round trip). */
export function listTasks(boardId?: string): Task[] {
  const query = db.select().from(tasksTable);
  return (boardId ? query.where(eq(tasksTable.boardId, boardId)) : query)
    .orderBy(asc(tasksTable.boardId), asc(tasksTable.statusId), asc(tasksTable.order))
    .all();
}

export function getTask(id: string): Task | undefined {
  return db.select().from(tasksTable).where(eq(tasksTable.id, id)).get();
}

/**
 * Resolve the (board, status) a write is targeting.
 *
 * Either may be omitted — the client's forms often know only one of them — and
 * naming just a status is enough, since a status belongs to exactly one board.
 * What is never allowed is an inconsistent pair, which would put a task in a
 * column its board does not have and so render it nowhere.
 */
function resolvePlacement(
  input: { boardId?: string; statusId?: string },
  current?: Task,
): { boardId: string; statusId: string } {
  if (input.statusId) {
    const status = getStatus(input.statusId);
    if (!status) throw new BoardError("unknown status", 404);
    if (input.boardId && input.boardId !== status.boardId)
      throw new BoardError("that status is on another board");
    return { boardId: status.boardId, statusId: status.id };
  }
  const boardId = input.boardId ?? current?.boardId ?? DEFAULT_BOARD_ID;
  if (!getBoard(boardId)) throw new BoardError("unknown board", 404);
  // Moving a task to another board without naming a column drops it in that
  // board's first one — the only column we can be sure exists there.
  if (current && current.boardId === boardId) return { boardId, statusId: current.statusId };
  const statusId = firstStatusId(boardId);
  if (!statusId) throw new BoardError("that board has no columns");
  return { boardId, statusId };
}

export function createTask(input: CreateTaskInput): Task {
  const id = randomUUID();
  const now = Date.now();
  const { boardId, statusId } = resolvePlacement(input);
  // A fresh task lands at the end of its column unless told otherwise.
  const order =
    input.order ??
    db
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(and(eq(tasksTable.boardId, boardId), eq(tasksTable.statusId, statusId)))
      .all().length;
  db.insert(tasksTable)
    .values({
      id,
      boardId,
      title: input.title,
      description: input.description ?? null,
      statusId,
      priority: input.priority ?? "medium",
      labels: input.labels ?? [],
      assignee: input.assignee ?? null,
      dueAt: input.dueAt ?? null,
      note: input.note ?? null,
      order,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return getTask(id)!;
}

export function updateTask(id: string, input: UpdateTaskInput): Task | null {
  const existing = getTask(id);
  if (!existing) return null;
  const patch: Partial<Task> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.description !== undefined) patch.description = input.description;
  if (input.boardId !== undefined || input.statusId !== undefined) {
    const placement = resolvePlacement(input, existing);
    patch.boardId = placement.boardId;
    patch.statusId = placement.statusId;
    // A task arriving in a different column joins the end of it; leaving its
    // old `order` behind would put it at an arbitrary depth among rows that
    // never moved.
    if (placement.statusId !== existing.statusId || placement.boardId !== existing.boardId) {
      patch.order = db
        .select({ id: tasksTable.id })
        .from(tasksTable)
        .where(
          and(
            eq(tasksTable.boardId, placement.boardId),
            eq(tasksTable.statusId, placement.statusId),
          ),
        )
        .all().length;
    }
  }
  if (input.priority !== undefined) patch.priority = input.priority;
  if (input.labels !== undefined) patch.labels = input.labels;
  if (input.assignee !== undefined) patch.assignee = input.assignee;
  if (input.dueAt !== undefined) patch.dueAt = input.dueAt;
  if (input.note !== undefined) patch.note = input.note;
  if (input.order !== undefined) patch.order = input.order;
  patch.updatedAt = Date.now();
  db.update(tasksTable).set(patch).where(eq(tasksTable.id, id)).run();
  return getTask(id) ?? null;
}

export function deleteTask(id: string): boolean {
  return db.delete(tasksTable).where(eq(tasksTable.id, id)).run().changes > 0;
}

/**
 * Apply an ordered list of moves for one board in a single transaction.
 *
 * The client sends the whole board's new column-by-column order and the server
 * commits it atomically — a drag is all-or-nothing, and no two rows in a column
 * can collide on the same `order`. The position written is the entry's own
 * `order` (its index *within its column*), not the entry's index in this array,
 * which is a board-wide running count and would leave every column but the
 * first starting at a non-zero offset.
 *
 * Every entry is validated against the board first: a stale client that names a
 * column deleted out from under it fails the whole request rather than parking
 * tasks in a column that does not exist.
 */
export function applyReorder(entries: ReorderEntry[], board = DEFAULT_BOARD_ID): Task[] {
  for (const entry of entries) assertStatusOnBoard(entry.boardId ?? board, entry.statusId);
  const now = Date.now();
  db.transaction(() => {
    for (const entry of entries) {
      db.update(tasksTable)
        .set({
          statusId: entry.statusId,
          order: entry.order,
          boardId: entry.boardId ?? board,
          updatedAt: now,
        })
        .where(eq(tasksTable.id, entry.id))
        .run();
    }
  });
  return listTasks();
}
