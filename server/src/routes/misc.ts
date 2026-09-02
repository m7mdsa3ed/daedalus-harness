import type { Hono } from "hono";
import { z } from "zod";
import { readWebSearch, saveWebSearch, type loadConfig } from "../config.js";
import { getWebSearchUsage } from "../websearch-usage.js";
import { SEARCH_LIMIT, searchEvents } from "../search.js";
import { KnowledgeInputSchema, addKnowledge, deleteKnowledge, listAllKnowledge, listKnowledge } from "../knowledge.js";
import { BundleSchema, exportBundle, importBundle } from "../backup.js";
import { proxyGatewayRequest } from "../gateway-shim.js";
import { proxyMcpRequest } from "../mcp-shim.js";
import { getProfileQuota, getQuota, quotaCwd } from "../quota.js";
import { profileUsage } from "../usage-api.js";
import { getAgent, listAgents } from "../registry.js";
import { defaultProfileFor, getProfile, listProfiles, profileSupports } from "../profiles.js";
import { getProject } from "../projects.js";
import type { Push } from "../push.js";
import { clearNotifications, listNotifications, markNotificationsRead, unreadNotifications } from "../notifications.js";
import { addComposerHistory, clearComposerHistory, listComposerHistory } from "../composer-history.js";
import type { SessionManager } from "../sessions.js";
import { bearerToken, workspace } from "./helpers.js";

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

/* What the composer posts after a send has reached the server. `text` is the
   prompt as typed; the rest is provenance the history panel prints and is
   optional because not every surface that sends has a thread behind it. */
const ComposerHistorySchema = z.object({
  text: z.string().min(1),
  sessionId: z.string().nullish(),
  threadTitle: z.string().nullish(),
});

/** Everything server-wide with no bigger home: health, the web-search backend
    config, transcript search, the knowledge base, backup, push registration,
    the gateway shim's proxy, and the web-search usage ledger. */
export function miscRoutes(
  app: Hono,
  deps: { config: ReturnType<typeof loadConfig>; sessions: SessionManager; push: Push },
): void {
  const { config, sessions, push } = deps;

  app.get("/api/health", (c) => {
    const token = bearerToken(c.req.header("authorization"), c.req.query("token"));
    // `webSearch` is only whether the search API is configured — never the token.
    return c.json({ ok: true, name: "daedalus", authorized: token === config.token, webSearch: Boolean(readWebSearch()) });
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

  /* Full-text search over every thread's journaled transcript (see search.ts).
     Behind the same bearer middleware as the rest of /api. The query is
     sanitized server-side (ftsQuery) so raw FTS5 operators cannot 500, and the
     snippet brackets matches with private-use codepoints the client styles —
     never markup. */
  app.get("/api/search", (c) => {
    const q = c.req.query("q")?.trim() ?? "";
    if (!q) return c.json({ results: [] });
    const limit = Number.parseInt(c.req.query("limit") ?? "", 10) || SEARCH_LIMIT;
    return c.json({ results: searchEvents(q, limit) });
  });

  /* Knowledge base. The same table the `knowledge` MCP server reads, exposed as a
     REST resource so the user can see and edit it — per project below, and as
     one list across every project for Settings › Knowledge base. Missing
     project surfaces as a 404 via the `workspace()` wrapper. */
  app.get("/api/knowledge", (c) => c.json(listAllKnowledge()));

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

  /* Backup: everything the harness stores, as one JSON document (backup.ts).
     Secrets are OFF unless `secrets=1` opts in, and this route accepts the
     bearer token only in the Authorization header — the general middleware also
     takes `?token=`, but a full-secret export URL is exactly the thing that ends
     up in browser history and proxy logs. `journals=0` leaves the transcripts
     out. Served as an attachment so a plain link downloads it. */
  app.get("/api/backup", (c) => {
    const header = c.req.header("authorization");
    if (!header?.startsWith("Bearer ") || header.slice(7) !== config.token) {
      return c.json({ error: "this route requires the Authorization header (no ?token=)" }, 401);
    }
    const bundle = exportBundle({
      includeSecrets: c.req.query("secrets") === "1",
      includeJournals: c.req.query("journals") !== "0",
    });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    c.header("content-disposition", `attachment; filename="daedalus-backup-${stamp}.json"`);
    return c.json(bundle);
  });

  /* Restore. `mode=merge` (default) upserts by id and keeps what the bundle does
     not name; `mode=replace` empties every table first. Either way the threads
     the bundle names are retired before their rows are rewritten — a row
     changed under a running process is a race — and the manager reloads after,
     which is also what closes the peers reading an archive that just changed. */
  app.post("/api/backup/import", async (c) => {
    const mode = c.req.query("mode") === "replace" ? "replace" : "merge";
    const parsed = BundleSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const bundle = parsed.data;
    sessions.retireAll(mode === "replace" ? undefined : bundle.sessions.map((s) => s.id));
    const summary = importBundle(bundle, mode);
    sessions.reload();
    console.log(`[backup] imported (${mode}):`, summary);
    return c.json(summary);
  });

  /* Claude Code's traffic to a profile's gateway. Same rule as the editor: the
     per-boot key in the path is the credential (the CLI carries its own
     `x-api-key` for the gateway itself), and a key the shim did not mint is a
     404. See gateway-shim.ts for the one repair it makes on the way back. */
  app.all("/gw/*", (c) => proxyGatewayRequest(c.req.raw));

  /* The MCP OAuth shim, mounted the same way and for the same reason: the
     credential is in the path, the route is outside /api, and what it fronts
     is a library row's own URL with a fresh bearer on it (mcp-shim.ts). */
  app.all("/mx/*", (c) => proxyMcpRequest(c.req.raw));

  /* Aggregate usage of the harness's own web-search MCP server: totals by tool
     and status, plus the most recent calls (`?limit=` caps the tail). */
  app.get("/api/websearch/usage", (c) =>
    c.json(getWebSearchUsage(Number(c.req.query("limit")) || 50)),
  );

  /*
   * ---- subscription quota ----
   *
   * What is left of the plan an agent is spending: `/usage` in Claude Code,
   * `/status` in Codex, normalized by quota.ts. Cached there with a short TTL,
   * so these routes are cheap to call and `?refresh=1` is the way past it.
   *
   * Two routes because there are two questions. The list answers "how is this
   * *machine* doing", which is every probe-capable agent on its virtual Default
   * profile — the profile that carries no credentials, so the agent runs on its
   * own `claude`/`codex login`, which is what a subscription is — *plus* every
   * stored profile that names a usage provider of its own, which is the other
   * kind of plan this machine is spending (a gateway's coding plan, read from
   * that provider's account API; see usage-api.ts). Those come first, because
   * they are the ones somebody configured. The single route answers "how is this
   * *thread* doing", where the profile is whatever the thread runs on and the
   * answer may well be "an API key, no plan".
   *
   * The probes run in the server's own cwd unless `?projectId=` names one: an
   * account's usage is the same in every directory, and requiring a project
   * would make the settings page depend on there being one.
   */
  const quotaProject = (id?: string) => (id && getProject(id)) || quotaCwd();

  app.get("/api/quota", async (c) => {
    const project = quotaProject(c.req.query("projectId"));
    const refresh = c.req.query("refresh") === "1";
    const probeable = listAgents().filter((agent) => agent.quotaProbe);
    /* Stored profiles only — `listProfiles()` with no agents synthesizes no
       virtual Defaults, and a Default never names a provider anyway. */
    const providers = listProfiles().filter((profile) => profileUsage(profile));
    const [plans, agents] = await Promise.all([
      Promise.all(providers.map((profile) => getProfileQuota(profile, { refresh }))),
      Promise.all(
        probeable.map((agent) => getQuota(agent, defaultProfileFor(agent.id, agent.name), project, { refresh })),
      ),
    ]);
    return c.json([...plans, ...agents]);
  });

  /* One profile's provider plan, with no agent in the question — the account is
     the profile's, and every agent it serves shares the one reading. Registered
     before the `:agentId` route because `profile` would otherwise be read as an
     agent id. */
  app.get("/api/quota/profile/:profileId", async (c) => {
    const profile = getProfile(c.req.param("profileId"));
    if (!profile) return c.json({ error: "unknown profile" }, 404);
    if (!profileUsage(profile)) return c.json({ error: "profile names no usage provider" }, 400);
    return c.json(await getProfileQuota(profile, { refresh: c.req.query("refresh") === "1" }));
  });

  app.get("/api/quota/:agentId", async (c) => {
    const agent = getAgent(c.req.param("agentId"));
    if (!agent) return c.json({ error: "unknown agent" }, 404);
    /* No profileId means the Default one — the same machine-level reading the
       list route gives, so a caller that only knows the agent has a route. */
    const profileId = c.req.query("profileId");
    const profile = profileId ? getProfile(profileId) : defaultProfileFor(agent.id, agent.name);
    if (!profile) return c.json({ error: "unknown profile" }, 404);
    if (!profileSupports(profile, agent.id)) return c.json({ error: "profile does not serve this agent" }, 400);
    return c.json(
      await getQuota(agent, profile, quotaProject(c.req.query("projectId")), { refresh: c.req.query("refresh") === "1" }),
    );
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

  /* ── the notification inbox (notifications.ts) ──
     The pill in the sidebar reads these. Listed newest first with the unread
     count beside them; read is acknowledged by id, or all at once. */
  app.get("/api/notifications", (c) => {
    const limit = Number.parseInt(c.req.query("limit") ?? "", 10);
    return c.json({
      items: listNotifications(Number.isFinite(limit) && limit > 0 ? limit : undefined),
      unread: unreadNotifications(),
    });
  });

  app.post("/api/notifications/read", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : null;
    markNotificationsRead(ids);
    return c.json({ ok: true, unread: unreadNotifications() });
  });

  /* Clear the whole inbox (a "clear" action in the pill), or only entries older
     than `?before=` (ms). Deleting is lossy where marking read is not, so this
     is the explicit user gesture, never implied by opening the pill. */
  app.delete("/api/notifications", async (c) => {
    const before = Number.parseInt(c.req.query("before") ?? "", 10);
    clearNotifications(Number.isFinite(before) ? before : undefined);
    return c.json({ ok: true });
  });

  /* ── the composer's prompt history (composer-history.ts) ──
     Global across every thread, which is the point: recall used to be the
     transcript of the thread you were standing in. Newest first, the order the
     panel lists and Up walks. */
  app.get("/api/composer-history", (c) => {
    const limit = Number.parseInt(c.req.query("limit") ?? "", 10);
    return c.json({ items: listComposerHistory(Number.isFinite(limit) && limit > 0 ? limit : undefined) });
  });

  /* Written by the composer once a send has actually left. An exact repeat is
     moved to the top rather than added again (see `addComposerHistory`), so
     this is safe to call on every send. A prompt that is only an attachment
     records nothing and answers `{ entry: null }`. */
  app.post("/api/composer-history", async (c) => {
    const parsed = ComposerHistorySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const { text, sessionId, threadTitle } = parsed.data;
    return c.json({ entry: addComposerHistory({ text, sessionId, threadTitle }) });
  });

  /* Forget one line (`?id=`), everything older than `?before=` (ms), or the
     whole history. Like the inbox's delete, this is only ever an explicit
     gesture — history is lossy to remove and nothing implies it. */
  app.delete("/api/composer-history", (c) => {
    const id = c.req.query("id");
    const before = Number.parseInt(c.req.query("before") ?? "", 10);
    const removed = clearComposerHistory({ id: id || undefined, before: Number.isFinite(before) ? before : undefined });
    return c.json({ ok: true, removed });
  });
}
