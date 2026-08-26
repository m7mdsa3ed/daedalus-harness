import { z } from "zod";
import type {
  pmBoards,
  pmColumns,
  pmComments,
  pmCustomFields,
  pmIssueTypes,
  pmLabels,
  pmMilestones,
  pmSprints,
  pmTasks,
} from "../db/pm.js";

/*
 * zod INPUT schemas + shared wire types for the PM module. zod validates only
 * what crosses HTTP; row types come from Drizzle `$inferSelect`. Pure — the
 * only import from db/pm.js is type-only, so this module stays loadable
 * without a database and db/pm.ts can borrow the json-column types back from
 * here without a runtime cycle.
 *
 * The client mirrors these shapes in client/src/lib/pm/types.ts — change both
 * twins together.
 */

// ---------------------------------------------------------------------------
// Rows (the wire shape of a fetched entity IS the row)

export type BoardRow = typeof pmBoards.$inferSelect;
export type ColumnRow = typeof pmColumns.$inferSelect;
export type LabelRow = typeof pmLabels.$inferSelect;
export type IssueTypeRow = typeof pmIssueTypes.$inferSelect;
export type CustomFieldRow = typeof pmCustomFields.$inferSelect;
export type SprintRow = typeof pmSprints.$inferSelect;
export type MilestoneRow = typeof pmMilestones.$inferSelect;
export type TaskRow = typeof pmTasks.$inferSelect;
export type CommentRow = typeof pmComments.$inferSelect;

// ---------------------------------------------------------------------------
// Shared value shapes (stored in json columns — db/pm.ts imports these types)

export const VIEW_NAMES = [
  "kanban",
  "list",
  "table",
  "backlog",
  "calendar",
  "timeline",
  "dashboard",
] as const;
export type ViewName = (typeof VIEW_NAMES)[number];

export const ChecklistItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  done: z.boolean(),
});
export const ChecklistSchema = z.object({
  id: z.string(),
  name: z.string(),
  items: z.array(ChecklistItemSchema),
});
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;
export type Checklist = z.infer<typeof ChecklistSchema>;

/** Spawn-on-complete: completing a recurring task clones it with dates
    advanced by `interval` × `freq`. */
export const RecurrenceSchema = z.object({
  freq: z.enum(["daily", "weekly", "monthly", "yearly"]),
  interval: z.number().int().min(1).default(1),
});
export type Recurrence = z.infer<typeof RecurrenceSchema>;

/** Every filter is optional and they AND together; the same spec drives the
    task-list SQL on the server and `applyFilters` on the client. */
export const FilterSpecSchema = z.object({
  q: z.string().optional(),
  columnIds: z.array(z.string()).optional(),
  assignees: z.array(z.string()).optional(),
  labelIds: z.array(z.string()).optional(),
  typeIds: z.array(z.string()).optional(),
  /** "none" = backlog (no sprint). */
  sprint: z.union([z.literal("none"), z.string()]).optional(),
  epicId: z.string().optional(),
  parentId: z.string().optional(),
  milestoneId: z.string().optional(),
  priorityGte: z.number().int().min(0).max(4).optional(),
  due: z.enum(["overdue", "today", "week"]).optional(),
  archived: z.boolean().optional(),
  trashed: z.boolean().optional(),
});
export type FilterSpec = z.infer<typeof FilterSpecSchema>;

export const SavedViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  view: z.enum(VIEW_NAMES).optional(),
  filter: FilterSpecSchema,
});
export type SavedView = z.infer<typeof SavedViewSchema>;

// ---------------------------------------------------------------------------
// Automations: WHEN trigger → IF conditions → THEN actions

export const AutomationTriggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("task_created") }),
  z.object({ type: z.literal("task_moved") }),
  z.object({ type: z.literal("task_completed") }),
  /** Fires when the named TaskRow field appears in the mutation's ChangeRecords. */
  z.object({ type: z.literal("field_changed"), field: z.string() }),
]);
export type AutomationTrigger = z.infer<typeof AutomationTriggerSchema>;

export const AutomationConditionSchema = z.object({
  /** TaskRow field name, read from the task AFTER the patch. */
  field: z.string(),
  op: z.enum(["eq", "neq", "gte", "lte", "set", "unset"]),
  value: z.unknown().optional(),
});
export type AutomationCondition = z.infer<typeof AutomationConditionSchema>;

/** Deliberately a whitelist of field-setting ops — an action can only produce
    a patch that goes back through applyMutation, never arbitrary effects, so
    the chain-depth cap + per-chain rule dedup is the whole safety story. */
export const AutomationActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("set_column"), columnId: z.string() }),
  z.object({ type: z.literal("set_priority"), priority: z.number().int().min(0).max(4) }),
  z.object({ type: z.literal("set_assignees"), assignees: z.array(z.string()) }),
  z.object({ type: z.literal("add_label"), labelId: z.string() }),
  z.object({ type: z.literal("remove_label"), labelId: z.string() }),
  z.object({ type: z.literal("set_sprint"), sprintId: z.string().nullable() }),
  z.object({ type: z.literal("set_milestone"), milestoneId: z.string().nullable() }),
  z.object({ type: z.literal("set_type"), typeId: z.string() }),
  z.object({ type: z.literal("set_due_date"), dueDate: z.number().int().nullable() }),
  z.object({ type: z.literal("archive") }),
]);
export type AutomationAction = z.infer<typeof AutomationActionSchema>;

export const AutomationRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean().default(true),
  when: AutomationTriggerSchema,
  if: z.array(AutomationConditionSchema).default([]),
  then: z.array(AutomationActionSchema).min(1),
});
export type AutomationRule = z.infer<typeof AutomationRuleSchema>;

/** One changed field in a mutation — appended to pm_activity, matched by
    `field_changed` triggers. */
export interface ChangeRecord {
  field: string;
  from: unknown;
  to: unknown;
}

/** The call boundary between tasks.ts (which owns the db) and automations.ts
    (which is pure): everything matchRule/runAutomations may look at. */
export interface AutomationContext {
  board: BoardRow;
  columns: ColumnRow[];
  labels: LabelRow[];
  issueTypes: IssueTypeRow[];
  customFields: CustomFieldRow[];
  sprints: SprintRow[];
  milestones: MilestoneRow[];
  /** null when the trigger is task_created. */
  before: TaskRow | null;
  after: TaskRow;
  /** Label ids after the mutation — labels live in a join table, not on the row. */
  labelIds: string[];
  changes: ChangeRecord[];
}

// ---------------------------------------------------------------------------
// HTTP inputs

export const BoardInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().default(null),
  color: z.string().nullable().default(null),
  /** Uppercased human key prefix ("DAE" → DAE-1). Collision with a live board → 400. */
  keyPrefix: z.string().min(1).max(10).regex(/^[A-Za-z][A-Za-z0-9]*$/),
  defaultView: z.enum(VIEW_NAMES).default("kanban"),
});
export type BoardInput = z.infer<typeof BoardInputSchema>;

export const ColumnInputSchema = z.object({
  name: z.string().min(1),
  color: z.string().nullable().default(null),
  category: z.enum(["open", "active", "done"]).default("open"),
  wipLimit: z.number().int().min(1).nullable().default(null),
});
export type ColumnInput = z.infer<typeof ColumnInputSchema>;

export const LabelInputSchema = z.object({
  name: z.string().min(1),
  color: z.string().nullable().default(null),
});
export type LabelInput = z.infer<typeof LabelInputSchema>;

export const IssueTypeInputSchema = z.object({
  name: z.string().min(1),
  icon: z.string().nullable().default(null),
  isEpic: z.boolean().default(false),
});
export type IssueTypeInput = z.infer<typeof IssueTypeInputSchema>;

export const CustomFieldInputSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(["text", "number", "select", "multiselect", "date", "checkbox", "url"]),
    options: z.array(z.string()).nullable().default(null),
  })
  .refine((f) => !["select", "multiselect"].includes(f.type) || (f.options?.length ?? 0) > 0, {
    message: "select fields need options",
  });
export type CustomFieldInput = z.infer<typeof CustomFieldInputSchema>;

export const SprintInputSchema = z.object({
  name: z.string().min(1),
  goal: z.string().nullable().default(null),
  startDate: z.number().int().nullable().default(null),
  endDate: z.number().int().nullable().default(null),
});
export type SprintInput = z.infer<typeof SprintInputSchema>;

export const MilestoneInputSchema = z.object({
  name: z.string().min(1),
  date: z.number().int().nullable().default(null),
});
export type MilestoneInput = z.infer<typeof MilestoneInputSchema>;

export const TaskCreateInputSchema = z.object({
  title: z.string().min(1),
  descriptionMd: z.string().nullable().default(null),
  /** Defaults to the board's first column. */
  columnId: z.string().optional(),
  typeId: z.string().nullable().default(null),
  priority: z.number().int().min(0).max(4).default(0),
  assignees: z.array(z.string()).default([]),
  startDate: z.number().int().nullable().default(null),
  dueDate: z.number().int().nullable().default(null),
  storyPoints: z.number().int().min(0).nullable().default(null),
  estimateMinutes: z.number().int().min(0).nullable().default(null),
  epicId: z.string().nullable().default(null),
  parentId: z.string().nullable().default(null),
  sprintId: z.string().nullable().default(null),
  milestoneId: z.string().nullable().default(null),
  labelIds: z.array(z.string()).default([]),
  recurrence: RecurrenceSchema.nullable().default(null),
  customFieldValues: z.record(z.string(), z.unknown()).default({}),
  checklists: z.array(ChecklistSchema).default([]),
});
export type TaskCreateInput = z.infer<typeof TaskCreateInputSchema>;

/** PATCH body: every field optional, absent = untouched. Moves go through
    MoveOp (they also rank); archive/trash through their endpoints. */
export const TaskPatchSchema = z.object({
  title: z.string().min(1).optional(),
  descriptionMd: z.string().nullable().optional(),
  typeId: z.string().nullable().optional(),
  priority: z.number().int().min(0).max(4).optional(),
  assignees: z.array(z.string()).optional(),
  startDate: z.number().int().nullable().optional(),
  dueDate: z.number().int().nullable().optional(),
  storyPoints: z.number().int().min(0).nullable().optional(),
  estimateMinutes: z.number().int().min(0).nullable().optional(),
  epicId: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  sprintId: z.string().nullable().optional(),
  milestoneId: z.string().nullable().optional(),
  labelIds: z.array(z.string()).optional(),
  recurrence: RecurrenceSchema.nullable().optional(),
  customFieldValues: z.record(z.string(), z.unknown()).optional(),
  checklists: z.array(ChecklistSchema).optional(),
});
export type TaskPatch = z.infer<typeof TaskPatchSchema>;

/** Kanban drop: target column + position; `sprintId` present = also (re)assign
    the sprint (backlog lanes), absent = leave it alone. */
export const MoveOpSchema = z.object({
  columnId: z.string(),
  index: z.number().int().min(0),
  sprintId: z.string().nullable().optional(),
});
export type MoveOp = z.infer<typeof MoveOpSchema>;

/** Rewrite one rank list wholesale (sorts, multi-drag gestures). `scope` names
    which gap-1000 rank the ids reorder. */
export const BulkReorderSchema = z.object({
  scope: z.discriminatedUnion("kind", [
    /** pm_tasks.order within one column. */
    z.object({ kind: z.literal("column"), columnId: z.string() }),
    /** pm_tasks.backlogRank of unsprinted tasks. */
    z.object({ kind: z.literal("backlog") }),
    /** pm_tasks.backlogRank within one sprint lane. */
    z.object({ kind: z.literal("sprint"), sprintId: z.string() }),
    /** pm_columns.order — the board's column layout itself. */
    z.object({ kind: z.literal("columns") }),
  ]),
  orderedIds: z.array(z.string()).min(1),
});
export type BulkReorder = z.infer<typeof BulkReorderSchema>;

/** Multi-select toolbar: one op over many tasks, one transaction, one response. */
export const BulkOpSchema = z.object({
  ids: z.array(z.string()).min(1),
  op: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("patch"),
      /** The fields the table's bulk bar offers — a subset of TaskPatchSchema
          plus columnId (bulk moves append at the target column's end, so no
          index and no MoveOp). */
      patch: z.object({
        columnId: z.string().optional(),
        typeId: z.string().nullable().optional(),
        priority: z.number().int().min(0).max(4).optional(),
        assignees: z.array(z.string()).optional(),
        sprintId: z.string().nullable().optional(),
        milestoneId: z.string().nullable().optional(),
        dueDate: z.number().int().nullable().optional(),
        labelIds: z.array(z.string()).optional(),
      }),
    }),
    z.object({ type: z.literal("archive") }),
    z.object({ type: z.literal("unarchive") }),
    z.object({ type: z.literal("trash") }),
    z.object({ type: z.literal("restore") }),
  ]),
});
export type BulkOp = z.infer<typeof BulkOpSchema>;

export const CommentInputSchema = z.object({
  author: z.string().min(1),
  bodyMd: z.string().min(1),
});
export type CommentInput = z.infer<typeof CommentInputSchema>;
