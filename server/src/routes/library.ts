import type { Hono } from "hono";
import { z } from "zod";
import {
  CommandInputSchema,
  McpServerInputSchema,
  SkillInputSchema,
  commands,
  mcpServers,
  skills,
  isBuiltinMcp,
  CHROME_DEVTOOLS_MCP_ID,
} from "../library.js";
import { ModelPromptInputSchema, modelPrompts, modelPromptsFilePath, writeModelPromptsLibrary } from "../model-prompts.js";
import { PersonaInputSchema, personas } from "../personas.js";
import { discoverCommands, discoverMcpServers, discoverSkills } from "../discover.js";
import {
  authStateOf,
  authStates,
  clientInfoOf,
  completeAuthorization,
  disconnectServer,
  mcpOauth,
  newFlowState,
  parkPendingFlow,
  probeMcpAuth,
  registerMcpClient,
  takePendingFlow,
} from "../mcp-oauth.js";
import { startAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import { getConfig } from "../config.js";
import {
  checkMcpServer,
  completeMcp,
  invokeMcp,
  mcpCatalogFor,
  type McpCompletion,
  type McpInvocation,
} from "../mcp-check.js";
import type * as acp from "../acp.js";
import { searchRegistry } from "../mcp-registry.js";
import { mcpServersFor, type SessionManager } from "../sessions.js";
import { getProject, listProjects, type Project } from "../projects.js";

/** The library: MCP servers, skills, slash commands, personas and model
    prompts, shared across projects — plus the import scan over the agents' own
    configs.

    Personas are here rather than beside profiles because they are the same kind
    of thing as the other three: a reusable row a thread points at, with no
    credentials in it and nothing per-project about it. The only asymmetry is
    that a thread names exactly one, where it links any number of the rest. Model
    prompts are here for the same "reusable row, no credentials" reason; nothing
    points at one — a row applies by matching the model id. */
export function libraryRoutes(app: Hono, deps: { sessions: SessionManager }): void {
  for (const [base, reg, schema] of [
    ["mcp-servers", mcpServers, McpServerInputSchema],
    ["skills", skills, SkillInputSchema],
    ["commands", commands, CommandInputSchema],
    ["personas", personas, PersonaInputSchema],
    ["model-prompts", modelPrompts, ModelPromptInputSchema],
  ] as const) {
    /* The MCP list is the one that says more than the row holds: each `http`
       row carries its OAuth state, computed from the join. Tokens never leave
       the server, exactly as `profiles.apiKey` never does — what goes out is
       whether it is connected, until when, and why the last attempt failed. */
    app.get(`/api/${base}`, async (c) => {
      if (base !== "mcp-servers") return c.json(await reg.list());
      const states = await authStates();
      return c.json(
        (await mcpServers.list()).map((s) => ({ ...s, authState: states.get(s.id) ?? { kind: "none" as const } })),
      );
    });
    app.post(`/api/${base}`, async (c) => {
      const parsed = schema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
      return c.json(await reg.create(parsed.data as never), 201);
    });
    app.put(`/api/${base}/:id`, async (c) => {
      const parsed = schema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
      const updated = await reg.update(c.req.param("id"), parsed.data as never);
      return updated ? c.json(updated) : c.json({ error: "not found" }, 404);
    });
    app.delete(`/api/${base}/:id`, async (c) =>
      (await reg.remove(c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404),
    );
  }

  /** Put one of the harness's own MCP servers in the library. Idempotent — the
      row has a fixed id — so the button is safe to press again. */
  /**
   * Check one stored row: connect as the agent would and report what it
   * advertises — tools, prompts and resources.
   *
   * The def is resolved through `mcpServersFor`, the one function a spawn uses,
   * so a builtin is checked as the synthesized server it becomes and an OAuth
   * row as the shim URL the child is actually handed. A row that resolves to
   * nothing is the two cases worth naming rather than reporting as a failure:
   * an OAuth server nobody has connected, and a builtin whose backend is not
   * configured.
   */
  /**
   * The server as a thread's agent would be handed it — the one resolution
   * both the listing and the playground stand on.
   *
   * A builtin's env carries the *calling thread's* project, and there is no
   * thread behind a settings screen, so one is named or the first stands in.
   * For a listing which project it is changes what the tools answer and never
   * what they are; for a call it changes the answer itself, which is why the
   * detail page lets a builtin's project be picked.
   */
  async function resolveMcpDef(id: string, projectId?: string) {
    const row = (await mcpServers.list()).find((s) => s.id === id);
    if (!row) return { error: "not found", status: 404 as const };
    const projects = await listProjects();
    const project = (projectId && projects.find((p) => p.id === projectId)) || projects[0];
    if (!project) return { error: "add a project first", status: 400 as const };
    const { servers } = await mcpServersFor({ mcpServerIds: [id] }, project, getConfig(), null);
    const def = servers[0];
    if (def) return { def, project };
    /* The two cases worth naming rather than reporting as a failure: an OAuth
       server nobody has connected, and a builtin whose backend is unconfigured. */
    return {
      unavailable:
        row.type === "builtin"
          ? `The ${row.builtin} server is not configured, so no thread is given it.`
          : "Not connected — authorize this server first.",
    };
  }

  /* Both doors are the same read; they differ only in whether a remembered
     listing is allowed to answer. GET is what the list draws itself from, so
     every row says what it offers without anybody pressing anything; POST is
     the Check button, which means "connect now". */
  app.on(["GET", "POST"], ["/api/mcp-servers/:id/catalog", "/api/mcp-servers/:id/check"], async (c) => {
    const id = c.req.param("id");
    const resolved = await resolveMcpDef(id, c.req.query("project"));
    if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
    if ("unavailable" in resolved) {
      return c.json({ ok: false, ms: 0, tools: [], prompts: [], resources: [], error: resolved.unavailable });
    }
    if (c.req.method === "GET" && id === CHROME_DEVTOOLS_MCP_ID) {
      return c.json({
        ok: false,
        deferred: true,
        ms: 0,
        tools: [],
        prompts: [],
        resources: [],
        error: "Chrome access is requested only when you press Check or start a linked thread.",
      });
    }
    return c.json(await mcpCatalogFor(id, resolved.def, c.req.method === "POST"));
  });

  /**
   * The playground: run one of the things this server offers — a tool, a
   * prompt or a resource — and hand back what it answered, verbatim.
   *
   * One route for all three, because the kind picks an SDK method and nothing
   * else (`invokeMcp`). A connection of its own per call rather than a pooled
   * one, the same bargain the check makes. A tool call is a *write* as often as
   * a read, so this is deliberately behind an explicit press on a page somebody
   * navigated to, and nothing here is cached: the point is the live answer.
   */
  app.post("/api/mcp-servers/:id/invoke", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const call = invocationOf(body);
    if (typeof call === "string") return c.json({ error: call }, 400);
    const resolved = await resolveMcpDef(c.req.param("id"), body.project as string | undefined);
    if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
    if ("unavailable" in resolved) return c.json({ error: resolved.unavailable }, 400);
    return c.json(await invokeMcp(c.req.param("id"), resolved.def, call));
  });

  /** Suggestions for a prompt argument or a template variable, as the server
      ranks them — the playground's inputs ask as they are typed. */
  app.post("/api/mcp-servers/:id/complete", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<McpCompletion> & { project?: string };
    const bad = completionError(body);
    if (bad) return c.json({ error: bad }, 400);
    const resolved = await resolveMcpDef(c.req.param("id"), body.project);
    if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
    if ("unavailable" in resolved) return c.json({ values: [] });
    return c.json({ values: await completeMcp(c.req.param("id"), resolved.def, body as McpCompletion) });
  });

  /* ── The playground for a server that is not a row ──

     The same three reads, handed a definition instead of an id: a server
     being tried before it is saved, or one that never will be. Nothing is
     stored — no catalog row, no library row — and the pool is keyed on the
     definition itself, so every call with the same one shares a connection
     and an edited one connects afresh (`playgroundDef`).

     Stdio, streamable HTTP and legacy SSE — every transport the client speaks,
     including the one the library cannot store yet. Not OAuth and not a
     builtin: the first needs a row for its token to belong to, the second is
     synthesized from a row. Behind the bearer token like everything else, and
     no wider than what it already grants: a stdio row is a command too. */
  app.post("/api/mcp-playground/:op", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const parsed = PlaygroundServerSchema.safeParse(body.server);
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const def = playgroundDef(parsed.data);
    const poolId = `playground:${JSON.stringify(def)}`;
    switch (c.req.param("op")) {
      case "check":
        return c.json({ ...(await checkMcpServer(def)), checkedAt: Date.now() });
      case "invoke": {
        const call = invocationOf(body);
        if (typeof call === "string") return c.json({ error: call }, 400);
        return c.json(await invokeMcp(poolId, def, call));
      }
      case "complete": {
        const bad = completionError(body as Partial<McpCompletion>);
        if (bad) return c.json({ error: bad }, 400);
        return c.json({ values: await completeMcp(poolId, def, body as unknown as McpCompletion) });
      }
      default:
        return c.json({ error: "op must be check, invoke or complete" }, 404);
    }
  });

  /* ── A thread's MCP servers, for the composer ──

     The harness's own client reads what a thread's servers offer, so every
     runtime gets MCP prompts as `/` commands and resources as `@` attachments —
     not only the runtimes whose own MCP client surfaces them. Scoped to the
     thread and resolved through `mcpServersFor`, the function its spawn uses,
     so the composer offers exactly the servers the agent was handed (a
     workflow server is not among them: it has no prompts or resources). */
  async function threadServers(sessionId: string) {
    const session = deps.sessions.get(sessionId);
    if (!session) return null;
    const project: Project | undefined = session.project ?? (await getProject(session.projectId));
    if (!project) return null;
    const ids = deps.sessions.effectiveLinks(session).mcpServerIds;
    const resolved = await Promise.all(
      ids.map(async (id) => {
        const { servers } = await mcpServersFor({ mcpServerIds: [id] }, project, getConfig(), null);
        return servers[0] ? { id, def: servers[0] } : null;
      }),
    );
    return resolved.filter((r) => r !== null);
  }

  app.get("/api/sessions/:id/mcp", async (c) => {
    const servers = await threadServers(c.req.param("id"));
    if (!servers) return c.json({ error: "no such thread" }, 404);
    /* The stored listing where it is fresh — this is read when a composer
       opens, and a connect per server per open would be the cost of typing. */
    const listed = await Promise.all(
      servers.map(async ({ id, def }) => {
        const catalog = await mcpCatalogFor(id, def);
        return {
          id,
          name: def.name,
          ok: catalog.ok,
          prompts: catalog.prompts,
          resources: catalog.resources,
          resourceTemplates: catalog.resourceTemplates ?? [],
          completions: Boolean(catalog.capabilities?.completions),
        };
      }),
    );
    return c.json(listed);
  });

  /* Rendering a prompt or reading a resource for the composer. Tools are not
     offered here: a tool call is the agent's, behind its permission gate. */
  app.post("/api/sessions/:id/mcp/:serverId/invoke", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { kind?: string; name?: string; args?: unknown };
    if (body.kind !== "prompt" && body.kind !== "resource") {
      return c.json({ error: "kind must be prompt or resource" }, 400);
    }
    if (!body.name) return c.json({ error: "name is required" }, 400);
    const servers = await threadServers(c.req.param("id"));
    if (!servers) return c.json({ error: "no such thread" }, 404);
    const server = servers.find((s) => s.id === c.req.param("serverId"));
    if (!server) return c.json({ error: "that server is not linked to this thread" }, 404);
    const args =
      body.args && typeof body.args === "object" && !Array.isArray(body.args)
        ? (body.args as Record<string, unknown>)
        : {};
    return c.json(await invokeMcp(server.id, server.def, { kind: body.kind, name: body.name, args }));
  });

  app.post("/api/mcp-servers/builtin/:kind", async (c) => {
    const kind = c.req.param("kind");
    if (!isBuiltinMcp(kind)) return c.json({ error: "unknown builtin" }, 404);
    return c.json(await mcpServers.ensureBuiltin(kind), 201);
  });

  app.post("/api/mcp-servers/chrome-devtools", async (c) =>
    c.json(await mcpServers.ensureChromeDevtools(), 201),
  );

  /* The marketplace. A proxy and nothing else — no row is written here, and
     what comes back is already `McpServerInput`-shaped, so installing one is
     the ordinary `POST /api/mcp-servers` every other door uses. Uncached: a
     search is a keystroke's answer, and the registry is the thing that knows
     what it holds. */
  app.get("/api/mcp-registry", async (c) =>
    c.json(await searchRegistry(c.req.query("q") ?? "", c.req.query("cursor") || undefined)),
  );

  // Importable entries from the agents' own configs, minus what the library already has.
  app.get("/api/import", async (c) => {
    const haveMcp = new Set((await mcpServers.list()).map((s) => s.name));
    const havePaths = new Set((await skills.list()).map((s) => s.path));
    const haveCommands = new Set((await commands.list()).map((s) => s.name));
    return c.json({
      mcpServers: (await discoverMcpServers()).filter((s) => !haveMcp.has(s.name)),
      skills: (await discoverSkills()).filter((s) => !havePaths.has(s.path)),
      commands: (await discoverCommands()).filter((s) => !haveCommands.has(s.name)),
    });
  });

  mcpOauthRoutes(app);
}

/* ── OAuth for HTTP MCP servers ──────────────────────────────────────────
 *
 * Three routes and a callback page. The tokens are the server's: the agent is
 * handed the shim's loopback URL and never learns that any of this happened
 * (see mcp-shim.ts), which is what makes refresh transparent mid-turn and
 * revocation immediate.
 */
function mcpOauthRoutes(app: Hono): void {
  /** Does this URL demand OAuth? The form's Check button, and what the form
      runs on save so an `http` row that answers 401 is stored as `oauth` and
      can offer Connect right there. A network call behind a button somebody
      is watching — never on the spawn path. */
  app.post("/api/mcp-servers/probe", async (c) => {
    const parsed = z.object({ url: z.string().url() }).safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    return c.json(await probeMcpAuth(parsed.data.url));
  });

  /**
   * Start the browser half of the flow.
   *
   * Probes when the row has no connection yet, registers the client with DCR
   * when there is none (or when the redirect base has moved — an AS refusing a
   * redirect it never saw is a dead end nobody can diagnose, and registration
   * is free), then mints PKCE + a `state` and hands back the URL for the
   * client to open in a popup.
   */
  app.post("/api/mcp-servers/:id/authorize", async (c) => {
    const id = c.req.param("id");
    const server = (await mcpServers.list()).find((s) => s.id === id);
    if (!server) return c.json({ error: "not found" }, 404);
    if (server.type !== "http") return c.json({ error: "only an HTTP MCP server can use OAuth" }, 400);

    const redirectUri = `${redirectBase(c.req.raw)}/oauth/mcp/callback`;
    let row = await mcpOauth.get(id);

    /* Discovery, when this row has never been connected — or when it was
       connected against a different authorization server, which is what a
       changed URL means. */
    if (!row) {
      const probe = await probeMcpAuth(server.url);
      if (probe.kind === "none") {
        /* It answers unauthenticated after all: record that rather than
           starting a flow nothing is waiting for. */
        mcpServers.update(id, { ...server, auth: "none" });
        return c.json({ error: "this server does not ask for OAuth" }, 400);
      }
      if (probe.kind === "unknown") {
        return c.json({ error: `couldn't work out how this server authenticates: ${probe.detail}` }, 502);
      }
      mcpServers.update(id, { ...server, auth: "oauth" });
      /* Scopes: everything the resource advertises, which is what the
         reference clients do and the least surprising. A per-row scope field
         is a later refinement. */
      const scope = probe.scopesSupported.length ? probe.scopesSupported.join(" ") : null;
      const client = await registerMcpClient(probe.metadata, redirectUri, scope);
      row = await mcpOauth.put({
        mcpServerId: id,
        resource: probe.resource,
        issuer: probe.issuer,
        metadata: probe.metadata,
        clientId: client.client_id,
        clientSecret: client.client_secret ?? null,
        redirectUri,
        scope: client.scope ?? scope,
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        lastError: null,
      });
    } else if (row.redirectUri !== redirectUri) {
      const client = await registerMcpClient(row.metadata, redirectUri, row.scope);
      row = (await mcpOauth.patch(id, {
        clientId: client.client_id,
        clientSecret: client.client_secret ?? null,
        redirectUri,
        scope: client.scope ?? row.scope,
      }))!;
    }

    /* The state is minted first because `startAuthorization` takes it as
       input and hands the PKCE verifier back; the flow is parked once both
       exist, so a parked entry is never half a flow. */
    const state = newFlowState();
    const { authorizationUrl, codeVerifier } = await startAuthorization(row.issuer, {
      metadata: row.metadata,
      clientInformation: clientInfoOf(row),
      redirectUrl: redirectUri,
      state,
      resource: new URL(row.resource),
      ...(row.scope ? { scope: row.scope } : {}),
    });
    parkPendingFlow(state, {
      serverId: id,
      verifier: codeVerifier,
      redirectUri,
      resource: row.resource,
      issuer: row.issuer,
    });
    return c.json({ authorizeUrl: authorizationUrl.toString(), redirectUri });
  });

  /**
   * Where the authorization server sends the browser back.
   *
   * Outside `/api`, and unauthenticated **by necessity**: no bearer survives a
   * redirect. The `state` is therefore the credential — 32 random bytes,
   * single-use, ten-minute TTL, and it *names* the parked flow rather than
   * being reflected into it. Answers a small self-closing page, the same shape
   * `/ide` already serves; no client bundle is involved.
   */
  app.get("/oauth/mcp/callback", async (c) => {
    const url = new URL(c.req.url);
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const asError = url.searchParams.get("error");
    const pending = state ? takePendingFlow(state) : undefined;
    if (!pending) return c.html(callbackPage({ ok: false, message: "This authorization link has expired or was already used. Start again from Settings › MCP servers." }), 400);
    const row = await mcpOauth.get(pending.serverId);
    if (!row) return c.html(callbackPage({ ok: false, message: "That MCP server is no longer connected here." }), 404);
    if (asError) {
      const detail = url.searchParams.get("error_description") || asError;
      await mcpOauth.patch(pending.serverId, { lastError: detail });
      return c.html(callbackPage({ ok: false, message: `The authorization server refused: ${detail}` }), 400);
    }
    if (!code) return c.html(callbackPage({ ok: false, message: "The authorization server sent no code." }), 400);
    try {
      await completeAuthorization(row, code, pending.verifier, pending.redirectUri);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await mcpOauth.patch(pending.serverId, { lastError: detail });
      return c.html(callbackPage({ ok: false, message: `The token exchange failed: ${detail}` }), 502);
    }
    return c.html(callbackPage({ ok: true, message: "Connected. You can close this window." }));
  });

  /** Disconnect: revoke where the AS advertises an endpoint (RFC 7009,
      best-effort) and drop the tokens. The local delete succeeds even when the
      revocation call does not — a dead AS must not make a server permanently
      un-disconnectable. */
  app.delete("/api/mcp-servers/:id/authorize", async (c) => {
    const id = c.req.param("id");
    const server = (await mcpServers.list()).find((s) => s.id === id);
    if (!server) return c.json({ error: "not found" }, 404);
    const result = await disconnectServer(id);
    return c.json({ ok: true, ...result, authState: await authStateOf(id, server.type === "http" ? server.auth : "none") });
  });
}

/**
 * Where an authorization server should send the browser back to.
 *
 * `config.json`'s `mcpOauthRedirectBase` when set — the answer for a named
 * tunnel, a reverse proxy, or an authorization server that only accepts a
 * loopback redirect. Otherwise derived from the request that started the flow,
 * which is sound because the browser is already talking to *this* server:
 * whatever host it reached it on is reachable by definition.
 *
 * `X-Forwarded-Proto`/`X-Forwarded-Host` first, since a proxy knows the public
 * scheme and host where the `Host` header may not, then `Host` itself.
 * **Never `Origin`** — that is the *client bundle's* origin, which in dev is
 * the Vite server on 5173 while the callback route lives here on the API's
 * port, and the redirect has to land on a route this server serves.
 */
export function redirectBase(req: Request): string {
  const configured = getConfig().mcpOauthRedirectBase?.replace(/\/+$/, "");
  if (configured) return configured;
  const headers = req.headers;
  const forwardedHost = headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (forwardedHost) {
    const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
    return `${proto}://${forwardedHost}`;
  }
  const host = headers.get("host");
  if (host) return `${new URL(req.url).protocol}//${host}`;
  return new URL(req.url).origin;
}

/** The page the authorization server's redirect lands on. Self-closing, and it
    posts to its opener first so the settings page can refresh without waiting
    for the poll. No client bundle: this is a leaf the browser reaches once. */
function callbackPage({ ok, message }: { ok: boolean; message: string }): string {
  const escaped = message.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]!);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${ok ? "Connected" : "Couldn't connect"}</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; display: grid; place-items: center;
         min-height: 100vh; background: #0b0b0c; color: #e7e7ea; padding: 2rem; }
  .card { max-width: 34rem; text-align: center; }
  h1 { font-size: 1.1rem; margin: 0 0 .5rem; color: ${ok ? "#7ee2a8" : "#ff8f8f"}; }
  p { margin: 0; opacity: .85; }
</style></head>
<body><div class="card"><h1>${ok ? "Connected" : "Couldn't connect"}</h1><p>${escaped}</p></div>
<script>
  try { window.opener && window.opener.postMessage({ source: "daedalus-mcp-oauth", ok: ${ok} }, "*") } catch (e) {}
  ${ok ? "setTimeout(function () { window.close() }, 1200)" : ""}
</script></body></html>`;
}

const pairList = z.array(z.object({ name: z.string(), value: z.string() })).default([]);

/** A server the playground is handed rather than looks up. */
const PlaygroundServerSchema = z.union([
  z.object({ type: z.enum(["http", "sse"]), url: z.string().url(), headers: pairList }),
  z.object({
    type: z.literal("stdio").default("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: pairList,
  }),
]);

/** As ACP spells it — the shape `mcpServersFor` hands a spawn, so the
    playground connects exactly as a thread's agent would once it is saved. */
function playgroundDef(input: z.infer<typeof PlaygroundServerSchema>): acp.McpServer {
  const name = "playground";
  return input.type === "stdio"
    ? { name, command: input.command, args: input.args, env: input.env }
    : { type: input.type, name, url: input.url, headers: input.headers };
}

/** A playground call from a request body, or what is wrong with it. */
function invocationOf(body: Record<string, unknown>): McpInvocation | string {
  const { kind, name, args } = body;
  if (kind !== "tool" && kind !== "prompt" && kind !== "resource") return "kind must be tool, prompt or resource";
  if (typeof name !== "string" || !name) return "name is required";
  if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
    return "arguments must be a JSON object";
  }
  return { kind, name, args: (args as Record<string, unknown>) ?? {} };
}

function completionError(body: Partial<McpCompletion>): string | null {
  const ref = body.ref as { type?: string; name?: unknown; uri?: unknown } | undefined;
  if (!ref || (ref.type === "ref/prompt" ? typeof ref.name !== "string" : ref.type !== "ref/resource" || typeof ref.uri !== "string")) {
    return "ref must be {type:'ref/prompt',name} or {type:'ref/resource',uri}";
  }
  if (typeof body.argument?.name !== "string" || typeof body.argument.value !== "string") {
    return "argument must be {name, value}";
  }
  return null;
}
