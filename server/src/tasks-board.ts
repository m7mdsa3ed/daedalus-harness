/* Tasks-board resource for the harness's REST API.
 *
 * Standalone, as the board is intended to be initially: tasks are a top-level
 * resource with no foreign keys to sessions, projects or agents. Nothing here
 * knows what a thread is, which is the point — wiring the board to agent turns
 * is a later, additive step.
 *
 * Mirrors knowledge.ts / scheduler.ts: thin Drizzle operations behind zod input
 * schemas, called from index.ts. The `board` column is kept so a future
 * multi-board read is a column filter rather than a status rename, but the app
 * targets a single board today.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { db, tasks as tasksTable } from "./db/index.js";

/** A status a task can be in — also a kanban column. */
export const TASK_STATUSES = ["todo", "in_progress", "done", "blocked"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** The shape both create and update accept. Update treats every field as
    optional, but a task needs a title to be born. */
const TaskFields = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().max(50_000).optional().nullable(),
  status: z.enum(TASK_STATUSES).optional(),
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
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;

export type Task = typeof tasksTable.$inferSelect;

/** A single move or reorder: one task to a (status, position) on a board. */
export const ReorderEntrySchema = z.object({
  id: z.string().min(1),
  status: z.enum(TASK_STATUSES),
  /** New within-column position; 0 = first. */
  order: z.number().int().min(0),
  board: z.string().min(1).optional(),
});
export type ReorderEntry = z.infer<typeof ReorderEntrySchema>;

export function listTasks(): Task[] {
  return db
    .select()
    .from(tasksTable)
    .orderBy(asc(tasksTable.board), asc(tasksTable.status), asc(tasksTable.order))
    .all();
}

export function getTask(id: string): Task | undefined {
  return db.select().from(tasksTable).where(eq(tasksTable.id, id)).get();
}

export function createTask(input: CreateTaskInput): Task {
  const id = randomUUID();
  const now = Date.now();
  // A fresh task lands at the end of its column unless told otherwise.
  const order =
    input.order ??
    (db
      .select()
      .from(tasksTable)
      .where(and(eq(tasksTable.board, "default"), eq(tasksTable.status, input.status ?? "todo")))
      .all().length ?? 0);
  db.insert(tasksTable)
    .values({
      id,
      board: "default",
      title: input.title,
      description: input.description ?? null,
      status: input.status ?? "todo",
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
  return db.select().from(tasksTable).where(eq(tasksTable.id, id)).get()!;
}

export function updateTask(id: string, input: UpdateTaskInput): Task | null {
  const existing = getTask(id);
  if (!existing) return null;
  const patch: Partial<Task> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.description !== undefined) patch.description = input.description;
  if (input.status !== undefined) patch.status = input.status;
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
 * The client sends the whole column's new order (plus any cross-column moves)
 * and the server recomputes stable integer positions from the array index, so a
 * drag is atomic — no partial reorder if one write fails — and none of the
 * rows can collide on the same `order` value.
 */
export function applyReorder(entries: ReorderEntry[], board = "default"): Task[] {
  db.transaction(() => {
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      db.update(tasksTable)
        .set({ status: entry.status, order: index, board: entry.board ?? board, updatedAt: Date.now() })
        .where(eq(tasksTable.id, entry.id))
        .run();
    }
  });
  return listTasks();
}
