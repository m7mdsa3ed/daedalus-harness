# Daedalus Harness — OAuth for MCP servers

## Context

An MCP server reached over HTTP may demand OAuth. The spec (MCP 2025-06-18 auth) says a
server is an OAuth 2.1 **protected resource**: an unauthenticated request is answered `401`
with `WWW-Authenticate: Bearer resource_metadata="…"`, that URL is RFC 9728 Protected
Resource Metadata naming one or more authorization servers, each of those publishes RFC 8414
metadata, the client registers itself with RFC 7591 Dynamic Client Registration (there is no
out-of-band client id for a personal tool), runs authorization code + PKCE with the RFC 8707
`resource` indicator pinned to the server's canonical URL, and then carries a short-lived
bearer that it refreshes. Anthropic's own connectors, Linear, Notion, Sentry, Atlassian and
GitHub's MCP server all work this way.

The harness handles none of it. An `mcp_servers` row is `builtin`, `http` (a `url` plus a
list of static `{name, value}` headers) or `stdio` (`library.ts:49-66`), and the `http` shape
goes to the agent verbatim at `session/new` (`sessions.ts:311`). There is no
authorization-server discovery, no token store, no refresh, and no surface that can say
"this one needs connecting". A server that demands OAuth fails at `initialize` with a 401
that reaches the user as *the MCP server closed the connection*.

### What already exists

| The piece OAuth needs | The harness's equivalent | State |
|---|---|---|
| A loopback proxy that rewrites a credential per request | `gateway-shim.ts` (`/gw/<key>/…`) | exists, and is the model |
| An unauthenticated route whose credential is in the path | `/gw`, `/ide`, `/wf`, `/rt` | exists |
| Somewhere to keep a secret that never reaches the client | `profiles.apiKey`'s write-only bargain | exists |
| A row that resolves to *nothing* when it cannot answer | `websearchServer()` returning null | exists |
| A library row with a status the UI reads back | `mcp_servers` + `settings/mcp.tsx` | exists |
| Coalescing concurrent work on one key | the probe's in-flight map (`probe.ts`) | exists |
| Rewriting an SSE stream in flight | `renamespaceSse` (`gateway-shim.ts:397`) | exists |
| Discovery / DCR / PKCE / refresh | `@modelcontextprotocol/sdk/client/auth.js` (already a dependency) | exists, unused |
| A token store, a browser flow, a redirect URI | — | **missing** |

So this is mostly composition, like `routines.md` was. The genuinely new parts are a table,
a three-route browser flow, and one more shim.

---

## The crux: the token is the server's, and the child must never hold it

Three ways to do this. Two are wrong for reasons worth writing down.

**A — inject a bearer into the row's headers at spawn.** The server does the flow, stores
the token, and `mcpServersFor` appends `Authorization: Bearer …` to the `headers` it already
sends. It is ten lines and it is broken: those headers are fixed at `session/new`, access
tokens live an hour, and a thread lives days. The first refresh window that passes mid-turn
kills every tool on that server for the rest of the process, with no path to recovery short
of a respawn. A credential that expires cannot be delivered as a constant.

**B — hand the row a stdio bridge (`npx mcp-remote <url>`).** Works today with no code at
all, and should be documented as the escape hatch. As the design it fails on four counts:
it runs the flow on the *server's* machine and needs a browser there, so a phone cannot
authorize anything; the tokens land in `~/.mcp-auth`, outside the database, outside
`backup.ts`, and outside anything the UI can report; every server pays a node process; and
the harness would be teaching users a per-tool workaround for a protocol it claims to speak.

**C — an authenticating proxy, exactly like the gateway shim.** The `http` server handed to
the agent points at `http://127.0.0.1:<port>/mx/<key>/<serverId>`, and the shim forwards to
the real URL with a fresh access token attached, refreshing when it is stale and retrying
once on a 401. CLAUDE.md already states this principle for the gateway — *the endpoint and
the credential are the shim's, not the child's* — and every consequence it buys there is
bought again here:

- **Every agent gets OAuth, and none of them learn a word about it.** claude-agent-acp,
  codex-acp, opencode and the harness's own runtime all just see an HTTP MCP server with no
  auth. No per-agent knowledge, which is the standing rule.
- **Refresh is transparent and mid-turn.** The credential is resolved per request, the way
  `proxyGatewayRequest` resolves a thread's profile per request.
- **Revocation is immediate.** Disconnecting a server stops the next tool call, rather than
  waiting for every thread that holds it to respawn.
- **`agent/src/mcp.ts` does not change.** That is the test of whether this is in the right
  place.

Choose C. B stays in the docs as the workaround for a server the flow cannot handle.

---

## Design

### 1. Storage

Two changes in `server/src/db/schema.ts`.

One column on `mcp_servers`:

```ts
/** How the row authenticates. "none" is a plain URL, possibly with static
    headers the user typed (a PAT). "oauth" means the tokens are in
    `mcp_oauth` and the agent is handed the shim's URL, never this one. */
auth: text("auth", { enum: ["none", "oauth"] }).notNull().default("none"),
```

It is a stored answer, not a typed one — `probeMcpAuth` sets it — because spawn must not
make a network call to find out what to hand the agent.

One table, cascading off the row it belongs to:

```ts
export const mcpOauth = sqliteTable("mcp_oauth", {
  mcpServerId: text("mcp_server_id").primaryKey()
    .references(() => mcpServers.id, { onDelete: "cascade" }),
  /** RFC 8707 canonical resource identifier, from PRM — what the token is *for*. */
  resource: text("resource").notNull(),
  /** The authorization server chosen from PRM's list, and its cached RFC 8414 metadata. */
  issuer: text("issuer").notNull(),
  metadata: text("metadata", { mode: "json" }).$type<AuthServerMetadata>().notNull(),
  /** From dynamic registration. `clientSecret` is null for a public client. */
  clientId: text("client_id").notNull(),
  clientSecret: text("client_secret"),
  /** Registered exactly, and re-registered when the reachable base changes. */
  redirectUri: text("redirect_uri").notNull(),
  scope: text("scope"),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  /** Unix ms. Null = no expiry was reported; treat as valid until a 401 says otherwise. */
  expiresAt: integer("expires_at"),
  /** Why the last attempt failed, for the row to say so instead of just going quiet. */
  lastError: text("last_error"),
  updatedAt: integer("updated_at").notNull(),
});
```

A separate table rather than more columns on `mcp_servers` for three reasons: the secrets are
then trivially separable in `backup.ts` (`secrets=0` blanks one table's three columns rather
than reaching into a row of mixed provenance); connecting and disconnecting is an insert and
a delete, not an edit of the library row, so it never collides with somebody editing the
server's name; and the cascade means deleting the server takes the tokens with it, which is
the same guarantee `profile_*`/`session_*` already give.

`pnpm db:push` after, per the standing rule. No migration file.

### 2. Discovery — `server/src/mcp-oauth.ts`

```ts
export type McpAuthProbe =
  | { kind: "none" }
  | { kind: "oauth"; resource: string; issuer: string; metadata: AuthServerMetadata;
      scopesSupported: string[]; registrationEndpoint: string | null }
  | { kind: "unknown"; status: number; detail: string };
```

`probeMcpAuth(url)` POSTs a minimal `initialize` with no credential. `200`/`202` → `none`.
`401` → read `WWW-Authenticate`, fetch the `resource_metadata` URL it names; when the header
carries none, fall back to the well-known paths in order (path-aware
`/.well-known/oauth-protected-resource/<path>` first, then root), and when *that* fails, to
treating the resource's own origin as the issuer, which is what servers written before RFC
9728 do. Then fetch AS metadata (RFC 8414, then the OIDC discovery fallback). Anything else
→ `unknown`, reported verbatim, because a 403 from a corporate proxy must not read as "needs
OAuth".

Use the SDK's exported helpers (`discoverOAuthProtectedResourceMetadata`,
`discoverAuthorizationServerMetadata`, `registerClient`, `startAuthorization`,
`exchangeAuthorization`, `refreshAuthorization`, `selectResourceURL`) rather than
hand-rolling the RFCs. Deliberately **not** `auth()` or `OAuthClientProvider`: those are
written around a transport instance that owns the connection, and here the connection belongs
to an agent in another process. We want the primitives, not the loop.

### 3. The browser flow — three routes

- **`POST /api/mcp-servers/:id/authorize`** (bearer, ordinary `/api`). Probes if the row has
  no `mcp_oauth` yet, registers the client with DCR if there is no `clientId`, mints a PKCE
  verifier and a 32-byte `state`, parks `{serverId, verifier, redirectUri, resource, issuer,
  at}` in a boot-scoped `Map`, and answers `{authorizeUrl}`. The client opens it in a popup.
- **`GET /oauth/mcp/callback?code&state`** — outside `/api`, and unauthenticated *by
  necessity*: the authorization server redirects a browser here and no bearer survives that
  hop. **The `state` is the credential**, and it has to be treated as one: 32 random bytes,
  single-use (deleted on first read), a 10-minute TTL, compared with `safeKeyEqual`
  (`gateway-shim.ts:69`), and it names the pending flow rather than being reflected into it.
  On success it exchanges the code, writes the tokens, and answers a small self-closing HTML
  page — the same shape `/ide` already serves, no client bundle involved.
- **`DELETE /api/mcp-servers/:id/authorize`** — revoke at `revocation_endpoint` when the AS
  advertises one (RFC 7009, best-effort), then delete the row. Deleting locally must succeed
  even when the revocation call fails, or a dead AS makes a server permanently un-disconnectable.

Status needs no route of its own: `GET /api/mcp-servers` grows an `auth` field per row —
`{kind: "none"} | {kind: "oauth", state: "connected" | "expired" | "disconnected", expiresAt,
issuer, scope, error}` — computed from the join. Tokens never leave the server, exactly as
`profiles.apiKey` never does.

#### The redirect URI is the hard part

It must match what was registered, byte for byte, and it has to be somewhere the *user's
browser* can land. Three facts decide it: the browser is already talking to this server, so
whatever origin it used is reachable by definition; the client dev server (5173) and the API
(4001) are different origins, so the callback lands on the API's and cannot be a client
route; and `pnpm dev:tunnel` mints a fresh hostname every run, so nothing derived can be
assumed stable.

So: the redirect base is `config.json`'s `mcpOauthRedirectBase` when set (the answer for a
named tunnel or a reverse proxy), else derived from the request that started the flow —
`X-Forwarded-Proto`/`X-Forwarded-Host` first, then `Origin`, then `Host`. It is stored on the
row. When a later flow computes a different base, the client is **re-registered** rather than
reused: DCR is cheap and free, and an AS refusing a redirect it never saw is a dead end the
user cannot diagnose. Servers that only accept loopback redirects (some do, for native
clients) work when the browser is on the same machine and are a documented limitation
otherwise — `mcpOauthRedirectBase` is the escape hatch.

### 4. The shim — `server/src/mcp-shim.ts`

Modelled on `gateway-shim.ts` and sharing its key discipline: `configureMcpShim({port})`,
a per-boot `randomBytes(24)` key never written to disk, `mcpProxyUrlFor(serverId)` →
`http://127.0.0.1:<port>/mx/<key>/<serverId>`, and `parseMcpPath` beside `parseGatewayPath`.
Mounted in `index.ts` alongside `/gw`, `/ide`, `/wf`, `/rt`, outside the bearer middleware.

`proxyMcpRequest(req)`:

1. Parse and `safeKeyEqual` the key; unknown server or bad key → 404, never a hint.
2. Resolve the token. Stale (`expiresAt` within 60s) → refresh first, **coalesced by an
   in-flight `Map<serverId, Promise>`**, because a turn opens several tool calls at once and
   a refresh token is frequently single-use — two concurrent refreshes is how an account
   ends up disconnected.
3. Forward byte for byte to `<url>/<rest>`: method, body streamed and never read (the
   gateway's rule — a request body is not ours to parse), query preserved, the user's own
   static headers merged in, the inbound `Authorization` **dropped** and replaced with ours,
   `MCP-Protocol-Version` and `Mcp-Session-Id` passed through both ways.
4. Response piped, streaming intact — `text/event-stream` included, which is the same
   pipe `proxyGatewayRequest` already does.
5. `401` from upstream → refresh once and retry the request; a second `401` clears the
   tokens, writes `lastError`, fans the new status out to peers, and returns the 401 so the
   agent reports a real failure rather than a hang.
6. `3xx` → not followed; a same-origin `Location` is rewritten back through the proxy.

Two details that will otherwise bite:

- **Legacy HTTP+SSE transport.** The old transport's stream opens with an `endpoint` event
  carrying the URL for subsequent POSTs. Resolved against the proxy's origin, that path
  misses the `/mx/<key>/<serverId>` prefix and the agent posts into nothing. A
  `TransformStream` rewrites that one event — the exact shape `renamespaceSse` already has,
  and the only place the shim looks inside a body.
- **The `resource` indicator.** Tokens are bound to the real server's canonical URL, not the
  proxy's. Nothing about the proxy changes that; it is worth stating because the temptation
  to pass the proxy URL as `resource` would produce tokens the upstream rejects.

### 5. Spawn

`mcpServersFor` (`sessions.ts:291`) gains one branch and one return value:

```ts
} else if (s.type === "http") {
  if (s.auth !== "oauth") out.push({ type: "http", name: s.name, url: s.url, headers: s.headers });
  else if (mcpAuth.isConnected(s.id)) out.push({ type: "http", name: s.name, url: mcpProxyUrlFor(s.id), headers: s.headers });
  else skipped.push(s.id);
}
```

An unauthorized server **is not advertised**, following the rule the built-in web-search row
already sets: a tool that cannot answer is not offered, however it was linked. The return
becomes `{servers, skipped}` — `sessions.ts`, `probe.ts` and `routines.ts` are the three call
sites — and `skipped` is kept on the session so the composer's tools read-out
(`ThreadToolsMenu`, `editable={false}`) can mark the row *needs authorization* with a link to
the settings page. Not journaled and not an error row: nothing failed, a thread simply spawned
without a tool it was never able to use.

### 6. Client

- **`components/settings/mcp.tsx`** — the row grows a status pill from the new `auth` field
  (Connected · Expires in 42m / Needs authorization / Disconnected) and a Connect ·
  Reconnect · Disconnect action. Connect POSTs, opens `authorizeUrl` in a popup, and refreshes
  the list on the popup's `message`, on `focus`, and on a 2s poll while one is open — three
  because a popup blocked, closed or completed on a phone's tab switch each fail one of them.
- **The form** — a **Check** button beside the URL running the probe, and the probe on save:
  an `http` row that answers 401 flips to `auth: "oauth"` and offers Connect right there. The
  headers field stays exactly as it is, because a static PAT remains the common case and the
  simplest one.
- **Errors** — `captureError` + `ErrorNote` inline on the form and beside the row, never a
  toast: the standing rule is that a surface with the user's attention holds its own error,
  and every failure here (probe refused, DCR refused, exchange refused) has one.
- `lib/settings.ts` — `McpServerDef` gains `auth`, and `mcpSubtitle` says the state.

### 7. Backup

`backup.ts` gains `mcpOauth` to the bundle beside `mcpServers`: exported, `secrets=0` blanks
`accessToken`/`refreshToken`/`clientSecret`, merge upserts by `mcpServerId`, and a blank
secret keeps the install's existing value (the rule already in place for profile keys). A
restored row on another machine keeps its registration; the first 401 through the shim is
what discovers the redirect URI no longer matches, which is the same recovery path a revoked
token takes. Rows whose `mcp_server_id` names nothing count as `orphaned`, not fatal.

### 8. What does not change

`agent/src/mcp.ts`. The harness's own runtime keeps building a plain
`StreamableHTTPClientTransport` from a URL and headers, because that is all the shim ever
hands it. Giving the agent its own `authProvider` for standalone use is a separate, later
question and explicitly out of scope here.

---

## Phases

1. **Storage + discovery.** The column, the table, `pnpm db:push`, `mcp-oauth.ts` with
   `probeMcpAuth` and the token helpers. No routes. Unit-testable on its own.
2. **The flow.** The three routes, the pending-state map, the callback page, `auth` on the
   list route. Verifiable by hand against a real provider before any agent is involved.
3. **The shim.** `mcp-shim.ts`, mounted, with refresh coalescing, the 401 retry and the SSE
   `endpoint` rewrite.
4. **Spawn.** `mcpServersFor`'s branch and `skipped`, threaded through `probe.ts` and
   `routines.ts`.
5. **Client.** The status pill, Connect/Disconnect, the form's Check, the tools read-out mark.
6. **Backup + tests.**

Phases 1–3 are useful before 4: a connected server that no thread uses yet is still a thing
the settings page can show working.

## Testing

`server/test/` gets `mcp-oauth.mjs` and a `pnpm test:mcp-oauth`, in the shape
`pnpm test:gateway` already has — a stand-in authorization server plus a stand-in protected
MCP server in-process:

- unauthenticated probe → 401 → PRM → AS metadata → `kind: "oauth"`
- DCR, authorize URL shape (PKCE `code_challenge`, `resource`, `state`), callback exchange
- a proxied `tools/list` carrying the right bearer, with the client's own header untouched
- an expired token refreshed exactly **once** under five concurrent requests
- upstream 401 → refresh → retry → success; and the second-401 path clearing the row
- the SSE `endpoint` rewrite pointing back through the proxy
- a wrong key, a replayed `state` and an expired `state` all refused
- an unauthorized server omitted from `mcpServersFor`, and present once connected

## Open questions

- **Which AS when PRM lists several.** First entry for now; a picker is a real UI question
  and no server we have met lists more than one.
- **Scopes.** Request `scopes_supported` wholesale, or nothing at all and let the AS decide?
  Requesting everything is what the reference clients do and is the least surprising; a
  per-row scope field is a later refinement.
- **Client-credentials servers.** Some enterprise MCP servers want a machine flow with no
  browser. It fits the same table (no `redirectUri`, no browser hop) but is not in this plan.
- **Expiry as an event.** A token expiring while nobody is looking is invisible until the
  next tool call. The `quota` event is the precedent for a live-only absolute status fan-out
  if it turns out to matter; not worth it before it does.
