import type { Hono } from "hono";
import { z } from "zod";
import { readWebSearch, type loadConfig } from "../config.js";
import { getWebSearchUsage } from "../websearch-usage.js";
import { SPEND_GROUPS, spendBy, type SpendGroupBy } from "../model-calls/index.js";
import { SEARCH_LIMIT, searchEvents } from "../search.js";
import { KnowledgeInputSchema, addKnowledge, deleteKnowledge, listAllKnowledge, listKnowledge } from "../knowledge.js";
import { BundleSchema, exportBundle, importBundle } from "../backup.js";
import { proxyGatewayRequest } from "../gateway-shim.js";
import { handleOtlp } from "../model-calls/sources/otlp.js";
import { handlePauseHook } from "../pause-hooks.js";
import { proxyMcpRequest } from "../mcp-shim.js";
import { getProfileQuota, getQuota, quotaCwd } from "../quota.js";
import { profileUsage } from "../usage-api.js";
import { getAgent, listAgents } from "../registry.js";
import { defaultProfileFor, getProfile, listProfiles, profileSupports } from "../profiles.js";
import { getProject } from "../projects.js";
import {
  globalRules, projectRules, createRule, updateRule, deleteRule,
} from "../rules.js";
import {
  ModelRoleInputSchema, ModelRolesInputSchema,
  addModelRole, deleteModelRole, listModelRoles, setModelRoles, updateModelRole,
} from "../model-roles.js";
import { listThemes, createTheme, updateTheme, deleteTheme } from "../themes.js";
import type { Push } from "../push.js";
import { clearNotifications, listNotifications, markNotificationsRead, unreadNotifications } from "../notifications.js";
import { addComposerHistory, clearComposerHistory, listComposerHistory } from "../composer-history.js";
import type { SessionManager } from "../sessions.js";
import { appVersion, changelog } from "../meta.js";
import { dbAvailable, dbStatus } from "../db/index.js";
import { API, FEATURES, MIN_CLIENT_API } from "../compat.js";
import { resolveLinkPreview } from "../link-preview.js";
import { CATEGORIES, PROFILES, mapsConfig, nearby, placePhoto, route, searchPlaces } from "../geo.js";
import { bearerToken, workspace } from "./helpers.js";

/* A dockview's own shape and nothing deeper: its panels and its grid. */

/* What the composer posts after a send has reached the server. `text` is the
   prompt as typed; the rest is provenance the history panel prints and is
   optional because not every surface that sends has a thread behind it. */
const ComposerHistorySchema = z.object({
  text: z.string().min(1),
  sessionId: z.string().nullish(),
  threadTitle: z.string().nullish(),
});

/* Individual rules — each has a title and content. Content may be
   empty on creation (the inline editor fills it in immediately). */
const RuleInputSchema = z.object({
  projectId: z.string().nullable().optional().default(null),
  title: z.string().min(1),
  content: z.string(),
});
const RuleUpdateSchema = z.object({
  title: z.string().min(1).optional(),
  content: z.string().optional(),
  sortOrder: z.number().optional(),
});

/** Everything server-wide with no bigger home: health, the web-search backend
    config, transcript search, the knowledge base, backup, push registration,
    the gateway shim's proxy, and the web-search usage ledger. */
export function miscRoutes(
  app: Hono,
  deps: { config: ReturnType<typeof loadConfig>; sessions: SessionManager; push: Push },
): void {
  const { config, sessions, push } = deps;

  // The openui Map's directions panel (geo.ts). Points are "lat,lng;lat,lng", at most 25 of them.
  const Point = z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)]);
  const GeoRouteQuery = z.object({
    profile: z.enum(PROFILES),
    points: z
      .string()
      .transform((s) => s.split(";").map((p) => p.split(",").map(Number) as [number, number]))
      .pipe(z.array(Point).min(2).max(25)),
    alternatives: z.enum(["0", "1"]).optional(),
    lang: z.string().max(35).optional(),
  });
  app.get("/api/geo/config", (c) => c.json(mapsConfig()));
  app.get("/api/geo/route", async (c) => {
    const q = GeoRouteQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "profile must be car, bike or foot and points 2-25 lat,lng pairs" }, 400);
    return c.json({ routes: await route(q.data.profile, q.data.points, q.data.alternatives === "1", q.data.lang) });
  });
  // A POST because an encoded polyline for a long route is far past a sensible URL.
  const GeoNearbyBody = z.object({
    categories: z.array(z.enum(CATEGORIES)).min(1).max(3),
    polyline: z.string().max(200_000).optional(),
    center: Point.optional(),
    radius: z.number().min(100).max(50_000).default(3000),
    lang: z.string().max(35).optional(),
  });
  app.post("/api/geo/nearby", async (c) => {
    const body = GeoNearbyBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success || (!body.data.polyline && !body.data.center))
      return c.json({ error: "categories (fuel, lodging, food) and a polyline or a center are required" }, 400);
    const where = body.data.polyline ? { polyline: body.data.polyline } : { center: body.data.center!, radius: body.data.radius };
    return c.json({ places: await nearby(body.data.categories, where, body.data.lang) });
  });
  app.get("/api/geo/search", async (c) => {
    const query = (c.req.query("q") ?? "").trim();
    if (!query || query.length > 200) return c.json({ error: "q must be 1-200 characters" }, 400);
    return c.json({ places: await searchPlaces(query, c.req.query("lang")?.slice(0, 35) || undefined) });
  });

  // One photo for a named place (the openui CardGrid), looked up only when the reader asks for photos.
  app.get("/api/geo/photo", async (c) => {
    const query = (c.req.query("q") ?? "").trim();
    if (!query || query.length > 200) return c.json({ error: "q must be 1-200 characters" }, 400);
    const near = Point.safeParse([Number(c.req.query("lat")), Number(c.req.query("lon"))]);
    return c.json({ photo: await placePhoto(query, near.success ? near.data : undefined) });
  });

  app.get("/api/health", async (c) => {
    await dbAvailable();
    const token = bearerToken(c.req.header("authorization"), c.req.query("token"));
    // `webSearch` is only whether the search API is configured — never the token.
    // The contract numbers ride the unauthenticated route because the gate must be able to
    // say "too old" before a token is known good (`compat.ts`).
    return c.json({
      ok: true, name: "daedalus", authorized: token === config.token, webSearch: Boolean(readWebSearch()),
      api: API, minClientApi: MIN_CLIENT_API, database: dbStatus(),
    });
  });

  /* The deployment's version and parsed changelog — what Settings › General's
     About group shows. Authed like every route under the global middleware. */
  app.get("/api/meta", (c) => c.json({ version: appVersion(), changelog: changelog(), features: FEATURES }));

  /* A pasted link's title and mark for its composer chip — fetched here and
     inlined (`link-preview.ts`), so the browser asks the page nothing. */
  app.get("/api/link-preview", async (c) => c.json(await resolveLinkPreview(c.req.query("url") ?? "")));

  /* Rules: standing instructions every thread spawns with, beneath
     any project's own rules (rules.ts). Individual rules with titles
     and content, composed into a single text block at spawn time. */
  app.get("/api/rules/project/:projectId", async (c) => {
    const projectId = c.req.param("projectId")
    const project = await getProject(projectId)
    if (!project) return c.json({ error: "unknown project" }, 404)
    return c.json(await projectRules(projectId))
  })
  app.get("/api/rules", async (c) => c.json(await globalRules()))
  app.post("/api/rules", async (c) => {
    const parsed = RuleInputSchema.safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400)
    return c.json(await createRule(parsed.data), 201)
  })
  app.put("/api/rules/:id", async (c) => {
    const parsed = RuleUpdateSchema.safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400)
    const updated = await updateRule(c.req.param("id"), parsed.data)
    return updated ? c.json(updated) : c.json({ error: "not found" }, 404)
  })
  app.delete("/api/rules/:id", async (c) =>
    (await deleteRule(c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404)
  )

  /* Model roles: the free-form vocabulary a profile's models tag themselves with
     (`ModelDef.roles`), so a subagent is spawned on a role rather than on a
     hardcoded model (docs/model-roles.md). Global, ordered, the same shape
     `rules` takes — and exposed the same way. `PUT` replaces the whole ordered
     list in one write (the Settings save); the single-row routes are for a
     targeted edit. A deleted role leaves dangling assignments on purpose: a
     reader ignores an id no row answers for. */
  app.get("/api/model-roles", async (c) => c.json(await listModelRoles()))
  app.put("/api/model-roles", async (c) => {
    const parsed = ModelRolesInputSchema.safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400)
    return c.json(await setModelRoles(parsed.data))
  })
  app.post("/api/model-roles", async (c) => {
    const parsed = ModelRoleInputSchema.safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400)
    return c.json(await addModelRole(parsed.data), 201)
  })
  app.put("/api/model-roles/:id", async (c) => {
    const parsed = ModelRoleInputSchema.partial().safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400)
    const updated = await updateModelRole(c.req.param("id"), parsed.data)
    return updated ? c.json(updated) : c.json({ error: "not found" }, 404)
  })
  app.delete("/api/model-roles/:id", async (c) =>
    (await deleteModelRole(c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404)
  )

  /* Themes — the studio's saved user-made themes, stored server-side so a
     theme follows the account and not the browser. The payload is the
     client's own `CustomTheme` untranslated: three halves, each a record of
     token → value, opaque here. The list is the gallery, the writes are the
     editor's live write-through. */
  const ThemeInputSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    light: z.record(z.string(), z.string()).default({}),
    dark: z.record(z.string(), z.string()).default({}),
    base: z.record(z.string(), z.string()).default({}),
  })
  const ThemeUpdateSchema = z.object({
    name: z.string().min(1).optional(),
    light: z.record(z.string(), z.string()).optional(),
    dark: z.record(z.string(), z.string()).optional(),
    base: z.record(z.string(), z.string()).optional(),
  })

  app.get("/api/themes", async (c) => c.json(await listThemes()))
  app.post("/api/themes", async (c) => {
    const parsed = ThemeInputSchema.safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400)
    return c.json(await createTheme(parsed.data), 201)
  })
  app.put("/api/themes/:id", async (c) => {
    const parsed = ThemeUpdateSchema.safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400)
    const updated = await updateTheme(c.req.param("id"), parsed.data)
    return updated ? c.json(updated) : c.json({ error: "not found" }, 404)
  })
  app.delete("/api/themes/:id", async (c) =>
    (await deleteTheme(c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404)
  )

  /* Full-text search over journaled transcripts (see search.ts). Optional
     `session` scopes it to one thread for the command palette's in-thread
     search. Query syntax is sanitized server-side; snippets use private-use
     markers, never markup. */
  app.get("/api/search", async (c) => {
    const q = c.req.query("q")?.trim() ?? "";
    if (!q) return c.json({ results: [] });
    const limit = Number.parseInt(c.req.query("limit") ?? "", 10) || SEARCH_LIMIT;
    const sessionId = c.req.query("session")?.trim() || undefined;
    return c.json({ results: await searchEvents(q, limit, sessionId) });
  });

  /* Knowledge base. The same table the `knowledge` MCP server reads, exposed as a
     REST resource so the user can see and edit it — per project below, and as
     one list across every project for Settings › Knowledge base. Missing
     project surfaces as a 404 via the `workspace()` wrapper. */
  app.get("/api/knowledge", async (c) => c.json(await listAllKnowledge()));

  app.get("/api/projects/:projectId/knowledge", (c) =>
    workspace(c, async () => await listKnowledge(c.req.param("projectId"))),
  );

  app.post("/api/projects/:projectId/knowledge", async (c) => {
    const parsed = KnowledgeInputSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    return workspace(c, async () => await addKnowledge(c.req.param("projectId"), parsed.data));
  });

  app.delete("/api/projects/:projectId/knowledge/:entryId", async (c) =>
    (await deleteKnowledge(c.req.param("projectId"), c.req.param("entryId")))
      ? c.json({ ok: true })
      : c.json({ error: "no such knowledge entry" }, 404),
  );

  /* Backup: everything the harness stores, as one JSON document (backup.ts).
     Secrets are OFF unless `secrets=1` opts in, and this route accepts the
     bearer token only in the Authorization header — the general middleware also
     takes `?token=`, but a full-secret export URL is exactly the thing that ends
     up in browser history and proxy logs. `journals=0` leaves the transcripts
     out. Served as an attachment so a plain link downloads it. */
  app.get("/api/backup", async (c) => {
    const header = c.req.header("authorization");
    if (!header?.startsWith("Bearer ") || header.slice(7) !== config.token) {
      return c.json({ error: "this route requires the Authorization header (no ?token=)" }, 401);
    }
    const bundle = await exportBundle({
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
    const summary = await importBundle(bundle, mode);
    sessions.reload();
    console.log(`[backup] imported (${mode}):`, summary);
    return c.json(summary);
  });

  /* Claude Code's traffic to a profile's gateway. Same rule as the editor: the
     derived key in the path is the credential (the CLI carries its own
     `x-api-key` for the gateway itself), and a key the shim did not derive is a
     404. See gateway-shim.ts for the one repair it makes on the way back. */
  app.all("/gw/*", (c) => proxyGatewayRequest(c.req.raw));

  /* Claude Code's OpenTelemetry export, mounted the same way: the derived key
     in the path is the credential and the thread must be attached to the
     `otlp` door (model-calls/sources/otlp.ts). Logs are read; traces and
     metrics are answered and dropped. */
  app.all("/otlp/*", (c) => handleOtlp(c.req.raw));

  /* A paused thread's step hooks, mounted the same way: the derived key in
     the path is the credential, and the answer is only ever late, never "no"
     (pause-hooks.ts). */
  app.post("/ph/*", (c) => handlePauseHook(c.req.raw));

  /* The MCP OAuth shim, mounted the same way and for the same reason: the
     credential is in the path, the route is outside /api, and what it fronts
     is a library row's own URL with a fresh bearer on it (mcp-shim.ts). */
  app.all("/mx/*", (c) => proxyMcpRequest(c.req.raw));

  /* Aggregate usage of the harness's own web-search MCP server: totals by tool
     and status, plus the most recent calls (`?limit=` caps the tail). */
  app.get("/api/websearch/usage", async (c) =>
    c.json(await getWebSearchUsage(Number(c.req.query("limit")) || 50)),
  );

  /* Spend: billed sums out of the model-call ledger (`model_calls`), grouped by
     `?groupBy=profile|model|project|agent|source` over `?from&to` (epoch ms,
     both optional). Settings › Usage is the one surface that lists spend. */
  app.get("/api/usage/calls", async (c) => {
    const groupBy = c.req.query("groupBy") ?? "profile";
    if (!(SPEND_GROUPS as readonly string[]).includes(groupBy)) {
      return c.json({ error: `groupBy must be one of ${SPEND_GROUPS.join(", ")}` }, 400);
    }
    const from = Number(c.req.query("from"));
    const to = Number(c.req.query("to"));
    return c.json({ groupBy, groups: await spendBy(groupBy as SpendGroupBy, from || undefined, to || undefined) });
  });

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
  const quotaProject = async (id?: string) => (id && await getProject(id)) || quotaCwd();

  app.get("/api/quota", async (c) => {
    const project = await quotaProject(c.req.query("projectId"));
    const refresh = c.req.query("refresh") === "1";
    const probeable = (await listAgents()).filter((agent) => agent.quotaProbe);
    /* Stored profiles only — `await listProfiles()` with no agents synthesizes no
       virtual Defaults, and a Default never names a provider anyway. A disabled
       profile is out of the usage plan — that is the half of "everywhere" the
       pickers are not — while a merely hidden one keeps reporting. */
    const providers = (await listProfiles()).filter((profile) => profileUsage(profile) && !profile.disabled);
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
    const profile = await getProfile(c.req.param("profileId"));
    if (!profile) return c.json({ error: "unknown profile" }, 404);
    if (!profileUsage(profile)) return c.json({ error: "profile names no usage provider" }, 400);
    return c.json(await getProfileQuota(profile, { refresh: c.req.query("refresh") === "1" }));
  });

  app.get("/api/quota/:agentId", async (c) => {
    const agent = await getAgent(c.req.param("agentId"));
    if (!agent) return c.json({ error: "unknown agent" }, 404);
    /* No profileId means the Default one — the same machine-level reading the
       list route gives, so a caller that only knows the agent has a route. */
    const profileId = c.req.query("profileId");
    const profile = profileId ? await getProfile(profileId) : defaultProfileFor(agent.id, agent.name);
    if (!profile) return c.json({ error: "unknown profile" }, 404);
    if (!profileSupports(profile, agent.id)) return c.json({ error: "profile does not serve this agent" }, 400);
    return c.json(
      await getQuota(agent, profile, await quotaProject(c.req.query("projectId")), { refresh: c.req.query("refresh") === "1" }),
    );
  });

  app.get("/api/push/config", async (c) => c.json({ enabled: push.enabled, ...push.webConfig() }));
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
  app.get("/api/notifications", async (c) => {
    const limit = Number.parseInt(c.req.query("limit") ?? "", 10);
    return c.json({
      items: await listNotifications(Number.isFinite(limit) && limit > 0 ? limit : undefined),
      unread: await unreadNotifications(),
    });
  });

  app.post("/api/notifications/read", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : null;
    await markNotificationsRead(ids);
    return c.json({ ok: true, unread: await unreadNotifications() });
  });

  /* Clear the whole inbox (a "clear" action in the pill), or only entries older
     than `?before=` (ms). Deleting is lossy where marking read is not, so this
     is the explicit user gesture, never implied by opening the pill. */
  app.delete("/api/notifications", async (c) => {
    const before = Number.parseInt(c.req.query("before") ?? "", 10);
    await clearNotifications(Number.isFinite(before) ? before : undefined);
    return c.json({ ok: true });
  });

  /* ── the composer's prompt history (composer-history.ts) ──
     Global across every thread, which is the point: recall used to be the
     transcript of the thread you were standing in. Newest first, the order the
     panel lists and Up walks. */
  app.get("/api/composer-history", async (c) => {
    const limit = Number.parseInt(c.req.query("limit") ?? "", 10);
    return c.json({ items: await listComposerHistory(Number.isFinite(limit) && limit > 0 ? limit : undefined) });
  });

  /* Written by the composer once a send has actually left. An exact repeat is
     moved to the top rather than added again (see `addComposerHistory`), so
     this is safe to call on every send. A prompt that is only an attachment
     records nothing and answers `{ entry: null }`. */
  app.post("/api/composer-history", async (c) => {
    const parsed = ComposerHistorySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const { text, sessionId, threadTitle } = parsed.data;
    /* Awaited: `addComposerHistory` is async, and returning the bare promise
       had `c.json` serialize `{}` into every answer — the write itself still
       ran, so the row was there on the next read while the caller was handed a
       row with no id and no text. The client patches its cache from this answer
       (`useRecordComposerHistory`), which is how an entry-shaped hole became the
       newest prompt on screen and a recall put `undefined` into the box. */
    return c.json({ entry: await addComposerHistory({ text, sessionId, threadTitle }) });
  });

  /* Forget one line (`?id=`), everything older than `?before=` (ms), or the
     whole history. Like the inbox's delete, this is only ever an explicit
     gesture — history is lossy to remove and nothing implies it. */
  app.delete("/api/composer-history", async (c) => {
    const id = c.req.query("id");
    const before = Number.parseInt(c.req.query("before") ?? "", 10);
    const removed = await clearComposerHistory({ id: id || undefined, before: Number.isFinite(before) ? before : undefined });
    return c.json({ ok: true, removed });
  });
}
