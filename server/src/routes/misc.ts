import type { Hono } from "hono";
import { z } from "zod";
import { readWebSearch, saveWebSearch, type loadConfig } from "../config.js";
import { getWebSearchUsage } from "../websearch-usage.js";
import { SEARCH_LIMIT, searchEvents } from "../search.js";
import { KnowledgeInputSchema, addKnowledge, deleteKnowledge, listAllKnowledge, listKnowledge } from "../knowledge.js";
import { BundleSchema, exportBundle, importBundle } from "../backup.js";
import { proxyGatewayRequest } from "../gateway-shim.js";
import type { Push } from "../push.js";
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

  /* Aggregate usage of the harness's own web-search MCP server: totals by tool
     and status, plus the most recent calls (`?limit=` caps the tail). */
  app.get("/api/websearch/usage", (c) =>
    c.json(getWebSearchUsage(Number(c.req.query("limit")) || 50)),
  );

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
}
