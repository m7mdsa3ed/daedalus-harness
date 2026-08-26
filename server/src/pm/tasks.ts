import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  count,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  max,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  db,
  pmActivity,
  pmBoards,
  pmColumns,
  pmComments,
  pmCustomFields,
  pmIssueTypes,
  pmLabels,
  pmMilestones,
  pmSprints,
  pmTaskDeps,
  pmTaskLabels,
  pmTasks,
} from "../db/index.js";
import { MAX_CHAIN_DEPTH, runAutomations } from "./automations.js";
import type {
  BoardRow,
  BulkOp,
  BulkReorder,
  ChangeRecord,
  ColumnRow,
  CommentInput,
  CommentRow,
  CustomFieldRow,
  FilterSpec,
  IssueTypeRow,
  LabelRow,
  MilestoneRow,
  MoveOp,
  Recurrence,
  SprintRow,
  TaskCreateInput,
  TaskPatch,
  TaskRow,
} from "./schema.js";

/*
 * Task queries and the applyMutation pipeline — the single choke point every
 * task write goes through, automations included. Filtering/paging happens in
 * SQL (the point of moving off JSON), and a returned task is always slim:
 * comments and activity live in their own tables and are never joined here.
 *
 * Every public mutation opens exactly ONE db.transaction. better-sqlite3 does
 * not nest transactions, so the recursion an automation chain needs happens in
 * the *InTx internals, which take the tx handle and never open their own.
 */

/** A rule violation the client caused — handlers read `status` off thrown
    errors (see /api/fs/list in index.ts), so 400 rides along here. */
export class PmInputError extends Error {
  readonly status = 400;
}

/** The wire shape of a task: the row plus its label ids (labels live in a
    join table, not a column — this is the only denormalization the client gets). */
export type Task = TaskRow & { labelIds: string[] };

export type ActivityRow = typeof pmActivity.$inferSelect;
export type TaskDepRow = typeof pmTaskDeps.$inferSelect;

/** Gap between adjacent ranks; a closed gap renormalizes the slice. */
const RANK_GAP = 1000;
const DAY_MS = 86_400_000;

/** The database handle inside `db.transaction` — same query surface, so every
    helper below takes either (see projects.ts for the pattern). */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Read helpers run both inside a mutation's transaction and bare. */
type Dbish = Tx | typeof db;

/** What applyMutationInTx accepts: the HTTP patch plus the fields only the
    server itself sets — moves (columnId/ranks) and the archive/trash stamps.
    HTTP bodies never reach these extras; MoveOp/BulkOp/automations produce them. */
type InternalPatch = TaskPatch & {
  columnId?: string;
  order?: number;
  backlogRank?: number;
  archivedAt?: number | null;
  deletedAt?: number | null;
};

/** Patch keys that map 1:1 onto columns. labelIds is deliberately absent —
    it is join rows, handled separately. */
const PATCHABLE = [
  "title",
  "descriptionMd",
  "typeId",
  "priority",
  "assignees",
  "startDate",
  "dueDate",
  "storyPoints",
  "estimateMinutes",
  "epicId",
  "parentId",
  "sprintId",
  "milestoneId",
  "recurrence",
  "customFieldValues",
  "checklists",
  "columnId",
  "order",
  "backlogRank",
  "archivedAt",
  "deletedAt",
] as const;

/** Rank fields are noise in a history — a renormalization would spray dozens
    of meaningless rows per task. */
const SILENT_FIELDS = new Set(["order", "backlogRank"]);

// ---------------------------------------------------------------------------
// Board context — loaded once per mutation, shared down the automation chain

interface BoardCtx {
  board: BoardRow;
  columns: ColumnRow[];
  labels: LabelRow[];
  issueTypes: IssueTypeRow[];
  customFields: CustomFieldRow[];
  sprints: SprintRow[];
  milestones: MilestoneRow[];
}

function loadBoardCtx(tx: Tx, boardId: string): BoardCtx | undefined {
  const board = tx.select().from(pmBoards).where(eq(pmBoards.id, boardId)).get();
  if (!board) return undefined;
  return {
    board,
    columns: tx
      .select()
      .from(pmColumns)
      .where(eq(pmColumns.boardId, boardId))
      .orderBy(asc(pmColumns.order))
      .all(),
    labels: tx.select().from(pmLabels).where(eq(pmLabels.boardId, boardId)).all(),
    issueTypes: tx
      .select()
      .from(pmIssueTypes)
      .where(eq(pmIssueTypes.boardId, boardId))
      .orderBy(asc(pmIssueTypes.order))
      .all(),
    customFields: tx
      .select()
      .from(pmCustomFields)
      .where(eq(pmCustomFields.boardId, boardId))
      .orderBy(asc(pmCustomFields.order))
      .all(),
    sprints: tx.select().from(pmSprints).where(eq(pmSprints.boardId, boardId)).all(),
    milestones: tx.select().from(pmMilestones).where(eq(pmMilestones.boardId, boardId)).all(),
  };
}

// ---------------------------------------------------------------------------
// Small shared helpers

function labelIdsOf(tx: Dbish, taskId: string): string[] {
  return tx
    .select({ labelId: pmTaskLabels.labelId })
    .from(pmTaskLabels)
    .where(eq(pmTaskLabels.taskId, taskId))
    .all()
    .map((r) => r.labelId);
}

/** Replace the task's label joins. Ids not on this board are dropped, not
    fatal — same stale-request stance as projects.existing(). */
function writeLabels(tx: Tx, ctx: BoardCtx, taskId: string, labelIds: string[]): string[] {
  const onBoard = new Set(ctx.labels.map((l) => l.id));
  const valid = [...new Set(labelIds)].filter((id) => onBoard.has(id));
  tx.delete(pmTaskLabels).where(eq(pmTaskLabels.taskId, taskId)).run();
  for (const labelId of valid) tx.insert(pmTaskLabels).values({ taskId, labelId }).run();
  return valid;
}

/** `<prefix>-<n>`, allocated atomically — the UPDATE…RETURNING is the lock, so
    concurrent inserts can never mint the same key. */
function allocateKey(tx: Tx, board: BoardRow): string {
  const row = tx
    .update(pmBoards)
    .set({ nextKey: sql`${pmBoards.nextKey} + 1` })
    .where(eq(pmBoards.id, board.id))
    .returning({ next: pmBoards.nextKey })
    .get()!;
  return `${board.keyPrefix}-${row.next - 1}`;
}

function endOfColumn(tx: Tx, boardId: string, columnId: string): number {
  const m = tx
    .select({ m: max(pmTasks.order) })
    .from(pmTasks)
    .where(and(eq(pmTasks.boardId, boardId), eq(pmTasks.columnId, columnId)))
    .get()?.m;
  return m == null ? 0 : m + RANK_GAP;
}

function endOfLane(tx: Tx, boardId: string, sprintId: string | null): number {
  const m = tx
    .select({ m: max(pmTasks.backlogRank) })
    .from(pmTasks)
    .where(
      and(
        eq(pmTasks.boardId, boardId),
        sprintId == null ? isNull(pmTasks.sprintId) : eq(pmTasks.sprintId, sprintId),
      ),
    )
    .get()?.m;
  return m == null ? 0 : m + RANK_GAP;
}

function appendActivity(tx: Tx, taskId: string, actor: string, changes: ChangeRecord[]): void {
  if (changes.length === 0) return;
  let seq =
    tx
      .select({ m: max(pmActivity.seq) })
      .from(pmActivity)
      .where(eq(pmActivity.taskId, taskId))
      .get()?.m ?? 0;
  const at = Date.now();
  for (const ch of changes) {
    tx.insert(pmActivity)
      .values({ taskId, seq: ++seq, at, actor, field: ch.field, from: ch.from, to: ch.to })
      .run();
  }
}

/** Typed 400 — an unknown field id or a value of the wrong shape must never
    reach the row, where nothing would ever validate it again. */
function validateCustomFieldValues(
  fields: CustomFieldRow[],
  values: Record<string, unknown>,
): void {
  const byId = new Map(fields.map((f) => [f.id, f]));
  for (const [id, value] of Object.entries(values)) {
    const field = byId.get(id);
    if (!field) throw new PmInputError(`unknown custom field: ${id}`);
    if (value == null) continue;
    const bad = () =>
      new PmInputError(`custom field "${field.name}" expects a ${field.type} value`);
    switch (field.type) {
      case "text":
      case "url":
        if (typeof value !== "string") throw bad();
        break;
      case "number":
      case "date":
        if (typeof value !== "number") throw bad();
        break;
      case "checkbox":
        if (typeof value !== "boolean") throw bad();
        break;
      case "select":
        if (typeof value !== "string" || !field.options?.includes(value)) throw bad();
        break;
      case "multiselect":
        if (
          !Array.isArray(value) ||
          value.some((v) => typeof v !== "string" || !field.options?.includes(v))
        )
          throw bad();
        break;
    }
  }
}

/** Ids in a patch must resolve on THIS board — an FK would catch a bad
    sprintId anyway, but as an opaque 500 instead of a 400 naming the field. */
function validateRefs(tx: Tx, ctx: BoardCtx, taskId: string | null, patch: InternalPatch): void {
  const check = (label: string, id: string | null | undefined, pool: { id: string }[]) => {
    if (id != null && !pool.some((e) => e.id === id))
      throw new PmInputError(`unknown ${label}: ${id}`);
  };
  check("column", patch.columnId, ctx.columns);
  check("issue type", patch.typeId, ctx.issueTypes);
  check("sprint", patch.sprintId, ctx.sprints);
  check("milestone", patch.milestoneId, ctx.milestones);
  for (const field of ["epicId", "parentId"] as const) {
    const id = patch[field];
    if (id == null) continue;
    if (id === taskId) throw new PmInputError(`a task cannot be its own ${field}`);
    const found = tx
      .select({ id: pmTasks.id })
      .from(pmTasks)
      .where(and(eq(pmTasks.id, id), eq(pmTasks.boardId, ctx.board.id)))
      .get();
    if (!found) throw new PmInputError(`unknown ${field}: ${id}`);
  }
}

function columnCategory(ctx: BoardCtx, columnId: string): "open" | "active" | "done" {
  return ctx.columns.find((c) => c.id === columnId)?.category ?? "open";
}

function advance(ts: number, r: Recurrence): number {
  const d = new Date(ts);
  switch (r.freq) {
    case "daily":
      d.setDate(d.getDate() + r.interval);
      break;
    case "weekly":
      d.setDate(d.getDate() + 7 * r.interval);
      break;
    case "monthly":
      d.setMonth(d.getMonth() + r.interval);
      break;
    case "yearly":
      d.setFullYear(d.getFullYear() + r.interval);
      break;
  }
  return d.getTime();
}

// ---------------------------------------------------------------------------
// The mutation pipeline

/** Run the board's rules against a finished mutation and recurse each effect
    back through the pipeline. `fired` is the chain's rule dedup — together
    with the depth cap it is what kills A→B→A cycles. */
function runAutomationPass(
  tx: Tx,
  ctx: BoardCtx,
  before: TaskRow | null,
  after: TaskRow,
  changes: ChangeRecord[],
  depth: number,
  fired: Set<string>,
): void {
  if (depth >= MAX_CHAIN_DEPTH) return;
  const effects = runAutomations(
    ctx.board.automations,
    {
      board: ctx.board,
      columns: ctx.columns,
      labels: ctx.labels,
      issueTypes: ctx.issueTypes,
      customFields: ctx.customFields,
      sprints: ctx.sprints,
      milestones: ctx.milestones,
      before,
      after,
      labelIds: labelIdsOf(tx, after.id),
      changes,
    },
    fired,
  );
  for (const { ruleId, patch } of effects) {
    fired.add(ruleId);
    // `archive` is the one non-field effect; the rest of the patch maps 1:1.
    const { archive, ...fields } = patch;
    applyMutationInTx(
      tx,
      ctx,
      after.id,
      { ...fields, ...(archive ? { archivedAt: Date.now() } : {}) },
      `automation:${ruleId}`,
      depth + 1,
      fired,
    );
  }
}

/** The choke point. Applies one patch, diffs it into ChangeRecords, journals
    them, lets automations react, and spawns the recurrence clone when this
    level is the one that completed the task. Never opens a transaction — the
    public wrappers do, exactly once. */
function applyMutationInTx(
  tx: Tx,
  ctx: BoardCtx,
  taskId: string,
  patch: InternalPatch,
  actor: string,
  depth: number,
  fired: Set<string>,
): TaskRow | undefined {
  const before = tx
    .select()
    .from(pmTasks)
    .where(and(eq(pmTasks.id, taskId), eq(pmTasks.boardId, ctx.board.id)))
    .get();
  if (!before) return undefined;

  if (patch.customFieldValues !== undefined)
    validateCustomFieldValues(ctx.customFields, patch.customFieldValues);
  validateRefs(tx, ctx, taskId, patch);

  const updates: Partial<TaskRow> = {};
  for (const key of PATCHABLE) {
    const value = patch[key];
    if (value !== undefined) (updates as Record<string, unknown>)[key] = value;
  }

  // A move into a done-category column completes the task; a move out
  // un-completes it. The column's category decides, not the client.
  if (updates.columnId !== undefined && updates.columnId !== before.columnId) {
    if (updates.order === undefined)
      updates.order = endOfColumn(tx, ctx.board.id, updates.columnId);
    const wasDone = columnCategory(ctx, before.columnId) === "done";
    const isDone = columnCategory(ctx, updates.columnId) === "done";
    if (!wasDone && isDone) updates.completedAt = Date.now();
    if (wasDone && !isDone) updates.completedAt = null;
  }
  // A sprint change without an explicit rank appends to the target lane.
  if (
    updates.sprintId !== undefined &&
    updates.sprintId !== before.sprintId &&
    updates.backlogRank === undefined
  ) {
    updates.backlogRank = endOfLane(tx, ctx.board.id, updates.sprintId);
  }

  const changes: ChangeRecord[] = [];
  for (const [field, to] of Object.entries(updates)) {
    const from = before[field as keyof TaskRow];
    if (JSON.stringify(from ?? null) === JSON.stringify(to ?? null)) {
      delete (updates as Record<string, unknown>)[field];
    } else if (!SILENT_FIELDS.has(field)) {
      changes.push({ field, from, to });
    }
  }

  let labelsChanged = false;
  if (patch.labelIds !== undefined) {
    const fromIds = labelIdsOf(tx, taskId);
    const toIds = writeLabels(tx, ctx, taskId, patch.labelIds);
    if (JSON.stringify([...fromIds].sort()) !== JSON.stringify([...toIds].sort())) {
      labelsChanged = true;
      changes.push({ field: "labels", from: fromIds, to: toIds });
    }
  }

  // A no-op patch is a no-op all the way down: no updatedAt churn, no
  // activity, no automations.
  if (Object.keys(updates).length === 0 && !labelsChanged) return before;

  updates.updatedAt = Date.now();
  tx.update(pmTasks).set(updates).where(eq(pmTasks.id, taskId)).run();
  const after = { ...before, ...updates };

  appendActivity(tx, taskId, actor, changes);
  const justCompleted = before.completedAt == null && after.completedAt != null;
  runAutomationPass(tx, ctx, before, after, changes, depth, fired);

  // Re-read: the automation chain above may have moved the row further.
  const current = tx.select().from(pmTasks).where(eq(pmTasks.id, taskId)).get()!;
  if (justCompleted && current.recurrence) spawnRecurrence(tx, ctx, current, actor, depth);
  return current;
}

/** Insert a task row with all the pipeline trimmings — key allocation, ranks,
    labels, the "created" activity row, the task_created automation pass.
    Shared by createTask and the recurrence spawner. */
function insertTaskInTx(
  tx: Tx,
  ctx: BoardCtx,
  input: TaskCreateInput,
  actor: string,
  depth: number,
  extra?: Partial<TaskRow>,
): TaskRow {
  if (ctx.columns.length === 0) throw new PmInputError("board has no columns");
  const columnId = input.columnId ?? ctx.columns[0].id;
  validateCustomFieldValues(ctx.customFields, input.customFieldValues);
  validateRefs(tx, ctx, null, { ...input, columnId });

  const now = Date.now();
  const row: TaskRow = {
    id: randomUUID(),
    boardId: ctx.board.id,
    key: allocateKey(tx, ctx.board),
    title: input.title,
    descriptionMd: input.descriptionMd,
    columnId,
    typeId: input.typeId,
    priority: input.priority,
    assignees: input.assignees,
    startDate: input.startDate,
    dueDate: input.dueDate,
    storyPoints: input.storyPoints,
    estimateMinutes: input.estimateMinutes,
    epicId: input.epicId,
    parentId: input.parentId,
    sprintId: input.sprintId,
    milestoneId: input.milestoneId,
    recurrence: input.recurrence,
    customFieldValues: input.customFieldValues,
    checklists: input.checklists,
    order: endOfColumn(tx, ctx.board.id, columnId),
    backlogRank: endOfLane(tx, ctx.board.id, input.sprintId),
    createdAt: now,
    updatedAt: now,
    // Creating straight into a done column keeps the invariant that a task in
    // a done-category column has a completedAt.
    completedAt: columnCategory(ctx, columnId) === "done" ? now : null,
    archivedAt: null,
    deletedAt: null,
    recurrenceParentId: null,
    ...extra,
  };
  tx.insert(pmTasks).values(row).run();
  writeLabels(tx, ctx, row.id, input.labelIds);
  appendActivity(tx, row.id, actor, [
    { field: "created", from: null, to: { key: row.key, title: row.title } },
  ]);
  // A spawn starts its own chain (new task, fresh rule dedup) but inherits the
  // depth so a create-loop still bottoms out.
  runAutomationPass(tx, ctx, null, row, [], depth, new Set());
  return tx.select().from(pmTasks).where(eq(pmTasks.id, row.id)).get()!;
}

/** Completing a recurring task clones it: fresh key, dates advanced by the
    recurrence, checklist ticks reset, comments/activity NOT carried — the
    clone is a new task whose provenance is `recurrenceParentId`. */
function spawnRecurrence(tx: Tx, ctx: BoardCtx, done: TaskRow, actor: string, depth: number): void {
  const r = done.recurrence!;
  // The clone must start un-completed, so it lands in the first non-done column.
  const target = ctx.columns.find((c) => c.category !== "done") ?? ctx.columns[0];
  insertTaskInTx(
    tx,
    ctx,
    {
      title: done.title,
      descriptionMd: done.descriptionMd,
      columnId: target.id,
      typeId: done.typeId,
      priority: done.priority,
      assignees: done.assignees,
      startDate: done.startDate == null ? null : advance(done.startDate, r),
      dueDate: done.dueDate == null ? null : advance(done.dueDate, r),
      storyPoints: done.storyPoints,
      estimateMinutes: done.estimateMinutes,
      epicId: done.epicId,
      parentId: done.parentId,
      sprintId: done.sprintId,
      milestoneId: done.milestoneId,
      labelIds: labelIdsOf(tx, done.id),
      recurrence: r,
      customFieldValues: done.customFieldValues,
      checklists: done.checklists.map((cl) => ({
        ...cl,
        items: cl.items.map((item) => ({ ...item, done: false })),
      })),
    },
    actor,
    depth + 1,
    { recurrenceParentId: done.id },
  );
}

function withLabels(tx: Tx, row: TaskRow): Task {
  return { ...row, labelIds: labelIdsOf(tx, row.id) };
}

// ---------------------------------------------------------------------------
// Public mutations (each = one transaction)

export function createTask(boardId: string, input: TaskCreateInput, actor: string): Task {
  return db.transaction((tx) => {
    const ctx = loadBoardCtx(tx, boardId);
    if (!ctx) throw new PmInputError(`unknown board: ${boardId}`);
    return withLabels(tx, insertTaskInTx(tx, ctx, input, actor, 0));
  });
}

/** THE write path: PATCH bodies, moves, bulk ops and automations all funnel
    here. Returns undefined for an unknown board/task. */
export function applyMutation(
  boardId: string,
  taskId: string,
  patch: TaskPatch,
  actor: string,
): Task | undefined {
  return db.transaction((tx) => {
    const ctx = loadBoardCtx(tx, boardId);
    if (!ctx) return undefined;
    const row = applyMutationInTx(tx, ctx, taskId, patch, actor, 0, new Set());
    return row && withLabels(tx, row);
  });
}

/** Kanban drop. Rank math is gap-1000; when the target gap has closed the
    whole column renormalizes to i*1000 first — still the same transaction, so
    still one fsync. Routes through the pipeline so automations see the move. */
export function moveTask(
  boardId: string,
  taskId: string,
  op: MoveOp,
  actor: string,
): Task | undefined {
  return db.transaction((tx) => {
    const ctx = loadBoardCtx(tx, boardId);
    if (!ctx) return undefined;
    if (!ctx.columns.some((c) => c.id === op.columnId))
      throw new PmInputError(`unknown column: ${op.columnId}`);

    // Live siblings in the target column, minus the moving task itself.
    const siblings = tx
      .select({ id: pmTasks.id, order: pmTasks.order })
      .from(pmTasks)
      .where(
        and(
          eq(pmTasks.boardId, boardId),
          eq(pmTasks.columnId, op.columnId),
          isNull(pmTasks.deletedAt),
          isNull(pmTasks.archivedAt),
          sql`${pmTasks.id} != ${taskId}`,
        ),
      )
      .orderBy(asc(pmTasks.order))
      .all();
    const index = Math.min(op.index, siblings.length);
    let prev = index > 0 ? siblings[index - 1].order : undefined;
    let next = index < siblings.length ? siblings[index].order : undefined;
    if (prev !== undefined && next !== undefined && next - prev <= 1) {
      // Gap closed: renormalize the slice (the whole column) to i*RANK_GAP.
      siblings.forEach((s, i) => {
        tx.update(pmTasks)
          .set({ order: i * RANK_GAP })
          .where(eq(pmTasks.id, s.id))
          .run();
      });
      prev = (index - 1) * RANK_GAP;
      next = index * RANK_GAP;
    }
    const order =
      prev === undefined && next === undefined
        ? 0
        : prev === undefined
          ? next! - RANK_GAP
          : next === undefined
            ? prev + RANK_GAP
            : prev + Math.floor((next - prev) / 2);

    const patch: InternalPatch = { columnId: op.columnId, order };
    if ("sprintId" in op && op.sprintId !== undefined) patch.sprintId = op.sprintId;
    const row = applyMutationInTx(tx, ctx, taskId, patch, actor, 0, new Set());
    return row && withLabels(tx, row);
  });
}

/** Rewrite one rank list wholesale (sorts, multi-drag). Pure rank writes —
    no activity, no automations, nothing a rule could meaningfully watch. */
export function bulkReorder(boardId: string, input: BulkReorder): boolean {
  return db.transaction((tx) => {
    const board = tx.select({ id: pmBoards.id }).from(pmBoards).where(eq(pmBoards.id, boardId)).get();
    if (!board) return false;
    const { scope, orderedIds } = input;
    orderedIds.forEach((id, i) => {
      const rank = i * RANK_GAP;
      if (scope.kind === "columns") {
        tx.update(pmColumns)
          .set({ order: rank })
          .where(and(eq(pmColumns.id, id), eq(pmColumns.boardId, boardId)))
          .run();
      } else if (scope.kind === "column") {
        tx.update(pmTasks)
          .set({ order: rank })
          .where(and(eq(pmTasks.id, id), eq(pmTasks.boardId, boardId), eq(pmTasks.columnId, scope.columnId)))
          .run();
      } else {
        // backlog / sprint lanes rank on backlogRank.
        tx.update(pmTasks)
          .set({ backlogRank: rank })
          .where(
            and(
              eq(pmTasks.id, id),
              eq(pmTasks.boardId, boardId),
              scope.kind === "sprint" ? eq(pmTasks.sprintId, scope.sprintId) : isNull(pmTasks.sprintId),
            ),
          )
          .run();
      }
    });
    return true;
  });
}

/** Multi-select toolbar: one transaction, one response. Every task still goes
    through the pipeline, so a bulk move fires the same automations a drag
    would — each task on its own fresh chain. */
export function bulkOp(boardId: string, input: BulkOp, actor: string): Task[] {
  return db.transaction((tx) => {
    const ctx = loadBoardCtx(tx, boardId);
    if (!ctx) throw new PmInputError(`unknown board: ${boardId}`);
    const patch: InternalPatch =
      input.op.type === "patch"
        ? input.op.patch
        : input.op.type === "archive"
          ? { archivedAt: Date.now() }
          : input.op.type === "unarchive"
            ? { archivedAt: null }
            : input.op.type === "trash"
              ? { deletedAt: Date.now() }
              : { deletedAt: null };
    const out: Task[] = [];
    for (const id of input.ids) {
      const row = applyMutationInTx(tx, ctx, id, patch, actor, 0, new Set());
      if (row) out.push(withLabels(tx, row));
    }
    return out;
  });
}

export function archiveTask(boardId: string, taskId: string, actor: string): Task | undefined {
  return stamp(boardId, taskId, { archivedAt: Date.now() }, actor);
}
export function unarchiveTask(boardId: string, taskId: string, actor: string): Task | undefined {
  return stamp(boardId, taskId, { archivedAt: null }, actor);
}
/** Soft delete — restorable until purged; mirrors sessions' deletedAt. */
export function trashTask(boardId: string, taskId: string, actor: string): Task | undefined {
  return stamp(boardId, taskId, { deletedAt: Date.now() }, actor);
}
export function restoreTask(boardId: string, taskId: string, actor: string): Task | undefined {
  return stamp(boardId, taskId, { deletedAt: null }, actor);
}

function stamp(
  boardId: string,
  taskId: string,
  patch: InternalPatch,
  actor: string,
): Task | undefined {
  return db.transaction((tx) => {
    const ctx = loadBoardCtx(tx, boardId);
    if (!ctx) return undefined;
    const row = applyMutationInTx(tx, ctx, taskId, patch, actor, 0, new Set());
    return row && withLabels(tx, row);
  });
}

/** Hard delete. Subtasks cascade with it, as do comments/activity/joins —
    that is the schema's job, not this function's. */
export function purgeTask(boardId: string, taskId: string): boolean {
  return (
    db
      .delete(pmTasks)
      .where(and(eq(pmTasks.id, taskId), eq(pmTasks.boardId, boardId)))
      .run().changes > 0
  );
}

// ---------------------------------------------------------------------------
// Queries

/** LIKE-escape + wrap. Every LIKE below carries `ESCAPE '\'` so a literal
    % or _ in a search term matches itself. */
function contains(needle: string): string {
  return "%" + needle.replace(/[\\%_]/g, (c) => `\\${c}`) + "%";
}

export interface TaskPage {
  total: number;
  tasks: Task[];
}

/**
 * The board fetch. Filters AND together and run in SQL — never load-all-then-
 * filter — and the page is slim: no comments, no activity. Default shows live
 * tasks only; `archived`/`trashed` swap the shelf being looked at.
 */
export function queryTasks(
  boardId: string,
  filter: FilterSpec = {},
  page: { limit?: number; offset?: number } = {},
): TaskPage {
  const conds: SQL[] = [eq(pmTasks.boardId, boardId)];
  conds.push(filter.trashed ? isNotNull(pmTasks.deletedAt) : isNull(pmTasks.deletedAt));
  if (!filter.trashed)
    conds.push(filter.archived ? isNotNull(pmTasks.archivedAt) : isNull(pmTasks.archivedAt));

  if (filter.q) {
    const p = contains(filter.q);
    conds.push(
      or(
        sql`${pmTasks.title} LIKE ${p} ESCAPE '\\'`,
        sql`${pmTasks.key} LIKE ${p} ESCAPE '\\'`,
      )!,
    );
  }
  if (filter.columnIds?.length) conds.push(inArray(pmTasks.columnId, filter.columnIds));
  if (filter.assignees?.length) {
    // json-array LIKE on the exact quoted string — acceptable v1; the quotes
    // keep "sam" from matching "samir".
    conds.push(
      or(
        ...filter.assignees.map(
          (a) => sql`${pmTasks.assignees} LIKE ${contains(JSON.stringify(a))} ESCAPE '\\'`,
        ),
      )!,
    );
  }
  if (filter.labelIds?.length) {
    conds.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(pmTaskLabels)
          .where(
            and(eq(pmTaskLabels.taskId, pmTasks.id), inArray(pmTaskLabels.labelId, filter.labelIds)),
          ),
      ),
    );
  }
  if (filter.typeIds?.length) conds.push(inArray(pmTasks.typeId, filter.typeIds));
  if (filter.sprint !== undefined)
    conds.push(filter.sprint === "none" ? isNull(pmTasks.sprintId) : eq(pmTasks.sprintId, filter.sprint));
  if (filter.epicId !== undefined) conds.push(eq(pmTasks.epicId, filter.epicId));
  if (filter.parentId !== undefined) conds.push(eq(pmTasks.parentId, filter.parentId));
  if (filter.milestoneId !== undefined) conds.push(eq(pmTasks.milestoneId, filter.milestoneId));
  if (filter.priorityGte !== undefined) conds.push(gte(pmTasks.priority, filter.priorityGte));
  if (filter.due) {
    const dayStart = new Date().setHours(0, 0, 0, 0);
    if (filter.due === "overdue")
      conds.push(isNotNull(pmTasks.dueDate), lt(pmTasks.dueDate, Date.now()), isNull(pmTasks.completedAt));
    else if (filter.due === "today")
      conds.push(gte(pmTasks.dueDate, dayStart), lt(pmTasks.dueDate, dayStart + DAY_MS));
    else conds.push(gte(pmTasks.dueDate, dayStart), lt(pmTasks.dueDate, dayStart + 7 * DAY_MS));
  }

  const where = and(...conds);
  const total = db.select({ n: count() }).from(pmTasks).where(where).get()!.n;
  const rows = db
    .select()
    .from(pmTasks)
    .where(where)
    .orderBy(asc(pmTasks.order), asc(pmTasks.createdAt))
    .limit(page.limit ?? 500)
    .offset(page.offset ?? 0)
    .all();

  // One query attaches the whole page's labels — never one per task.
  const labelRows =
    rows.length === 0
      ? []
      : db
          .select()
          .from(pmTaskLabels)
          .where(inArray(pmTaskLabels.taskId, rows.map((r) => r.id)))
          .all();
  const labelsByTask = new Map<string, string[]>();
  for (const { taskId, labelId } of labelRows) {
    labelsByTask.set(taskId, [...(labelsByTask.get(taskId) ?? []), labelId]);
  }
  return { total, tasks: rows.map((r) => ({ ...r, labelIds: labelsByTask.get(r.id) ?? [] })) };
}

/** Archived/trashed included — the editor can open anything with an id. */
export function getTask(boardId: string, taskId: string): Task | undefined {
  const row = db
    .select()
    .from(pmTasks)
    .where(and(eq(pmTasks.id, taskId), eq(pmTasks.boardId, boardId)))
    .get();
  return row && { ...row, labelIds: labelIdsOf(db, row.id) };
}

// ---------------------------------------------------------------------------
// Comments (lazy-fetched by the task editor, never joined into the board fetch)

export function listComments(
  taskId: string,
  page: { limit?: number; offset?: number } = {},
): { total: number; comments: CommentRow[] } {
  const total = db.select({ n: count() }).from(pmComments).where(eq(pmComments.taskId, taskId)).get()!.n;
  const comments = db
    .select()
    .from(pmComments)
    .where(eq(pmComments.taskId, taskId))
    // createdAt has millisecond resolution, so two quick comments can tie;
    // rowid preserves insertion order where a random UUID id would not.
    .orderBy(asc(pmComments.createdAt), sql`${pmComments}.rowid asc`)
    .limit(page.limit ?? 50)
    .offset(page.offset ?? 0)
    .all();
  return { total, comments };
}

export function addComment(taskId: string, input: CommentInput): CommentRow | undefined {
  const task = db.select({ id: pmTasks.id }).from(pmTasks).where(eq(pmTasks.id, taskId)).get();
  if (!task) return undefined;
  const row: CommentRow = {
    id: randomUUID(),
    taskId,
    author: input.author,
    bodyMd: input.bodyMd,
    createdAt: Date.now(),
  };
  db.insert(pmComments).values(row).run();
  return row;
}

export function deleteComment(taskId: string, commentId: string): boolean {
  return (
    db
      .delete(pmComments)
      .where(and(eq(pmComments.id, commentId), eq(pmComments.taskId, taskId)))
      .run().changes > 0
  );
}

// ---------------------------------------------------------------------------
// Activity (journal pattern: `after` is a seq cursor, a read is a range scan)

export function listActivity(taskId: string, after = 0, limit = 200): ActivityRow[] {
  return db
    .select()
    .from(pmActivity)
    .where(and(eq(pmActivity.taskId, taskId), sql`${pmActivity.seq} > ${after}`))
    .orderBy(asc(pmActivity.seq))
    .limit(limit)
    .all();
}

// ---------------------------------------------------------------------------
// Dependencies (taskId is blocked by dependsOnId)

export function addDependency(boardId: string, taskId: string, dependsOnId: string): void {
  if (taskId === dependsOnId) throw new PmInputError("a task cannot depend on itself");
  const found = db
    .select({ id: pmTasks.id })
    .from(pmTasks)
    .where(and(inArray(pmTasks.id, [taskId, dependsOnId]), eq(pmTasks.boardId, boardId)))
    .all();
  if (found.length !== 2) throw new PmInputError("both tasks must exist on this board");
  db.insert(pmTaskDeps).values({ taskId, dependsOnId }).onConflictDoNothing().run();
}

export function removeDependency(taskId: string, dependsOnId: string): boolean {
  return (
    db
      .delete(pmTaskDeps)
      .where(and(eq(pmTaskDeps.taskId, taskId), eq(pmTaskDeps.dependsOnId, dependsOnId)))
      .run().changes > 0
  );
}

/** Every dep pair on the board — the timeline draws its arrows from this. */
export function listDependencies(boardId: string): TaskDepRow[] {
  return db
    .select({ taskId: pmTaskDeps.taskId, dependsOnId: pmTaskDeps.dependsOnId })
    .from(pmTaskDeps)
    .innerJoin(pmTasks, eq(pmTasks.id, pmTaskDeps.taskId))
    .where(eq(pmTasks.boardId, boardId))
    .all();
}

/** Tasks with at least one live blocker (a dep whose task is not in a
    done-category column) — the "blocked" badge is this set. */
export function blockedTaskIds(boardId: string): Set<string> {
  const rows = db
    .select({ taskId: pmTaskDeps.taskId })
    .from(pmTaskDeps)
    .innerJoin(pmTasks, eq(pmTasks.id, pmTaskDeps.dependsOnId))
    .innerJoin(pmColumns, eq(pmColumns.id, pmTasks.columnId))
    .where(
      and(
        eq(pmTasks.boardId, boardId),
        sql`${pmColumns.category} != 'done'`,
        isNull(pmTasks.deletedAt),
      ),
    )
    .all();
  return new Set(rows.map((r) => r.taskId));
}
