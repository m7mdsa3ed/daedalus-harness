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
  boards as boardsTable,
  conn,
  taskActivity,
  taskComments,
  taskLinks,
  tasks as tasksTable,
  transaction,
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
  listId: z.string().min(1).optional().nullable(),
  statusId: z.string().min(1).optional(),
  type: z.enum(TASK_TYPES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  labels: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  assignee: z.string().trim().max(200).optional().nullable(),
  assignees: z.array(z.string().trim().max(200)).max(20).optional(),
  parentId: z.string().min(1).optional().nullable(),
  sprintId: z.string().min(1).optional().nullable(),
  estimate: z.number().int().min(0).max(10_000).optional().nullable(),
  timeEstimate: z.number().int().min(0).max(100_000).optional().nullable(),
  timeTracked: z.number().int().min(0).max(100_000).optional().nullable(),
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
    assignees: true,
    parentId: true,
    sprintId: true,
    estimate: true,
    timeEstimate: true,
    timeTracked: true,
    listId: true,
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
export function listTasks(boardId?: string): Promise<Task[]> {
  const query = conn().select().from(tasksTable);
  return (boardId ? query.where(eq(tasksTable.boardId, boardId)) : query).orderBy(
    asc(tasksTable.boardId),
    asc(tasksTable.statusId),
    asc(tasksTable.order),
  );
}

export async function getTask(id: string): Promise<Task | undefined> {
  return (await conn().select().from(tasksTable).where(eq(tasksTable.id, id)).limit(1))[0];
}

/** `KEY-12` → the task, for deep links and link pickers. */
export async function findTaskByKey(key: string): Promise<Task | undefined> {
  const match = /^([A-Za-z][A-Za-z0-9]{1,5})-(\d+)$/.exec(key.trim());
  if (!match) return undefined;
  const board = (await conn()
    .select()
    .from(boardsTable)
    .where(eq(boardsTable.key, match[1]!.toUpperCase()))
    .limit(1))[0];
  if (!board) return undefined;
  return (await conn()
    .select()
    .from(tasksTable)
    .where(and(eq(tasksTable.boardId, board.id), eq(tasksTable.number, Number(match[2]))))
    .limit(1))[0];
}

/**
 * Resolve the (board, status) a write is targeting.
 *
 * Either may be omitted — the client's forms often know only one of them — and
 * naming just a status is enough, since a status belongs to exactly one board.
 * What is never allowed is an inconsistent pair, which would put a task in a
 * column its board does not have and so render it nowhere.
 */
async function resolvePlacement(
  input: { boardId?: string; statusId?: string },
  current?: Task,
): Promise<{ boardId: string; statusId: string }> {
  if (input.statusId) {
    const status = await getStatus(input.statusId);
    if (!status) throw new BoardError("unknown status", 404);
    if (input.boardId && input.boardId !== status.boardId)
      throw new BoardError("that status is on another board");
    return { boardId: status.boardId, statusId: status.id };
  }
  const boardId = input.boardId ?? current?.boardId ?? DEFAULT_BOARD_ID;
  if (!(await getBoard(boardId))) throw new BoardError("unknown board", 404);
  // Moving a task to another board without naming a column drops it in that
  // board's first one — the only column we can be sure exists there.
  if (current && current.boardId === boardId) return { boardId, statusId: current.statusId };
  const statusId = await firstStatusId(boardId);
  if (!statusId) throw new BoardError("that board has no columns");
  return { boardId, statusId };
}

/** A parent must be a real task on the same board, and never the task itself
    or one of its own descendants — a cycle would make the tree unrenderable. */
async function assertParent(parentId: string, boardId: string, selfId?: string): Promise<void> {
  const parent = await getTask(parentId);
  if (!parent) throw new BoardError("unknown parent task", 404);
  if (parent.boardId !== boardId) throw new BoardError("a parent must be on the same board");
  if (!selfId) return;
  let cursor: Task | undefined = parent;
  const seen = new Set<string>();
  while (cursor) {
    if (cursor.id === selfId) throw new BoardError("a task cannot be its own ancestor");
    if (seen.has(cursor.id)) break;
    seen.add(cursor.id);
    cursor = cursor.parentId ? await getTask(cursor.parentId) : undefined;
  }
}

async function assertSprint(sprintId: string, boardId: string): Promise<void> {
  const sprint = await getSprint(sprintId);
  if (!sprint) throw new BoardError("unknown sprint", 404);
  if (sprint.boardId !== boardId) throw new BoardError("that sprint is on another board");
}

function normalizeChecklist(items: z.infer<typeof ChecklistSchema>): ChecklistItem[] {
  return items.map((item) => ({ id: item.id ?? randomUUID(), text: item.text, done: item.done }));
}

async function columnTail(boardId: string, statusId: string): Promise<number> {
  return (
    await conn()
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(and(eq(tasksTable.boardId, boardId), eq(tasksTable.statusId, statusId)))
  ).length;
}

async function record(taskId: string, at: number, field: string, from: unknown, to: unknown): Promise<void> {
  await conn().insert(taskActivity)
    .values({ id: randomUUID(), taskId, at, field, from: from ?? null, to: to ?? null });
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const id = randomUUID();
  const now = Date.now();
  const { boardId, statusId } = await resolvePlacement(input);
  if (input.parentId) await assertParent(input.parentId, boardId);
  if (input.sprintId) await assertSprint(input.sprintId, boardId);
  const status = (await getStatus(statusId))!;
  await transaction(async () => {
    // The board's counter is read and bumped inside the transaction, so two
    // creates racing on the same board cannot mint the same number.
    const board = (await getBoard(boardId))!;
    const number = board.nextNumber;
    await conn().update(boardsTable)
      .set({ nextNumber: number + 1, updatedAt: now })
      .where(eq(boardsTable.id, boardId));
    // A fresh task lands at the end of its column unless told otherwise.
    const order = input.order ?? (await columnTail(boardId, statusId));
    const assignees = input.assignees ?? (input.assignee ? [input.assignee] : []);
    await conn().insert(tasksTable)
      .values({
        id,
        boardId,
        listId: input.listId ?? null,
        number,
        type: input.type ?? "task",
        title: input.title,
        description: input.description ?? null,
        statusId,
        priority: input.priority ?? "medium",
        labels: input.labels ?? [],
        assignee: input.assignee ?? null,
        assignees,
        parentId: input.parentId ?? null,
        sprintId: input.sprintId ?? null,
        estimate: input.estimate ?? null,
        timeEstimate: input.timeEstimate ?? null,
        timeTracked: input.timeTracked ?? null,
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
      });
    await record(id, now, "created", null, null);
  });
  return (await getTask(id))!;
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
  "assignees",
  "parentId",
  "sprintId",
  "estimate",
  "timeEstimate",
  "timeTracked",
  "listId",
  "startAt",
  "dueAt",
  "archived",
  "boardId",
];

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export async function updateTask(id: string, input: UpdateTaskInput): Promise<Task | null> {
  const existing = await getTask(id);
  if (!existing) return null;
  const now = Date.now();
  const patch: Partial<Task> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.description !== undefined) patch.description = input.description;
  if (input.boardId !== undefined || input.statusId !== undefined) {
    const placement = await resolvePlacement(input, existing);
    patch.boardId = placement.boardId;
    patch.statusId = placement.statusId;
    // A task arriving in a different column joins the end of it; leaving its
    // old `order` behind would put it at an arbitrary depth among rows that
    // never moved.
    if (placement.statusId !== existing.statusId || placement.boardId !== existing.boardId) {
      patch.order = await columnTail(placement.boardId, placement.statusId);
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
  if (input.assignees !== undefined) patch.assignees = input.assignees;
  if (input.listId !== undefined) patch.listId = input.listId;
  if (input.timeEstimate !== undefined) patch.timeEstimate = input.timeEstimate;
  if (input.timeTracked !== undefined) patch.timeTracked = input.timeTracked;
  if (input.parentId !== undefined) {
    if (input.parentId) await assertParent(input.parentId, boardId, id);
    patch.parentId = input.parentId;
  }
  if (input.sprintId !== undefined) {
    if (input.sprintId) await assertSprint(input.sprintId, boardId);
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
    const target = await getStatus(statusId);
    patch.completedAt = target?.category === "done" ? (existing.completedAt ?? now) : null;
  }
  patch.updatedAt = now;

  await transaction(async () => {
    if (patch.boardId && patch.boardId !== existing.boardId) {
      const board = (await getBoard(patch.boardId))!;
      patch.number = board.nextNumber;
      await conn().update(boardsTable)
        .set({ nextNumber: board.nextNumber + 1, updatedAt: now })
        .where(eq(boardsTable.id, board.id));
      // Children cannot follow a parent to another board — they are detached.
      await conn()
        .update(tasksTable)
        .set({ parentId: null, updatedAt: now })
        .where(eq(tasksTable.parentId, id));
    }
    await conn().update(tasksTable).set(patch).where(eq(tasksTable.id, id));
    for (const field of TRACKED) {
      if (!(field in patch)) continue;
      const before = existing[field];
      const after = patch[field];
      if (same(before, after)) continue;
      await record(id, now, field, before, after);
    }
    if (input.description !== undefined && !same(existing.description, input.description)) {
      await record(id, now, "description", null, null);
    }
  });
  return (await getTask(id)) ?? null;
}

/** The same patch on many tasks, one transaction, one activity row each. */
export async function bulkUpdate(input: BulkUpdateInput): Promise<Task[]> {
  const rows = await conn().select().from(tasksTable).where(inArray(tasksTable.id, input.ids));
  if (rows.length === 0) return [];
  let out: Task[] = [];
  await transaction(async () => {
    for (const row of rows) {
      const patch: UpdateTaskInput = { ...input.patch };
      // A status is a column of one board; a bulk move that names one only
      // applies to the tasks on that board — the rest keep their column.
      if (patch.statusId) {
        const status = await getStatus(patch.statusId);
        if (!status) throw new BoardError("unknown status", 404);
        if (status.boardId !== row.boardId) delete patch.statusId;
      }
      if (patch.sprintId) {
        const sprint = await getSprint(patch.sprintId);
        if (!sprint) throw new BoardError("unknown sprint", 404);
        if (sprint.boardId !== row.boardId) delete patch.sprintId;
      }
      if (patch.parentId) {
        const parent = await getTask(patch.parentId);
        if (!parent || parent.boardId !== row.boardId || parent.id === row.id) delete patch.parentId;
      }
      const updated = await updateTask(row.id, patch);
      if (updated) out.push(updated);
    }
  });
  out = out.sort((a, b) => a.order - b.order);
  return out;
}

/** Delete a task with everything that hangs off it. Children are detached
    (they keep their place on the board), never deleted with their parent. */
export async function deleteTask(id: string): Promise<boolean> {
  if (!(await getTask(id))) return false;
  const now = Date.now();
  await transaction(async () => {
    await conn().update(tasksTable)
      .set({ parentId: null, updatedAt: now })
      .where(eq(tasksTable.parentId, id));
    await conn().delete(taskComments).where(eq(taskComments.taskId, id));
    await conn().delete(taskActivity).where(eq(taskActivity.taskId, id));
    await conn().delete(taskLinks).where(or(eq(taskLinks.fromId, id), eq(taskLinks.toId, id)));
    await conn().delete(tasksTable).where(eq(tasksTable.id, id));
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
export async function applyReorder(entries: ReorderEntry[], board = DEFAULT_BOARD_ID): Promise<Task[]> {
  for (const entry of entries) await assertStatusOnBoard(entry.boardId ?? board, entry.statusId);
  const now = Date.now();
  await transaction(async () => {
    for (const entry of entries) {
      const current = await getTask(entry.id);
      if (!current) continue;
      const statusChanged = current.statusId !== entry.statusId;
      const target = statusChanged ? await getStatus(entry.statusId) : null;
      await conn().update(tasksTable)
        .set({
          statusId: entry.statusId,
          order: entry.order,
          boardId: entry.boardId ?? board,
          ...(statusChanged
            ? { completedAt: target?.category === "done" ? (current.completedAt ?? now) : null }
            : {}),
          updatedAt: statusChanged ? now : current.updatedAt,
        })
        .where(eq(tasksTable.id, entry.id));
      if (statusChanged) await record(entry.id, now, "statusId", current.statusId, entry.statusId);
    }
  });
  return await listTasks();
}

// ---- detail: comments, activity, links ----

export interface TaskDetail {
  task: Task;
  comments: TaskComment[];
  activity: TaskActivity[];
  links: TaskLink[];
  children: Task[];
}

export async function getTaskDetail(id: string): Promise<TaskDetail | undefined> {
  const task = await getTask(id);
  if (!task) return undefined;
  return {
    task,
    comments: await conn()
      .select()
      .from(taskComments)
      .where(eq(taskComments.taskId, id))
      .orderBy(asc(taskComments.createdAt))
      ,
    activity: await conn()
      .select()
      .from(taskActivity)
      .where(eq(taskActivity.taskId, id))
      .orderBy(desc(taskActivity.at))
      .limit(200)
      ,
    links: await conn()
      .select()
      .from(taskLinks)
      .where(or(eq(taskLinks.fromId, id), eq(taskLinks.toId, id)))
      .orderBy(asc(taskLinks.createdAt))
      ,
    children: await conn()
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.parentId, id))
      .orderBy(asc(tasksTable.number))
      ,
  };
}

export async function addComment(taskId: string, input: z.infer<typeof CommentSchema>): Promise<TaskComment> {
  if (!await getTask(taskId)) throw new BoardError("unknown task", 404);
  const id = randomUUID();
  const now = Date.now();
  await transaction(async () => {
    await conn().insert(taskComments)
      .values({ id, taskId, body: input.body, author: input.author ?? null, createdAt: now, updatedAt: now });
    await conn().update(tasksTable).set({ updatedAt: now }).where(eq(tasksTable.id, taskId));
    record(taskId, now, "commented", null, id);
  });
  return (await conn().select().from(taskComments).where(eq(taskComments.id, id)).limit(1))[0]!;
}

export async function updateComment(id: string, body: string): Promise<TaskComment | null> {
  const existing = (await conn().select().from(taskComments).where(eq(taskComments.id, id)).limit(1))[0];
  if (!existing) return null;
  await conn().update(taskComments).set({ body, updatedAt: Date.now() }).where(eq(taskComments.id, id));
  return (await conn().select().from(taskComments).where(eq(taskComments.id, id)).limit(1))[0] ?? null;
}

export async function deleteComment(id: string): Promise<boolean> {
  return ((await conn().delete(taskComments).where(eq(taskComments.id, id))).rowCount ?? 0) > 0;
}

/** Link `fromId` to `toId`. A duplicate pair (either direction for `relates`)
    is answered with the existing row rather than a second one. */
export async function addLink(fromId: string, input: z.infer<typeof LinkSchema>): Promise<TaskLink> {
  if (fromId === input.toId) throw new BoardError("a task cannot link to itself");
  if (!await getTask(fromId) || !await getTask(input.toId)) throw new BoardError("unknown task", 404);
  const existing = (await conn()
    .select()
    .from(taskLinks)
    .where(
      or(
        and(eq(taskLinks.fromId, fromId), eq(taskLinks.toId, input.toId), eq(taskLinks.kind, input.kind)),
        and(eq(taskLinks.fromId, input.toId), eq(taskLinks.toId, fromId), eq(taskLinks.kind, "relates")),
      ),
    )
    .limit(1))[0];
  if (existing && (existing.kind === input.kind || input.kind === "relates")) return existing;
  const id = randomUUID();
  const now = Date.now();
  await transaction(async () => {
    await conn().insert(taskLinks).values({ id, fromId, toId: input.toId, kind: input.kind, createdAt: now });
    record(fromId, now, "linked", null, { kind: input.kind, taskId: input.toId });
    record(input.toId, now, "linked", null, { kind: input.kind, taskId: fromId, inbound: true });
  });
  return (await conn().select().from(taskLinks).where(eq(taskLinks.id, id)).limit(1))[0]!;
}

export async function deleteLink(id: string): Promise<boolean> {
  return ((await conn().delete(taskLinks).where(eq(taskLinks.id, id))).rowCount ?? 0) > 0;
}
