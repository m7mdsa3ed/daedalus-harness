/* Boards, their columns, sprints and saved views.
 *
 * A board is a project of work: it has a key (the prefix of every task key on
 * it), columns, sprints, saved views and custom field definitions. Every one
 * of those is a row, which is the point of this file: the four statuses used
 * to be a TypeScript union repeated across the schema, two zod files and the
 * client, so adding one was a six-file edit and a schema push. Here a status
 * is a row with a name, and a task's `statusId` points at it.
 *
 * No foreign keys, matching `tasks` (see schema.ts). SQLite would have to
 * either cascade a status delete into its tasks — silently destroying work — or
 * refuse it. Neither is the answer: deleting a column is a question ("where do
 * its tasks go?"), so `deleteStatus` takes the answer as an argument and moves
 * them; `completeSprint` asks the same of the sprint's unfinished tasks. Every
 * cascade here is written out in one transaction instead.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";

import {
  boardLists,
  boardStatuses,
  boardViews,
  boards,
  conn,
  sprints,
  taskActivity,
  taskComments,
  taskLinks,
  tasks as tasksTable,
  transaction,
  type CustomFieldDef,
} from "./db/index.js";
import { HttpError } from "./http-error.js";

export type Board = typeof boards.$inferSelect;
export type BoardStatus = typeof boardStatuses.$inferSelect;
export type Sprint = typeof sprints.$inferSelect;
export type BoardView = typeof boardViews.$inferSelect;
export type BoardList = typeof boardLists.$inferSelect;

/** The board every install starts with, and the one legacy tasks already name. */
export const DEFAULT_BOARD_ID = "default";

/** Palette tokens a board or column may be tinted with. The client maps these
    to theme classes; the server only checks membership, so a stored value can
    never be arbitrary CSS. */
export const BOARD_COLORS = [
  "slate",
  "blue",
  "violet",
  "emerald",
  "amber",
  "rose",
  "cyan",
  "orange",
] as const;
export type BoardColor = (typeof BOARD_COLORS)[number];

export const STATUS_CATEGORIES = ["todo", "in_progress", "done"] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

export const VIEW_KINDS = ["board", "list", "table", "calendar", "timeline"] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

export const FIELD_TYPES = ["text", "number", "select", "date", "checkbox", "url"] as const;

/**
 * The columns a brand-new board is born with.
 *
 * Also the *migration*: seeded onto the default board, these ids are the exact
 * strings pre-boards tasks already hold in `tasks.status`, so the enum becomes
 * a foreign key with no row rewritten. Only the default board gets these ids —
 * every other board mints UUIDs.
 */
const SEED_STATUSES: { id: string; name: string; color: BoardColor; category: StatusCategory }[] = [
  { id: "todo", name: "To do", color: "slate", category: "todo" },
  { id: "in_progress", name: "In progress", color: "blue", category: "in_progress" },
  { id: "blocked", name: "Blocked", color: "rose", category: "in_progress" },
  { id: "done", name: "Done", color: "emerald", category: "done" },
];

// ---- input schemas ----

const BoardName = z.string().trim().min(1).max(120);
const Color = z.enum(BOARD_COLORS).nullable().optional();
/** 2–6 uppercase letters or digits, starting with a letter — `DAE`, `WEB2`. */
export const BoardKey = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9]{1,5}$/, "a key is 2–6 letters or digits, starting with a letter");

export const CustomFieldSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(60),
  type: z.enum(FIELD_TYPES),
  options: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
});

export const CreateBoardSchema = z.object({
  name: BoardName,
  key: BoardKey.optional(),
  description: z.string().max(2000).nullable().optional(),
  projectId: z.string().min(1).nullable().optional(),
  color: Color,
  /** Column names to start with; omitted = the four seed columns. */
  statuses: z.array(z.string().trim().min(1).max(60)).max(24).optional(),
});

export const UpdateBoardSchema = z
  .object({
    name: BoardName.optional(),
    key: BoardKey.optional(),
    description: z.string().max(2000).nullable().optional(),
    projectId: z.string().min(1).nullable().optional(),
    color: Color,
    order: z.number().int().min(0).optional(),
    customFields: z.array(CustomFieldSchema).max(30).optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, "nothing to update");

export const CreateStatusSchema = z.object({
  name: z.string().trim().min(1).max(60),
  color: Color,
  category: z.enum(STATUS_CATEGORIES).optional(),
  wipLimit: z.number().int().min(1).max(999).nullable().optional(),
  /** Where to insert it; omitted = last. */
  order: z.number().int().min(0).optional(),
});

export const UpdateStatusSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    color: Color,
    category: z.enum(STATUS_CATEGORIES).optional(),
    wipLimit: z.number().int().min(1).max(999).nullable().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, "nothing to update");

export const ReorderStatusesSchema = z.object({ ids: z.array(z.string().min(1)).max(64) });

export const CreateSprintSchema = z.object({
  name: z.string().trim().min(1).max(120),
  goal: z.string().max(2000).nullable().optional(),
  startAt: z.number().int().min(0).nullable().optional(),
  endAt: z.number().int().min(0).nullable().optional(),
});

export const UpdateSprintSchema = CreateSprintSchema.partial().refine(
  (patch) => Object.keys(patch).length > 0,
  "nothing to update",
);

/** Closing a sprint: where do its open tasks go? `next` = the first planned
    sprint after it (created on the fly if there is none), `backlog` = nowhere. */
export const CompleteSprintSchema = z.object({
  moveTo: z.enum(["backlog", "next"]).default("backlog"),
});

export const ViewConfigSchema = z.object({
  filters: z.record(z.string(), z.unknown()).optional(),
  groupBy: z.string().max(40).optional(),
  sortBy: z.string().max(40).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
  columns: z.array(z.string().max(40)).max(40).optional(),
});

export const CreateViewSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(VIEW_KINDS),
  config: ViewConfigSchema.optional(),
});

export const UpdateViewSchema = CreateViewSchema.partial()
  .extend({ order: z.number().int().min(0).optional() })
  .refine((patch) => Object.keys(patch).length > 0, "nothing to update");

// ---- lists ----

export const CreateListSchema = z.object({
  name: z.string().trim().min(1).max(120),
  color: Color,
  group: z.string().trim().max(60).nullable().optional(),
});

export const UpdateListSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    color: Color,
    order: z.number().int().min(0).optional(),
    group: z.string().trim().max(60).nullable().optional(),
    collapsed: z.boolean().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, "nothing to update");

export const ReorderListsSchema = z.object({ ids: z.array(z.string().min(1)).max(64) });

export type CreateListInput = z.infer<typeof CreateListSchema>;
export type UpdateListInput = z.infer<typeof UpdateListSchema>;

export type CreateBoardInput = z.infer<typeof CreateBoardSchema>;
export type UpdateBoardInput = z.infer<typeof UpdateBoardSchema>;
export type CreateStatusInput = z.infer<typeof CreateStatusSchema>;
export type UpdateStatusInput = z.infer<typeof UpdateStatusSchema>;
export type CreateSprintInput = z.infer<typeof CreateSprintSchema>;
export type UpdateSprintInput = z.infer<typeof UpdateSprintSchema>;
export type CreateViewInput = z.infer<typeof CreateViewSchema>;
export type UpdateViewInput = z.infer<typeof UpdateViewSchema>;

/** Raised for the cases a caller can fix by asking differently — the routes
    turn these into a 400/404 rather than a 500. */
export class BoardError extends HttpError {
  constructor(message: string, status = 400) {
    super(message, status);
    this.name = "BoardError";
  }
}

// ---- reads ----

export async function listBoards(): Promise<Board[]> {
  return await conn().select().from(boards).orderBy(asc(boards.order), asc(boards.createdAt));
}

export async function getBoard(id: string): Promise<Board | undefined> {
  return (await conn().select().from(boards).where(eq(boards.id, id)).limit(1))[0];
}

/** Every status on one board, left to right. */
export async function listStatuses(boardId: string): Promise<BoardStatus[]> {
  return await conn()
    .select()
    .from(boardStatuses)
    .where(eq(boardStatuses.boardId, boardId))
    .orderBy(asc(boardStatuses.order), asc(boardStatuses.createdAt))
    ;
}

/** Every status on every board — one query, so the client can load the whole
    switcher without a request per board. */
export async function listAllStatuses(): Promise<BoardStatus[]> {
  return await conn()
    .select()
    .from(boardStatuses)
    .orderBy(asc(boardStatuses.boardId), asc(boardStatuses.order), asc(boardStatuses.createdAt))
    ;
}

export async function getStatus(id: string): Promise<BoardStatus | undefined> {
  return (await conn().select().from(boardStatuses).where(eq(boardStatuses.id, id)).limit(1))[0];
}

/** The column a task lands in when the caller named none: the board's first. */
export async function firstStatusId(boardId: string): Promise<string | undefined> {
  return (await listStatuses(boardId))[0]?.id;
}

export async function listAllSprints(): Promise<Sprint[]> {
  return await conn()
    .select()
    .from(sprints)
    .orderBy(asc(sprints.boardId), asc(sprints.order), asc(sprints.createdAt))
    ;
}

export async function listSprints(boardId: string): Promise<Sprint[]> {
  return await conn()
    .select()
    .from(sprints)
    .where(eq(sprints.boardId, boardId))
    .orderBy(asc(sprints.order), asc(sprints.createdAt))
    ;
}

export async function getSprint(id: string): Promise<Sprint | undefined> {
  return (await conn().select().from(sprints).where(eq(sprints.id, id)).limit(1))[0];
}

export async function listAllViews(): Promise<BoardView[]> {
  return await conn()
    .select()
    .from(boardViews)
    .orderBy(asc(boardViews.boardId), asc(boardViews.order), asc(boardViews.createdAt))
    ;
}

export async function getView(id: string): Promise<BoardView | undefined> {
  return (await conn().select().from(boardViews).where(eq(boardViews.id, id)).limit(1))[0];
}

// ---- writes ----

async function insertStatus(
  boardId: string,
  spec: {
    id?: string;
    name: string;
    color?: BoardColor | null;
    category?: StatusCategory;
    wipLimit?: number | null;
    order: number;
  },
  now: number,
): Promise<BoardStatus> {
  const id = spec.id ?? randomUUID();
  await conn().insert(boardStatuses)
    .values({
      id,
      boardId,
      name: spec.name,
      color: spec.color ?? null,
      category: spec.category ?? "todo",
      wipLimit: spec.wipLimit ?? null,
      order: spec.order,
      createdAt: now,
      updatedAt: now,
    });
  return (await getStatus(id))!;
}

/** A key from a name: the first letters of its words, or its first letters,
    upper-cased and made unique against every other board. */
export function keyFromName(name: string, taken: Set<string> = new Set()): string {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  let base =
    words.length >= 2
      ? words.map((w) => w[0]).join("").slice(0, 4)
      : (words[0] ?? "TASK").slice(0, 4);
  if (!/^[A-Z]/.test(base)) base = `T${base}`.slice(0, 4);
  if (base.length < 2) base = `${base}X`;
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) candidate = `${base}${n++}`.slice(0, 6);
  return candidate;
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
 *
 * It also backfills what a release added: a `done` category on any column
 * still named "Done", and a number on every task written before keys existed
 * (in creation order, per board), so the first boot after the upgrade shows
 * `TASK-1 … TASK-n` rather than a page of `TASK-0`.
 */
export async function ensureDefaultBoard(): Promise<void> {
  const now = Date.now();
  if ((await conn().select({ id: boards.id }).from(boards).limit(1)).length === 0) {
    await transaction(async () => {
      await conn().insert(boards)
        .values({
          id: DEFAULT_BOARD_ID,
          name: "Tasks",
          key: "TASK",
          color: null,
          order: 0,
          nextNumber: 1,
          customFields: [],
          createdAt: now,
          updatedAt: now,
        });
      /* A `for` loop and not `forEach(async …)`: the callback's promise is
         not awaited by forEach, so the seed columns would escape the
         transaction and land after the board they belong to was committed. */
      for (const [index, seed] of SEED_STATUSES.entries()) {
        await insertStatus(DEFAULT_BOARD_ID, { ...seed, order: index }, now);
      }
    });
  }
  await backfillNumbers(now);
}

/** Tasks with no number are pre-keys rows; give each a number after the
    board's current counter and advance it. Column categories the seed knew
    (`done`) are restored on the legacy ids too. */
async function backfillNumbers(now: number): Promise<void> {
  const unnumbered = await conn()
    .select()
    .from(tasksTable)
    .where(or(isNull(tasksTable.number), eq(tasksTable.number, 0)))
    .orderBy(asc(tasksTable.createdAt));
  const legacyDone = await getStatus("done");
  if (unnumbered.length === 0 && (!legacyDone || legacyDone.category === "done")) return;
  await transaction(async () => {
    if (legacyDone && legacyDone.category !== "done") {
      await conn().update(boardStatuses)
        .set({ category: "done", updatedAt: now })
        .where(eq(boardStatuses.id, "done"));
      await conn().update(boardStatuses)
        .set({ category: "in_progress", updatedAt: now })
        .where(inArray(boardStatuses.id, ["in_progress", "blocked"]));
    }
    const counters = new Map<string, number>();
    for (const task of unnumbered) {
      const board = await getBoard(task.boardId);
      if (!board) continue;
      const next = counters.get(board.id) ?? board.nextNumber;
      await conn().update(tasksTable).set({ number: next }).where(eq(tasksTable.id, task.id));
      counters.set(board.id, next + 1);
    }
    for (const [boardId, nextNumber] of counters) {
      await conn().update(boards).set({ nextNumber, updatedAt: now }).where(eq(boards.id, boardId));
    }
  });
}

export async function createBoard(input: CreateBoardInput): Promise<Board> {
  const id = randomUUID();
  const now = Date.now();
  const names = input.statuses?.length ? input.statuses : null;
  const existing = await listBoards();
  const taken = new Set(existing.map((b) => b.key));
  const key = input.key ?? keyFromName(input.name, taken);
  if (taken.has(key)) throw new BoardError(`the key ${key} is already used by another board`);
  await transaction(async () => {
    await conn().insert(boards)
      .values({
        id,
        name: input.name,
        key,
        description: input.description ?? null,
        projectId: input.projectId ?? null,
        color: input.color ?? null,
        order: existing.length,
        nextNumber: 1,
        customFields: [],
        createdAt: now,
        updatedAt: now,
      });
    /* `for` loops and not `forEach(async …)`: forEach does not await its
       callback, so the columns would escape the transaction — and a board
       committed without any is a board nothing can be filed on. */
    if (names) {
      for (const [index, name] of names.entries()) {
        await insertStatus(
          id,
          {
            name,
            order: index,
            // The last named column is the done one — the only sensible guess.
            category: index === names.length - 1 && names.length > 1 ? "done" : index === 0 ? "todo" : "in_progress",
          },
          now,
        );
      }
    } else {
      // A new board gets the seed columns by *name* only — the seed ids belong
      // to the default board, which is the one legacy tasks point at.
      for (const [index, seed] of SEED_STATUSES.entries()) {
        await insertStatus(
          id,
          { name: seed.name, color: seed.color, category: seed.category, order: index },
          now,
        );
      }
    }
  });
  return (await getBoard(id))!;
}

export async function updateBoard(id: string, input: UpdateBoardInput): Promise<Board | null> {
  if (!(await getBoard(id))) return null;
  const patch: Partial<Board> = { updatedAt: Date.now() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.key !== undefined) {
    const clash = (await listBoards()).find((b) => b.id !== id && b.key === input.key);
    if (clash) throw new BoardError(`the key ${input.key} is already used by "${clash.name}"`);
    patch.key = input.key;
  }
  if (input.description !== undefined) patch.description = input.description;
  if (input.projectId !== undefined) patch.projectId = input.projectId;
  if (input.color !== undefined) patch.color = input.color;
  if (input.order !== undefined) patch.order = input.order;
  if (input.customFields !== undefined) {
    // A field keeps its id across edits so task values survive a rename; a new
    // one is minted here.
    patch.customFields = input.customFields.map<CustomFieldDef>((f) => ({
      id: f.id ?? randomUUID(),
      name: f.name,
      type: f.type,
      ...(f.type === "select" ? { options: f.options ?? [] } : {}),
    }));
  }
  await conn().update(boards).set(patch).where(eq(boards.id, id));
  return (await getBoard(id)) ?? null;
}

/**
 * Delete a board, its columns, sprints, views and its tasks (with their
 * comments, activity and links), in one transaction.
 *
 * Refuses the last board: the app's only view of tasks is a board, so an
 * install with none is one where the page has nothing to render and no way
 * back except creating one — a state worth making unreachable rather than
 * handling.
 */
export async function deleteBoard(id: string): Promise<boolean> {
  if (!(await getBoard(id))) return false;
  if ((await listBoards()).length <= 1) throw new BoardError("the last board cannot be deleted");
  await transaction(async () => {
    const ids = (
      await conn().select({ id: tasksTable.id }).from(tasksTable).where(eq(tasksTable.boardId, id))
    ).map((r) => r.id);
    if (ids.length > 0) {
      await conn().delete(taskComments).where(inArray(taskComments.taskId, ids));
      await conn().delete(taskActivity).where(inArray(taskActivity.taskId, ids));
      await conn().delete(taskLinks).where(inArray(taskLinks.fromId, ids));
      await conn().delete(taskLinks).where(inArray(taskLinks.toId, ids));
    }
    await conn().delete(tasksTable).where(eq(tasksTable.boardId, id));
    await conn().delete(boardStatuses).where(eq(boardStatuses.boardId, id));
    await conn().delete(sprints).where(eq(sprints.boardId, id));
    await conn().delete(boardViews).where(eq(boardViews.boardId, id));
    await conn().delete(boardLists).where(eq(boardLists.boardId, id));
    await conn().delete(boards).where(eq(boards.id, id));
  });
  return true;
}

export async function createStatus(boardId: string, input: CreateStatusInput): Promise<BoardStatus> {
  if (!(await getBoard(boardId))) throw new BoardError("unknown board", 404);
  const existing = await listStatuses(boardId);
  const at = Math.min(input.order ?? existing.length, existing.length);
  const now = Date.now();
  let created!: BoardStatus;
  await transaction(async () => {
    /* Inserting in the middle pushes everything at or after `at` one right, so
       `order` stays a dense 0..n-1 run and the board never has to sort ties.
       A `for` loop and not `forEach(async …)`: the callback's promise is not
       awaited by forEach, so the writes would escape the transaction and the
       function would return before any of them landed. */
    for (const [offset, status] of existing.slice(at).entries()) {
      await conn().update(boardStatuses)
        .set({ order: at + offset + 1, updatedAt: now })
        .where(eq(boardStatuses.id, status.id));
    }
    created = await insertStatus(
      boardId,
      {
        name: input.name,
        color: input.color,
        category: input.category,
        wipLimit: input.wipLimit,
        order: at,
      },
      now,
    );
  });
  return created;
}

export async function updateStatus(id: string, input: UpdateStatusInput): Promise<BoardStatus | null> {
  const status = await getStatus(id);
  if (!status) return null;
  const now = Date.now();
  const patch: Partial<BoardStatus> = { updatedAt: now };
  if (input.name !== undefined) patch.name = input.name;
  if (input.color !== undefined) patch.color = input.color;
  if (input.category !== undefined) patch.category = input.category;
  if (input.wipLimit !== undefined) patch.wipLimit = input.wipLimit;
  await transaction(async () => {
    await conn().update(boardStatuses).set(patch).where(eq(boardStatuses.id, id));
    /* A column that becomes (or stops being) done changes what every task in
       it means: stamp or clear their completion so the sprint counts and the
       "done this week" filters agree with the board. */
    if (input.category !== undefined && input.category !== status.category) {
      const nowDone = input.category === "done";
      await conn().update(tasksTable)
        .set({ completedAt: nowDone ? now : null, updatedAt: now })
        .where(and(eq(tasksTable.boardId, status.boardId), eq(tasksTable.statusId, id)));
    }
  });
  return (await getStatus(id)) ?? null;
}

/**
 * Delete a column and rehome its tasks.
 *
 * `moveTo` is the caller's answer to "where do its tasks go?" and must name a
 * column on the same board; omitted, they go to the first remaining column.
 * Refuses the board's last column for the reason `deleteBoard` refuses the last
 * board — the tasks would have nowhere to be.
 */
export async function deleteStatus(id: string, moveTo?: string): Promise<boolean> {
  const status = await getStatus(id);
  if (!status) return false;
  const siblings = (await listStatuses(status.boardId)).filter((s) => s.id !== id);
  if (siblings.length === 0) throw new BoardError("a board needs at least one column");
  const target = moveTo ? siblings.find((s) => s.id === moveTo) : siblings[0];
  if (!target) throw new BoardError("moveTo must name another column on the same board");

  const now = Date.now();
  await transaction(async () => {
    // The rehomed tasks go to the end of the target column, keeping their order
    // relative to each other.
    const tail = (
      await conn()
        .select()
        .from(tasksTable)
        .where(and(eq(tasksTable.boardId, status.boardId), eq(tasksTable.statusId, target.id)))
    ).length;
    const moving = await conn()
      .select()
      .from(tasksTable)
      .where(and(eq(tasksTable.boardId, status.boardId), eq(tasksTable.statusId, id)))
      .orderBy(asc(tasksTable.order));
    const completedAt = target.category === "done" ? now : null;
    for (const [index, task] of moving.entries()) {
      await conn().update(tasksTable)
        .set({
          statusId: target.id,
          order: tail + index,
          completedAt: target.category === "done" ? (task.completedAt ?? completedAt) : null,
          updatedAt: now,
        })
        .where(eq(tasksTable.id, task.id));
    }
    await conn().delete(boardStatuses).where(eq(boardStatuses.id, id));
    // Close the gap the delete left, so `order` stays dense.
    for (const [index, sibling] of siblings.entries()) {
      if (sibling.order === index) continue;
      await conn().update(boardStatuses)
        .set({ order: index, updatedAt: now })
        .where(eq(boardStatuses.id, sibling.id));
    }
  });
  return true;
}

/** Left-to-right column order for one board, from the full list of its ids.
    Ids that are not this board's are ignored; ones left out keep their place
    at the end, so a stale client can never lose a column. */
export async function reorderStatuses(boardId: string, ids: string[]): Promise<BoardStatus[]> {
  const existing = await listStatuses(boardId);
  const known = new Set(existing.map((s) => s.id));
  const ordered = [...ids.filter((id) => known.has(id))];
  for (const status of existing) if (!ordered.includes(status.id)) ordered.push(status.id);
  const now = Date.now();
  await transaction(async () => {
    for (const [index, id] of ordered.entries()) {
      await conn().update(boardStatuses)
        .set({ order: index, updatedAt: now })
        .where(eq(boardStatuses.id, id));
    }
  });
  return await listStatuses(boardId);
}

// ---- sprints ----

export async function createSprint(boardId: string, input: CreateSprintInput): Promise<Sprint> {
  if (!(await getBoard(boardId))) throw new BoardError("unknown board", 404);
  if (input.startAt != null && input.endAt != null && input.endAt < input.startAt)
    throw new BoardError("a sprint cannot end before it starts");
  const id = randomUUID();
  const now = Date.now();
  await conn().insert(sprints)
    .values({
      id,
      boardId,
      name: input.name,
      goal: input.goal ?? null,
      startAt: input.startAt ?? null,
      endAt: input.endAt ?? null,
      state: "planned",
      order: (await listSprints(boardId)).length,
      createdAt: now,
      updatedAt: now,
    });
  return (await getSprint(id))!;
}

export async function updateSprint(id: string, input: UpdateSprintInput): Promise<Sprint | null> {
  const sprint = await getSprint(id);
  if (!sprint) return null;
  const patch: Partial<Sprint> = { updatedAt: Date.now() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.goal !== undefined) patch.goal = input.goal;
  if (input.startAt !== undefined) patch.startAt = input.startAt;
  if (input.endAt !== undefined) patch.endAt = input.endAt;
  const startAt = patch.startAt !== undefined ? patch.startAt : sprint.startAt;
  const endAt = patch.endAt !== undefined ? patch.endAt : sprint.endAt;
  if (startAt != null && endAt != null && endAt < startAt)
    throw new BoardError("a sprint cannot end before it starts");
  await conn().update(sprints).set(patch).where(eq(sprints.id, id));
  return (await getSprint(id)) ?? null;
}

/** Start a planned sprint. One active sprint per board: starting a second
    is refused rather than silently closing the first. */
export async function startSprint(id: string): Promise<Sprint> {
  const sprint = await getSprint(id);
  if (!sprint) throw new BoardError("unknown sprint", 404);
  if (sprint.state !== "planned") throw new BoardError(`the sprint is already ${sprint.state}`);
  const active = (await listSprints(sprint.boardId)).find((s) => s.state === "active");
  if (active) throw new BoardError(`"${active.name}" is still active — complete it first`);
  const now = Date.now();
  await conn().update(sprints)
    .set({
      state: "active",
      startAt: sprint.startAt ?? now,
      endAt: sprint.endAt ?? now + 14 * 24 * 60 * 60_000,
      updatedAt: now,
    })
    .where(eq(sprints.id, id));
  return (await getSprint(id))!;
}

/**
 * Close a sprint and move what is not done.
 *
 * Done tasks stay on the closed sprint (that is its record); open ones go to
 * the backlog or to the next planned sprint, which is created if the board has
 * none — a closer who asked for "next" gets one, not an error.
 */
export async function completeSprint(
  id: string,
  moveTo: "backlog" | "next",
): Promise<{ sprint: Sprint; moved: number; next: Sprint | null }> {
  const sprint = await getSprint(id);
  if (!sprint) throw new BoardError("unknown sprint", 404);
  if (sprint.state === "closed") throw new BoardError("the sprint is already closed");
  const doneIds = new Set(
    (await listStatuses(sprint.boardId))
      .filter((s) => s.category === "done")
      .map((s) => s.id),
  );
  const now = Date.now();
  let moved = 0;
  let next: Sprint | null = null;
  await transaction(async () => {
    if (moveTo === "next") {
      const siblings = await listSprints(sprint.boardId);
      next =
        siblings.find((s) => s.state === "planned" && s.order > sprint.order) ??
        siblings.find((s) => s.state === "planned") ??
        null;
      if (!next) {
        const n = siblings.length + 1;
        next = await createSprint(sprint.boardId, { name: `Sprint ${n}` });
      }
    }
    const open = (
      await conn().select().from(tasksTable).where(eq(tasksTable.sprintId, id))
    ).filter((t) => !doneIds.has(t.statusId));
    for (const task of open) {
      await conn().update(tasksTable)
        .set({ sprintId: next?.id ?? null, updatedAt: now })
        .where(eq(tasksTable.id, task.id));
      moved++;
    }
    await conn()
      .update(sprints)
      .set({ state: "closed", endAt: sprint.endAt ?? now, updatedAt: now })
      .where(eq(sprints.id, id));
  });
  return { sprint: (await getSprint(id))!, moved, next };
}

/** Delete a sprint; its tasks return to the backlog. */
export async function deleteSprint(id: string): Promise<boolean> {
  if (!(await getSprint(id))) return false;
  const now = Date.now();
  await transaction(async () => {
    await conn().update(tasksTable)
      .set({ sprintId: null, updatedAt: now })
      .where(eq(tasksTable.sprintId, id));
    await conn().delete(sprints).where(eq(sprints.id, id));
  });
  return true;
}

// ---- saved views ----

export async function createView(boardId: string, input: CreateViewInput): Promise<BoardView> {
  if (!await getBoard(boardId)) throw new BoardError("unknown board", 404);
  const id = randomUUID();
  const now = Date.now();
  await conn().insert(boardViews)
    .values({
      id,
      boardId,
      name: input.name,
      kind: input.kind,
      config: input.config ?? {},
      order: (await listAllViews()).filter((v) => v.boardId === boardId).length,
      createdAt: now,
      updatedAt: now,
    });
  return (await getView(id))!;
}

export async function updateView(id: string, input: UpdateViewInput): Promise<BoardView | null> {
  if (!(await getView(id))) return null;
  const patch: Partial<BoardView> = { updatedAt: Date.now() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.kind !== undefined) patch.kind = input.kind;
  if (input.config !== undefined) patch.config = input.config;
  if (input.order !== undefined) patch.order = input.order;
  await conn().update(boardViews).set(patch).where(eq(boardViews.id, id));
  return (await getView(id)) ?? null;
}

export async function deleteView(id: string): Promise<boolean> {
  return ((await conn().delete(boardViews).where(eq(boardViews.id, id))).rowCount ?? 0) > 0;
}

// ---- lists ----

export async function listLists(boardId: string): Promise<BoardList[]> {
  return await conn()
    .select()
    .from(boardLists)
    .where(eq(boardLists.boardId, boardId))
    .orderBy(asc(boardLists.order), asc(boardLists.createdAt));
}

export async function listAllLists(): Promise<BoardList[]> {
  return await conn()
    .select()
    .from(boardLists)
    .orderBy(asc(boardLists.boardId), asc(boardLists.order), asc(boardLists.createdAt));
}

export async function getList(id: string): Promise<BoardList | undefined> {
  return (await conn().select().from(boardLists).where(eq(boardLists.id, id)).limit(1))[0];
}

export async function createList(boardId: string, input: CreateListInput): Promise<BoardList> {
  if (!(await getBoard(boardId))) throw new BoardError("unknown board", 404);
  const id = randomUUID();
  const now = Date.now();
  const existing = (await listLists(boardId)).length;
  await conn().insert(boardLists)
    .values({
      id,
      boardId,
      name: input.name,
      color: input.color ?? null,
      group: input.group ?? null,
      order: existing,
      collapsed: false,
      createdAt: now,
      updatedAt: now,
    });
  return (await getList(id))!;
}

export async function updateList(id: string, input: UpdateListInput): Promise<BoardList | null> {
  const list = await getList(id);
  if (!list) return null;
  const patch: Partial<BoardList> = { updatedAt: Date.now() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.color !== undefined) patch.color = input.color;
  if (input.order !== undefined) patch.order = input.order;
  if (input.group !== undefined) patch.group = input.group;
  if (input.collapsed !== undefined) patch.collapsed = input.collapsed;
  await conn().update(boardLists).set(patch).where(eq(boardLists.id, id));
  return (await getList(id)) ?? null;
}

export async function reorderLists(boardId: string, ids: string[]): Promise<BoardList[]> {
  const existing = await listLists(boardId);
  const known = new Set(existing.map((l) => l.id));
  const ordered = [...ids.filter((id) => known.has(id))];
  for (const list of existing) if (!ordered.includes(list.id)) ordered.push(list.id);
  const now = Date.now();
  await transaction(async () => {
    for (const [index, id] of ordered.entries()) {
      await conn().update(boardLists)
        .set({ order: index, updatedAt: now })
        .where(eq(boardLists.id, id));
    }
  });
  return await listLists(boardId);
}

export async function deleteList(id: string): Promise<boolean> {
  const list = await getList(id);
  if (!list) return false;
  const now = Date.now();
  await transaction(async () => {
    // Unlist the tasks that were in this list rather than deleting them.
    await conn().update(tasksTable)
      .set({ listId: null, updatedAt: now })
      .where(eq(tasksTable.listId, id));
    await conn().delete(boardLists).where(eq(boardLists.id, id));
  });
  return true;
}

// ---- repair ----

/**
 * Repair tasks pointing at a column, sprint or parent that no longer exists.
 *
 * Nothing in this file can produce one — every delete rehomes — but a backup
 * import can (a bundle whose tasks outlive their board's columns), and a task
 * with a dangling `statusId` renders in no column at all, which reads as data
 * loss. Called after an import; cheap enough to be worth the certainty.
 */
export async function reconcileTaskStatuses(): Promise<number> {
  const byBoard = new Map<string, Set<string>>();
  for (const status of await listAllStatuses()) {
    let set = byBoard.get(status.boardId);
    if (!set) byBoard.set(status.boardId, (set = new Set()));
    set.add(status.id);
  }
  const fallback = new Map<string, string>();
  for (const board of await listBoards()) {
    const first = await firstStatusId(board.id);
    if (first) fallback.set(board.id, first);
  }
  const sprintIds = new Set((await listAllSprints()).map((s) => s.id));
  const listIds = new Set((await listAllLists()).map((l) => l.id));
  const defaultBoard = (await listBoards())[0];
  let repaired = 0;
  const now = Date.now();
  await transaction(async () => {
    const all = await conn().select().from(tasksTable);
    const taskIds = new Set(all.map((t) => t.id));
    for (const task of all) {
      const patch: Partial<typeof task> = {};
      const valid = byBoard.get(task.boardId)?.has(task.statusId) ?? false;
      if (!valid) {
        const boardId = byBoard.has(task.boardId) ? task.boardId : defaultBoard?.id;
        const statusId = boardId ? fallback.get(boardId) : undefined;
        if (boardId && statusId) Object.assign(patch, { boardId, statusId });
      }
      if (task.sprintId && !sprintIds.has(task.sprintId)) patch.sprintId = null;
      if (task.parentId && !taskIds.has(task.parentId)) patch.parentId = null;
      if (task.listId && !listIds.has(task.listId)) patch.listId = null;
      if (Object.keys(patch).length === 0) continue;
      await conn().update(tasksTable)
        .set({ ...patch, updatedAt: now })
        .where(eq(tasksTable.id, task.id));
      repaired++;
    }
  });
  return repaired;
}

/** Assert a (board, status) pair the client sent is real and consistent. */
export async function assertStatusOnBoard(boardId: string, statusId: string): Promise<void> {
  const status = await getStatus(statusId);
  if (!status) throw new BoardError("unknown status", 404);
  if (status.boardId !== boardId) throw new BoardError("that status is on another board");
}
