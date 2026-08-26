import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type {
  AutomationRule,
  Checklist,
  Recurrence,
  SavedView,
  ViewName,
} from "../pm/schema.js";

/*
 * The PM module's tables (`pm_` prefix), re-exported from schema.ts's barrel so
 * drizzle-kit and `migrate()` pick them up with zero config changes.
 *
 * The storage rules are the ones the rest of the schema learned the hard way:
 * everything a task points AT is a real table with an FK and a cascade (a
 * dangling label or sprint id is structurally impossible), and append-only
 * history (comments, activity) is its own table so an append writes one row
 * and a long history paginates as a range scan. Config that is only ever read
 * as a whole and referenced by nothing — saved views, automation rules, a
 * task's checklists, a sprint's completion snapshot — stays a json column,
 * same pattern as `profiles.models`.
 *
 * Type-only imports from ../pm/schema.js are deliberate: the wire types are
 * the single source for the json column shapes, and because pm/schema.ts only
 * imports *types* back from here, there is no runtime cycle to exist.
 */

export const pmBoards = sqliteTable("pm_boards", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  color: text("color"),
  /** Human task keys are `<keyPrefix>-<n>`; collisions are rejected at create. */
  keyPrefix: text("key_prefix").notNull(),
  /** Next key number, allocated atomically (`next_key = next_key + 1 ... RETURNING`)
      inside the task-insert transaction — no read-modify-write race. */
  nextKey: integer("next_key").notNull().default(1),
  defaultView: text("default_view").$type<ViewName>().notNull().default("kanban"),
  savedViews: text("saved_views", { mode: "json" }).$type<SavedView[]>().notNull(),
  automations: text("automations", { mode: "json" }).$type<AutomationRule[]>().notNull(),
  /** Epoch ms; null = live. Archive hides, trash (`deletedAt`) is restorable
      until `?purge=1` hard-deletes — the cascades do the ref cleanup. */
  archivedAt: integer("archived_at"),
  deletedAt: integer("deleted_at"),
  /** Board id this template was duplicated from; null for ordinary boards.
      Not an FK — a template outlives its source. */
  templateFor: text("template_for"),
});

export const pmColumns = sqliteTable("pm_columns", {
  id: text("id").primaryKey(),
  boardId: text("board_id")
    .notNull()
    .references(() => pmBoards.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  color: text("color"),
  /** Drives completedAt stamping and burndown, not just display. */
  category: text("category", { enum: ["open", "active", "done"] }).notNull(),
  wipLimit: integer("wip_limit"),
  /** Gap-1000 rank, renormalized when a gap closes. */
  order: integer("order").notNull(),
});

export const pmLabels = sqliteTable("pm_labels", {
  id: text("id").primaryKey(),
  boardId: text("board_id")
    .notNull()
    .references(() => pmBoards.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  color: text("color"),
});

export const pmIssueTypes = sqliteTable("pm_issue_types", {
  id: text("id").primaryKey(),
  boardId: text("board_id")
    .notNull()
    .references(() => pmBoards.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  icon: text("icon"),
  /** Epics ARE tasks — a task of an epic type collects children via `epicId`. */
  isEpic: integer("is_epic", { mode: "boolean" }).notNull().default(false),
  order: integer("order").notNull(),
});

export const pmCustomFields = sqliteTable("pm_custom_fields", {
  id: text("id").primaryKey(),
  boardId: text("board_id")
    .notNull()
    .references(() => pmBoards.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type", {
    enum: ["text", "number", "select", "multiselect", "date", "checkbox", "url"],
  }).notNull(),
  /** Choices for select/multiselect; null for the other types. */
  options: text("options", { mode: "json" }).$type<string[]>(),
  order: integer("order").notNull(),
});

export const pmSprints = sqliteTable("pm_sprints", {
  id: text("id").primaryKey(),
  boardId: text("board_id")
    .notNull()
    .references(() => pmBoards.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  goal: text("goal"),
  startDate: integer("start_date"),
  endDate: integer("end_date"),
  state: text("state", { enum: ["planned", "active", "completed"] }).notNull().default("planned"),
  /** Frozen at `/complete` — committed vs done points — so velocity stays exact
      even after the tasks themselves move on. Whole-read, referenced by nothing. */
  snapshot: text("snapshot", { mode: "json" }).$type<{
    committedPoints: number;
    completedPoints: number;
    committedTasks: number;
    completedTasks: number;
    completedAt: number;
  }>(),
});

export const pmMilestones = sqliteTable("pm_milestones", {
  id: text("id").primaryKey(),
  boardId: text("board_id")
    .notNull()
    .references(() => pmBoards.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  date: integer("date"),
  reachedAt: integer("reached_at"),
});

export const pmTasks = sqliteTable(
  "pm_tasks",
  {
    id: text("id").primaryKey(),
    boardId: text("board_id")
      .notNull()
      .references(() => pmBoards.id, { onDelete: "cascade" }),
    /** `<keyPrefix>-<n>`, unique per board, allocated from `pm_boards.next_key`. */
    key: text("key").notNull(),
    title: text("title").notNull(),
    descriptionMd: text("description_md"),
    /** Deliberately RESTRICT, not cascade: the delete-column endpoint takes a
        `moveTasksTo` target and moves first — a column delete must never eat tasks. */
    columnId: text("column_id")
      .notNull()
      .references(() => pmColumns.id, { onDelete: "restrict" }),
    typeId: text("type_id").references(() => pmIssueTypes.id, { onDelete: "set null" }),
    /** 0 (none) … 4 (urgent). */
    priority: integer("priority").notNull().default(0),
    /** Free-form names — single bearer token, no accounts (see plan). */
    assignees: text("assignees", { mode: "json" }).$type<string[]>().notNull(),
    startDate: integer("start_date"),
    dueDate: integer("due_date"),
    storyPoints: integer("story_points"),
    estimateMinutes: integer("estimate_minutes"),
    /** Epic membership survives the epic's deletion; subtasks do not survive
        their parent's — that asymmetry is the point of the two actions. */
    epicId: text("epic_id").references((): AnySQLiteColumn => pmTasks.id, { onDelete: "set null" }),
    parentId: text("parent_id").references((): AnySQLiteColumn => pmTasks.id, {
      onDelete: "cascade",
    }),
    /** Deleting a sprint sends its tasks back to the backlog, not away. */
    sprintId: text("sprint_id").references(() => pmSprints.id, { onDelete: "set null" }),
    milestoneId: text("milestone_id").references(() => pmMilestones.id, { onDelete: "set null" }),
    recurrence: text("recurrence", { mode: "json" }).$type<Recurrence>(),
    /** Keyed by pm_custom_fields id; validated against the board's field defs
        in applyMutation, not here. */
    customFieldValues: text("custom_field_values", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
    /** Small and only ever read as a whole — unlike comments/activity. */
    checklists: text("checklists", { mode: "json" }).$type<Checklist[]>().notNull(),
    /** Gap-1000 rank within the column. */
    order: integer("order").notNull(),
    /** Gap-1000 rank in the backlog / sprint lane. */
    backlogRank: integer("backlog_rank").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    /** Stamped by a move into a done-category column, cleared by a move out. */
    completedAt: integer("completed_at"),
    archivedAt: integer("archived_at"),
    deletedAt: integer("deleted_at"),
    /** Task this one was spawned from on recurrence completion. Not an FK —
        the chain is provenance, not a reference to keep alive. */
    recurrenceParentId: text("recurrence_parent_id"),
  },
  (t) => [
    uniqueIndex("pm_tasks_board_key").on(t.boardId, t.key),
    /** The board fetch: live tasks of one board. */
    index("pm_tasks_board_live").on(t.boardId, t.deletedAt, t.archivedAt),
    index("pm_tasks_board_column_order").on(t.boardId, t.columnId, t.order),
    index("pm_tasks_board_sprint").on(t.boardId, t.sprintId),
    /** Calendar/timeline windows. */
    index("pm_tasks_board_due").on(t.boardId, t.dueDate),
  ],
);

export const pmTaskLabels = sqliteTable(
  "pm_task_labels",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => pmTasks.id, { onDelete: "cascade" }),
    labelId: text("label_id")
      .notNull()
      .references(() => pmLabels.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.labelId] })],
);

export const pmTaskDeps = sqliteTable(
  "pm_task_deps",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => pmTasks.id, { onDelete: "cascade" }),
    /** `taskId` depends on (is blocked by) `dependsOnId`. */
    dependsOnId: text("depends_on_id")
      .notNull()
      .references(() => pmTasks.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.dependsOnId] })],
);

/** Append-only, lazily fetched by the task editor — never joined into the
    board fetch (the journal pattern: one row per append, paginated reads). */
export const pmComments = sqliteTable("pm_comments", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => pmTasks.id, { onDelete: "cascade" }),
  author: text("author").notNull(),
  bodyMd: text("body_md").notNull(),
  createdAt: integer("created_at").notNull(),
});

/** One row per changed field per mutation. `seq` is monotonic per task — it is
    what `?after=` indexes, so a replay is a range scan (journal pattern). */
export const pmActivity = sqliteTable(
  "pm_activity",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => pmTasks.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    at: integer("at").notNull(),
    actor: text("actor").notNull(),
    field: text("field").notNull(),
    from: text("from", { mode: "json" }).$type<unknown>(),
    to: text("to", { mode: "json" }).$type<unknown>(),
  },
  (t) => [uniqueIndex("pm_activity_seq").on(t.taskId, t.seq)],
);
