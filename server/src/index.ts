import { performance } from "node:perf_hooks";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { WebSocket, WebSocketServer } from "ws";
import { loadConfig } from "./config.js";
import { HttpError } from "./http-error.js";
import { dbAvailable, isDbConnectionError, markDbDown } from "./db/index.js";

const DB_UNAVAILABLE = "database unavailable — reconnecting";
import { migrateLegacyPrompts } from "./legacy-prompts.js";
import { backfillPeakSchedules } from "./peak-schedules.js";
import { migrateScheduledMessages } from "./scheduled-migration.js";
import { retitleBuiltinMcp } from "./library.js";
import { seedModelPrompts, writeModelPromptsLibrary } from "./model-prompts.js";
import { seedDefaultModelRoles } from "./model-roles.js";
import { seedAgents } from "./registry.js";
import { seedPersonas } from "./persona-seeds.js";
import { ensureDefaultBoard } from "./boards.js";
import { SessionManager } from "./sessions.js";
import { adoptAgents } from "./adopt-boot.js";
import { mark } from "./boot-timing.js";
import { durable, sandbox } from "./sandbox/index.js";
import { startScheduler, stopScheduler } from "./scheduler.js";
import { WorkflowEngine } from "./workflows/engine.js";
import { workflowRoutes } from "./workflows/routes.js";
import { harnessRoutes } from "./routes/harness.js";
import { sqlRoutes } from "./routes/sql.js";
import { routineRoutes } from "./routes/routines.js";
import { RoutineGitTriggers } from "./routine-git-trigger.js";
import { RoutineEngine } from "./routines.js";
import { TaskTailer } from "./tasks.js";
import { stopWatching } from "./workspace-watch.js";
import { attachTerminal, killProjectTerminals } from "./terminals.js";
import { attachBrowserViewer, killProjectBrowsers } from "./browsers.js";
import { BROWSER_CLOSE, BROWSER_SOCKET_PATH } from "./browser-protocol.js";
import { getProject } from "./projects.js";
import { configureGatewayShim } from "./gateway-shim.js";
import { configureMcpShim } from "./mcp-shim.js";
import { configurePauseHooks } from "./pause-hooks.js";
import { configureOtlp } from "./model-calls/sources/otlp.js";
import { Push } from "./push.js";
import { addNotification } from "./notifications.js";
import { backfillSearchIndex } from "./search.js";
import { bearerToken } from "./routes/helpers.js";
import { miscRoutes } from "./routes/misc.js";
import { fimRoutes } from "./routes/fim.js";
import { sideModelRoutes } from "./routes/side-models.js";
import { voiceRoutes } from "./routes/voice.js";
import { profileRoutes } from "./routes/profiles.js";
import { spaceRoutes } from "./routes/spaces.js";
import { workspaceRoutes } from "./routes/workspace.js";
import { attachmentRoutes } from "./routes/attachments.js";
import { fileRoutes } from "./routes/files.js";
import { libraryRoutes } from "./routes/library.js";
import { sessionRoutes } from "./routes/sessions.js";
import { prewarmRoutes } from "./routes/prewarm.js";
import { taskRoutes } from "./routes/tasks.js";
import { mentionRoutes } from "./routes/mentions.js";
import { browserRoutes } from "./routes/browser.js";

mark("modules loaded");
const config = loadConfig();
// Index whatever was journaled before the FTS table existed. Once (a marker in
// search_meta), incremental, and before the server listens — so nothing is
// streaming into the journal while it walks. New events index at flush time.
await backfillSearchIndex();
mark("search index backfill");
/* Before anything can spawn: `{gatewayUrl}` in an agent's env is resolved at
   spawn from what this hands out, and a spawn that predates it would go to the
   gateway direct (correct, but without the shim's repair). */
configureGatewayShim({ port: config.port });
/* The same bargain for an MCP server that demands OAuth: the child is handed
   `/mx/<key>/<serverId>` and the token is attached here, per request. */
configureMcpShim({ port: config.port });
/* And for a runtime paused through its own hooks: they call `/ph/<key>/<id>`,
   which answers only while the thread is not paused (pause-hooks.ts). */
configurePauseHooks({ port: config.port });
/* And for Claude Code's telemetry: the `otlp` door attaches only once the
   receiver knows its port, and wipes the bodies a previous run left. */
configureOtlp({ port: config.port });
// Adds only the built-in agents this install has never been offered; a user's
// edits and deletions are left alone. See registry.seedAgents.
await seedAgents();
// Legacy saved prompts and personas become slash commands, once.
await migrateLegacyPrompts();
/* The built-in personas — roles a first message reveals, which is what the
   classifier picks from — and, once, the retirement of the first working-style
   set. Same rules as the agents: never a user's row. See persona-seeds.ts. */
{
  const { added, retired } = await seedPersonas();
  if (added || retired) mark(`personas: ${added} added, ${retired} retired`);
}
/* The published time-of-day rate cards onto models saved before `peak`
   existed, once, and only where the user has written no schedule of their own.
   See peak-schedules.ts for which families bill by the clock. */
mark(`peak schedules: ${await backfillPeakSchedules()} model(s)`);
// Scheduled messages become session-mode routines, once.
await migrateScheduledMessages();
/* Same rules again for the model-prompt library, then the file the runtime
   reads. The write is unconditional and not the seed's: the library is derived
   state, and a boot after a hand-edited `data/` — or after an import, which
   writes rows straight into the table — must leave the file agreeing with the
   database whether or not anything was seeded. */
await retitleBuiltinMcp();
await seedModelPrompts();
await writeModelPromptsLibrary();
/* The model-role vocabulary: the three defaults, seeded only into an install
   that has none. See model-roles.ts. */
await seedDefaultModelRoles();
/* The tasks board's first board and its four columns, seeded only into an
   install that has none. This is also the boards migration: the seeded column
   ids are the exact strings pre-boards tasks hold in `tasks.status`, so those
   rows become legible without being rewritten. See boards.ensureDefaultBoard. */
await ensureDefaultBoard();
mark("seeds and migrations");
const push = new Push(config.fcm);
/** The failure's own line, or null. A push body is a sentence, so its
    whitespace is collapsed on the way into one. */
const errorLine = (error?: unknown): string | null => {
  const message =
    error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
      ? ((error as { message: string }).message)
      : null;
  const flat = message?.replace(/\s+/g, " ").trim();
  return flat ? flat : null;
};
/** A notification body, from its parts: the thread is the "where", the message
    the user sent is the "what", and a failure's own line follows them. A long
    part is cut for the lock screen rather than left to be truncated there. */
const notifyBody = (...parts: (string | null | undefined)[]): string => {
  const one = (part: string) => {
    const flat = part.replace(/\s+/g, " ").trim();
    return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat;
  };
  return parts.filter((part): part is string => Boolean(part)).map(one).join(" — ");
};
let workflows: WorkflowEngine | null = null;
let routines: RoutineEngine | null = null;
let routineGitTriggers: RoutineGitTriggers | null = null;
const sessions = new SessionManager(
  {
    onPermissionRequest: async (s) => {
      await addNotification("permission", s);
      push.send("Permission needed", s.title, { sessionId: s.id, event: "permissionNeeded" }).catch(console.error);
    },
    onElicitationRequest: async (s) => {
      await addNotification("question", s);
      push.send("The agent has a question", s.title, { sessionId: s.id, event: "questionAsked" }).catch(console.error);
    },
    onTurnEnd: async (s, error, promptText) => {
      /* Not while the agent still has a workflow going. A native one answers its
         prompt at "launched" and works on, so a "Turn finished" here is the
         launch being announced as the end of the work — on the one surface
         (a lock screen) with nothing beside it to correct it. The run's own end
         opens a turn of its own, and that one notifies honestly. */
      if (!error && s.bridge?.background) return;
      /* The thread is the row's title; the body is what the turn was about —
         the message the user sent, and the failure's own line when it failed.
         A notice that said only "Turn finished" told the reader nothing they
         could recognise on a lock screen. */
      const asked = promptText?.trim() ? promptText : null;
      const failed = errorLine(error);
      await addNotification(
        error ? "turn_failed" : "turn_finished",
        s,
        notifyBody(asked, failed) || undefined,
      );
      push
        .send(error ? "Turn failed" : "Turn finished", notifyBody(s.title, asked, failed), {
          sessionId: s.id,
          // The client reads this to decide whether the notification is one the
          // agent is BLOCKED on (lib/notification-shape).
          event: error ? "turnFailed" : "turnFinished",
        })
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
/* No turn survives a restart, so a turn row still open at boot is one the
   old process never closed (turn-changes.ts, `closeOrphans`). */
await sessions.turnChanges.closeOrphans();
mark("turn-changes recovery");
/* The workflow engine (workflows/engine.ts). Wired both ways after construction: the
   manager hands every top-level thread the `workflow` MCP server pointed at
   the engine's loopback URL, and the engine drives the manager to run steps.
   Runs the last process left "running" are rebuilt from their journal here but
   NOT resumed (`resume: false`): a step spawns a child thread and a hosted
   agent that outlived the server must be adopted first, so
   `resumeRecovered()` runs after `adoptAgents` below. */
workflows = new WorkflowEngine(sessions, { port: config.port });
sessions.setWorkflowRunner(workflows);
await workflows.recoverAtBoot({ resume: false });
mark("workflow recovery");
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
await routines.recoverAtBoot();
mark("routine recovery");
/* The `git` trigger kind (routine-git-trigger.ts): a project watcher that fires
   a routine when the repository under it moves. Separate from the scheduler
   because it has no clock — it is woken by the filesystem, not by a sweep — and
   it watches only the projects that have an enabled git trigger, so a process
   with none holds no handles. */
/* Agent hosts that outlived the last server (DAEDALUS_SANDBOX=hosted; a no-op
   under direct). Reattached and their threads claimed now, before anything can
   spawn or sweep; the bridges are opened once we listen (below). */
await sessions.ready;
mark("session manager ready");
const adoption = await adoptAgents(sandbox, sessions);
mark(`agents adopted (${adoption.adopted})`);
// Adopted hosts have claimed their threads: the recovered workflow runs may spawn now.
workflows.resumeRecovered();
mark("workflow runs resumed");
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
  /* The database went away under this request: say so as the same 503 the
     gate below answers while it is down, and let the next request re-check. */
  if (isDbConnectionError(err)) {
    markDbDown(err);
    return c.json({ error: DB_UNAVAILABLE }, 503);
  }
  const message = err instanceof Error ? err.message : String(err);
  /* An HttpError named its own status when it was thrown (every domain module's
     refusal class extends it — see http-error.ts); a JSON body that would not
     parse is a SyntaxError and the client's fault. Everything else really is a
     500. */
  const status =
    err instanceof HttpError ? (err.status as ContentfulStatusCode) : err instanceof SyntaxError ? 400 : 500;
  return c.json({ error: message || "internal error" }, status);
});

app.notFound((c) => c.json({ error: `no such endpoint: ${c.req.method} ${c.req.path}` }, 404));

app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/health") return next();
  const token = bearerToken(c.req.header("authorization"), c.req.query("token"));
  if (token !== config.token) return c.json({ error: "unauthorized" }, 401);
  return next();
});

/* While the database is unreachable every /api route answers at once with a
   503 rather than each one waiting out the pool's connect timeout; the check
   is also what notices it is back (db/index.ts `dbAvailable`). */
app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/health" || (await dbAvailable())) return next();
  return c.json({ error: DB_UNAVAILABLE }, 503);
});

/**
 * The two journal reads, compressed.
 *
 * A transcript is opened over HTTP now (`GET /api/sessions/:id/replay`), and
 * that document is the most compressible thing this server sends: the same
 * envelope keys over and over, one per streamed delta — which is the same
 * observation `perMessageDeflate` on the WebSocket below was already made for,
 * on the same bytes, before the read moved off the socket and left its
 * compression behind. Measured on this install's largest thread the body goes
 * from 17.9MB to 788KB, and on a phone that is the whole of the wait.
 *
 * Scoped to these two paths rather than `/api/*`: everything else here is a
 * small JSON object where a compression pass is a cost with nothing to show
 * for it, and the streaming routes (the terminal, the watch streams) must not
 * have a codec sitting between a line and the reader.
 */
app.use("/api/sessions/:id/replay", compress());
app.use("/api/sessions/:id/earlier", compress());

/* The routes, by domain (src/routes/). Registered after the middleware so
   everything under /api is behind the token; /api/health exempts itself above,
   and /gw/* + /mx/* + /wf/* + /hm/* + /bm/* + /rt/* are outside /api with the key-in-path
   rule — as is /oauth/mcp/callback, which is unauthenticated by necessity
   (an authorization server redirects a browser there and no bearer survives
   that hop; its `state` is the credential instead, see routes/library.ts)
   instead — /rt (the routine fire door) additionally accepts a trigger's own
   stored token in that position, because a derived loopback key is not a credential an
   alerting tool outside this process should hold (rotating it means rotating
   every key, and it is not scoped to one trigger). The
   backup route additionally refuses `?token=` — see routes/misc.ts. */
miscRoutes(app, { config, sessions, push });
fimRoutes(app);
sideModelRoutes(app);
profileRoutes(app, { sessions });
  spaceRoutes(app);
  workspaceRoutes(app);
attachmentRoutes(app);
fileRoutes(app);
libraryRoutes(app, { sessions });
sessionRoutes(app, { sessions });
prewarmRoutes(app, { sessions });
voiceRoutes(app, { sessions });
taskRoutes(app, { sessions, tasks });
mentionRoutes(app, { sessions });
workflowRoutes(app, { engine: workflows, sessions });
harnessRoutes(app, { runner: workflows });
sqlRoutes(app);
routineRoutes(app, { engine: routines });
browserRoutes(app, {
  runner: workflows,
  announce: (sessionId, projectId, tabId) => sessions.browserActivity(sessionId, projectId, tabId),
});

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`daedalus server on http://${info.address}:${info.port}`);
  console.log(`token: ${config.token}`);
  mark("listening");
  void adoption.bind().then(() => mark("threads bound"));
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
  if (url.pathname !== "/ws" && url.pathname !== "/terminal" && url.pathname !== BROWSER_SOCKET_PATH) {
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
    if (url.pathname === BROWSER_SOCKET_PATH) {
      const projectId = url.searchParams.get("projectId") ?? "";
      const sessionId = url.searchParams.get("sessionId") || null;
      void getProject(projectId).then(
        (project) => {
          if (!project) {
            ws.close(BROWSER_CLOSE.notFound, "no such project");
            return;
          }
          return attachBrowserViewer(projectId, sessionId, ws);
        },
        (error: unknown) => {
          console.error(`[browser] attach failed for project ${projectId}:`, error);
          if (ws.readyState === WebSocket.OPEN) ws.close(1011, "Browser attach failed; see server logs");
        },
      );
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
    void sessions.attach(sessionId, ws, cursor, batch, { window }).then(
      (refused) => {
        if (refused) ws.close(4004, refused);
      },
      (error: unknown) => {
        console.error(`[ws] attach failed for thread ${sessionId}:`, error);
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1011, "Thread attach failed; see server logs");
        }
      },
    );
  });
});

/**
 * One exit path for signals and fatal errors. The order matters: the watchers,
 * terminals and scheduler stop first, then the SessionManager retires
 * every live agent child (or, over a durable sandbox, detaches them and keeps
 * their adopt state for the next server) and flushes the journal rows still buffered for the
 * next tick — a bare `process.exit()` orphaned the children and dropped that
 * tick. The bounded drain afterwards is what lets the SIGTERM→SIGKILL
 * escalation timers in terminals actually fire before the process goes.
 */
const SHUTDOWN_DRAIN_MS = 2_000;
const DURABLE_SETTLE_MS = 150;
let shuttingDown = false;
async function shutdown(code: number): Promise<never> {
  if (shuttingDown) return new Promise<never>(() => {}); // first caller owns the exit
  shuttingDown = true;
  const shutdownStart = performance.now();
  const lap = (label: string) => console.log(`[shutdown] +${Math.round(performance.now() - shutdownStart)}ms ${label}`);
  lap("signal received");
  try {
    /* Before `stopWatching`, so the closers it fires cannot race a resubscribe:
       `stop()` is what tells the git triggers to stay down. */
    routineGitTriggers?.stop();
    stopWatching();
    killProjectTerminals();
    // Started here, awaited after the sessions: Chrome's graceful close is
    // what writes tabs.json, and it runs beside the agents' retirement.
    const browsersClosed = killProjectBrowsers();
    stopScheduler();
    clearInterval(heartbeat);
    workflows?.shutdown();
    routines?.shutdown();
    await sessions.shutdown();
    lap("sessions shut down");
    await browsersClosed;
    lap("browsers closed");
  } catch (error) {
    console.error("[shutdown]", error);
  }
  /* The fixed wait is for direct children: `AcpConnection.kill` escalates SIGTERM
     to SIGKILL on a timer that has to fire before the process goes. Over a durable
     sandbox nothing is waiting on one — the agents are not ours to kill, the hosts
     keep them — and every second here is a second every client spends reconnecting
     to a server that is not there. The short beat lets the pty kills and the
     sockets' close frames leave the process. */
  await new Promise((resolve) => setTimeout(resolve, durable ? DURABLE_SETTLE_MS : SHUTDOWN_DRAIN_MS));
  lap("exiting");
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
