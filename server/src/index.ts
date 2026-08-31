import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { WebSocketServer, type WebSocket } from "ws";
import { loadConfig } from "./config.js";
import { seedPersonas } from "./personas.js";
import { seedAgents } from "./registry.js";
import { seedTemplates } from "./templates.js";
import { ensureDefaultBoard } from "./boards.js";
import { SessionManager } from "./sessions.js";
import { startScheduler, stopScheduler } from "./scheduler.js";
import { WorkflowRunner } from "./workflows.js";
import { workflowRoutes } from "./routes/workflows.js";
import { routineRoutes } from "./routes/routines.js";
import { RoutineGitTriggers } from "./routine-git-trigger.js";
import { RoutineEngine } from "./routines.js";
import { TaskTailer } from "./tasks.js";
import { stopWatching } from "./workspace-watch.js";
import { attachTerminal, killProjectTerminals } from "./terminals.js";
import { adoptOrphans, stopAllIdes } from "./ide.js";
import { parseIdePath, proxyIdeUpgrade } from "./ide-proxy.js";
import { configureGatewayShim } from "./gateway-shim.js";
import { Push } from "./push.js";
import { addNotification } from "./notifications.js";
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
// And the Studio's starting points, on the same rule: a template added in a
// later release reaches installs that already exist, one the user deleted stays
// deleted. See templates.seedTemplates.
seedTemplates();
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
/** The failure's own line, pulled apart from the title the way `push` sends it:
    a pill's body is the event (the error, the tool), its title is the thread. */
const failureDetail = (error?: unknown): string | undefined => {
  const message =
    error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
      ? ((error as { message: string }).message)
      : null;
  return message ?? undefined;
};
let workflows: WorkflowRunner | null = null;
let routines: RoutineEngine | null = null;
let routineGitTriggers: RoutineGitTriggers | null = null;
const sessions = new SessionManager(
  {
    onPermissionRequest: (s) => {
      addNotification("permission", s);
      push.send("Permission needed", s.title, { sessionId: s.id }).catch(console.error);
    },
    onElicitationRequest: (s) => {
      addNotification("question", s);
      push.send("The agent has a question", s.title, { sessionId: s.id }).catch(console.error);
    },
    onTurnEnd: (s, error) => {
      addNotification(error ? "turn_failed" : "turn_finished", s, failureDetail(error));
      push
        .send(error ? "Turn failed" : "Turn finished", pushBody(s.title, error), { sessionId: s.id })
        .catch(console.error);
    },
    // A thread whose process went away cannot be waiting on a workflow answer,
    // and a routine run whose thread went away is over — its wait would
    // otherwise reject a minute later with a bare "thread retired", or never at
    // all if the run was waiting on a workflow rather than on a turn.
    // Guarded: the manager's own boot (a purge of an expired trash row) can
    // retire a thread before either engine below exists.
    onProcessGone: (s) => {
      workflows?.cancelForParent(s.id, "the thread's agent process ended");
      routines?.cancelForSession(s.id, "the run's agent process ended");
    },
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
/* The routine engine (routines.ts) — a saved thread-start that fires on its
   own. After the workflow runner because a workflow-bodied routine hands its
   run's thread to it, and neither can be given the other at its own
   construction. Same recovery rule for the same reason: every run was this
   process's child, so a row still marked running did not survive. `notify` is
   the `push` finish action; the engine takes it as a callback rather than
   importing Push, which is what lets a test drive it with neither. */
routines = new RoutineEngine(sessions, {
  port: config.port,
  workflows,
  notify: (title, body, data) => push.send(title, body, data).catch(console.error),
});
routines.recoverAtBoot();
/* The `git` trigger kind (routine-git-trigger.ts): a project watcher that fires
   a routine when the repository under it moves. Separate from the scheduler
   because it has no clock — it is woken by the filesystem, not by a sweep — and
   it watches only the projects that have an enabled git trigger, so a process
   with none holds no handles. */
routineGitTriggers = new RoutineGitTriggers({ engine: routines });
routineGitTriggers.start();
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
   and /ide/* + /gw/* + /wf/* + /rt/* are outside /api with the key-in-path rule
   instead — /rt (the routine fire door) additionally accepts a trigger's own
   stored token in that position, because a per-boot key is not a credential an
   alerting tool outside this process can hold across a restart. The
   backup route additionally refuses `?token=` — see routes/misc.ts. */
miscRoutes(app, { config, sessions, push });
profileRoutes(app, { sessions });
workspaceRoutes(app);
ideRoutes(app);
libraryRoutes(app);
sessionRoutes(app, { sessions });
taskRoutes(app, { sessions, tasks });
workflowRoutes(app, { runner: workflows });
routineRoutes(app, { engine: routines });

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`daedalus server on http://${info.address}:${info.port}`);
  console.log(`token: ${config.token}`);
});

/**
 * Compression, with a threshold — because the two things this socket carries
 * are not the same payload.
 *
 * A replay frame is up to `REPLAY_CHUNK_BYTES` of ACP JSON: the same envelope
 * keys over and over, terminal output, both sides of a diff. It compresses
 * five to ten times over, and it is exactly the traffic `REPLAY_WINDOW_BYTES`
 * exists to cap — so this buys window back rather than trimming it, which
 * matters most on the one connection that feels it, a phone behind
 * `pnpm dev:tunnel`. A live `update`, on the other hand, is a few hundred bytes
 * of streamed text arriving thousands of times a turn, where a deflate call per
 * message costs more than the bytes it saves.
 *
 * Hence `threshold`: below it a message goes out uncompressed, so the streaming
 * path is untouched and only the frames pay. The rest is ws's own advice about
 * per-connection zlib memory — a modest level and window, and a cap on how many
 * sockets may be compressing at once, since this process also owns every agent
 * child and must not spend a turn's latency deflating another thread's archive.
 */
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: {
    threshold: 8 * 1024,
    concurrencyLimit: 10,
    zlibDeflateOptions: { level: 3, memLevel: 7 },
    // Both ends keep a sliding window per socket otherwise; this is a long-lived
    // connection per open thread, and the frames are self-similar enough that
    // the context buys little next to what it holds.
    serverNoContextTakeover: true,
    clientNoContextTakeover: true,
  },
});

/**
 * Liveness, because nothing else pings — `ws` does not do it on its own, and a
 * socket that dies WITHOUT a close frame (a suspended laptop, a NAT idle
 * timeout, a quick tunnel dropping) stays `OPEN` on both ends forever. The
 * browser never hears a `close`, so its reconnect ladder never starts and the
 * thread merely goes quiet — the one failure the give-up message in
 * `actions.ts` cannot describe, because it never fires.
 *
 * It is also what keeps `peers.size` honest, which is load-bearing elsewhere:
 * the server pushes a notification only while a thread has no peer attached,
 * so one zombie peer silently suppresses every push to the phone.
 */
const WS_HEARTBEAT_MS = 30_000;
/** Sockets that have answered since the last round. A WeakSet rather than a
    field on the socket, so nothing is left to clean up when one is dropped. */
const wsAlive = new WeakSet<WebSocket>();
/** Called for every socket this server owns — thread and terminal alike. The
    browser answers a ping frame itself, so this buys the client nothing to
    implement; the client's own watchdog covers the other direction. */
function trackLiveness(ws: WebSocket): void {
  wsAlive.add(ws);
  ws.on("pong", () => wsAlive.add(ws));
}
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    /* Missed a whole round: `terminate()` and not `close()`, since a half-open
       socket will not answer the closing handshake either — it would sit in
       CLOSING until the OS gave up, still counted as a peer. */
    if (!wsAlive.has(ws)) {
      ws.terminate();
      continue;
    }
    wsAlive.delete(ws);
    ws.ping();
  }
}, WS_HEARTBEAT_MS);
// Nothing about a heartbeat should hold the process open on its own.
heartbeat.unref();
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
    trackLiveness(ws);
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
    void sessions.attach(sessionId, ws, cursor, batch, { window }).then((refused) => {
      if (refused) ws.close(4004, refused);
    });
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
    /* Before `stopWatching`, so the closers it fires cannot race a resubscribe:
       `stop()` is what tells the git triggers to stay down. */
    routineGitTriggers?.stop();
    stopWatching();
    killProjectTerminals();
    stopAllIdes();
    stopScheduler();
    clearInterval(heartbeat);
    workflows?.shutdown();
    routines?.shutdown();
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
