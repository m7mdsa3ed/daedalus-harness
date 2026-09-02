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
} from "../library.js";
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

/** The library: MCP servers, skills, slash commands and personas, shared
    across projects — plus the import scan over the agents' own configs.

    Personas are here rather than beside profiles because they are the same kind
    of thing as the other three: a reusable row a thread points at, with no
    credentials in it and nothing per-project about it. The only asymmetry is
    that a thread names exactly one, where it links any number of the rest. */
export function libraryRoutes(app: Hono): void {
  for (const [base, reg, schema] of [
    ["mcp-servers", mcpServers, McpServerInputSchema],
    ["skills", skills, SkillInputSchema],
    ["commands", commands, CommandInputSchema],
    ["personas", personas, PersonaInputSchema],
  ] as const) {
    /* The MCP list is the one that says more than the row holds: each `http`
       row carries its OAuth state, computed from the join. Tokens never leave
       the server, exactly as `profiles.apiKey` never does — what goes out is
       whether it is connected, until when, and why the last attempt failed. */
    app.get(`/api/${base}`, (c) => {
      if (base !== "mcp-servers") return c.json(reg.list());
      const states = authStates();
      return c.json(
        mcpServers.list().map((s) => ({ ...s, authState: states.get(s.id) ?? { kind: "none" as const } })),
      );
    });
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

  /** Put one of the harness's own MCP servers in the library. Idempotent — the
      row has a fixed id — so the button is safe to press again. */
  app.post("/api/mcp-servers/builtin/:kind", (c) => {
    const kind = c.req.param("kind");
    if (!isBuiltinMcp(kind)) return c.json({ error: "unknown builtin" }, 404);
    return c.json(mcpServers.ensureBuiltin(kind), 201);
  });

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
    const server = mcpServers.list().find((s) => s.id === id);
    if (!server) return c.json({ error: "not found" }, 404);
    if (server.type !== "http") return c.json({ error: "only an HTTP MCP server can use OAuth" }, 400);

    const redirectUri = `${redirectBase(c.req.raw)}/oauth/mcp/callback`;
    let row = mcpOauth.get(id);

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
      row = mcpOauth.put({
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
      row = mcpOauth.patch(id, {
        clientId: client.client_id,
        clientSecret: client.client_secret ?? null,
        redirectUri,
        scope: client.scope ?? row.scope,
      })!;
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
    const row = mcpOauth.get(pending.serverId);
    if (!row) return c.html(callbackPage({ ok: false, message: "That MCP server is no longer connected here." }), 404);
    if (asError) {
      const detail = url.searchParams.get("error_description") || asError;
      mcpOauth.patch(pending.serverId, { lastError: detail });
      return c.html(callbackPage({ ok: false, message: `The authorization server refused: ${detail}` }), 400);
    }
    if (!code) return c.html(callbackPage({ ok: false, message: "The authorization server sent no code." }), 400);
    try {
      await completeAuthorization(row, code, pending.verifier, pending.redirectUri);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      mcpOauth.patch(pending.serverId, { lastError: detail });
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
    const server = mcpServers.list().find((s) => s.id === id);
    if (!server) return c.json({ error: "not found" }, 404);
    const result = await disconnectServer(id);
    return c.json({ ok: true, ...result, authState: authStateOf(id, server.type === "http" ? server.auth : "none") });
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
