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
  boardStatuses,
  boardViews,
  boards,
  db,
  sprints,
  taskActivity,
  taskComments,
  taskLinks,
  tasks as tasksTable,
  type CustomFieldDef,
} from "./db/index.js";
import { HttpError } from "./http-error.js";

export type Board = typeof boards.$inferSelect;
export type BoardStatus = typeof boardStatuses.$inferSelect;
export type Sprint = typeof sprints.$inferSelect;
export type BoardView = typeof boardViews.$inferSelect;

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

export function listAllSprints(): Sprint[] {
  return db
    .select()
    .from(sprints)
    .orderBy(asc(sprints.boardId), asc(sprints.order), asc(sprints.createdAt))
    .all();
}

export function listSprints(boardId: string): Sprint[] {
  return db
    .select()
    .from(sprints)
    .where(eq(sprints.boardId, boardId))
    .orderBy(asc(sprints.order), asc(sprints.createdAt))
    .all();
}

export function getSprint(id: string): Sprint | undefined {
  return db.select().from(sprints).where(eq(sprints.id, id)).get();
}

export function listAllViews(): BoardView[] {
  return db
    .select()
    .from(boardViews)
    .orderBy(asc(boardViews.boardId), asc(boardViews.order), asc(boardViews.createdAt))
    .all();
}

export function getView(id: string): BoardView | undefined {
  return db.select().from(boardViews).where(eq(boardViews.id, id)).get();
}

// ---- writes ----

function insertStatus(
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
): BoardStatus {
  const id = spec.id ?? randomUUID();
  db.insert(boardStatuses)
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
    })
    .run();
  return getStatus(id)!;
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
export function ensureDefaultBoard(): void {
  const now = Date.now();
  if (db.select({ id: boards.id }).from(boards).limit(1).all().length === 0) {
    db.transaction(() => {
      db.insert(boards)
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
        })
        .run();
      SEED_STATUSES.forEach((seed, index) =>
        insertStatus(DEFAULT_BOARD_ID, { ...seed, order: index }, now),
      );
    });
  }
  backfillNumbers(now);
}

/** Tasks with no number are pre-keys rows; give each a number after the
    board's current counter and advance it. Column categories the seed knew
    (`done`) are restored on the legacy ids too. */
function backfillNumbers(now: number): void {
  const unnumbered = db
    .select()
    .from(tasksTable)
    .where(or(isNull(tasksTable.number), eq(tasksTable.number, 0)))
    .orderBy(asc(tasksTable.createdAt))
    .all();
  const legacyDone = getStatus("done");
  if (unnumbered.length === 0 && (!legacyDone || legacyDone.category === "done")) return;
  db.transaction(() => {
    if (legacyDone && legacyDone.category !== "done") {
      db.update(boardStatuses)
        .set({ category: "done", updatedAt: now })
        .where(eq(boardStatuses.id, "done"))
        .run();
      db.update(boardStatuses)
        .set({ category: "in_progress", updatedAt: now })
        .where(inArray(boardStatuses.id, ["in_progress", "blocked"]))
        .run();
    }
    const counters = new Map<string, number>();
    for (const task of unnumbered) {
      const board = getBoard(task.boardId);
      if (!board) continue;
      const next = counters.get(board.id) ?? board.nextNumber;
      db.update(tasksTable).set({ number: next }).where(eq(tasksTable.id, task.id)).run();
      counters.set(board.id, next + 1);
    }
    for (const [boardId, nextNumber] of counters) {
      db.update(boards).set({ nextNumber, updatedAt: now }).where(eq(boards.id, boardId)).run();
    }
  });
}

export function createBoard(input: CreateBoardInput): Board {
  const id = randomUUID();
  const now = Date.now();
  const names = input.statuses?.length ? input.statuses : null;
  const existing = listBoards();
  const taken = new Set(existing.map((b) => b.key));
  const key = input.key ?? keyFromName(input.name, taken);
  if (taken.has(key)) throw new BoardError(`the key ${key} is already used by another board`);
  db.transaction(() => {
    db.insert(boards)
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
      })
      .run();
    if (names) {
      names.forEach((name, index) =>
        insertStatus(
          id,
          {
            name,
            order: index,
            // The last named column is the done one — the only sensible guess.
            category: index === names.length - 1 && names.length > 1 ? "done" : index === 0 ? "todo" : "in_progress",
          },
          now,
        ),
      );
    } else {
      // A new board gets the seed columns by *name* only — the seed ids belong
      // to the default board, which is the one legacy tasks point at.
      SEED_STATUSES.forEach((seed, index) =>
        insertStatus(
          id,
          { name: seed.name, color: seed.color, category: seed.category, order: index },
          now,
        ),
      );
    }
  });
  return getBoard(id)!;
}

export function updateBoard(id: string, input: UpdateBoardInput): Board | null {
  if (!getBoard(id)) return null;
  const patch: Partial<Board> = { updatedAt: Date.now() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.key !== undefined) {
    const clash = listBoards().find((b) => b.id !== id && b.key === input.key);
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
  db.update(boards).set(patch).where(eq(boards.id, id)).run();
  return getBoard(id) ?? null;
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
export function deleteBoard(id: string): boolean {
  if (!getBoard(id)) return false;
  if (listBoards().length <= 1) throw new BoardError("the last board cannot be deleted");
  db.transaction(() => {
    const ids = db
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(eq(tasksTable.boardId, id))
      .all()
      .map((r) => r.id);
    if (ids.length > 0) {
      db.delete(taskComments).where(inArray(taskComments.taskId, ids)).run();
      db.delete(taskActivity).where(inArray(taskActivity.taskId, ids)).run();
      db.delete(taskLinks).where(inArray(taskLinks.fromId, ids)).run();
      db.delete(taskLinks).where(inArray(taskLinks.toId, ids)).run();
    }
    db.delete(tasksTable).where(eq(tasksTable.boardId, id)).run();
    db.delete(boardStatuses).where(eq(boardStatuses.boardId, id)).run();
    db.delete(sprints).where(eq(sprints.boardId, id)).run();
    db.delete(boardViews).where(eq(boardViews.boardId, id)).run();
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
    created = insertStatus(
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

export function updateStatus(id: string, input: UpdateStatusInput): BoardStatus | null {
  const status = getStatus(id);
  if (!status) return null;
  const now = Date.now();
  const patch: Partial<BoardStatus> = { updatedAt: now };
  if (input.name !== undefined) patch.name = input.name;
  if (input.color !== undefined) patch.color = input.color;
  if (input.category !== undefined) patch.category = input.category;
  if (input.wipLimit !== undefined) patch.wipLimit = input.wipLimit;
  db.transaction(() => {
    db.update(boardStatuses).set(patch).where(eq(boardStatuses.id, id)).run();
    /* A column that becomes (or stops being) done changes what every task in
       it means: stamp or clear their completion so the sprint counts and the
       "done this week" filters agree with the board. */
    if (input.category !== undefined && input.category !== status.category) {
      const nowDone = input.category === "done";
      db.update(tasksTable)
        .set({ completedAt: nowDone ? now : null, updatedAt: now })
        .where(and(eq(tasksTable.boardId, status.boardId), eq(tasksTable.statusId, id)))
        .run();
    }
  });
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
    const completedAt = target.category === "done" ? now : null;
    moving.forEach((task, index) => {
      db.update(tasksTable)
        .set({
          statusId: target.id,
          order: tail + index,
          completedAt: target.category === "done" ? (task.completedAt ?? completedAt) : null,
          updatedAt: now,
        })
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

// ---- sprints ----

export function createSprint(boardId: string, input: CreateSprintInput): Sprint {
  if (!getBoard(boardId)) throw new BoardError("unknown board", 404);
  if (input.startAt != null && input.endAt != null && input.endAt < input.startAt)
    throw new BoardError("a sprint cannot end before it starts");
  const id = randomUUID();
  const now = Date.now();
  db.insert(sprints)
    .values({
      id,
      boardId,
      name: input.name,
      goal: input.goal ?? null,
      startAt: input.startAt ?? null,
      endAt: input.endAt ?? null,
      state: "planned",
      order: listSprints(boardId).length,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return getSprint(id)!;
}

export function updateSprint(id: string, input: UpdateSprintInput): Sprint | null {
  const sprint = getSprint(id);
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
  db.update(sprints).set(patch).where(eq(sprints.id, id)).run();
  return getSprint(id) ?? null;
}

/** Start a planned sprint. One active sprint per board: starting a second
    is refused rather than silently closing the first. */
export function startSprint(id: string): Sprint {
  const sprint = getSprint(id);
  if (!sprint) throw new BoardError("unknown sprint", 404);
  if (sprint.state !== "planned") throw new BoardError(`the sprint is already ${sprint.state}`);
  const active = listSprints(sprint.boardId).find((s) => s.state === "active");
  if (active) throw new BoardError(`"${active.name}" is still active — complete it first`);
  const now = Date.now();
  db.update(sprints)
    .set({
      state: "active",
      startAt: sprint.startAt ?? now,
      endAt: sprint.endAt ?? now + 14 * 24 * 60 * 60_000,
      updatedAt: now,
    })
    .where(eq(sprints.id, id))
    .run();
  return getSprint(id)!;
}

/**
 * Close a sprint and move what is not done.
 *
 * Done tasks stay on the closed sprint (that is its record); open ones go to
 * the backlog or to the next planned sprint, which is created if the board has
 * none — a closer who asked for "next" gets one, not an error.
 */
export function completeSprint(
  id: string,
  moveTo: "backlog" | "next",
): { sprint: Sprint; moved: number; next: Sprint | null } {
  const sprint = getSprint(id);
  if (!sprint) throw new BoardError("unknown sprint", 404);
  if (sprint.state === "closed") throw new BoardError("the sprint is already closed");
  const doneIds = new Set(
    listStatuses(sprint.boardId)
      .filter((s) => s.category === "done")
      .map((s) => s.id),
  );
  const now = Date.now();
  let moved = 0;
  let next: Sprint | null = null;
  db.transaction(() => {
    if (moveTo === "next") {
      const siblings = listSprints(sprint.boardId);
      next =
        siblings.find((s) => s.state === "planned" && s.order > sprint.order) ??
        siblings.find((s) => s.state === "planned") ??
        null;
      if (!next) {
        const n = siblings.length + 1;
        next = createSprint(sprint.boardId, { name: `Sprint ${n}` });
      }
    }
    const open = db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.sprintId, id))
      .all()
      .filter((t) => !doneIds.has(t.statusId));
    for (const task of open) {
      db.update(tasksTable)
        .set({ sprintId: next?.id ?? null, updatedAt: now })
        .where(eq(tasksTable.id, task.id))
        .run();
      moved++;
    }
    db.update(sprints)
      .set({ state: "closed", endAt: sprint.endAt ?? now, updatedAt: now })
      .where(eq(sprints.id, id))
      .run();
  });
  return { sprint: getSprint(id)!, moved, next };
}

/** Delete a sprint; its tasks return to the backlog. */
export function deleteSprint(id: string): boolean {
  if (!getSprint(id)) return false;
  const now = Date.now();
  db.transaction(() => {
    db.update(tasksTable)
      .set({ sprintId: null, updatedAt: now })
      .where(eq(tasksTable.sprintId, id))
      .run();
    db.delete(sprints).where(eq(sprints.id, id)).run();
  });
  return true;
}

// ---- saved views ----

export function createView(boardId: string, input: CreateViewInput): BoardView {
  if (!getBoard(boardId)) throw new BoardError("unknown board", 404);
  const id = randomUUID();
  const now = Date.now();
  db.insert(boardViews)
    .values({
      id,
      boardId,
      name: input.name,
      kind: input.kind,
      config: input.config ?? {},
      order: listAllViews().filter((v) => v.boardId === boardId).length,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return getView(id)!;
}

export function updateView(id: string, input: UpdateViewInput): BoardView | null {
  if (!getView(id)) return null;
  const patch: Partial<BoardView> = { updatedAt: Date.now() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.kind !== undefined) patch.kind = input.kind;
  if (input.config !== undefined) patch.config = input.config;
  if (input.order !== undefined) patch.order = input.order;
  db.update(boardViews).set(patch).where(eq(boardViews.id, id)).run();
  return getView(id) ?? null;
}

export function deleteView(id: string): boolean {
  return db.delete(boardViews).where(eq(boardViews.id, id)).run().changes > 0;
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
  const sprintIds = new Set(listAllSprints().map((s) => s.id));
  const defaultBoard = listBoards()[0];
  let repaired = 0;
  const now = Date.now();
  db.transaction(() => {
    const all = db.select().from(tasksTable).all();
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
      if (Object.keys(patch).length === 0) continue;
      db.update(tasksTable)
        .set({ ...patch, updatedAt: now })
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
