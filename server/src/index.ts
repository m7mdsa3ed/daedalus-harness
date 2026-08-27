import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config.js";
import { getAgent, listAgents, seedAgents } from "./registry.js";
import {
  ProfileInputSchema,
  createProfile,
  deleteProfile,
  getProfile,
  listProfiles,
  redact,
  updateProfile,
} from "./profiles.js";
import {
  ProjectInputSchema,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
} from "./projects.js";
import { discoverCommands, discoverMcpServers, discoverSkills } from "./discover.js";
import { listDirectory } from "./fs.js";
import {
  CommandInputSchema,
  McpServerInputSchema,
  SkillInputSchema,
  commands,
  mcpServers,
  skills,
} from "./library.js";
import { probeAgentOptions } from "./probe.js";
import { SessionManager } from "./sessions.js";
import { TaskDirError, TaskTailer } from "./tasks.js";
import { Push } from "./push.js";

const config = loadConfig();
// Adds only the built-in agents this install has never been offered; a user's
// edits and deletions are left alone. See registry.seedAgents.
seedAgents();
const push = new Push(config.fcm);
/** Thread title, with the failure's own message appended when there is one. */
const pushBody = (title: string, error?: unknown): string => {
  const message =
    error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
      ? ((error as { message: string }).message)
      : null;
  return message ? `${title} — ${message}` : title;
};
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
  },
  config.sessionIdleMinutes,
);
// Tails background-task journals (files an agent disclosed in a tool result)
// and fans each new line out to the owning thread's peers — see tasks.ts.
const tasks = new TaskTailer((sessionId, transcriptDir, event) =>
  sessions.notify(sessionId, "_daedalus/task_event", { transcriptDir, event }),
);

const app = new Hono();
app.use("*", cors());

/**
 * Every route below may throw — a bad spawn config, an unknown agent id, a
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

app.get("/api/health", (c) => {
  const token = bearerToken(c.req.header("authorization"), c.req.query("token"));
  return c.json({ ok: true, name: "daedalus", authorized: token === config.token });
});

app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/health") return next();
  const token = bearerToken(c.req.header("authorization"), c.req.query("token"));
  if (token !== config.token) return c.json({ error: "unauthorized" }, 401);
  return next();
});

app.get("/api/agents", (c) => c.json(listAgents()));

// Agents are passed in so an agent with no profile of its own still gets one
// (virtual, never stored) — see defaultProfileFor.
app.get("/api/profiles", (c) => c.json(listProfiles(listAgents()).map(redact)));
app.post("/api/profiles", async (c) => {
  const parsed = ProfileInputSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  return c.json(redact(createProfile(parsed.data)), 201);
});
app.put("/api/profiles/:id", async (c) => {
  const parsed = ProfileInputSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  const updated = updateProfile(c.req.param("id"), parsed.data);
  return updated ? c.json(redact(updated)) : c.json({ error: "not found" }, 404);
});
app.delete("/api/profiles/:id", (c) =>
  deleteProfile(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404),
);

/**
 * What this profile's agent can be configured with, asked by spawning one and
 * throwing it away. The client calls this once per profile, so a thread that
 * has not been sent yet can still offer real settings — see probe.ts for why
 * there is no cheaper way to ask.
 */
app.post("/api/profiles/:id/options", async (c) => {
  const profile = getProfile(c.req.param("id"));
  if (!profile || !getAgent(profile.agentId)) return c.json({ error: "unknown profile" }, 404);
  const { projectId } = await c.req.json();
  // No falling back to "some other project": the cwd is part of the answer, so
  // probing a different one returns a menu that quietly does not apply here.
  const project = getProject(projectId);
  if (!project) return c.json({ error: "unknown project" }, 404);
  const refresh = c.req.query("refresh") === "1";
  return c.json(await probeAgentOptions(profile, project, { refresh }));
});

app.get("/api/projects", (c) => c.json(listProjects()));
app.post("/api/projects", async (c) => {
  const parsed = ProjectInputSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  return c.json(createProject(parsed.data), 201);
});
app.put("/api/projects/:id", async (c) => {
  const parsed = ProjectInputSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  const updated = updateProject(c.req.param("id"), parsed.data);
  return updated ? c.json(updated) : c.json({ error: "not found" }, 404);
});
app.delete("/api/projects/:id", (c) =>
  deleteProject(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404),
);

// Feeds the client's path autocomplete; ?path= (empty lists the home dir).
// Handles its own errors: `not found` vs `not a directory` deserve real codes,
// and app.onError would flatten both to 500.
app.get("/api/fs/list", (c) => {
  try {
    return c.json(listDirectory(c.req.query("path") ?? ""));
  } catch (err) {
    const status = (err as { status?: number }).status;
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, status === 404 ? 404 : status === 400 ? 400 : 500);
  }
});

// Library: MCP servers, skills and slash commands, shared across projects.
for (const [base, reg, schema] of [
  ["mcp-servers", mcpServers, McpServerInputSchema],
  ["skills", skills, SkillInputSchema],
  ["commands", commands, CommandInputSchema],
] as const) {
  app.get(`/api/${base}`, (c) => c.json(reg.list()));
  app.post(`/api/${base}`, async (c) => {
    const parsed = schema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    return c.json(reg.create(parsed.data as never), 201);
  });
  app.put(`/api/${base}/:id`, async (c) => {
    const parsed = schema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const updated = reg.update(c.req.param("id"), parsed.data as never);
    return updated ? c.json(updated) : c.json({ error: "not found" }, 404);
  });
  app.delete(`/api/${base}/:id`, (c) =>
    reg.remove(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404),
  );
}

// Importable entries from the agents' own configs, minus what the library already has.
app.get("/api/import", (c) => {
  const haveMcp = new Set(mcpServers.list().map((s) => s.name));
  const havePaths = new Set(skills.list().map((s) => s.path));
  const haveCommands = new Set(commands.list().map((s) => s.name));
  return c.json({
    mcpServers: discoverMcpServers().filter((s) => !haveMcp.has(s.name)),
    skills: discoverSkills().filter((s) => !havePaths.has(s.path)),
    commands: discoverCommands().filter((s) => !haveCommands.has(s.name)),
  });
});

app.get("/api/sessions", (c) => c.json(sessions.list()));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.post("/api/sessions", async (c) => {
  const { id, profileId, projectId, model, effort } = await c.req.json();
  const profile = getProfile(profileId);
  // A virtual profile is resolved from its id, so an id naming an agent that
  // does not exist would otherwise reach spawn and fail there instead.
  if (!profile || !getAgent(profile.agentId)) {
    return c.json({ error: "unknown profile" }, 404);
  }
  const project = getProject(projectId);
  if (!project) return c.json({ error: "unknown project" }, 404);
  // The client mints the id so it can route to the thread before this call is
  // made. Anything it sends still has to be a UUID and still has to be free —
  // taking a live session's id would hand the caller someone else's agent.
  if (id !== undefined) {
    if (typeof id !== "string" || !UUID_RE.test(id)) {
      return c.json({ error: "id must be a UUID" }, 400);
    }
    if (sessions.get(id)) return c.json({ error: "session already exists" }, 409);
  }
  const session = sessions.create(profile, project, model, effort, id);
  return c.json({ id: session.id }, 201);
});
app.post("/api/sessions/:id/respawn", async (c) => {
  const session = sessions.get(c.req.param("id"));
  if (!session) return c.json({ error: "not found" }, 404);
  const { profileId, model, effort } = await c.req.json();
  const profile = getProfile(profileId ?? session.profileId);
  if (!profile || !getAgent(profile.agentId)) {
    return c.json({ error: "unknown profile" }, 404);
  }
  const project = getProject(session.projectId);
  if (!project) return c.json({ error: "unknown project" }, 404);
  sessions.respawn(session.id, profile, project, model, effort);
  return c.json({ ok: true, acpSessionId: session.acpSessionId });
});
// The model or reasoning effort changed over ACP (session/set_config_option).
// Metadata only: the process keeps running, and this is purely what revive
// rebuilds its env from — without it a retired thread comes back on the model
// the user switched away from.
app.patch("/api/sessions/:id", async (c) => {
  const { model, effort } = await c.req.json();
  const ok = sessions.setSpawnState(c.req.param("id"), {
    model: typeof model === "string" ? model : undefined,
    effort: typeof effort === "string" ? effort : undefined,
  });
  return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});
// What the agent process has been printing. The client shows this when a thread
// fails in a way ACP won't explain — the agent's own stack trace is the answer
// and it never travels over the protocol.
app.get("/api/sessions/:id/stderr", (c) => {
  const session = sessions.get(c.req.param("id"));
  if (!session) return c.json({ error: "not found" }, 404);
  return c.json({ lines: sessions.stderrTail(session.id) });
});
app.get("/api/sessions/:id/journal", (c) => {
  const session = sessions.get(c.req.param("id"));
  if (!session) return c.json({ error: "not found" }, 404);
  // promptActive rides along with the cursor: read in the same tick as the
  // journal it describes, so the client can't pair a stale turn state with a
  // fresh replay window (or vice versa).
  const log = sessions.journal(session.id)!;
  return c.json({ ...log, promptActive: session.promptActive });
});
// Delete is reversible by default: the process dies, the thread stays in the
// list marked deleted. `?purge=1` is the irreversible one.
app.delete("/api/sessions/:id", (c) => {
  const purge = c.req.query("purge") === "1";
  const ok = purge ? sessions.purge(c.req.param("id")) : sessions.softDelete(c.req.param("id"));
  return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});
app.post("/api/sessions/:id/restore", (c) =>
  sessions.restore(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404),
);

/**
 * Follow a background task an agent launched (e.g. a Claude Code workflow):
 * the client passes the transcript dir it read out of the tool-call frame, the
 * server verifies the path names a live thread's ACP session, tails its
 * journal, and answers with everything the file holds so far. New lines then
 * arrive over the thread's WebSocket as `_daedalus/task_event`. Idempotent —
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

app.get("/api/push/config", (c) => c.json({ enabled: push.enabled, ...push.webConfig() }));
app.post("/api/push/register", async (c) => {
  const { token } = await c.req.json();
  if (typeof token !== "string" || !token) return c.json({ error: "token required" }, 400);
  push.registerToken(token);
  return c.json({ ok: true });
});

function bearerToken(header: string | undefined, query: string | undefined): string {
  if (header?.startsWith("Bearer ")) return header.slice(7);
  return query ?? "";
}

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`daedalus server on http://${info.address}:${info.port}`);
  console.log(`token: ${config.token}`);
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/ws") {
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
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const cursor = Number(url.searchParams.get("cursor") ?? 0) || 0;
    // The refusal reason rides the close frame — the client shows it verbatim
    // in the thread rather than guessing from the code.
    const refused = sessions.attach(sessionId, ws, cursor);
    if (refused) ws.close(4004, refused);
  });
});

// A rejected promise nowhere near a request handler still kills the process by
// default. Log it and keep serving — every session lives in this one process.
process.on("unhandledRejection", (reason) => console.error("[unhandled rejection]", reason));
process.on("uncaughtException", (error) => console.error("[uncaught exception]", error));
