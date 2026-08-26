import { Hono, type Context } from "hono";
import { and, isNull, or, sql } from "drizzle-orm";
import { db, pmBoards, pmTasks } from "../db/index.js";
import {
  createBoard,
  createColumn,
  createCustomField,
  createIssueType,
  createLabel,
  createMilestone,
  createSprint,
  completeSprint,
  deleteAutomation,
  deleteBoard,
  deleteColumn,
  deleteCustomField,
  deleteIssueType,
  deleteLabel,
  deleteMilestone,
  deleteSavedView,
  deleteSprint,
  duplicateBoard,
  getBoard,
  listBoards,
  patchBoard,
  patchColumn,
  patchCustomField,
  patchIssueType,
  patchLabel,
  patchMilestone,
  patchSprint,
  purgeBoard,
  putAutomation,
  putSavedView,
  reachMilestone,
  restoreBoard,
  setBoardArchived,
  startSprint,
} from "./boards.js";
import {
  addComment,
  addDependency,
  applyMutation,
  archiveTask,
  blockedTaskIds,
  bulkOp,
  bulkReorder,
  createTask,
  deleteComment,
  getTask,
  listActivity,
  listComments,
  listDependencies,
  moveTask,
  purgeTask,
  queryTasks,
  removeDependency,
  restoreTask,
  trashTask,
  unarchiveTask,
} from "./tasks.js";
import { matchRule, runAutomations } from "./automations.js";
import { burndown, dashboard, velocity } from "./reports.js";
import {
  AutomationRuleSchema,
  BoardInputSchema,
  BulkOpSchema,
  BulkReorderSchema,
  ColumnInputSchema,
  CommentInputSchema,
  CustomFieldInputSchema,
  FilterSpecSchema,
  IssueTypeInputSchema,
  LabelInputSchema,
  MilestoneInputSchema,
  MoveOpSchema,
  SavedViewSchema,
  SprintInputSchema,
  TaskCreateInputSchema,
  TaskPatchSchema,
  type AutomationContext,
  type AutomationRule,
  type ChangeRecord,
  type TaskRow,
} from "./schema.js";
import type { Board } from "./boards.js";

/*
 * The PM module's REST surface, mounted under /api in index.ts (AFTER the
 * bearer-auth middleware, so every route here inherits it). Envelopes match
 * the rest of the API: 201 on create, 404 `{ error: "not found" }`, 400
 * `{ error: parsed.error.issues }` for zod rejections.
 *
 * Boards are PATCHed, not PUT — a deliberate deviation from the PUT the other
 * entities use: a board row carries `nextKey`, which the server mutates on
 * every task insert, so a full-replace PUT echoing a stale read would rewind
 * the key counter. A PATCH can only name the fields the client owns.
 */
export const pmRoutes = new Hono();

/** boards.ts / tasks.ts throw domain failures carrying `status` (PmError,
    PmInputError). Translate those to their code; everything else rethrows into
    index.ts's app.onError. (A sub-app's onError survives mounting — Hono wraps
    the routes with it when the handler isn't the default.) */
pmRoutes.onError((err, c) => {
  const status = (err as { status?: number }).status;
  if (status === 400 || status === 404) return c.json({ error: err.message }, status);
  throw err;
});

const notFound = (c: Context) => c.json({ error: "not found" }, 404);

/** Task mutations journal who did them; single-token auth means the client
    self-reports (free-form string), defaulting to "user". */
const actorOf = (body: unknown): string => {
  const actor = (body as { actor?: unknown } | null)?.actor;
  return typeof actor === "string" && actor ? actor : "user";
};

// ---------------------------------------------------------------------------
// Boards

pmRoutes.get("/boards", (c) =>
  c.json(
    listBoards({
      archived: c.req.query("archived") === "1",
      templates: c.req.query("templates") === "1",
      trashed: c.req.query("trashed") === "1",
    }),
  ),
);

pmRoutes.post("/boards", async (c) => {
  const parsed = BoardInputSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  return c.json(createBoard(parsed.data), 201);
});

pmRoutes.get("/boards/:boardId", (c) => {
  const board = getBoard(c.req.param("boardId"));
  return board ? c.json(board) : notFound(c);
});

pmRoutes.patch("/boards/:boardId", async (c) => {
  const parsed = BoardInputSchema.partial().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  const board = patchBoard(c.req.param("boardId"), parsed.data);
  return board ? c.json(board) : notFound(c);
});

// Trash by default (restorable); ?purge=1 is the irreversible one — mirrors
// DELETE /api/sessions/:id.
pmRoutes.delete("/boards/:boardId", (c) => {
  const id = c.req.param("boardId");
  const ok = c.req.query("purge") === "1" ? purgeBoard(id) : !!deleteBoard(id);
  return ok ? c.json({ ok: true }) : notFound(c);
});

pmRoutes.post("/boards/:boardId/restore", (c) => {
  const board = restoreBoard(c.req.param("boardId"));
  return board ? c.json(board) : notFound(c);
});

pmRoutes.post("/boards/:boardId/archive", async (c) => {
  const { archived } = (await c.req.json()) as { archived?: unknown };
  const board = setBoardArchived(c.req.param("boardId"), archived !== false);
  return board ? c.json(board) : notFound(c);
});

pmRoutes.post("/boards/:boardId/duplicate", async (c) => {
  const { asTemplate, withTasks } = (await c.req.json().catch(() => ({}))) as {
    asTemplate?: unknown;
    withTasks?: unknown;
  };
  const board = duplicateBoard(c.req.param("boardId"), {
    asTemplate: asTemplate === true,
    withTasks: withTasks === true,
  });
  return board ? c.json(board, 201) : notFound(c);
});

// ---------------------------------------------------------------------------
// Board config sub-resources (columns / labels / issue-types / custom-fields).
// No GETs — they ride the board fetch. Same CRUD shape for all four, but the
// column delete takes ?moveTasksTo= (a column delete must never eat tasks).

pmRoutes.post("/boards/:boardId/columns", async (c) => {
  const parsed = ColumnInputSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  const column = createColumn(c.req.param("boardId"), parsed.data);
  return column ? c.json(column, 201) : notFound(c);
});
pmRoutes.patch("/boards/:boardId/columns/:columnId", async (c) => {
  const parsed = ColumnInputSchema.partial().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  const column = patchColumn(c.req.param("boardId"), c.req.param("columnId"), parsed.data);
  return column ? c.json(column) : notFound(c);
});
pmRoutes.delete("/boards/:boardId/columns/:columnId", (c) => {
  const moveTasksTo = c.req.query("moveTasksTo");
  if (!moveTasksTo) return c.json({ error: "moveTasksTo is required" }, 400);
  return deleteColumn(c.req.param("boardId"), c.req.param("columnId"), moveTasksTo)
    ? c.json({ ok: true })
    : notFound(c);
});

pmRoutes.post("/boards/:boardId/labels", async (c) => {
  const parsed = LabelInputSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  const label = createLabel(c.req.param("boardId"), parsed.data);
  return label ? c.json(label, 201) : notFound(c);
});
pmRoutes.patch("/boards/:boardId/labels/:labelId", async (c) => {
  const parsed = LabelInputSchema.partial().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  const label = patchLabel(c.req.param("boardId"), c.req.param("labelId"), parsed.data);
  return label ? c.json(label) : notFound(c);
});
pmRoutes.delete("/boards/:boardId/labels/:labelId", (c) =>
  deleteLabel(c.req.param("boardId"), c.req.param("labelId")) ? c.json({ ok: true }) : notFound(c),
);

pmRoutes.post("/boards/:boardId/issue-types", async (c) => {
  const parsed = IssueTypeInputSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  const type = createIssueType(c.req.param("boardId"), parsed.data);
  return type ? c.json(type, 201) : notFound(c);
});
pmRoutes.patch("/boards/:boardId/issue-types/:typeId", async (c) => {
  const parsed = IssueTypeInputSchema.partial().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  const type = patchIssueType(c.req.param("boardId"), c.req.param("typeId"), parsed.data);
  return type ? c.json(type) : notFound(c);
});
pmRoutes.delete("/boards/:boardId/issue-types/:typeId", (c) =>
  deleteIssueType(c.req.param("boardId"), c.req.param("typeId"))
    ? c.json({ ok: true })
    : notFound(c),
);

pmRoutes.post("/boards/:boardId/custom-fields", async (c) => {
  const parsed = CustomFieldInputSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  const field = createCustomField(c.req.param("boardId"), parsed.data);
  return field ? c.json(field, 201) : notFound(c);
});
pmRoutes.patch("/boards/:boardId/custom-fields/:fieldId", async (c) => {
  const parsed = CustomFieldInputSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  const field = patchCustomField(c.req.param("boardId"), c.req.param("fieldId"), parsed.data);
  return field ? c.json(field) : notFound(c);
});
pmRoutes.delete("/boards/:boardId/custom-fields/:fieldId", (c) =>
  deleteCustomField(c.req.param("boardId"), c.req.param("fieldId"))
    ? c.json({ ok: true })
    : notFound(c),
);

// ---------------------------------------------------------------------------
// Sprints + milestones

pmRoutes.post("/boards/:boardId/sprints", async (c) => {
  const parsed = SprintInputSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  const sprint = createSprint(c.req.param("boardId"), parsed.data);
  return sprint ? c.json(sprint, 201) : notFound(c);
});
pmRoutes.patch("/boards/:boardId/sprints/:sprintId", async (c) => {
  const parsed = SprintInputSchema.partial().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  const sprint = patchSprint(c.req.param("boardId"), c.req.param("sprintId"), parsed.data);
  return sprint ? c.json(sprint) : notFound(c);
});
pmRoutes.delete("/boards/:boardId/sprints/:sprintId", (c) =>
  deleteSprint(c.req.param("boardId"), c.req.param("sprintId"))
    ? c.json({ ok: true })
    : notFound(c),
);
pmRoutes.post("/boards/:boardId/sprints/:sprintId/start", (c) => {
  const sprint = startSprint(c.req.param("boardId"), c.req.param("sprintId"));
  return sprint ? c.json(sprint) : notFound(c);
});
pmRoutes.post("/boards/:boardId/sprints/:sprintId/complete", async (c) => {
  const { moveIncompleteTo } = (await c.req.json().catch(() => ({}))) as {
    moveIncompleteTo?: unknown;
  };
  const sprint = completeSprint(
    c.req.param("boardId"),
    c.req.param("sprintId"),
    typeof moveIncompleteTo === "string" ? moveIncompleteTo : null,
  );
  return sprint ? c.json(sprint) : notFound(c);
});

pmRoutes.post("/boards/:boardId/milestones", async (c) => {
  const parsed = MilestoneInputSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  const milestone = createMilestone(c.req.param("boardId"), parsed.data);
  return milestone ? c.json(milestone, 201) : notFound(c);
});
pmRoutes.patch("/boards/:boardId/milestones/:milestoneId", async (c) => {
  const parsed = MilestoneInputSchema.partial().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  const milestone = patchMilestone(
    c.req.param("boardId"),
    c.req.param("milestoneId"),
    parsed.data,
  );
  return milestone ? c.json(milestone) : notFound(c);
});
pmRoutes.delete("/boards/:boardId/milestones/:milestoneId", (c) =>
  deleteMilestone(c.req.param("boardId"), c.req.param("milestoneId"))
    ? c.json({ ok: true })
    : notFound(c),
);
pmRoutes.post("/boards/:boardId/milestones/:milestoneId/reach", async (c) => {
  const { reached } = (await c.req.json().catch(() => ({}))) as { reached?: unknown };
  const milestone = reachMilestone(
    c.req.param("boardId"),
    c.req.param("milestoneId"),
    reached !== false,
  );
  return milestone ? c.json(milestone) : notFound(c);
});

// ---------------------------------------------------------------------------
// Saved views + automations (json config on the board row; PUT = upsert by id,
// the id living in the path so create and rename are the same call)

pmRoutes.put("/boards/:boardId/views/:viewId", async (c) => {
  const parsed = SavedViewSchema.safeParse({
    ...(await c.req.json()),
    id: c.req.param("viewId"),
  });
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  const view = putSavedView(c.req.param("boardId"), parsed.data);
  return view ? c.json(view) : notFound(c);
});
pmRoutes.delete("/boards/:boardId/views/:viewId", (c) =>
  deleteSavedView(c.req.param("boardId"), c.req.param("viewId"))
    ? c.json({ ok: true })
    : notFound(c),
);

// Static /test must be registered before the :ruleId routes would ever shadow
// it — Hono's router prefers static segments, but keeping the order honest
// costs nothing.
pmRoutes.post("/boards/:boardId/automations/test", async (c) => {
  const body = (await c.req.json()) as { rule?: unknown; taskId?: unknown };
  const parsed = AutomationRuleSchema.safeParse(body.rule);
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  const boardId = c.req.param("boardId");
  const board = getBoard(boardId);
  if (!board) return notFound(c);
  const task = typeof body.taskId === "string" ? getTask(boardId, body.taskId) : undefined;
  if (!task) return c.json({ error: "taskId must name a task on this board" }, 400);

  // Dry-run: SYNTHESIZE the mutation the rule's trigger watches for (the task
  // is not actually changing), then evaluate — nothing is applied.
  const rule = parsed.data;
  const { labelIds, ...row } = task;
  const after: TaskRow = row;
  let before: TaskRow | null = after;
  const changes: ChangeRecord[] = [];
  switch (rule.when.type) {
    case "task_created":
      before = null;
      break;
    case "task_moved":
      changes.push({ field: "columnId", from: null, to: after.columnId });
      break;
    case "task_completed": {
      before = { ...after, completedAt: null };
      const completed: TaskRow = { ...after, completedAt: after.completedAt ?? Date.now() };
      changes.push({ field: "completedAt", from: null, to: completed.completedAt });
      return c.json(dryRun(rule, board, before, completed, labelIds, changes));
    }
    case "field_changed":
      changes.push({
        field: rule.when.field,
        from: null,
        to: (after as unknown as Record<string, unknown>)[rule.when.field] ?? null,
      });
      break;
  }
  return c.json(dryRun(rule, board, before, after, labelIds, changes));
});

function dryRun(
  rule: AutomationRule,
  board: Board,
  before: TaskRow | null,
  after: TaskRow,
  labelIds: string[],
  changes: ChangeRecord[],
) {
  const ctx: AutomationContext = {
    board,
    columns: board.columns,
    labels: board.labels,
    issueTypes: board.issueTypes,
    customFields: board.customFields,
    sprints: board.sprints,
    milestones: board.milestones,
    before,
    after,
    labelIds,
    changes,
  };
  const matched = matchRule(rule, ctx);
  return { matched, effects: matched ? runAutomations([rule], ctx, new Set()) : [] };
}

pmRoutes.put("/boards/:boardId/automations/:ruleId", async (c) => {
  const parsed = AutomationRuleSchema.safeParse({
    ...(await c.req.json()),
    id: c.req.param("ruleId"),
  });
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  const rule = putAutomation(c.req.param("boardId"), parsed.data);
  return rule ? c.json(rule) : notFound(c);
});
pmRoutes.delete("/boards/:boardId/automations/:ruleId", (c) =>
  deleteAutomation(c.req.param("boardId"), c.req.param("ruleId"))
    ? c.json({ ok: true })
    : notFound(c),
);

// ---------------------------------------------------------------------------
// Tasks

/** GET /tasks query params → FilterSpec. Multi-valued filters repeat the param
    (?column=a&column=b); flags are "1". */
function parseFilter(c: { req: { query(k: string): string | undefined; queries(k: string): string[] | undefined } }) {
  const many = (k: string) => {
    const values = c.req.queries(k);
    return values && values.length > 0 ? values : undefined;
  };
  const num = (k: string) => {
    const raw = c.req.query(k);
    return raw === undefined ? undefined : Number(raw);
  };
  return FilterSpecSchema.safeParse({
    q: c.req.query("q"),
    columnIds: many("column"),
    assignees: many("assignee"),
    labelIds: many("label"),
    typeIds: many("type"),
    sprint: c.req.query("sprint"),
    epicId: c.req.query("epic"),
    parentId: c.req.query("parent"),
    milestoneId: c.req.query("milestone"),
    priorityGte: num("priorityGte"),
    due: c.req.query("due"),
    archived: c.req.query("archived") === "1" ? true : undefined,
    trashed: c.req.query("trashed") === "1" ? true : undefined,
  });
}

pmRoutes.get("/boards/:boardId/tasks", (c) => {
  const boardId = c.req.param("boardId");
  if (!getBoard(boardId)) return notFound(c);
  const filter = parseFilter(c);
  if (!filter.success) return c.json({ error: filter.error.issues }, 400);
  const limit = c.req.query("limit");
  const offset = c.req.query("offset");
  return c.json(
    queryTasks(boardId, filter.data, {
      limit: limit === undefined ? undefined : Number(limit) || undefined,
      offset: offset === undefined ? undefined : Number(offset) || 0,
    }),
  );
});

pmRoutes.post("/boards/:boardId/tasks", async (c) => {
  const body = await c.req.json();
  const parsed = TaskCreateInputSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  return c.json(createTask(c.req.param("boardId"), parsed.data, actorOf(body)), 201);
});

// Multi-select ops: one transaction, one response. Registered before
// /tasks/:taskId so "bulk" can never be read as a task id.
pmRoutes.post("/boards/:boardId/tasks/bulk", async (c) => {
  const body = await c.req.json();
  const parsed = BulkOpSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  return c.json(bulkOp(c.req.param("boardId"), parsed.data, actorOf(body)));
});

pmRoutes.get("/boards/:boardId/tasks/:taskId", (c) => {
  const task = getTask(c.req.param("boardId"), c.req.param("taskId"));
  return task ? c.json(task) : notFound(c);
});

pmRoutes.patch("/boards/:boardId/tasks/:taskId", async (c) => {
  const body = await c.req.json();
  const parsed = TaskPatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  const task = applyMutation(
    c.req.param("boardId"),
    c.req.param("taskId"),
    parsed.data,
    actorOf(body),
  );
  return task ? c.json(task) : notFound(c);
});

// Trash by default; ?purge=1 hard-deletes (subtasks/comments/activity cascade).
pmRoutes.delete("/boards/:boardId/tasks/:taskId", (c) => {
  const boardId = c.req.param("boardId");
  const taskId = c.req.param("taskId");
  if (c.req.query("purge") === "1") {
    return purgeTask(boardId, taskId) ? c.json({ ok: true }) : notFound(c);
  }
  const task = trashTask(boardId, taskId, c.req.query("actor") || "user");
  return task ? c.json(task) : notFound(c);
});

pmRoutes.post("/boards/:boardId/tasks/:taskId/move", async (c) => {
  const body = await c.req.json();
  const parsed = MoveOpSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  const task = moveTask(c.req.param("boardId"), c.req.param("taskId"), parsed.data, actorOf(body));
  return task ? c.json(task) : notFound(c);
});

for (const [path, fn] of [
  ["restore", restoreTask],
  ["archive", archiveTask],
  ["unarchive", unarchiveTask],
] as const) {
  pmRoutes.post(`/boards/:boardId/tasks/:taskId/${path}`, async (c) => {
    const body = await c.req.json().catch(() => null);
    const task = fn(c.req.param("boardId"), c.req.param("taskId"), actorOf(body));
    return task ? c.json(task) : notFound(c);
  });
}

// Wholesale rank rewrite (sorts, multi-drag) — see BulkReorderSchema's scopes.
pmRoutes.post("/boards/:boardId/reorder", async (c) => {
  const parsed = BulkReorderSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  return bulkReorder(c.req.param("boardId"), parsed.data) ? c.json({ ok: true }) : notFound(c);
});

// ---------------------------------------------------------------------------
// Comments + activity (lazy-fetched by the task editor; never in the board fetch)

/** Comments/activity are keyed by taskId alone in tasks.ts, so the board scope
    in the URL is enforced here. */
function taskOn(c: { req: { param(k: "boardId" | "taskId"): string } }) {
  return getTask(c.req.param("boardId"), c.req.param("taskId"));
}

pmRoutes.get("/boards/:boardId/tasks/:taskId/comments", (c) => {
  const task = taskOn(c);
  if (!task) return notFound(c);
  const limit = c.req.query("limit");
  const offset = c.req.query("offset");
  return c.json(
    listComments(task.id, {
      limit: limit === undefined ? undefined : Number(limit) || undefined,
      offset: offset === undefined ? undefined : Number(offset) || 0,
    }),
  );
});

pmRoutes.post("/boards/:boardId/tasks/:taskId/comments", async (c) => {
  const parsed = CommentInputSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  const task = taskOn(c);
  if (!task) return notFound(c);
  const comment = addComment(task.id, parsed.data);
  return comment ? c.json(comment, 201) : notFound(c);
});

pmRoutes.delete("/boards/:boardId/tasks/:taskId/comments/:commentId", (c) => {
  const task = taskOn(c);
  if (!task) return notFound(c);
  return deleteComment(task.id, c.req.param("commentId")) ? c.json({ ok: true }) : notFound(c);
});

// ?after=<seq> is the cursor — the journal pattern, a read is a range scan.
pmRoutes.get("/boards/:boardId/tasks/:taskId/activity", (c) => {
  const task = taskOn(c);
  if (!task) return notFound(c);
  const after = Number(c.req.query("after") ?? 0) || 0;
  const limit = Number(c.req.query("limit") ?? 0) || undefined;
  return c.json(listActivity(task.id, after, limit));
});

// ---------------------------------------------------------------------------
// Dependencies (taskId is blocked by dependsOnId)

pmRoutes.post("/boards/:boardId/tasks/:taskId/dependencies", async (c) => {
  const { dependsOnId } = (await c.req.json()) as { dependsOnId?: unknown };
  if (typeof dependsOnId !== "string" || !dependsOnId) {
    return c.json({ error: "dependsOnId is required" }, 400);
  }
  addDependency(c.req.param("boardId"), c.req.param("taskId"), dependsOnId);
  return c.json({ ok: true }, 201);
});

pmRoutes.delete("/boards/:boardId/tasks/:taskId/dependencies/:dependsOnId", (c) => {
  const task = taskOn(c);
  if (!task) return notFound(c);
  return removeDependency(task.id, c.req.param("dependsOnId"))
    ? c.json({ ok: true })
    : notFound(c);
});

// Board-wide: every dep pair (timeline arrows) + the currently-blocked set.
pmRoutes.get("/boards/:boardId/dependencies", (c) => {
  const boardId = c.req.param("boardId");
  if (!getBoard(boardId)) return notFound(c);
  return c.json({
    dependencies: listDependencies(boardId),
    blockedTaskIds: [...blockedTaskIds(boardId)],
  });
});

// ---------------------------------------------------------------------------
// Reports + dashboard

pmRoutes.get("/boards/:boardId/reports/burndown", (c) => {
  const sprintId = c.req.query("sprintId");
  if (!sprintId) return c.json({ error: "sprintId is required" }, 400);
  const report = burndown(c.req.param("boardId"), sprintId);
  return report ? c.json(report) : notFound(c);
});

pmRoutes.get("/boards/:boardId/reports/velocity", (c) => {
  const boardId = c.req.param("boardId");
  if (!getBoard(boardId)) return notFound(c);
  return c.json(velocity(boardId));
});

pmRoutes.get("/boards/:boardId/dashboard", (c) => {
  const boardId = c.req.param("boardId");
  if (!getBoard(boardId)) return notFound(c);
  return c.json(dashboard(boardId));
});

// ---------------------------------------------------------------------------
// Cross-board search (⌘K). LIKE over title/key/description with a LIMIT —
// upgradeable to FTS5 later without touching the route shape.

pmRoutes.get("/search", (c) => {
  const q = c.req.query("q")?.trim();
  if (!q) return c.json([]);
  const limit = Math.min(Number(c.req.query("limit") ?? 20) || 20, 100);
  const pattern = "%" + q.replace(/[\\%_]/g, (ch) => `\\${ch}`) + "%";
  const rows = db
    .select({
      id: pmTasks.id,
      boardId: pmTasks.boardId,
      key: pmTasks.key,
      title: pmTasks.title,
      columnId: pmTasks.columnId,
      boardName: pmBoards.name,
    })
    .from(pmTasks)
    .innerJoin(pmBoards, sql`${pmBoards.id} = ${pmTasks.boardId}`)
    .where(
      and(
        // Only boards a person can address: live, non-template.
        isNull(pmBoards.deletedAt),
        isNull(pmBoards.templateFor),
        isNull(pmTasks.deletedAt),
        or(
          sql`${pmTasks.title} LIKE ${pattern} ESCAPE '\\'`,
          sql`${pmTasks.key} LIKE ${pattern} ESCAPE '\\'`,
          sql`${pmTasks.descriptionMd} LIKE ${pattern} ESCAPE '\\'`,
        ),
      ),
    )
    .limit(limit)
    .all();
  return c.json(rows);
});
