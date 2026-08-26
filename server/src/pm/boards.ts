import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull, max, ne } from "drizzle-orm";
import {
  db,
  pmBoards,
  pmColumns,
  pmCustomFields,
  pmIssueTypes,
  pmLabels,
  pmMilestones,
  pmSprints,
  pmTaskDeps,
  pmTaskLabels,
  pmTasks,
} from "../db/index.js";
import type {
  AutomationRule,
  BoardInput,
  BoardRow,
  ColumnInput,
  ColumnRow,
  CustomFieldInput,
  CustomFieldRow,
  IssueTypeInput,
  IssueTypeRow,
  LabelInput,
  LabelRow,
  MilestoneInput,
  MilestoneRow,
  SavedView,
  SprintInput,
  SprintRow,
  TaskRow,
} from "./schema.js";

/*
 * Board + board-config CRUD (columns/labels/issue types/custom fields/sprints/
 * milestones/saved views/automations), trash/restore/purge, duplication.
 * projects.ts is the style model: sync `db` calls, `db.transaction` around
 * multi-table writes, `undefined` for not-found. Task WRITES that must diff,
 * log activity and run automations live in tasks.ts (`applyMutation`) — the
 * task updates here (column delete, sprint complete) are deliberate plain
 * UPDATEs of fields no automation trigger watches structurally.
 */

/** 400-class failure (a rule of the domain, not a missing row): routes.ts
    catches `PmError` and answers `{ error: message }` with `status`. */
export class PmError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "PmError";
    this.status = status;
  }
}

/** The wire Board the client sees: the row plus every per-board config table.
    Tasks are NOT here — the board fetch stays slim, tasks have their own list. */
export type Board = BoardRow & {
  columns: ColumnRow[];
  labels: LabelRow[];
  issueTypes: IssueTypeRow[];
  customFields: CustomFieldRow[];
  sprints: SprintRow[];
  milestones: MilestoneRow[];
};

/** Gap-1000 ranks; appends go at `max + RANK_GAP`. */
const RANK_GAP = 1000;

// ---------------------------------------------------------------------------
// Boards

export function listBoards(
  opts: { archived?: boolean; templates?: boolean; trashed?: boolean } = {},
): BoardRow[] {
  return db
    .select()
    .from(pmBoards)
    .where(
      and(
        opts.trashed ? isNotNull(pmBoards.deletedAt) : isNull(pmBoards.deletedAt),
        opts.archived ? isNotNull(pmBoards.archivedAt) : isNull(pmBoards.archivedAt),
        opts.templates ? isNotNull(pmBoards.templateFor) : isNull(pmBoards.templateFor),
      ),
    )
    .all();
}

export function getBoard(id: string): Board | undefined {
  const row = db.select().from(pmBoards).where(eq(pmBoards.id, id)).get();
  if (!row) return undefined;
  return {
    ...row,
    columns: db
      .select()
      .from(pmColumns)
      .where(eq(pmColumns.boardId, id))
      .orderBy(pmColumns.order)
      .all(),
    labels: db.select().from(pmLabels).where(eq(pmLabels.boardId, id)).orderBy(pmLabels.name).all(),
    issueTypes: db
      .select()
      .from(pmIssueTypes)
      .where(eq(pmIssueTypes.boardId, id))
      .orderBy(pmIssueTypes.order)
      .all(),
    customFields: db
      .select()
      .from(pmCustomFields)
      .where(eq(pmCustomFields.boardId, id))
      .orderBy(pmCustomFields.order)
      .all(),
    sprints: db
      .select()
      .from(pmSprints)
      .where(eq(pmSprints.boardId, id))
      .orderBy(pmSprints.startDate, pmSprints.name)
      .all(),
    milestones: db
      .select()
      .from(pmMilestones)
      .where(eq(pmMilestones.boardId, id))
      .orderBy(pmMilestones.date, pmMilestones.name)
      .all(),
  };
}

/** Human keys must stay unambiguous among the boards a person can address —
    live, non-template ones. Trashed and template boards don't reserve theirs. */
function assertPrefixFree(keyPrefix: string, excludeBoardId?: string): void {
  const clash = db
    .select({ id: pmBoards.id })
    .from(pmBoards)
    .where(
      and(
        eq(pmBoards.keyPrefix, keyPrefix),
        isNull(pmBoards.deletedAt),
        isNull(pmBoards.templateFor),
        excludeBoardId ? ne(pmBoards.id, excludeBoardId) : undefined,
      ),
    )
    .get();
  if (clash) throw new PmError(`key prefix ${keyPrefix} is already used by another board`);
}

export function createBoard(input: BoardInput): Board {
  const id = randomUUID();
  const keyPrefix = input.keyPrefix.toUpperCase();
  db.transaction((tx) => {
    assertPrefixFree(keyPrefix);
    tx.insert(pmBoards)
      .values({
        id,
        name: input.name,
        description: input.description,
        color: input.color,
        keyPrefix,
        defaultView: input.defaultView,
        savedViews: [],
        automations: [],
      })
      .run();
    // A usable default: one column per category (the done column is what stamps
    // completedAt) and the four canonical issue types, Epic last.
    const columns: [string, ColumnRow["category"]][] = [
      ["To do", "open"],
      ["In progress", "active"],
      ["Done", "done"],
    ];
    columns.forEach(([name, category], i) => {
      tx.insert(pmColumns)
        .values({ id: randomUUID(), boardId: id, name, category, order: i * RANK_GAP })
        .run();
    });
    const types: [string, boolean][] = [
      ["Task", false],
      ["Story", false],
      ["Bug", false],
      ["Epic", true],
    ];
    types.forEach(([name, isEpic], i) => {
      tx.insert(pmIssueTypes)
        .values({ id: randomUUID(), boardId: id, name, isEpic, order: i * RANK_GAP })
        .run();
    });
  });
  return getBoard(id)!;
}

export function patchBoard(id: string, patch: Partial<BoardInput>): Board | undefined {
  const row = db.select().from(pmBoards).where(eq(pmBoards.id, id)).get();
  if (!row) return undefined;
  const keyPrefix = patch.keyPrefix?.toUpperCase();
  db.transaction((tx) => {
    if (keyPrefix && keyPrefix !== row.keyPrefix && !row.deletedAt && !row.templateFor) {
      assertPrefixFree(keyPrefix, id);
    }
    tx.update(pmBoards)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.color !== undefined ? { color: patch.color } : {}),
        ...(keyPrefix !== undefined ? { keyPrefix } : {}),
        ...(patch.defaultView !== undefined ? { defaultView: patch.defaultView } : {}),
      })
      .where(eq(pmBoards.id, id))
      .run();
  });
  return getBoard(id);
}

export function setBoardArchived(id: string, archived: boolean): BoardRow | undefined {
  const changed = db
    .update(pmBoards)
    .set({ archivedAt: archived ? Date.now() : null })
    .where(eq(pmBoards.id, id))
    .run().changes;
  return changed > 0 ? db.select().from(pmBoards).where(eq(pmBoards.id, id)).get() : undefined;
}

/** Soft delete — restorable until purged. Its key prefix frees up immediately
    (see assertPrefixFree), which is why restore has to re-check it. */
export function deleteBoard(id: string): BoardRow | undefined {
  const changed = db
    .update(pmBoards)
    .set({ deletedAt: Date.now() })
    .where(and(eq(pmBoards.id, id), isNull(pmBoards.deletedAt)))
    .run().changes;
  return changed > 0 ? db.select().from(pmBoards).where(eq(pmBoards.id, id)).get() : undefined;
}

export function restoreBoard(id: string): BoardRow | undefined {
  const row = db
    .select()
    .from(pmBoards)
    .where(and(eq(pmBoards.id, id), isNotNull(pmBoards.deletedAt)))
    .get();
  if (!row) return undefined;
  db.transaction((tx) => {
    // Someone may have reused the prefix while this board sat in the trash.
    if (!row.templateFor) assertPrefixFree(row.keyPrefix, id);
    tx.update(pmBoards).set({ deletedAt: null }).where(eq(pmBoards.id, id)).run();
  });
  return db.select().from(pmBoards).where(eq(pmBoards.id, id)).get();
}

/** Hard delete. Tasks, config, joins, comments and activity all hang off the
    board by cascading FKs — the cleanup is the schema's job, not this function's. */
export function purgeBoard(id: string): boolean {
  return db.delete(pmBoards).where(eq(pmBoards.id, id)).run().changes > 0;
}

// ---------------------------------------------------------------------------
// Duplication / templates

/** Replace every string that is a remapped id, wherever it sits inside a json
    value (saved-view filters, automation actions, custom-field value keys are
    handled separately). JSON reviver = one deep walk, no shape knowledge. */
function remapJson<T>(value: T, map: Map<string, string>): T {
  return JSON.parse(JSON.stringify(value), (_key, v) =>
    typeof v === "string" && map.has(v) ? map.get(v) : v,
  ) as T;
}

/** A duplicate wants the source prefix but must not collide with a live board;
    a numeric suffix (DAE → DAE2, DAE3…) keeps the button one click. */
function freePrefix(base: string): string {
  const taken = new Set(
    db
      .select({ keyPrefix: pmBoards.keyPrefix })
      .from(pmBoards)
      .where(and(isNull(pmBoards.deletedAt), isNull(pmBoards.templateFor)))
      .all()
      .map((r) => r.keyPrefix),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, 10 - String(n).length)}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Clone a board's whole configuration — columns, labels, issue types, custom
 * fields, sprints (reset to planned) and milestones (unreached) — under fresh
 * ids, with one remap table carrying every reference across: saved views,
 * automation rules and (when `withTasks`) the tasks themselves, their label
 * joins, dependencies and custom-field value keys. `asTemplate` stamps
 * `templateFor`; instantiating a template is duplicating it back without it.
 */
export function duplicateBoard(
  id: string,
  opts: { asTemplate?: boolean; withTasks?: boolean } = {},
): Board | undefined {
  const source = getBoard(id);
  if (!source) return undefined;
  const newId = randomUUID();
  const map = new Map<string, string>([[id, newId]]);
  const now = Date.now();

  db.transaction((tx) => {
    for (const list of [
      source.columns,
      source.labels,
      source.issueTypes,
      source.customFields,
      source.sprints,
      source.milestones,
    ]) {
      for (const row of list) map.set(row.id, randomUUID());
    }
    const tasks: TaskRow[] = opts.withTasks
      ? db
          .select()
          .from(pmTasks)
          .where(and(eq(pmTasks.boardId, id), isNull(pmTasks.deletedAt)))
          .all()
      : [];
    for (const task of tasks) map.set(task.id, randomUUID());

    tx.insert(pmBoards)
      .values({
        id: newId,
        name: `${source.name} (${opts.asTemplate ? "template" : "copy"})`,
        description: source.description,
        color: source.color,
        // Templates never reserve a prefix; the source's carries over verbatim.
        keyPrefix: opts.asTemplate ? source.keyPrefix : freePrefix(source.keyPrefix),
        nextKey: opts.withTasks ? source.nextKey : 1,
        defaultView: source.defaultView,
        savedViews: remapJson(source.savedViews, map),
        automations: remapJson(source.automations, map),
        templateFor: opts.asTemplate ? id : null,
      })
      .run();
    for (const c of source.columns) {
      tx.insert(pmColumns).values({ ...c, id: map.get(c.id)!, boardId: newId }).run();
    }
    for (const l of source.labels) {
      tx.insert(pmLabels).values({ ...l, id: map.get(l.id)!, boardId: newId }).run();
    }
    for (const t of source.issueTypes) {
      tx.insert(pmIssueTypes).values({ ...t, id: map.get(t.id)!, boardId: newId }).run();
    }
    for (const f of source.customFields) {
      tx.insert(pmCustomFields).values({ ...f, id: map.get(f.id)!, boardId: newId }).run();
    }
    for (const s of source.sprints) {
      tx.insert(pmSprints)
        .values({ ...s, id: map.get(s.id)!, boardId: newId, state: "planned", snapshot: null })
        .run();
    }
    for (const m of source.milestones) {
      tx.insert(pmMilestones)
        .values({ ...m, id: map.get(m.id)!, boardId: newId, reachedAt: null })
        .run();
    }

    if (tasks.length > 0) {
      // parentId/epicId are immediate FKs into pm_tasks, so parents must land
      // before children: insert in passes until every task's refs exist.
      const pending = [...tasks];
      const inserted = new Set<string>();
      while (pending.length > 0) {
        const ready = pending.filter(
          (t) =>
            (!t.parentId || inserted.has(t.parentId)) && (!t.epicId || inserted.has(t.epicId)),
        );
        // A ref to a task that was not cloned (trashed) can never become ready.
        const batch = ready.length > 0 ? ready : pending.splice(0);
        for (const t of batch) {
          tx.insert(pmTasks)
            .values({
              ...t,
              id: map.get(t.id)!,
              boardId: newId,
              columnId: map.get(t.columnId)!,
              typeId: t.typeId ? (map.get(t.typeId) ?? null) : null,
              epicId: t.epicId && inserted.has(t.epicId) ? map.get(t.epicId)! : null,
              parentId: t.parentId && inserted.has(t.parentId) ? map.get(t.parentId)! : null,
              sprintId: t.sprintId ? (map.get(t.sprintId) ?? null) : null,
              milestoneId: t.milestoneId ? (map.get(t.milestoneId) ?? null) : null,
              customFieldValues: Object.fromEntries(
                Object.entries(t.customFieldValues).map(([k, v]) => [map.get(k) ?? k, v]),
              ),
              createdAt: now,
              updatedAt: now,
              recurrenceParentId: null,
            })
            .run();
          inserted.add(t.id);
        }
        for (const t of batch) {
          const at = pending.indexOf(t);
          if (at >= 0) pending.splice(at, 1);
        }
      }
      // Join rows whose both ends were cloned; a dep on a trashed task lapses.
      const cloned = new Set(tasks.map((t) => t.id));
      for (const row of db.select().from(pmTaskLabels).all()) {
        if (cloned.has(row.taskId) && map.has(row.labelId)) {
          tx.insert(pmTaskLabels)
            .values({ taskId: map.get(row.taskId)!, labelId: map.get(row.labelId)! })
            .run();
        }
      }
      for (const row of db.select().from(pmTaskDeps).all()) {
        if (cloned.has(row.taskId) && cloned.has(row.dependsOnId)) {
          tx.insert(pmTaskDeps)
            .values({ taskId: map.get(row.taskId)!, dependsOnId: map.get(row.dependsOnId)! })
            .run();
        }
      }
    }
  });
  return getBoard(newId);
}

// ---------------------------------------------------------------------------
// Columns

function boardExists(boardId: string): boolean {
  return !!db.select({ id: pmBoards.id }).from(pmBoards).where(eq(pmBoards.id, boardId)).get();
}

function nextOrder(rows: { order: number }[]): number {
  return rows.length === 0 ? 0 : Math.max(...rows.map((r) => r.order)) + RANK_GAP;
}

export function createColumn(boardId: string, input: ColumnInput): ColumnRow | undefined {
  if (!boardExists(boardId)) return undefined;
  const id = randomUUID();
  const siblings = db
    .select({ order: pmColumns.order })
    .from(pmColumns)
    .where(eq(pmColumns.boardId, boardId))
    .all();
  db.insert(pmColumns)
    .values({
      id,
      boardId,
      name: input.name,
      color: input.color,
      category: input.category,
      wipLimit: input.wipLimit,
      order: nextOrder(siblings),
    })
    .run();
  return db.select().from(pmColumns).where(eq(pmColumns.id, id)).get();
}

export function patchColumn(
  boardId: string,
  columnId: string,
  patch: Partial<ColumnInput>,
): ColumnRow | undefined {
  const where = and(eq(pmColumns.id, columnId), eq(pmColumns.boardId, boardId));
  const changed = db
    .update(pmColumns)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.color !== undefined ? { color: patch.color } : {}),
      ...(patch.category !== undefined ? { category: patch.category } : {}),
      ...(patch.wipLimit !== undefined ? { wipLimit: patch.wipLimit } : {}),
    })
    .where(where)
    .run().changes;
  return changed > 0 ? db.select().from(pmColumns).where(where).get() : undefined;
}

/**
 * Delete a column, moving its tasks to `moveTasksTo` (appended at that
 * column's tail) in the same transaction. The RESTRICT FK on
 * `pm_tasks.columnId` is the backstop: a path that forgot the move would fail,
 * not eat tasks. Plain UPDATEs — a column's funeral is not an automation event.
 */
export function deleteColumn(boardId: string, columnId: string, moveTasksTo: string): boolean {
  const source = db
    .select()
    .from(pmColumns)
    .where(and(eq(pmColumns.id, columnId), eq(pmColumns.boardId, boardId)))
    .get();
  if (!source) return false;
  const target = db
    .select()
    .from(pmColumns)
    .where(and(eq(pmColumns.id, moveTasksTo), eq(pmColumns.boardId, boardId)))
    .get();
  if (!target || target.id === source.id) {
    throw new PmError("moveTasksTo must name a different column on the same board");
  }
  db.transaction((tx) => {
    const moving = db
      .select({ id: pmTasks.id, order: pmTasks.order })
      .from(pmTasks)
      .where(eq(pmTasks.columnId, columnId))
      .orderBy(pmTasks.order)
      .all();
    const tail = db
      .select({ order: pmTasks.order })
      .from(pmTasks)
      .where(eq(pmTasks.columnId, moveTasksTo))
      .all();
    let order = nextOrder(tail);
    for (const task of moving) {
      tx.update(pmTasks).set({ columnId: moveTasksTo, order }).where(eq(pmTasks.id, task.id)).run();
      order += RANK_GAP;
    }
    tx.delete(pmColumns).where(eq(pmColumns.id, columnId)).run();
  });
  return true;
}

// ---------------------------------------------------------------------------
// Labels

export function createLabel(boardId: string, input: LabelInput): LabelRow | undefined {
  if (!boardExists(boardId)) return undefined;
  const id = randomUUID();
  db.insert(pmLabels).values({ id, boardId, name: input.name, color: input.color }).run();
  return db.select().from(pmLabels).where(eq(pmLabels.id, id)).get();
}

export function patchLabel(
  boardId: string,
  labelId: string,
  patch: Partial<LabelInput>,
): LabelRow | undefined {
  const where = and(eq(pmLabels.id, labelId), eq(pmLabels.boardId, boardId));
  const changed = db
    .update(pmLabels)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.color !== undefined ? { color: patch.color } : {}),
    })
    .where(where)
    .run().changes;
  return changed > 0 ? db.select().from(pmLabels).where(where).get() : undefined;
}

/** The join rows go with it — the cascade's job. */
export function deleteLabel(boardId: string, labelId: string): boolean {
  return (
    db
      .delete(pmLabels)
      .where(and(eq(pmLabels.id, labelId), eq(pmLabels.boardId, boardId)))
      .run().changes > 0
  );
}

// ---------------------------------------------------------------------------
// Issue types

export function createIssueType(boardId: string, input: IssueTypeInput): IssueTypeRow | undefined {
  if (!boardExists(boardId)) return undefined;
  const id = randomUUID();
  const siblings = db
    .select({ order: pmIssueTypes.order })
    .from(pmIssueTypes)
    .where(eq(pmIssueTypes.boardId, boardId))
    .all();
  db.insert(pmIssueTypes)
    .values({
      id,
      boardId,
      name: input.name,
      icon: input.icon,
      isEpic: input.isEpic,
      order: nextOrder(siblings),
    })
    .run();
  return db.select().from(pmIssueTypes).where(eq(pmIssueTypes.id, id)).get();
}

export function patchIssueType(
  boardId: string,
  typeId: string,
  patch: Partial<IssueTypeInput>,
): IssueTypeRow | undefined {
  const where = and(eq(pmIssueTypes.id, typeId), eq(pmIssueTypes.boardId, boardId));
  const changed = db
    .update(pmIssueTypes)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.icon !== undefined ? { icon: patch.icon } : {}),
      ...(patch.isEpic !== undefined ? { isEpic: patch.isEpic } : {}),
    })
    .where(where)
    .run().changes;
  return changed > 0 ? db.select().from(pmIssueTypes).where(where).get() : undefined;
}

/** Tasks of this type fall back to untyped (`typeId` SET NULL). */
export function deleteIssueType(boardId: string, typeId: string): boolean {
  return (
    db
      .delete(pmIssueTypes)
      .where(and(eq(pmIssueTypes.id, typeId), eq(pmIssueTypes.boardId, boardId)))
      .run().changes > 0
  );
}

// ---------------------------------------------------------------------------
// Custom fields

export function createCustomField(
  boardId: string,
  input: CustomFieldInput,
): CustomFieldRow | undefined {
  if (!boardExists(boardId)) return undefined;
  const id = randomUUID();
  const siblings = db
    .select({ order: pmCustomFields.order })
    .from(pmCustomFields)
    .where(eq(pmCustomFields.boardId, boardId))
    .all();
  db.insert(pmCustomFields)
    .values({
      id,
      boardId,
      name: input.name,
      type: input.type,
      options: input.options,
      order: nextOrder(siblings),
    })
    .run();
  return db.select().from(pmCustomFields).where(eq(pmCustomFields.id, id)).get();
}

export function patchCustomField(
  boardId: string,
  fieldId: string,
  patch: Partial<CustomFieldInput>,
): CustomFieldRow | undefined {
  const where = and(eq(pmCustomFields.id, fieldId), eq(pmCustomFields.boardId, boardId));
  const changed = db
    .update(pmCustomFields)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.type !== undefined ? { type: patch.type } : {}),
      ...(patch.options !== undefined ? { options: patch.options } : {}),
    })
    .where(where)
    .run().changes;
  return changed > 0 ? db.select().from(pmCustomFields).where(where).get() : undefined;
}

/**
 * Values live in `pm_tasks.customFieldValues` json keyed by field id — no FK
 * to cascade — so the delete sweeps the key out of every task on the board in
 * the same transaction. Otherwise applyMutation's validation would reject any
 * later write that echoed the orphan key back.
 */
export function deleteCustomField(boardId: string, fieldId: string): boolean {
  const exists = db
    .select({ id: pmCustomFields.id })
    .from(pmCustomFields)
    .where(and(eq(pmCustomFields.id, fieldId), eq(pmCustomFields.boardId, boardId)))
    .get();
  if (!exists) return false;
  db.transaction((tx) => {
    const tasks = db
      .select({ id: pmTasks.id, customFieldValues: pmTasks.customFieldValues })
      .from(pmTasks)
      .where(eq(pmTasks.boardId, boardId))
      .all();
    for (const task of tasks) {
      if (!(fieldId in task.customFieldValues)) continue;
      const { [fieldId]: _dropped, ...rest } = task.customFieldValues;
      tx.update(pmTasks).set({ customFieldValues: rest }).where(eq(pmTasks.id, task.id)).run();
    }
    tx.delete(pmCustomFields).where(eq(pmCustomFields.id, fieldId)).run();
  });
  return true;
}

// ---------------------------------------------------------------------------
// Sprints

export function createSprint(boardId: string, input: SprintInput): SprintRow | undefined {
  if (!boardExists(boardId)) return undefined;
  const id = randomUUID();
  db.insert(pmSprints)
    .values({
      id,
      boardId,
      name: input.name,
      goal: input.goal,
      startDate: input.startDate,
      endDate: input.endDate,
    })
    .run();
  return db.select().from(pmSprints).where(eq(pmSprints.id, id)).get();
}

export function patchSprint(
  boardId: string,
  sprintId: string,
  patch: Partial<SprintInput>,
): SprintRow | undefined {
  const where = and(eq(pmSprints.id, sprintId), eq(pmSprints.boardId, boardId));
  const changed = db
    .update(pmSprints)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.goal !== undefined ? { goal: patch.goal } : {}),
      ...(patch.startDate !== undefined ? { startDate: patch.startDate } : {}),
      ...(patch.endDate !== undefined ? { endDate: patch.endDate } : {}),
    })
    .where(where)
    .run().changes;
  return changed > 0 ? db.select().from(pmSprints).where(where).get() : undefined;
}

/** Its tasks return to the backlog (`sprintId` SET NULL), not away. */
export function deleteSprint(boardId: string, sprintId: string): boolean {
  return (
    db
      .delete(pmSprints)
      .where(and(eq(pmSprints.id, sprintId), eq(pmSprints.boardId, boardId)))
      .run().changes > 0
  );
}

/** planned → active; at most one active sprint per board. */
export function startSprint(boardId: string, sprintId: string): SprintRow | undefined {
  const where = and(eq(pmSprints.id, sprintId), eq(pmSprints.boardId, boardId));
  const sprint = db.select().from(pmSprints).where(where).get();
  if (!sprint) return undefined;
  if (sprint.state !== "planned") {
    throw new PmError(`sprint is ${sprint.state}, only a planned sprint can start`);
  }
  const active = db
    .select({ name: pmSprints.name })
    .from(pmSprints)
    .where(and(eq(pmSprints.boardId, boardId), eq(pmSprints.state, "active")))
    .get();
  if (active) throw new PmError(`"${active.name}" is already active — complete it first`);
  db.update(pmSprints).set({ state: "active" }).where(where).run();
  return db.select().from(pmSprints).where(where).get();
}

/**
 * active → completed. Freezes the committed-vs-done numbers into `snapshot`
 * (velocity stays exact after the tasks move on), then moves incomplete tasks
 * to `moveIncompleteTo` (another non-completed sprint) or the backlog (null).
 * Plain UPDATEs, not applyMutation — a sprint rollover is not a task mutation
 * automations should chase.
 */
export function completeSprint(
  boardId: string,
  sprintId: string,
  moveIncompleteTo: string | null = null,
): SprintRow | undefined {
  const where = and(eq(pmSprints.id, sprintId), eq(pmSprints.boardId, boardId));
  const sprint = db.select().from(pmSprints).where(where).get();
  if (!sprint) return undefined;
  if (sprint.state !== "active") {
    throw new PmError(`sprint is ${sprint.state}, only an active sprint can complete`);
  }
  if (moveIncompleteTo) {
    const target = db
      .select({ state: pmSprints.state })
      .from(pmSprints)
      .where(and(eq(pmSprints.id, moveIncompleteTo), eq(pmSprints.boardId, boardId)))
      .get();
    if (!target || target.state === "completed" || moveIncompleteTo === sprintId) {
      throw new PmError("moveIncompleteTo must name another open sprint on the same board");
    }
  }
  db.transaction((tx) => {
    const tasks = db
      .select({
        id: pmTasks.id,
        storyPoints: pmTasks.storyPoints,
        completedAt: pmTasks.completedAt,
      })
      .from(pmTasks)
      .where(and(eq(pmTasks.sprintId, sprintId), isNull(pmTasks.deletedAt)))
      .all();
    const done = tasks.filter((t) => t.completedAt != null);
    tx.update(pmSprints)
      .set({
        state: "completed",
        snapshot: {
          committedPoints: tasks.reduce((sum, t) => sum + (t.storyPoints ?? 0), 0),
          completedPoints: done.reduce((sum, t) => sum + (t.storyPoints ?? 0), 0),
          committedTasks: tasks.length,
          completedTasks: done.length,
          completedAt: Date.now(),
        },
      })
      .where(eq(pmSprints.id, sprintId))
      .run();
    // Rolled-over tasks append to the END of the lane they arrive in. Their
    // backlogRank was allocated in the sprint they are leaving and means
    // nothing over there — carried across it collides with whatever already
    // holds that rank, and two tasks at one backlog position order by luck.
    const incomplete = tasks.filter((t) => t.completedAt == null);
    if (incomplete.length > 0) {
      const top = tx
        .select({ m: max(pmTasks.backlogRank) })
        .from(pmTasks)
        .where(
          and(
            eq(pmTasks.boardId, boardId),
            moveIncompleteTo == null
              ? isNull(pmTasks.sprintId)
              : eq(pmTasks.sprintId, moveIncompleteTo),
          ),
        )
        .get()?.m;
      let rank = top == null ? 0 : top + RANK_GAP;
      for (const task of incomplete) {
        tx.update(pmTasks)
          .set({ sprintId: moveIncompleteTo, backlogRank: rank })
          .where(eq(pmTasks.id, task.id))
          .run();
        rank += RANK_GAP;
      }
    }
  });
  return db.select().from(pmSprints).where(where).get();
}

// ---------------------------------------------------------------------------
// Milestones

export function createMilestone(boardId: string, input: MilestoneInput): MilestoneRow | undefined {
  if (!boardExists(boardId)) return undefined;
  const id = randomUUID();
  db.insert(pmMilestones).values({ id, boardId, name: input.name, date: input.date }).run();
  return db.select().from(pmMilestones).where(eq(pmMilestones.id, id)).get();
}

export function patchMilestone(
  boardId: string,
  milestoneId: string,
  patch: Partial<MilestoneInput>,
): MilestoneRow | undefined {
  const where = and(eq(pmMilestones.id, milestoneId), eq(pmMilestones.boardId, boardId));
  const changed = db
    .update(pmMilestones)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.date !== undefined ? { date: patch.date } : {}),
    })
    .where(where)
    .run().changes;
  return changed > 0 ? db.select().from(pmMilestones).where(where).get() : undefined;
}

export function deleteMilestone(boardId: string, milestoneId: string): boolean {
  return (
    db
      .delete(pmMilestones)
      .where(and(eq(pmMilestones.id, milestoneId), eq(pmMilestones.boardId, boardId)))
      .run().changes > 0
  );
}

/** Mark reached (now) or un-reach (`reached: false`) — one reversible switch. */
export function reachMilestone(
  boardId: string,
  milestoneId: string,
  reached = true,
): MilestoneRow | undefined {
  const where = and(eq(pmMilestones.id, milestoneId), eq(pmMilestones.boardId, boardId));
  const changed = db
    .update(pmMilestones)
    .set({ reachedAt: reached ? Date.now() : null })
    .where(where)
    .run().changes;
  return changed > 0 ? db.select().from(pmMilestones).where(where).get() : undefined;
}

// ---------------------------------------------------------------------------
// Saved views + automations (whole-read json config on the board row)

function withBoardJson<K extends "savedViews" | "automations">(
  boardId: string,
  key: K,
  edit: (current: BoardRow[K]) => BoardRow[K],
): BoardRow | undefined {
  const row = db.select().from(pmBoards).where(eq(pmBoards.id, boardId)).get();
  if (!row) return undefined;
  db.update(pmBoards)
    .set({ [key]: edit(row[key]) })
    .where(eq(pmBoards.id, boardId))
    .run();
  return db.select().from(pmBoards).where(eq(pmBoards.id, boardId)).get();
}

/** Upsert by id — PUT semantics, same call for create and rename. */
export function putSavedView(boardId: string, view: SavedView): SavedView | undefined {
  const board = withBoardJson(boardId, "savedViews", (views) => [
    ...views.filter((v) => v.id !== view.id),
    view,
  ]);
  return board ? view : undefined;
}

export function deleteSavedView(boardId: string, viewId: string): boolean {
  let removed = false;
  const board = withBoardJson(boardId, "savedViews", (views) => {
    removed = views.some((v) => v.id === viewId);
    return views.filter((v) => v.id !== viewId);
  });
  return !!board && removed;
}

/** Upsert by id. Referential honesty (does that columnId exist?) is checked
    where the rule RUNS — automations.ts skips an action whose target is gone. */
export function putAutomation(boardId: string, rule: AutomationRule): AutomationRule | undefined {
  const board = withBoardJson(boardId, "automations", (rules) => [
    ...rules.filter((r) => r.id !== rule.id),
    rule,
  ]);
  return board ? rule : undefined;
}

export function deleteAutomation(boardId: string, ruleId: string): boolean {
  let removed = false;
  const board = withBoardJson(boardId, "automations", (rules) => {
    removed = rules.some((r) => r.id === ruleId);
    return rules.filter((r) => r.id !== ruleId);
  });
  return !!board && removed;
}
