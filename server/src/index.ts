import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config.js";
import { listAgents } from "./registry.js";
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
import { discoverMcpServers, discoverSkills } from "./discover.js";
import {
  McpServerInputSchema,
  SkillInputSchema,
  mcpServers,
  skills,
} from "./library.js";
import { SessionManager } from "./sessions.js";
import { Push } from "./push.js";

const config = loadConfig();
const push = new Push(config.fcm);
const sessions = new SessionManager(
  {
    onPermissionRequest: (s) =>
      push.send("Permission needed", s.title, { sessionId: s.id }).catch(console.error),
    onTurnEnd: (s) => push.send("Turn finished", s.title, { sessionId: s.id }).catch(console.error),
  },
  config.sessionIdleMinutes,
);

const app = new Hono();
app.use("*", cors());

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

app.get("/api/profiles", (c) => c.json(listProfiles().map(redact)));
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

// Library: MCP servers and skills, shared across projects.
for (const [base, reg, schema] of [
  ["mcp-servers", mcpServers, McpServerInputSchema],
  ["skills", skills, SkillInputSchema],
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
  return c.json({
    mcpServers: discoverMcpServers().filter((s) => !haveMcp.has(s.name)),
    skills: discoverSkills().filter((s) => !havePaths.has(s.path)),
  });
});

app.get("/api/sessions", (c) => c.json(sessions.list()));
app.post("/api/sessions", async (c) => {
  const { profileId, projectId, model, effort } = await c.req.json();
  const profile = getProfile(profileId);
  if (!profile) return c.json({ error: "unknown profile" }, 404);
  const project = getProject(projectId);
  if (!project) return c.json({ error: "unknown project" }, 404);
  const session = sessions.create(profile, project, model, effort);
  return c.json({ id: session.id }, 201);
});
app.post("/api/sessions/:id/respawn", async (c) => {
  const session = sessions.get(c.req.param("id"));
  if (!session) return c.json({ error: "not found" }, 404);
  const { profileId, model, effort } = await c.req.json();
  const profile = getProfile(profileId ?? session.profileId);
  if (!profile) return c.json({ error: "unknown profile" }, 404);
  const project = getProject(session.projectId);
  if (!project) return c.json({ error: "unknown project" }, 404);
  sessions.respawn(session.id, profile, project, model, effort);
  return c.json({ ok: true, acpSessionId: session.acpSessionId });
});
app.get("/api/sessions/:id/journal", (c) => {
  const session = sessions.get(c.req.param("id"));
  if (!session) return c.json({ error: "not found" }, 404);
  // promptActive rides along with the cursor: read in the same tick as the
  // journal it describes, so the client can't pair a stale turn state with a
  // fresh replay window (or vice versa).
  return c.json({
    cursor: session.journal.length,
    promptActive: session.promptActive,
    entries: session.journal,
  });
});
app.delete("/api/sessions/:id", (c) =>
  sessions.kill(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404),
);

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
  if (url.pathname !== "/ws" || url.searchParams.get("token") !== config.token) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const cursor = Number(url.searchParams.get("cursor") ?? 0) || 0;
    if (!sessions.attach(sessionId, ws, cursor)) ws.close(4004, "unknown session");
  });
});
