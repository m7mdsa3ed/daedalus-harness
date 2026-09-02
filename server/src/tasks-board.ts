/* Tasks resource for the harness's REST API.
 *
 * Standalone, as the board is intended to be: tasks are a top-level resource
 * with no foreign keys to sessions or agents. Nothing here knows what a thread
 * is, which is the point — wiring the board to agent turns is additive.
 *
 * Thin Drizzle operations behind zod input schemas, called from
 * routes/tasks.ts. A task's column is `statusId`, a row in `board_statuses`
 * (see boards.ts) rather than a member of a fixed union; `boardId` says which
 * board that column is on. Everything a task carries beyond that — its key,
 * type, parent, sprint, checklist, custom fields, comments, activity, links —
 * is here, and every change to a task is written to `task_activity` by the one
 * function that writes tasks, so the history is never reconstructed.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";

import {
  db,
  taskActivity,
  taskComments,
  taskLinks,
  tasks as tasksTable,
  boards as boardsTable,
  type ChecklistItem,
} from "./db/index.js";
import {
  BoardError,
  DEFAULT_BOARD_ID,
  assertStatusOnBoard,
  firstStatusId,
  getBoard,
  getSprint,
  getStatus,
} from "./boards.js";

export const TASK_PRIORITIES = ["lowest", "low", "medium", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_TYPES = ["task", "bug", "story", "epic"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const LINK_KINDS = ["blocks", "relates", "duplicates"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

const ChecklistSchema = z
  .array(
    z.object({
      id: z.string().min(1).max(64).optional(),
      text: z.string().trim().min(1).max(500),
      done: z.boolean().default(false),
    }),
  )
  .max(100);

/** The shape both create and update accept. Update treats every field as
    optional, but a task needs a title to be born. */
const TaskFields = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().max(50_000).optional().nullable(),
  boardId: z.string().min(1).optional(),
  statusId: z.string().min(1).optional(),
  type: z.enum(TASK_TYPES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  labels: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  assignee: z.string().trim().max(200).optional().nullable(),
  parentId: z.string().min(1).optional().nullable(),
  sprintId: z.string().min(1).optional().nullable(),
  estimate: z.number().int().min(0).max(10_000).optional().nullable(),
  startAt: z.number().int().min(0).optional().nullable(),
  dueAt: z.number().int().min(0).optional().nullable(),
  archived: z.boolean().optional(),
  checklist: ChecklistSchema.optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
  note: z.string().max(2000).optional().nullable(),
  order: z.number().int().min(0).optional(),
});

export const CreateTaskSchema = TaskFields.extend({
  title: z.string().trim().min(1).max(500),
});

/** Update = any subset of fields, plus a null/absent distinction handled by
    dropping undefined keys before write. */
export const UpdateTaskSchema = TaskFields.partial();

/** A patch applied to many tasks at once: the fields that make sense to set
    in bulk (never title, description, checklist or order). */
export const BulkUpdateSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(500),
  patch: TaskFields.pick({
    statusId: true,
    type: true,
    priority: true,
    labels: true,
    assignee: true,
    parentId: true,
    sprintId: true,
    estimate: true,
    startAt: true,
    dueAt: true,
    archived: true,
  }).partial(),
});

export const CommentSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
  author: z.string().trim().max(200).optional().nullable(),
});

export const LinkSchema = z.object({
  toId: z.string().min(1),
  kind: z.enum(LINK_KINDS).default("relates"),
});

export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;
type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;
export type BulkUpdateInput = z.infer<typeof BulkUpdateSchema>;

export type Task = typeof tasksTable.$inferSelect;
export type TaskComment = typeof taskComments.$inferSelect;
export type TaskActivity = typeof taskActivity.$inferSelect;
export type TaskLink = typeof taskLinks.$inferSelect;

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

/** `KEY-12` → the task, for deep links and link pickers. */
export function findTaskByKey(key: string): Task | undefined {
  const match = /^([A-Za-z][A-Za-z0-9]{1,5})-(\d+)$/.exec(key.trim());
  if (!match) return undefined;
  const board = db
    .select()
    .from(boardsTable)
    .where(eq(boardsTable.key, match[1]!.toUpperCase()))
    .get();
  if (!board) return undefined;
  return db
    .select()
    .from(tasksTable)
    .where(and(eq(tasksTable.boardId, board.id), eq(tasksTable.number, Number(match[2]))))
    .get();
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

/** A parent must be a real task on the same board, and never the task itself
    or one of its own descendants — a cycle would make the tree unrenderable. */
function assertParent(parentId: string, boardId: string, selfId?: string): void {
  const parent = getTask(parentId);
  if (!parent) throw new BoardError("unknown parent task", 404);
  if (parent.boardId !== boardId) throw new BoardError("a parent must be on the same board");
  if (!selfId) return;
  let cursor: Task | undefined = parent;
  const seen = new Set<string>();
  while (cursor) {
    if (cursor.id === selfId) throw new BoardError("a task cannot be its own ancestor");
    if (seen.has(cursor.id)) break;
    seen.add(cursor.id);
    cursor = cursor.parentId ? getTask(cursor.parentId) : undefined;
  }
}

function assertSprint(sprintId: string, boardId: string): void {
  const sprint = getSprint(sprintId);
  if (!sprint) throw new BoardError("unknown sprint", 404);
  if (sprint.boardId !== boardId) throw new BoardError("that sprint is on another board");
}

function normalizeChecklist(items: z.infer<typeof ChecklistSchema>): ChecklistItem[] {
  return items.map((item) => ({ id: item.id ?? randomUUID(), text: item.text, done: item.done }));
}

function columnTail(boardId: string, statusId: string): number {
  return db
    .select({ id: tasksTable.id })
    .from(tasksTable)
    .where(and(eq(tasksTable.boardId, boardId), eq(tasksTable.statusId, statusId)))
    .all().length;
}

function record(taskId: string, at: number, field: string, from: unknown, to: unknown): void {
  db.insert(taskActivity)
    .values({ id: randomUUID(), taskId, at, field, from: from ?? null, to: to ?? null })
    .run();
}

export function createTask(input: CreateTaskInput): Task {
  const id = randomUUID();
  const now = Date.now();
  const { boardId, statusId } = resolvePlacement(input);
  if (input.parentId) assertParent(input.parentId, boardId);
  if (input.sprintId) assertSprint(input.sprintId, boardId);
  const status = getStatus(statusId)!;
  db.transaction(() => {
    // The board's counter is read and bumped inside the transaction, so two
    // creates racing on the same board cannot mint the same number.
    const board = getBoard(boardId)!;
    const number = board.nextNumber;
    db.update(boardsTable)
      .set({ nextNumber: number + 1, updatedAt: now })
      .where(eq(boardsTable.id, boardId))
      .run();
    // A fresh task lands at the end of its column unless told otherwise.
    const order = input.order ?? columnTail(boardId, statusId);
    db.insert(tasksTable)
      .values({
        id,
        boardId,
        number,
        type: input.type ?? "task",
        title: input.title,
        description: input.description ?? null,
        statusId,
        priority: input.priority ?? "medium",
        labels: input.labels ?? [],
        assignee: input.assignee ?? null,
        parentId: input.parentId ?? null,
        sprintId: input.sprintId ?? null,
        estimate: input.estimate ?? null,
        startAt: input.startAt ?? null,
        dueAt: input.dueAt ?? null,
        completedAt: status.category === "done" ? now : null,
        archived: input.archived ?? false,
        checklist: input.checklist ? normalizeChecklist(input.checklist) : [],
        custom: input.custom ?? {},
        note: input.note ?? null,
        order,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    record(id, now, "created", null, null);
  });
  return getTask(id)!;
}

/** The fields whose changes are written to the activity log, with the value
    the log stores for each (ids stay ids; the client resolves names). */
const TRACKED: (keyof Task)[] = [
  "title",
  "statusId",
  "type",
  "priority",
  "labels",
  "assignee",
  "parentId",
  "sprintId",
  "estimate",
  "startAt",
  "dueAt",
  "archived",
  "boardId",
];

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function updateTask(id: string, input: UpdateTaskInput): Task | null {
  const existing = getTask(id);
  if (!existing) return null;
  const now = Date.now();
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
      patch.order = columnTail(placement.boardId, placement.statusId);
    }
    if (placement.boardId !== existing.boardId) {
      // A board move leaves the old board's sprint and parent behind — both
      // belong to it — and takes a fresh number from the new board's counter.
      patch.sprintId = null;
      patch.parentId = null;
    }
  }
  const boardId = patch.boardId ?? existing.boardId;
  if (input.type !== undefined) patch.type = input.type;
  if (input.priority !== undefined) patch.priority = input.priority;
  if (input.labels !== undefined) patch.labels = input.labels;
  if (input.assignee !== undefined) patch.assignee = input.assignee;
  if (input.parentId !== undefined) {
    if (input.parentId) assertParent(input.parentId, boardId, id);
    patch.parentId = input.parentId;
  }
  if (input.sprintId !== undefined) {
    if (input.sprintId) assertSprint(input.sprintId, boardId);
    patch.sprintId = input.sprintId;
  }
  if (input.estimate !== undefined) patch.estimate = input.estimate;
  if (input.startAt !== undefined) patch.startAt = input.startAt;
  if (input.dueAt !== undefined) patch.dueAt = input.dueAt;
  if (input.archived !== undefined) patch.archived = input.archived;
  if (input.checklist !== undefined) patch.checklist = normalizeChecklist(input.checklist);
  if (input.custom !== undefined) patch.custom = { ...existing.custom, ...input.custom };
  if (input.note !== undefined) patch.note = input.note;
  if (input.order !== undefined) patch.order = input.order;

  // Entering a done column stamps completion; leaving one clears it.
  const statusId = patch.statusId ?? existing.statusId;
  if (statusId !== existing.statusId) {
    const target = getStatus(statusId);
    patch.completedAt = target?.category === "done" ? (existing.completedAt ?? now) : null;
  }
  patch.updatedAt = now;

  db.transaction(() => {
    if (patch.boardId && patch.boardId !== existing.boardId) {
      const board = getBoard(patch.boardId)!;
      patch.number = board.nextNumber;
      db.update(boardsTable)
        .set({ nextNumber: board.nextNumber + 1, updatedAt: now })
        .where(eq(boardsTable.id, board.id))
        .run();
      // Children cannot follow a parent to another board — they are detached.
      db.update(tasksTable)
        .set({ parentId: null, updatedAt: now })
        .where(eq(tasksTable.parentId, id))
        .run();
    }
    db.update(tasksTable).set(patch).where(eq(tasksTable.id, id)).run();
    for (const field of TRACKED) {
      if (!(field in patch)) continue;
      const before = existing[field];
      const after = patch[field];
      if (same(before, after)) continue;
      record(id, now, field, before, after);
    }
    if (input.description !== undefined && !same(existing.description, input.description)) {
      record(id, now, "description", null, null);
    }
  });
  return getTask(id) ?? null;
}

/** The same patch on many tasks, one transaction, one activity row each. */
export function bulkUpdate(input: BulkUpdateInput): Task[] {
  const rows = db.select().from(tasksTable).where(inArray(tasksTable.id, input.ids)).all();
  if (rows.length === 0) return [];
  let out: Task[] = [];
  db.transaction(() => {
    for (const row of rows) {
      const patch: UpdateTaskInput = { ...input.patch };
      // A status is a column of one board; a bulk move that names one only
      // applies to the tasks on that board — the rest keep their column.
      if (patch.statusId) {
        const status = getStatus(patch.statusId);
        if (!status) throw new BoardError("unknown status", 404);
        if (status.boardId !== row.boardId) delete patch.statusId;
      }
      if (patch.sprintId) {
        const sprint = getSprint(patch.sprintId);
        if (!sprint) throw new BoardError("unknown sprint", 404);
        if (sprint.boardId !== row.boardId) delete patch.sprintId;
      }
      if (patch.parentId) {
        const parent = getTask(patch.parentId);
        if (!parent || parent.boardId !== row.boardId || parent.id === row.id) delete patch.parentId;
      }
      const updated = updateTask(row.id, patch);
      if (updated) out.push(updated);
    }
  });
  out = out.sort((a, b) => a.order - b.order);
  return out;
}

/** Delete a task with everything that hangs off it. Children are detached
    (they keep their place on the board), never deleted with their parent. */
export function deleteTask(id: string): boolean {
  if (!getTask(id)) return false;
  const now = Date.now();
  db.transaction(() => {
    db.update(tasksTable)
      .set({ parentId: null, updatedAt: now })
      .where(eq(tasksTable.parentId, id))
      .run();
    db.delete(taskComments).where(eq(taskComments.taskId, id)).run();
    db.delete(taskActivity).where(eq(taskActivity.taskId, id)).run();
    db.delete(taskLinks).where(or(eq(taskLinks.fromId, id), eq(taskLinks.toId, id))).run();
    db.delete(tasksTable).where(eq(tasksTable.id, id)).run();
  });
  return true;
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
 * tasks in a column that does not exist. A column change goes through the
 * activity log and the completion stamp like any other.
 */
export function applyReorder(entries: ReorderEntry[], board = DEFAULT_BOARD_ID): Task[] {
  for (const entry of entries) assertStatusOnBoard(entry.boardId ?? board, entry.statusId);
  const now = Date.now();
  db.transaction(() => {
    for (const entry of entries) {
      const current = getTask(entry.id);
      if (!current) continue;
      const statusChanged = current.statusId !== entry.statusId;
      const target = statusChanged ? getStatus(entry.statusId) : null;
      db.update(tasksTable)
        .set({
          statusId: entry.statusId,
          order: entry.order,
          boardId: entry.boardId ?? board,
          ...(statusChanged
            ? { completedAt: target?.category === "done" ? (current.completedAt ?? now) : null }
            : {}),
          updatedAt: statusChanged ? now : current.updatedAt,
        })
        .where(eq(tasksTable.id, entry.id))
        .run();
      if (statusChanged) record(entry.id, now, "statusId", current.statusId, entry.statusId);
    }
  });
  return listTasks();
}

// ---- detail: comments, activity, links ----

export interface TaskDetail {
  task: Task;
  comments: TaskComment[];
  activity: TaskActivity[];
  links: TaskLink[];
  children: Task[];
}

export function getTaskDetail(id: string): TaskDetail | undefined {
  const task = getTask(id);
  if (!task) return undefined;
  return {
    task,
    comments: db
      .select()
      .from(taskComments)
      .where(eq(taskComments.taskId, id))
      .orderBy(asc(taskComments.createdAt))
      .all(),
    activity: db
      .select()
      .from(taskActivity)
      .where(eq(taskActivity.taskId, id))
      .orderBy(desc(taskActivity.at))
      .limit(200)
      .all(),
    links: db
      .select()
      .from(taskLinks)
      .where(or(eq(taskLinks.fromId, id), eq(taskLinks.toId, id)))
      .orderBy(asc(taskLinks.createdAt))
      .all(),
    children: db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.parentId, id))
      .orderBy(asc(tasksTable.number))
      .all(),
  };
}

export function addComment(taskId: string, input: z.infer<typeof CommentSchema>): TaskComment {
  if (!getTask(taskId)) throw new BoardError("unknown task", 404);
  const id = randomUUID();
  const now = Date.now();
  db.transaction(() => {
    db.insert(taskComments)
      .values({ id, taskId, body: input.body, author: input.author ?? null, createdAt: now, updatedAt: now })
      .run();
    db.update(tasksTable).set({ updatedAt: now }).where(eq(tasksTable.id, taskId)).run();
    record(taskId, now, "commented", null, id);
  });
  return db.select().from(taskComments).where(eq(taskComments.id, id)).get()!;
}

export function updateComment(id: string, body: string): TaskComment | null {
  const existing = db.select().from(taskComments).where(eq(taskComments.id, id)).get();
  if (!existing) return null;
  db.update(taskComments).set({ body, updatedAt: Date.now() }).where(eq(taskComments.id, id)).run();
  return db.select().from(taskComments).where(eq(taskComments.id, id)).get() ?? null;
}

export function deleteComment(id: string): boolean {
  return db.delete(taskComments).where(eq(taskComments.id, id)).run().changes > 0;
}

/** Link `fromId` to `toId`. A duplicate pair (either direction for `relates`)
    is answered with the existing row rather than a second one. */
export function addLink(fromId: string, input: z.infer<typeof LinkSchema>): TaskLink {
  if (fromId === input.toId) throw new BoardError("a task cannot link to itself");
  if (!getTask(fromId) || !getTask(input.toId)) throw new BoardError("unknown task", 404);
  const existing = db
    .select()
    .from(taskLinks)
    .where(
      or(
        and(eq(taskLinks.fromId, fromId), eq(taskLinks.toId, input.toId), eq(taskLinks.kind, input.kind)),
        and(eq(taskLinks.fromId, input.toId), eq(taskLinks.toId, fromId), eq(taskLinks.kind, "relates")),
      ),
    )
    .get();
  if (existing && (existing.kind === input.kind || input.kind === "relates")) return existing;
  const id = randomUUID();
  const now = Date.now();
  db.transaction(() => {
    db.insert(taskLinks).values({ id, fromId, toId: input.toId, kind: input.kind, createdAt: now }).run();
    record(fromId, now, "linked", null, { kind: input.kind, taskId: input.toId });
    record(input.toId, now, "linked", null, { kind: input.kind, taskId: fromId, inbound: true });
  });
  return db.select().from(taskLinks).where(eq(taskLinks.id, id)).get()!;
}

export function deleteLink(id: string): boolean {
  return db.delete(taskLinks).where(eq(taskLinks.id, id)).run().changes > 0;
}
