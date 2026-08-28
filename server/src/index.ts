import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { stream } from "hono/streaming";
import { cors } from "hono/cors";
import { WebSocketServer } from "ws";
import { loadConfig, readWebSearch, saveWebSearch } from "./config.js";
import { runProvider } from "./websearch.js";
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
import { modelsDevProviders, searchModelsDev } from "./models-dev.js";
import { enrichProviderModels, fetchProviderModels } from "./provider-models.js";
import { SessionManager } from "./sessions.js";
import {
  createScheduled,
  deleteScheduled,
  listScheduled,
  startScheduler,
  stopScheduler,
} from "./scheduler.js";
import { TaskDirError, TaskTailer } from "./tasks.js";
import {
  WorkspaceError,
  createEntry,
  deleteEntry,
  listDir,
  projectRoot,
  readFile as readWorkspaceFile,
  readFileBytes,
  renameEntry,
  statFile,
  writeFile as writeWorkspaceFile,
} from "./workspace-fs.js";
import { stopWatching, watchProject, type WatchBatch } from "./workspace-watch.js";
import * as git from "./git.js";
import { createPreview, deletePreview, listPreviews } from "./previews.js";
import { KnowledgeInputSchema, addKnowledge, deleteKnowledge, listKnowledge } from "./knowledge.js";
import {
  attachTerminal,
  createTerminal,
  killProjectTerminals,
  killTerminal,
  listTerminals,
} from "./terminals.js";
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
  sessions.taskEvent(sessionId, transcriptDir, event),
);
// Fires scheduled prompts for threads (scheduler.ts). Owns its own interval,
// so it runs even when every browser is closed.
startScheduler(sessions);

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
  // `webSearch` is only whether the search API is configured — never the token.
  return c.json({ ok: true, name: "daedalus", authorized: token === config.token, webSearch: Boolean(config.webSearch) });
});

app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/health") return next();
  const token = bearerToken(c.req.header("authorization"), c.req.query("token"));
  if (token !== config.token) return c.json({ error: "unauthorized" }, 401);
  return next();
});

// Server-global web-search backend. This is the default a profile inherits when
// it does not set its own overrides. The token is read-only: a PUT with an
// empty token keeps the stored one (the client never sees it, like apiKey).
const WebSearchConfigSchema = z.object({
  searchApiBaseUrl: z.string().min(1),
  searchApiToken: z.string().optional().default(""),
  searchModel: z.string().min(1),
  fetchModel: z.string().min(1),
});

/** The client-facing shape: all four fields except the token, plus a boolean
    for the "leave empty to keep it" hint. The token key is never set so it
    cannot leak even in a serialized payload. */
const webSearchResponse = (ws: { searchApiBaseUrl: string; searchModel: string; fetchModel: string; searchApiToken?: string }) => ({
  searchApiBaseUrl: ws.searchApiBaseUrl,
  searchModel: ws.searchModel,
  fetchModel: ws.fetchModel,
  hasToken: Boolean(ws.searchApiToken),
});

app.get("/api/config/web-search", (c) => {
  const webSearch = readWebSearch();
  if (!webSearch) return c.json({ configured: false });
  return c.json({ configured: true, ...webSearchResponse(webSearch) });
});

app.put("/api/config/web-search", async (c) => {
  const parsed = WebSearchConfigSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  const existing = readWebSearch();
  // Empty token in an update means "keep the stored one" (never shown back).
  const input = {
    ...parsed.data,
    searchApiToken: parsed.data.searchApiToken || (existing?.searchApiToken ?? ""),
  };
  const saved = saveWebSearch(input);
  return c.json({ configured: true, ...webSearchResponse(saved) });
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

/**
 * The model list behind the profile's credentials — `GET {baseUrl}/models` —
 * mapped onto models.dev for the metadata (name, context, pricing, efforts,
 * modalities). The body may carry `baseUrl`/`apiKey` straight from the form:
 * an unsaved profile fetches with what the user typed, and a saved one falls
 * back to its stored key when the body leaves the key empty (the client never
 * has it). No profile id is required when the body carries both.
 */
app.post("/api/profiles/:id/fetch-models", async (c) => {
  const body = await c.req.json().catch(() => ({}) as { baseUrl?: string; apiKey?: string });
  let baseUrl = body.baseUrl?.trim() ?? "";
  let apiKey = body.apiKey ?? "";
  if (!baseUrl || !apiKey) {
    const profile = getProfile(c.req.param("id"));
    if (profile) {
      baseUrl = baseUrl || profile.baseUrl;
      apiKey = apiKey || profile.apiKey;
    } else if (!baseUrl) {
      return c.json({ error: "unknown profile" }, 404);
    }
  }
  if (!baseUrl) return c.json({ error: "no base URL to fetch models from" }, 400);
  try {
    const models = await fetchProviderModels(baseUrl, apiKey);
    return c.json({ models: await enrichProviderModels(models) });
  } catch (err) {
    // The provider's answer (or absence of one) is the message worth showing.
    return c.json({ error: err instanceof Error ? err.message : "the provider fetch failed" }, 502);
  }
});

/**
 * models.dev, proxied. The full catalog is ~4.4 MB, so the client searches
 * server-side and gets trimmed entries; an unreachable upstream is a 502 the
 * UI renders as "enrichment unavailable", not an editor-breaking error.
 */
app.get("/api/models-dev/providers", async (c) => {
  try {
    return c.json({ providers: await modelsDevProviders() });
  } catch {
    return c.json({ error: "couldn't reach models.dev" }, 502);
  }
});

app.get("/api/models-dev/search", async (c) => {
  try {
    const provider = c.req.query("provider") || undefined;
    const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
    return c.json({ models: await searchModelsDev(c.req.query("q") ?? "", { provider, limit }) });
  } catch {
    return c.json({ error: "couldn't reach models.dev" }, 502);
  }
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
app.delete("/api/projects/:id", (c) => {
  const id = c.req.param("id");
  if (!deleteProject(id)) return c.json({ error: "not found" }, 404);
  // The directory may still exist, but nothing is allowed to look at it through
  // this project any more — and a watcher nobody can unsubscribe from is a
  // handle held until the process exits.
  stopWatching(id);
  killProjectTerminals(id);
  return c.json({ ok: true });
});

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

/* ── Workspace filesystem ──
   Project-scoped, unlike `/api/fs/list` above: every path here is relative and
   resolved against the project's own cwd, and a WorkspaceError carries the
   status its refusal deserves — 403 for an escape, 409 for a stale write —
   which app.onError would otherwise flatten into a 500. */
const workspace = async <T>(c: Context, run: () => T | Promise<T>) => {
  try {
    return c.json((await run()) as object);
  } catch (err) {
    if (err instanceof WorkspaceError) return c.json({ error: err.message }, err.status);
    throw err;
  }
};

const flag = (c: Context, name: string) => c.req.query(name) === "1";

app.get("/api/projects/:projectId/tree", (c) =>
  workspace(c, () =>
    listDir(c.req.param("projectId"), c.req.query("path"), {
      hidden: flag(c, "hidden"),
      ignored: flag(c, "ignored"),
    }),
  ),
);

app.get("/api/projects/:projectId/file", (c) =>
  workspace(c, () => readWorkspaceFile(c.req.param("projectId"), c.req.query("path") ?? "")),
);

/* Raw bytes, for the editor's image preview. Not folded into `/file`: that
   route answers JSON, and a route whose response type depends on a query flag
   is one the client has to guess about. `svg` is served as `image/svg+xml`
   because an <img> renders it inertly — it is never handed to a document. */
app.get("/api/projects/:projectId/file-raw", async (c) => {
  try {
    const { bytes, contentType } = await readFileBytes(
      c.req.param("projectId"),
      c.req.query("path") ?? "",
    );
    return c.body(bytes as unknown as ArrayBuffer, 200, {
      "Content-Type": contentType,
      "Content-Disposition": "inline",
      "Cache-Control": "no-store",
      // Belt and braces next to the type allowlist above.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "X-Content-Type-Options": "nosniff",
    });
  } catch (err) {
    if (err instanceof WorkspaceError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

app.get("/api/projects/:projectId/file-stat", (c) =>
  workspace(c, () => statFile(c.req.param("projectId"), c.req.query("path") ?? "")),
);

app.put("/api/projects/:projectId/file", async (c) => {
  const body = (await c.req.json()) as {
    content?: unknown;
    expectedVersion?: unknown;
    force?: unknown;
  };
  if (typeof body.content !== "string") return c.json({ error: "content must be a string" }, 400);
  return workspace(c, () =>
    writeWorkspaceFile(c.req.param("projectId"), c.req.query("path") ?? "", body.content as string, {
      expectedVersion: typeof body.expectedVersion === "string" ? body.expectedVersion : undefined,
      force: body.force === true,
    }),
  );
});

app.post("/api/projects/:projectId/files", async (c) => {
  const body = (await c.req.json()) as { path?: unknown; type?: unknown };
  if (typeof body.path !== "string") return c.json({ error: "path is required" }, 400);
  const type = body.type === "dir" ? "dir" : "file";
  return workspace(c, () => createEntry(c.req.param("projectId"), body.path as string, type));
});

app.patch("/api/projects/:projectId/files", async (c) => {
  const body = (await c.req.json()) as { from?: unknown; to?: unknown };
  if (typeof body.from !== "string" || typeof body.to !== "string")
    return c.json({ error: "from and to are required" }, 400);
  return workspace(c, () =>
    renameEntry(c.req.param("projectId"), body.from as string, body.to as string),
  );
});

app.delete("/api/projects/:projectId/files", async (c) => {
  const body = (await c.req.json()) as { path?: unknown };
  if (typeof body.path !== "string") return c.json({ error: "path is required" }, 400);
  return workspace(c, () => deleteEntry(c.req.param("projectId"), body.path as string));
});

/* Saved preview URLs. A project's dev-server address belongs to the project,
   not to a browser tab — you want the same one back on the phone that you saved
   on the laptop, which is why this is SQLite and not localStorage. */
app.get("/api/projects/:projectId/previews", (c) =>
  workspace(c, () => listPreviews(c.req.param("projectId"))),
);

app.post("/api/projects/:projectId/previews", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { label?: unknown; url?: unknown };
  return workspace(c, () => createPreview(c.req.param("projectId"), body.label, body.url));
});

app.delete("/api/projects/:projectId/previews/:previewId", (c) =>
  deletePreview(c.req.param("previewId"))
    ? c.json({ ok: true })
    : c.json({ error: "no such preview" }, 404),
);

/* Knowledge base. The same table the `knowledge` MCP server reads, exposed as a
   REST resource so the user can see and edit it in Settings › Projects. Missing
   project surfaces as a 404 via the `workspace()` wrapper. */
app.get("/api/projects/:projectId/knowledge", (c) =>
  workspace(c, () => listKnowledge(c.req.param("projectId"))),
);

app.post("/api/projects/:projectId/knowledge", async (c) => {
  const parsed = KnowledgeInputSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  return workspace(c, () => addKnowledge(c.req.param("projectId"), parsed.data));
});

app.delete("/api/projects/:projectId/knowledge/:entryId", (c) =>
  deleteKnowledge(c.req.param("projectId"), c.req.param("entryId"))
    ? c.json({ ok: true })
    : c.json({ error: "no such knowledge entry" }, 404),
);

/* Source control. Every write names its paths explicitly — there is no
   "everything" shortcut on discard, because the one destructive operation here
   should not have a form where an empty list means the whole tree. */
app.get("/api/projects/:projectId/git/status", (c) =>
  workspace(c, () => git.status(c.req.param("projectId"))),
);

app.get("/api/projects/:projectId/git/branches", (c) =>
  workspace(c, () => git.branches(c.req.param("projectId"))),
);

app.get("/api/projects/:projectId/git/file", (c) => {
  const comparison = c.req.query("comparison");
  const side: git.Comparison =
    comparison === "staged" ? "staged" : comparison === "worktree" ? "worktree" : "head";
  return workspace(c, () => git.fileAt(c.req.param("projectId"), c.req.query("path") ?? "", side));
});

app.post("/api/projects/:projectId/git/:action", async (c) => {
  const projectId = c.req.param("projectId");
  const action = c.req.param("action");
  const body = (await c.req.json().catch(() => ({}))) as {
    paths?: unknown;
    message?: unknown;
    branch?: unknown;
    create?: unknown;
    amend?: unknown;
  };
  const paths = Array.isArray(body.paths)
    ? body.paths.filter((p): p is string => typeof p === "string")
    : [];

  switch (action) {
    case "stage":
      return workspace(c, async () => {
        await git.stage(projectId, paths);
        return git.status(projectId);
      });
    case "unstage":
      return workspace(c, async () => {
        await git.unstage(projectId, paths);
        return git.status(projectId);
      });
    case "discard":
      return workspace(c, async () => {
        await git.discard(projectId, paths);
        return git.status(projectId);
      });
    case "commit":
      return workspace(c, async () => {
        const result = await git.commit(projectId, String(body.message ?? ""), {
          amend: body.amend === true,
        });
        return { ...result, status: await git.status(projectId) };
      });
    case "checkout":
      return workspace(c, async () => {
        await git.checkout(projectId, String(body.branch ?? ""), { create: body.create === true });
        return git.status(projectId);
      });
    default:
      return c.json({ error: `unknown git action: ${action}` }, 404);
  }
});

/* Terminals. The list and the lifecycle are ordinary JSON routes; the bytes go
   over their own WebSocket (see the upgrade handler at the bottom) because a
   PTY stream has nothing to do with the thread protocol's journal and replay. */
app.get("/api/projects/:projectId/terminals", (c) =>
  workspace(c, () => listTerminals(c.req.param("projectId"))),
);

app.post("/api/projects/:projectId/terminals", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { title, cols, rows } = body as { title?: string; cols?: number; rows?: number };
  return workspace(c, () => createTerminal(c.req.param("projectId"), { title, cols, rows }));
});

app.delete("/api/projects/:projectId/terminals/:terminalId", (c) =>
  killTerminal(c.req.param("terminalId"))
    ? c.json({ ok: true })
    : c.json({ error: "no such terminal" }, 404),
);

/* File events as an NDJSON stream rather than SSE: EventSource cannot set an
   Authorization header, and the alternative is the bearer token in a URL — in
   history, in logs, in whatever proxy is in front. `fetch` reads this fine. */
app.get("/api/projects/:projectId/watch", (c) => {
  const projectId = c.req.param("projectId");
  /* Validate before streaming, not inside it: once `stream()` has taken the
     response there is no status left to send, so an unknown project would have
     been a 200 that immediately ends rather than the 404 it is. */
  try {
    projectRoot(projectId);
  } catch (err) {
    if (err instanceof WorkspaceError) return c.json({ error: err.message }, err.status);
    throw err;
  }

  return stream(c, async (s) => {
    c.header("Content-Type", "application/x-ndjson");
    c.header("Cache-Control", "no-store");
    const queue: WatchBatch[] = [];
    const wake = { fn: null as (() => void) | null };
    const off = watchProject(projectId, (batch) => {
      queue.push(batch);
      wake.fn?.();
    });
    s.onAbort(() => {
      off();
      wake.fn?.();
    });
    try {
      while (!s.closed && !s.aborted) {
        const batch = queue.shift();
        if (batch) {
          await s.write(JSON.stringify(batch) + "\n");
          continue;
        }
        await new Promise<void>((resolve) => {
          wake.fn = () => {
            wake.fn = null;
            resolve();
          };
          /* A blank-line heartbeat, so a connection that died is noticed by
             the write failing rather than by nothing ever happening in a repo
             where nothing is happening. */
          setTimeout(() => wake.fn?.(), 30_000).unref?.();
        });
        if (queue.length === 0) await s.write("\n");
      }
    } finally {
      off();
    }
  });
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
  const { id, profileId, projectId, model, effort, configChoices } = await c.req.json();
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
  const session = sessions.create(profile, project, model, effort, id, configChoices);
  /* Wait for the handshake. A 201 therefore means the agent has answered
     session/new, its settings have been applied, and the first `session_config`
     is already in the log — so the socket the client opens next inherits a
     thread that is genuinely ready rather than one still booting. */
  await session.bridge!.ready;
  return c.json({ id: session.id }, 201);
});
/**
 * Swap the agent process — a new profile, model or effort — and put the
 * conversation back. Also the revive path for a thread whose process is gone.
 *
 * This answers once the thread is usable: the server has spawned, handshaken,
 * replayed the conversation through session/load and restored the settings the
 * restart reset. It used to be three round trips the browser drove, which meant
 * a tab closing halfway through left a half-restored thread.
 */
app.post("/api/sessions/:id/respawn", async (c) => {
  const session = sessions.get(c.req.param("id"));
  if (!session) return c.json({ error: "not found" }, 404);
  // A deleted thread can only come back through restore; answering the respawn
  // attempt as a 4xx keeps a stale client's retry from reading as a server
  // fault in the logs.
  if (session.deletedAt !== null) return c.json({ error: "session deleted" }, 409);
  const { profileId, model, effort } = await c.req.json();
  const profile = getProfile(profileId ?? session.profileId);
  if (!profile || !getAgent(profile.agentId)) {
    return c.json({ error: "unknown profile" }, 404);
  }
  const project = getProject(session.projectId);
  if (!project) return c.json({ error: "unknown project" }, 404);
  await sessions.respawn(session.id, profile, project, model, effort);
  return c.json({ ok: true, acpSessionId: session.acpSessionId });
});
// What the agent process has been printing. The client shows this when a thread
// fails in a way ACP won't explain — the agent's own stack trace is the answer
// and it never travels over the protocol.
app.get("/api/sessions/:id/stderr", (c) => {
  const session = sessions.get(c.req.param("id"));
  if (!session) return c.json({ error: "not found" }, 404);
  return c.json({ lines: sessions.stderrTail(session.id) });
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
app.delete("/api/scheduled/:id", (c) =>
  deleteScheduled(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404),
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

app.get("/api/push/config", (c) => c.json({ enabled: push.enabled, ...push.webConfig() }));
app.post("/api/push/register", async (c) => {
  const { token } = await c.req.json();
  if (typeof token !== "string" || !token) return c.json({ error: "token required" }, 400);
  push.registerToken(token);
  return c.json({ ok: true });
});
// Turning notifications off, or forgetting this server, has to reach the token
// list — a device nobody removed keeps receiving pushes for as long as its
// token lives, which no preference in the client can stop.
app.delete("/api/push/register", async (c) => {
  const { token } = await c.req.json();
  if (typeof token !== "string" || !token) return c.json({ error: "token required" }, 400);
  push.unregisterToken(token);
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
    const refused = sessions.attach(sessionId, ws, cursor);
    if (refused) ws.close(4004, refused);
  });
});

// A rejected promise nowhere near a request handler still kills the process by
// default. Log it and keep serving — every session lives in this one process.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopWatching();
    killProjectTerminals();
    stopScheduler();
    process.exit(0);
  });
}
process.on("unhandledRejection", (reason) => console.error("[unhandled rejection]", reason));
process.on("uncaughtException", (error) => console.error("[uncaught exception]", error));
