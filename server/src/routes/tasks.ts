import type { Context, Hono } from "hono";
import { z } from "zod";
import { createScheduled, deleteScheduled, listScheduled, updateScheduled } from "../scheduler.js";
import { TaskDirError, type TaskTailer } from "../tasks.js";
import {
  BoardError,
  CompleteSprintSchema,
  CreateBoardSchema,
  CreateSprintSchema,
  CreateStatusSchema,
  CreateViewSchema,
  ReorderStatusesSchema,
  UpdateBoardSchema,
  UpdateSprintSchema,
  UpdateStatusSchema,
  UpdateViewSchema,
  completeSprint,
  createBoard,
  createSprint,
  createStatus,
  createView,
  deleteBoard,
  deleteSprint,
  deleteStatus,
  deleteView,
  getBoard,
  listAllSprints,
  listAllStatuses,
  listAllViews,
  listBoards,
  listStatuses,
  reorderStatuses,
  startSprint,
  updateBoard,
  updateSprint,
  updateStatus,
  updateView,
} from "../boards.js";
import {
  BulkUpdateSchema,
  CommentSchema,
  CreateTaskSchema,
  LinkSchema,
  ReorderEntrySchema,
  UpdateTaskSchema,
  addComment,
  addLink,
  applyReorder,
  bulkUpdate,
  createTask,
  deleteComment,
  deleteLink,
  deleteTask,
  findTaskByKey,
  getTaskDetail,
  listTasks,
  updateComment,
  updateTask,
} from "../tasks-board.js";
import type { SessionManager } from "../sessions.js";
import { crud } from "./helpers.js";

/* ── Scheduled messages ──
   Server-delivered prompts for a thread: the client only says "send `text` at
   `time` (opt. recurring)"; the sweep in scheduler.ts owns the firing, so a
   scheduled turn happens whether or not any browser is attached. Schedules a
   thread's row survives it, so deleting a thread cascades its schedules away. */
const ScheduledInputSchema = z.object({
  sessionId: z.string().min(1),
  text: z.string().min(1).max(16_000),
  nextAt: z.number().int().min(0),
  everyMs: z.number().int().positive().optional().nullable(),
});

/* Edit a schedule in place: text, time, recurrence, or pause/resume
   (`enabled`). Any patch also resets the row's skip state, so a schedule that
   was parked after too many undeliverable sweeps is retried. */
const ScheduledPatchSchema = z
  .object({
    text: z.string().min(1).max(16_000).optional(),
    nextAt: z.number().int().min(0).optional(),
    everyMs: z.number().int().positive().nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, "nothing to update");

/** Scheduled messages, the task workspace, and the background-task watch. */
export function taskRoutes(app: Hono, deps: { sessions: SessionManager; tasks: TaskTailer }): void {
  const { sessions, tasks } = deps;

  app.get("/api/scheduled", (c) => c.json(listScheduled()));
  app.post("/api/scheduled", async (c) => {
    const parsed = ScheduledInputSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    // A schedule for a thread the server has never heard of can never fire. The
    // thread need not be LIVE (a retired one is revivable, which is half the
    // point of the feature) — but it has to exist.
    const session = sessions.get(parsed.data.sessionId);
    if (!session) return c.json({ error: "unknown session" }, 404);
    return c.json(createScheduled(parsed.data), 201);
  });

  app.patch("/api/scheduled/:id", crud(ScheduledPatchSchema).update(updateScheduled));

  app.delete("/api/scheduled/:id", (c) =>
    deleteScheduled(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404),
  );

  /* ── Boards and their columns ──
     A board is a kanban and a status is one of its columns, both rows rather
     than constants, which is what lets a user add a status. Deleting either is
     destructive in a way a task delete is not (a column holds other people's
     work), so both refuse to leave the app with nothing to render and
     `deleteStatus` rehomes rather than cascades — see boards.ts. `BoardError`
     carries the status code for the cases a caller can fix. */
  const guard = async (c: Context, run: () => Response): Promise<Response> => {
    try {
      return run();
    } catch (err) {
      if (err instanceof BoardError)
        return c.json({ error: err.message }, err.status === 404 ? 404 : 400);
      throw err;
    }
  };

  app.get("/api/boards", (c) =>
    // One request for the whole workspace: the boards plus every column,
    // sprint and saved view of every board, since the client needs a board's
    // columns the instant it is selected and a request per board would make
    // switching feel remote.
    c.json({
      boards: listBoards(),
      statuses: listAllStatuses(),
      sprints: listAllSprints(),
      views: listAllViews(),
    }),
  );

  app.post("/api/boards", async (c) => {
    const parsed = CreateBoardSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    return guard(c, () => c.json(createBoard(parsed.data), 201));
  });

  app.patch("/api/boards/:id", async (c) => {
    const parsed = UpdateBoardSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    return guard(c, () => {
      const row = updateBoard(c.req.param("id"), parsed.data);
      return row ? c.json(row) : c.json({ error: "not found" }, 404);
    });
  });

  app.delete("/api/boards/:id", (c) =>
    guard(c, () =>
      deleteBoard(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404),
    ),
  );

  app.get("/api/boards/:id/statuses", (c) =>
    getBoard(c.req.param("id"))
      ? c.json(listStatuses(c.req.param("id")))
      : c.json({ error: "not found" }, 404),
  );

  app.post("/api/boards/:id/statuses", async (c) => {
    const parsed = CreateStatusSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    return guard(c, () => c.json(createStatus(c.req.param("id"), parsed.data), 201));
  });

  app.post("/api/boards/:id/statuses/reorder", async (c) => {
    const parsed = ReorderStatusesSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    if (!getBoard(c.req.param("id"))) return c.json({ error: "not found" }, 404);
    return c.json(reorderStatuses(c.req.param("id"), parsed.data.ids));
  });

  app.patch("/api/statuses/:id", crud(UpdateStatusSchema, { lenientJson: true }).update(updateStatus));

  /* `moveTo` is where this column's tasks go. Omitted, they go to the board's
     first remaining column — never nowhere. */
  app.delete("/api/statuses/:id", (c) => {
    const moveTo = c.req.query("moveTo");
    return guard(c, () =>
      deleteStatus(c.req.param("id"), moveTo || undefined)
        ? c.json({ ok: true })
        : c.json({ error: "not found" }, 404),
    );
  });

  /* ── Sprints ──
     A dated window of a board's work. planned → active → closed; closing one
     asks where its open tasks go, the way a column delete does. */
  app.post("/api/boards/:id/sprints", async (c) => {
    const parsed = CreateSprintSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    return guard(c, () => c.json(createSprint(c.req.param("id"), parsed.data), 201));
  });

  app.patch("/api/sprints/:id", async (c) => {
    const parsed = UpdateSprintSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    return guard(c, () => {
      const row = updateSprint(c.req.param("id"), parsed.data);
      return row ? c.json(row) : c.json({ error: "not found" }, 404);
    });
  });

  app.post("/api/sprints/:id/start", (c) => guard(c, () => c.json(startSprint(c.req.param("id")))));

  app.post("/api/sprints/:id/complete", async (c) => {
    const parsed = CompleteSprintSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    return guard(c, () => c.json(completeSprint(c.req.param("id"), parsed.data.moveTo)));
  });

  app.delete("/api/sprints/:id", (c) =>
    deleteSprint(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404),
  );

  /* ── Saved views ── a layout plus the filters it was saved with. */
  app.post("/api/boards/:id/views", async (c) => {
    const parsed = CreateViewSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    return guard(c, () => c.json(createView(c.req.param("id"), parsed.data), 201));
  });

  app.patch("/api/views/:id", crud(UpdateViewSchema, { lenientJson: true }).update(updateView));

  app.delete("/api/views/:id", (c) =>
    deleteView(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404),
  );

  /* ── Tasks ──
     A standalone, top-level resource — no session/agent scoping. The whole
     list is small (a few thousand rows at most), so every mutation answers with
     the row(s) it changed and the client reconciles from that. */
  app.get("/api/tasks", (c) => {
    const boardId = c.req.query("board");
    return c.json(listTasks(boardId || undefined));
  });

  /** `KEY-12` → the task, for deep links and the link picker. */
  app.get("/api/tasks/by-key/:key", (c) => {
    const task = findTaskByKey(c.req.param("key"));
    return task ? c.json(task) : c.json({ error: "not found" }, 404);
  });

  app.post("/api/tasks", async (c) => {
    const parsed = CreateTaskSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    return guard(c, () => c.json(createTask(parsed.data), 201));
  });

  /* Whole-board reorder + status moves, one request. The body is the board's new
     column-by-column order; the server commits it atomically. Registered before
     `/api/tasks/:id` so the literal segment wins. */
  app.post("/api/tasks/reorder", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { entries?: unknown; board?: unknown };
    const entries = Array.isArray(body.entries) ? body.entries : [];
    const parsed = z.array(ReorderEntrySchema).safeParse(entries);
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const boardId = typeof body.board === "string" && body.board.trim() ? body.board : "default";
    return guard(c, () => c.json(applyReorder(parsed.data, boardId)));
  });

  /* One patch, many tasks: the multi-select's "set status / priority /
     assignee / sprint / archive" in one transaction. */
  app.post("/api/tasks/bulk", async (c) => {
    const parsed = BulkUpdateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    return guard(c, () => c.json(bulkUpdate(parsed.data)));
  });

  /** The task with its comments, activity, links and children — what the
      detail panel opens on. */
  app.get("/api/tasks/:id", (c) => {
    const detail = getTaskDetail(c.req.param("id"));
    return detail ? c.json(detail) : c.json({ error: "not found" }, 404);
  });

  app.patch("/api/tasks/:id", async (c) => {
    const parsed = UpdateTaskSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    return guard(c, () => {
      const row = updateTask(c.req.param("id"), parsed.data);
      return row ? c.json(row) : c.json({ error: "not found" }, 404);
    });
  });

  app.delete("/api/tasks/:id", (c) =>
    deleteTask(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404),
  );

  app.post("/api/tasks/:id/comments", async (c) => {
    const parsed = CommentSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    return guard(c, () => c.json(addComment(c.req.param("id"), parsed.data), 201));
  });

  app.patch("/api/comments/:id", async (c) => {
    const parsed = CommentSchema.pick({ body: true }).safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const row = updateComment(c.req.param("id"), parsed.data.body);
    return row ? c.json(row) : c.json({ error: "not found" }, 404);
  });

  app.delete("/api/comments/:id", (c) =>
    deleteComment(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404),
  );

  app.post("/api/tasks/:id/links", async (c) => {
    const parsed = LinkSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    return guard(c, () => c.json(addLink(c.req.param("id"), parsed.data), 201));
  });

  app.delete("/api/links/:id", (c) =>
    deleteLink(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404),
  );

  /**
   * Follow a background task an agent launched (e.g. a Claude Code workflow):
   * the client passes the transcript dir it read out of the tool-call frame, the
   * server verifies the path names a live thread's ACP session, tails its
   * journal, and answers with everything the file holds so far. New lines then
   * arrive over the thread's WebSocket as `task_event`. Idempotent —
   * panels re-call this to keep the tail alive and to backfill after a reload.
   */
  app.post("/api/tasks/watch", async (c) => {
    const { transcriptDir } = await c.req.json();
    try {
      const { events, pending } = await tasks.watch(transcriptDir, sessions.list());
      // `pending` = the directory does not exist yet (the client asks the instant
      // the launch frame arrives, a beat before the agent creates it). The watch
      // is live either way and streams as soon as the journal appears.
      return c.json({ events, pending });
    } catch (err) {
      if (err instanceof TaskDirError) {
        return c.json({ error: err.message }, err.status === 404 ? 404 : err.status === 403 ? 403 : 400);
      }
      throw err;
    }
  });
}
