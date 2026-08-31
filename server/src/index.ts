import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config.js";
import { seedPersonas } from "./personas.js";
import { seedAgents } from "./registry.js";
import { ensureDefaultBoard } from "./boards.js";
import { SessionManager } from "./sessions.js";
import { startScheduler, stopScheduler } from "./scheduler.js";
import { WorkflowRunner } from "./workflows.js";
import { workflowRoutes } from "./routes/workflows.js";
import { TaskTailer } from "./tasks.js";
import { stopWatching } from "./workspace-watch.js";
import { attachTerminal, killProjectTerminals } from "./terminals.js";
import { adoptOrphans, stopAllIdes } from "./ide.js";
import { parseIdePath, proxyIdeUpgrade } from "./ide-proxy.js";
import { configureGatewayShim } from "./gateway-shim.js";
import { Push } from "./push.js";
import { backfillSearchIndex } from "./search.js";
import { bearerToken } from "./routes/helpers.js";
import { miscRoutes } from "./routes/misc.js";
import { profileRoutes } from "./routes/profiles.js";
import { workspaceRoutes } from "./routes/workspace.js";
import { ideRoutes } from "./routes/ide.js";
import { libraryRoutes } from "./routes/library.js";
import { sessionRoutes } from "./routes/sessions.js";
import { taskRoutes } from "./routes/tasks.js";

const config = loadConfig();
// Index whatever was journaled before the FTS table existed. Once (a marker in
// search_meta), incremental, and before the server listens — so nothing is
// streaming into the journal while it walks. New events index at flush time.
backfillSearchIndex();
/* Before anything can spawn: `{gatewayUrl}` in an agent's env is resolved at
   spawn from what this hands out, and a spawn that predates it would go to the
   gateway direct (correct, but without the shim's repair). */
configureGatewayShim({ port: config.port });
// Editors a previous process left running: taken back under the same key so
// browser frames survive a restart, or cleaned up. See adoptOrphans.
await adoptOrphans();
// Adds only the built-in agents this install has never been offered; a user's
// edits and deletions are left alone. See registry.seedAgents.
seedAgents();
// Same rules, same reasons: only the personas this install has never been
// offered, and never over a row the user has edited. See personas.seedPersonas.
seedPersonas();
/* The tasks board's first board and its four columns, seeded only into an
   install that has none. This is also the boards migration: the seeded column
   ids are the exact strings pre-boards tasks hold in `tasks.status`, so those
   rows become legible without being rewritten. See boards.ensureDefaultBoard. */
ensureDefaultBoard();
const push = new Push(config.fcm);
/** Thread title, with the failure's own message appended when there is one. */
const pushBody = (title: string, error?: unknown): string => {
  const message =
    error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
      ? ((error as { message: string }).message)
      : null;
  return message ? `${title} — ${message}` : title;
};
let workflows: WorkflowRunner | null = null;
const sessions = new SessionManager(
  {
    onPermissionRequest: (s) =>
      push.send("Permission needed", s.title, { sessionId: s.id }).catch(console.error),
    onElicitationRequest: (s) =>
      push.send("The agent has a question", s.title, { sessionId: s.id }).catch(console.error),
    onTurnEnd: (s, error) =>
      push
        .send(error ? "Turn failed" : "Turn finished", pushBody(s.title, error), { sessionId: s.id })
        .catch(console.error),
    // A thread whose process went away cannot be waiting on a workflow answer.
    // Guarded: the manager's own boot (a purge of an expired trash row) can
    // retire a thread before the runner below exists.
    onProcessGone: (s) => workflows?.cancelForParent(s.id, "the thread's agent process ended"),
  },
  config.sessionIdleMinutes,
  config.sessionJournalRetentionDays,
);
/* The workflow engine (workflows.ts). Wired both ways after construction: the
   manager hands every top-level thread the `workflow` MCP server pointed at
   the runner's loopback URL, and the runner drives the manager to run steps.
   Runs the last process left "running" are closed first — nothing survived it. */
workflows = new WorkflowRunner(sessions, { port: config.port });
sessions.setWorkflowRunner(workflows);
workflows.recoverAtBoot();
// Tails background-task journals (files an agent disclosed in a tool result)
// and fans each new line out to the owning thread's peers — see tasks.ts.
const tasks = new TaskTailer((sessionId, transcriptDir, event) =>
  sessions.taskEvent(sessionId, transcriptDir, event),
);
// Fires scheduled prompts for threads (scheduler.ts). Owns its own interval,
// so it runs even when every browser is closed.
startScheduler(sessions);

const app = new Hono();
app.use("*", cors());

/**
 * Every route may throw — a bad spawn config, an unknown agent id, a
 * malformed request body. Hono's default is a bare 500 with the text
 * "Internal Server Error", which tells the client nothing it can show a person.
 * One handler turns all of it into the `{ error }` shape the rest of the API
 * already uses, so lib/errors on the other end has something to say.
 */
app.onError((err, c) => {
  console.error(`[${c.req.method} ${c.req.path}]`, err);
  const message = err instanceof Error ? err.message : String(err);
  // A body that isn't JSON is the client's fault, not ours.
  const status = /JSON|Unexpected token|Unexpected end of/i.test(message) ? 400 : 500;
  return c.json({ error: message || "internal error" }, status);
});

app.notFound((c) => c.json({ error: `no such endpoint: ${c.req.method} ${c.req.path}` }, 404));

app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/health") return next();
  const token = bearerToken(c.req.header("authorization"), c.req.query("token"));
  if (token !== config.token) return c.json({ error: "unauthorized" }, 401);
  return next();
});

/* The routes, by domain (src/routes/). Registered after the middleware so
   everything under /api is behind the token; /api/health exempts itself above,
   and /ide/* + /gw/* are outside /api with the key-in-path rule instead. The
   backup route additionally refuses `?token=` — see routes/misc.ts. */
miscRoutes(app, { config, sessions, push });
profileRoutes(app, { sessions });
workspaceRoutes(app);
ideRoutes(app);
libraryRoutes(app);
sessionRoutes(app, { sessions });
taskRoutes(app, { sessions, tasks });
workflowRoutes(app, { runner: workflows });

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`daedalus server on http://${info.address}:${info.port}`);
  console.log(`token: ${config.token}`);
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  /* The editor's socket is not one of ours: VS Code's whole session — the
     extension host, the file watcher, every keystroke — rides it, and this
     server has nothing to say about the protocol. It is tunnelled to the
     loopback code-server before the token check, because the key already in
     its path is that request's credential (see ide.ts). */
  if (parseIdePath(url.pathname)) {
    proxyIdeUpgrade(req, socket, head);
    return;
  }
  if (url.pathname !== "/ws" && url.pathname !== "/terminal") {
    // Destroying the socket leaves the browser with a bare "connection failed".
    // An HTTP response at least names the problem in the network panel.
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }
  if (url.searchParams.get("token") !== config.token) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    // The refusal reason rides the close frame — the client shows it verbatim
    // rather than guessing from the code.
    if (url.pathname === "/terminal") {
      const refused = attachTerminal(
        url.searchParams.get("terminalId") ?? "",
        url.searchParams.get("projectId") ?? "",
        ws,
      );
      if (refused) ws.close(4004, refused);
      return;
    }
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const cursor = Number(url.searchParams.get("cursor") ?? 0) || 0;
    // Opt-in, because an older client would drop a `replay` frame it does not
    // know — and with it the `caught_up` inside, so the thread would hang
    // half-connected forever rather than merely render slowly.
    const batch = url.searchParams.get("batch") === "1";
    // Also opt-in, and for a sharper reason than `batch`: a windowed replay is
    // a transcript that begins in the middle, and a client that cannot ask for
    // the rest (`load_earlier`) must never be handed one.
    const window = Number(url.searchParams.get("window") ?? 0) || 0;
    const refused = sessions.attach(sessionId, ws, cursor, batch, { window });
    if (refused) ws.close(4004, refused);
  });
});

/**
 * One exit path for signals and fatal errors. The order matters: the watchers,
 * terminals, editors and scheduler stop first, then the SessionManager retires
 * every live agent child and flushes the journal rows still buffered for the
 * next tick — a bare `process.exit()` orphaned the children and dropped that
 * tick. The bounded drain afterwards is what lets the SIGTERM→SIGKILL
 * escalation timers in terminals/ide actually fire before the process goes.
 */
const SHUTDOWN_DRAIN_MS = 2_000;
let shuttingDown = false;
async function shutdown(code: number): Promise<never> {
  if (shuttingDown) return new Promise<never>(() => {}); // first caller owns the exit
  shuttingDown = true;
  try {
    stopWatching();
    killProjectTerminals();
    stopAllIdes();
    stopScheduler();
    workflows?.shutdown();
    sessions.shutdown();
  } catch (error) {
    console.error("[shutdown]", error);
  }
  await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_MS));
  process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void shutdown(0));
}
// A rejected promise nowhere near a request handler still kills the process by
// default. Log it and keep serving — every session lives in this one process.
process.on("unhandledRejection", (reason) => console.error("[unhandled rejection]", reason));
// A thrown exception is different: the process state is no longer trustworthy.
// Take the orderly exit — retire the children, flush the journal — and let pm2
// restart us; sessions are revivable by design.
process.on("uncaughtException", (error) => {
  console.error("[uncaught exception]", error);
  void shutdown(1);
});
