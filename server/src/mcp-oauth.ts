/* ── OAuth for HTTP MCP servers ──
 *
 * An MCP server reached over HTTP may demand OAuth. The spec (MCP 2025-06-18
 * auth) says such a server is an OAuth 2.1 **protected resource**: an
 * unauthenticated request is answered `401` with `WWW-Authenticate: Bearer
 * resource_metadata="…"`, that URL is RFC 9728 Protected Resource Metadata
 * naming one or more authorization servers, each of those publishes RFC 8414
 * metadata, the client registers itself with RFC 7591 Dynamic Client
 * Registration (there is no out-of-band client id for a personal tool), runs
 * authorization code + PKCE with the RFC 8707 `resource` indicator pinned to
 * the server's canonical URL, and then carries a short-lived bearer it
 * refreshes.
 *
 * This module is the protocol half — discovery, registration, the two token
 * grants and the store they land in. It deliberately uses the SDK's exported
 * primitives (`discoverOAuthProtectedResourceMetadata`,
 * `discoverAuthorizationServerMetadata`, `registerClient`,
 * `startAuthorization`, `exchangeAuthorization`, `refreshAuthorization`)
 * rather than `auth()` or an `OAuthClientProvider`: those are written around a
 * transport instance that owns the connection, and here the connection belongs
 * to an agent in another process. We want the primitives, not the loop.
 *
 * The browser flow is `routes/library.ts` + the callback in `index.ts`; the
 * credential is attached to live traffic by `mcp-shim.ts`. Nothing here is
 * ever handed to a child process — the token is the server's, and the child
 * only ever sees the shim's loopback URL.
 */
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import { db, mcpOauth as mcpOauthTable, mcpServers as mcpServersTable } from "./db/index.js";
import type { AuthServerMetadata } from "./db/schema.js";
import { HttpError } from "./http-error.js";

export type McpOauthRow = typeof mcpOauthTable.$inferSelect;

/** What this client tells an authorization server about itself at registration.
    A personal tool: one redirect, the code grant, and a public client unless
    the AS insists on a secret (it answers with one, and we store what it
    answers). */
const CLIENT_NAME = "Daedalus Harness";
const CLIENT_URI = "https://github.com/daedalus-harness";

/* ── Discovery ── */

export type McpAuthProbe =
  | { kind: "none" }
  | {
      kind: "oauth";
      /** RFC 8707 canonical resource identifier the token will be bound to. */
      resource: string;
      issuer: string;
      metadata: AuthServerMetadata;
      scopesSupported: string[];
      registrationEndpoint: string | null;
    }
  /** Anything that is neither "answered" nor "401" — reported verbatim,
      because a 403 from a corporate proxy must not read as "needs OAuth". */
  | { kind: "unknown"; status: number; detail: string };

/** A minimal `initialize` — the cheapest request that proves whether the
    server will talk to us unauthenticated. Sent as JSON-RPC over the
    Streamable HTTP transport's POST, which is what every modern MCP server
    answers on its base URL. */
function initializeBody(): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: CLIENT_NAME, version: "1.0.0" },
    },
  });
}

/** How long a probe or a discovery fetch gets. Short: this runs behind a
    button somebody is watching, and an unreachable host must say so rather
    than spin. */
const PROBE_TIMEOUT_MS = 15_000;

const withTimeout = (ms = PROBE_TIMEOUT_MS): AbortSignal => AbortSignal.timeout(ms);

/**
 * Does this URL demand OAuth, and if so, whose?
 *
 * `200`/`202` → `none`. `401` → follow the chain: the `WWW-Authenticate`
 * header's `resource_metadata` when it carries one, then RFC 9728's
 * well-known paths (the SDK tries the path-aware form before the root one),
 * and when *that* fails, treat the resource's own origin as the issuer —
 * which is what servers written before RFC 9728 do. Anything else is
 * `unknown`.
 */
export async function probeMcpAuth(url: string): Promise<McpAuthProbe> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: initializeBody(),
      signal: withTimeout(),
      redirect: "follow",
    });
  } catch (error) {
    return { kind: "unknown", status: 0, detail: error instanceof Error ? error.message : String(error) };
  }
  if (res.status === 200 || res.status === 202) {
    void res.body?.cancel();
    return { kind: "none" };
  }
  if (res.status !== 401) {
    const detail = (await res.text().catch(() => "")).slice(0, 400);
    return { kind: "unknown", status: res.status, detail: detail || res.statusText };
  }

  /* The SDK reads `resource_metadata` out of the challenge for us; when the
     header names none it falls back to the well-known paths, and a 404 there
     comes back as undefined rather than as a throw. */
  const resourceMetadataUrl = extractResourceMetadataUrl(res);
  void res.body?.cancel();
  let prm: Awaited<ReturnType<typeof discoverOAuthProtectedResourceMetadata>> | undefined;
  try {
    prm = await discoverOAuthProtectedResourceMetadata(url, resourceMetadataUrl ? { resourceMetadataUrl } : {});
  } catch {
    /* No PRM at all — the pre-RFC-9728 case, handled by the fallback below. */
  }

  /* Which AS, when PRM lists several: the first. A picker is a real UI
     question and no server met so far lists more than one. */
  const issuerCandidate = prm?.authorization_servers?.[0] ?? new URL(url).origin;
  const resource = prm?.resource ?? canonicalResource(url);

  let metadata: AuthServerMetadata | undefined;
  try {
    metadata = (await discoverAuthorizationServerMetadata(issuerCandidate)) as AuthServerMetadata | undefined;
  } catch (error) {
    return {
      kind: "unknown",
      status: 401,
      detail: `the server demands OAuth but its authorization server (${issuerCandidate}) published no usable metadata: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (!metadata?.authorization_endpoint || !metadata.token_endpoint) {
    return {
      kind: "unknown",
      status: 401,
      detail: `the server demands OAuth but its authorization server (${issuerCandidate}) published no usable metadata`,
    };
  }
  return {
    kind: "oauth",
    resource,
    issuer: metadata.issuer || issuerCandidate,
    metadata,
    scopesSupported: prm?.scopes_supported ?? metadata.scopes_supported ?? [],
    registrationEndpoint: typeof metadata.registration_endpoint === "string" ? metadata.registration_endpoint : null,
  };
}

/** `resource_metadata="…"` out of a `WWW-Authenticate: Bearer …` challenge.
    Hand-read rather than taken from the SDK's helper so a malformed header is
    simply "no URL" instead of a throw from inside a probe. */
export function extractResourceMetadataUrl(res: Response): URL | undefined {
  const header = res.headers.get("www-authenticate");
  if (!header) return undefined;
  const match = /resource_metadata\s*=\s*"([^"]+)"/i.exec(header) ?? /resource_metadata\s*=\s*([^\s,]+)/i.exec(header);
  if (!match?.[1]) return undefined;
  try {
    return new URL(match[1]);
  } catch {
    return undefined;
  }
}

/** `new URL(…)` that answers null instead of throwing — every caller here is
    reading user-typed configuration or a header some other server wrote, where
    a malformed value is an answer and not an exception. */
export function safeParseUrl(value: string, base?: URL): URL | null {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

/** RFC 8707 canonicalisation: lowercase scheme and host, no fragment, and no
    trailing slash on a bare origin. Only used when the server published no
    PRM of its own to name itself. */
export function canonicalResource(url: string): string {
  const parsed = new URL(url);
  /* Built by hand rather than by `toString()`: a URL object cannot hold an
     empty pathname — assigning "" leaves the "/" in place — and a bare origin
     with a trailing slash is a different string to the one an authorization
     server will have written down. */
  const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${path}${parsed.search}`;
}

/* ── Registration ── */

/** Register this harness with the authorization server. Free and cheap, and
    re-run rather than reused whenever the redirect base changes. */
export async function registerMcpClient(
  metadata: AuthServerMetadata,
  redirectUri: string,
  scope: string | null,
): Promise<OAuthClientInformationFull> {
  return registerClient(metadata.issuer, {
    metadata,
    clientMetadata: {
      client_name: CLIENT_NAME,
      client_uri: CLIENT_URI,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(scope ? { scope } : {}),
    },
    ...(scope ? { scope } : {}),
  });
}

/* ── The store ── */

export const mcpOauth = {
  get: (mcpServerId: string): McpOauthRow | undefined =>
    db.select().from(mcpOauthTable).where(eq(mcpOauthTable.mcpServerId, mcpServerId)).get(),

  all: (): McpOauthRow[] => db.select().from(mcpOauthTable).all(),

  /** Insert or replace the whole connection row. Every writer here goes
      through one statement so `updatedAt` cannot be forgotten. */
  put(row: Omit<McpOauthRow, "updatedAt">): McpOauthRow {
    const full = { ...row, updatedAt: Date.now() };
    db.insert(mcpOauthTable).values(full).onConflictDoUpdate({ target: mcpOauthTable.mcpServerId, set: full }).run();
    return full;
  },

  patch(mcpServerId: string, patch: Partial<Omit<McpOauthRow, "mcpServerId">>): McpOauthRow | undefined {
    db.update(mcpOauthTable)
      .set({ ...patch, updatedAt: Date.now() })
      .where(eq(mcpOauthTable.mcpServerId, mcpServerId))
      .run();
    return mcpOauth.get(mcpServerId);
  },

  remove: (mcpServerId: string): boolean =>
    db.delete(mcpOauthTable).where(eq(mcpOauthTable.mcpServerId, mcpServerId)).run().changes > 0,
};

/** How the row's state reads to the client. Tokens themselves never leave the
    server, exactly as `profiles.apiKey` never does. */
export type McpAuthState =
  | { kind: "none" }
  | {
      kind: "oauth";
      state: "connected" | "expired" | "disconnected";
      expiresAt: number | null;
      issuer: string;
      scope: string | null;
      error: string | null;
    };

/** Slack in front of `expiresAt`: a token that dies in the next minute is
    treated as already dead, so a refresh happens before the request rather
    than as a retry after a 401. */
export const EXPIRY_SLACK_MS = 60_000;

export function authStateOf(serverId: string, auth: "none" | "oauth"): McpAuthState {
  if (auth !== "oauth") return { kind: "none" };
  const row = mcpOauth.get(serverId);
  if (!row || !row.accessToken) {
    return {
      kind: "oauth",
      state: "disconnected",
      expiresAt: null,
      issuer: row?.issuer ?? "",
      scope: row?.scope ?? null,
      error: row?.lastError ?? null,
    };
  }
  /* "expired" is only ever said about a token with no way back — one that has
     run out AND has no refresh token. With a refresh token the connection is
     live: the shim renews it on the next request without anybody being asked. */
  const dead = row.expiresAt !== null && row.expiresAt <= Date.now() && !row.refreshToken;
  return {
    kind: "oauth",
    state: dead ? "expired" : "connected",
    expiresAt: row.expiresAt,
    issuer: row.issuer,
    scope: row.scope,
    error: row.lastError,
  };
}

/** Is this server ready to be advertised to an agent? The one question spawn
    asks — an unauthorized server is not offered at all, following the rule the
    built-in web-search row already sets. */
export function isConnected(serverId: string): boolean {
  const row = mcpOauth.get(serverId);
  return !!row?.accessToken && (row.expiresAt === null || row.expiresAt > Date.now() || !!row.refreshToken);
}

/* ── The pending browser flows ── */

interface Pending {
  serverId: string;
  verifier: string;
  redirectUri: string;
  resource: string;
  issuer: string;
  at: number;
}

/** Boot-scoped, never persisted: a flow that outlives a restart is one the
    user can simply start again, and a `state` on disk is a credential on disk. */
const pending = new Map<string, Pending>();

/** A `state` is only good for ten minutes, and only once. */
const STATE_TTL_MS = 10 * 60_000;

function sweepPending(): void {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [state, entry] of pending) if (entry.at < cutoff) pending.delete(state);
}

/** A fresh `state`. Minted before the flow is parked because
    `startAuthorization` takes the state as *input* and hands the PKCE verifier
    back — so the state has to exist before there is anything to park. */
export function newFlowState(): string {
  return randomBytes(32).toString("base64url");
}

export function parkPendingFlow(state: string, entry: Omit<Pending, "at">): void {
  sweepPending();
  pending.set(state, { ...entry, at: Date.now() });
}

/**
 * The parked flow this `state` names, consumed.
 *
 * **The `state` is the credential** — the callback route is unauthenticated by
 * necessity, since an authorization server redirects a browser there and no
 * bearer survives that hop. So it is 32 random bytes, single-use (deleted on
 * first read, which is what refuses a replay), and expired after ten minutes.
 * Lookup is by exact key: it names the pending flow rather than being
 * reflected into it, so there is nothing here to compare in variable time.
 */
export function takePendingFlow(state: string): Pending | undefined {
  sweepPending();
  const entry = pending.get(state);
  if (!entry) return undefined;
  pending.delete(state);
  if (Date.now() - entry.at > STATE_TTL_MS) return undefined;
  return entry;
}

/* ── Token grants ── */

/** `clientInformation` in the shape the SDK helpers take. */
export function clientInfoOf(row: McpOauthRow): { client_id: string; client_secret?: string } {
  return row.clientSecret ? { client_id: row.clientId, client_secret: row.clientSecret } : { client_id: row.clientId };
}

/** Tokens as the row's columns. `refresh_token` is preserved when the AS did
    not issue a new one — `refreshAuthorization` already does that, but the
    exchange path has to say it too. */
function tokenColumns(tokens: OAuthTokens, previous?: McpOauthRow): Partial<McpOauthRow> {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? previous?.refreshToken ?? null,
    scope: tokens.scope ?? previous?.scope ?? null,
    expiresAt: typeof tokens.expires_in === "number" ? Date.now() + tokens.expires_in * 1000 : null,
    lastError: null,
  };
}

/** Trade the authorization code for tokens and write them down. */
export async function completeAuthorization(
  row: McpOauthRow,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<McpOauthRow> {
  const tokens = await exchangeAuthorization(row.issuer, {
    metadata: row.metadata,
    clientInformation: clientInfoOf(row),
    authorizationCode: code,
    codeVerifier: verifier,
    redirectUri,
    resource: new URL(row.resource),
  });
  return mcpOauth.patch(row.mcpServerId, tokenColumns(tokens, row))!;
}

/**
 * In-flight refreshes, keyed by server.
 *
 * A turn opens several tool calls at once and a refresh token is frequently
 * single-use — two concurrent refreshes is exactly how an account ends up
 * disconnected. Same discipline as the option probe's in-flight map.
 */
const refreshing = new Map<string, Promise<McpOauthRow>>();

/** Renew the access token, at most once at a time per server. Rejects (and
    records `lastError`) when there is nothing to renew with. */
export function refreshTokens(row: McpOauthRow): Promise<McpOauthRow> {
  const existing = refreshing.get(row.mcpServerId);
  if (existing) return existing;
  const task = (async () => {
    if (!row.refreshToken) throw new HttpError("this connection has no refresh token; reconnect it", 401);
    try {
      const tokens = await refreshAuthorization(row.issuer, {
        metadata: row.metadata,
        clientInformation: clientInfoOf(row),
        refreshToken: row.refreshToken,
        resource: new URL(row.resource),
      });
      return mcpOauth.patch(row.mcpServerId, tokenColumns(tokens, row))!;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      mcpOauth.patch(row.mcpServerId, { lastError: `refresh failed: ${detail}` });
      throw error;
    }
  })().finally(() => refreshing.delete(row.mcpServerId));
  refreshing.set(row.mcpServerId, task);
  return task;
}

/**
 * The bearer to put on the next upstream request, refreshing first when it is
 * stale. Null when the row cannot answer at all, which the shim reports as a
 * 401 rather than forwarding an unauthenticated request the upstream would
 * refuse more confusingly.
 */
export async function accessTokenFor(serverId: string): Promise<string | null> {
  let row = mcpOauth.get(serverId);
  if (!row) return null;
  const stale = row.expiresAt !== null && row.expiresAt - EXPIRY_SLACK_MS <= Date.now();
  if (!row.accessToken || stale) {
    if (!row.refreshToken) return null;
    try {
      row = await refreshTokens(row);
    } catch {
      return null;
    }
  }
  return row.accessToken ?? null;
}

/**
 * Give the tokens back to the authorization server (RFC 7009) and forget them.
 *
 * Best-effort on the remote half **on purpose**: deleting locally must succeed
 * even when the revocation call fails, or a dead AS makes a server permanently
 * un-disconnectable.
 */
export async function disconnectServer(serverId: string): Promise<{ revoked: boolean; error: string | null }> {
  const row = mcpOauth.get(serverId);
  if (!row) return { revoked: false, error: null };
  let revoked = false;
  let error: string | null = null;
  /* OIDC discovery metadata does not declare `revocation_endpoint` in the
     SDK's union even though an AS may publish one, so it is read off the
     stored document rather than off the narrowed type. */
  const endpoint = (row.metadata as Record<string, unknown>).revocation_endpoint;
  if (typeof endpoint === "string" && endpoint) {
    for (const [token, hint] of [
      [row.refreshToken, "refresh_token"],
      [row.accessToken, "access_token"],
    ] as const) {
      if (!token) continue;
      try {
        const body = new URLSearchParams({ token, token_type_hint: hint, client_id: row.clientId });
        if (row.clientSecret) body.set("client_secret", row.clientSecret);
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
          signal: withTimeout(),
        });
        if (res.ok) revoked = true;
        else error = `revocation endpoint answered ${res.status}`;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    }
  }
  mcpOauth.remove(serverId);
  return { revoked, error };
}

/** Every `http` row that is marked `oauth`, with its connection state — what
    the list route reports beside each server. One query for the rows and one
    for the connections, not one per row. */
export function authStates(): Map<string, McpAuthState> {
  const rows = db
    .select({ id: mcpServersTable.id, auth: mcpServersTable.auth })
    .from(mcpServersTable)
    .where(and(eq(mcpServersTable.type, "http"), eq(mcpServersTable.auth, "oauth")))
    .all();
  return new Map(rows.map((r) => [r.id, authStateOf(r.id, r.auth)]));
}
