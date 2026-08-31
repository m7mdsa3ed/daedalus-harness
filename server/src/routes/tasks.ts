import type { Context, Hono } from "hono";
import { z } from "zod";
import { createScheduled, deleteScheduled, listScheduled, updateScheduled } from "../scheduler.js";
import { TaskDirError, type TaskTailer } from "../tasks.js";
import {
  BoardError,
  CreateBoardSchema,
  CreateStatusSchema,
  ReorderStatusesSchema,
  UpdateBoardSchema,
  UpdateStatusSchema,
  createBoard,
  createStatus,
  deleteBoard,
  deleteStatus,
  getBoard,
  listAllStatuses,
  listBoards,
  listStatuses,
  reorderStatuses,
  updateBoard,
  updateStatus,
} from "../boards.js";
import {
  CreateTaskSchema,
  ReorderEntrySchema,
  UpdateTaskSchema,
  applyReorder,
  createTask,
  deleteTask,
  listTasks,
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

/** Scheduled messages, the tasks board, and the background-task watch. */
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
    // One request for the whole switcher: the boards plus every column of
    // every board, since the client needs a board's columns the instant it is
    // selected and a request per board would make switching feel remote.
    c.json({ boards: listBoards(), statuses: listAllStatuses() }),
  );

  app.post("/api/boards", crud(CreateBoardSchema, { lenientJson: true }).create(createBoard));

  app.patch("/api/boards/:id", crud(UpdateBoardSchema, { lenientJson: true }).update(updateBoard));

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

  /* Tasks board. A standalone, top-level resource — no project/session/agent
     scoping yet, per "no connection between the agents and the board, initially".
     The whole board is small (a few hundred rows at most), so every mutation
     answers with the full list and the client reconciles from it rather than
     trying to diff. */
  app.get("/api/tasks", (c) => {
    const boardId = c.req.query("board");
    return c.json(listTasks(boardId || undefined));
  });

  app.post("/api/tasks", async (c) => {
    const parsed = CreateTaskSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    return guard(c, () => c.json(createTask(parsed.data), 201));
  });

  app.patch("/api/tasks/:id", async (c) => {
    const parsed = UpdateTaskSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    return guard(c, () => {
      const row = updateTask(c.req.param("id"), parsed.data);
      return row ? c.json(row) : c.json({ error: "not found" }, 404);
    });
  });

  /* Whole-board reorder + status moves, one request. The body is the board's new
     column-by-column order; the server commits it atomically. */
  app.post("/api/tasks/reorder", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { entries?: unknown; board?: unknown };
    const entries = Array.isArray(body.entries) ? body.entries : [];
    const parsed = z.array(ReorderEntrySchema).safeParse(entries);
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const boardId = typeof body.board === "string" && body.board.trim() ? body.board : "default";
    return guard(c, () => c.json(applyReorder(parsed.data, boardId)));
  });

  app.delete("/api/tasks/:id", (c) =>
    deleteTask(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404),
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
