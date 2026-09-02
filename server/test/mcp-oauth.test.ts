// Self-check for MCP OAuth: discovery (401 → PRM → AS metadata), dynamic
// registration, the authorize URL's shape, the callback exchange, and the
// shim that carries the bearer — refresh coalescing, the 401 retry, the SSE
// `endpoint` rewrite, and the refusals a path-carried credential owes.
//
// Two stand-ins, both in-process: an authorization server that speaks RFC
// 8414 + 7591 + the two token grants, and a protected MCP server that answers
// 401 without a bearer and JSON-RPC with one.
// Run: pnpm test:mcp-oauth
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Hono } from "hono";
import { serve } from "@hono/node-server";

import { db, mcpOauth as mcpOauthTable, mcpServers as mcpServersTable } from "../src/db/index.js";
import { mcpServers as mcpLibrary } from "../src/library.js";
import { mcpServersFor } from "../src/sessions.js";
import { getConfig } from "../src/config.js";
import {
  accessTokenFor,
  authStateOf,
  canonicalResource,
  completeAuthorization,
  disconnectServer,
  isConnected,
  mcpOauth,
  newFlowState,
  parkPendingFlow,
  probeMcpAuth,
  registerMcpClient,
  takePendingFlow,
} from "../src/mcp-oauth.js";
import {
  configureMcpShim,
  mcpProxyUrlFor,
  parseMcpPath,
  proxyMcpRequest,
  rewriteEndpointSse,
} from "../src/mcp-shim.js";
import { startAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import { redirectBase } from "../src/routes/library.js";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
    })
    .catch((err) => {
      failures.push(`${name}\n    ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    });
}

/* ── the pure half ── */

await test("the proxy path grammar refuses a shape that is not ours, and dot segments", () => {
  assert.deepEqual(parseMcpPath("/mx/key/srv-1/messages"), { key: "key", serverId: "srv-1", rest: "/messages" });
  assert.deepEqual(parseMcpPath("/mx/key/srv%201"), { key: "key", serverId: "srv 1", rest: "" });
  assert.equal(parseMcpPath("/mx/key/srv/../../etc"), null);
  assert.equal(parseMcpPath("/mx/key/srv/%2e%2e"), null);
  assert.equal(parseMcpPath("/mx/key"), null);
  assert.equal(parseMcpPath("/api/mcp-servers"), null);
});

await test("the canonical resource drops a fragment and a bare trailing slash", () => {
  assert.equal(canonicalResource("https://mcp.example.com/"), "https://mcp.example.com");
  assert.equal(canonicalResource("https://mcp.example.com/mcp#x"), "https://mcp.example.com/mcp");
});

await test("a state is single-use and names its flow rather than being reflected into it", () => {
  const state = newFlowState();
  assert.match(state, /^[\w-]{43}$/);
  parkPendingFlow(state, { serverId: "s1", verifier: "v", redirectUri: "http://x/cb", resource: "https://r", issuer: "https://as" });
  assert.equal(takePendingFlow(state)?.serverId, "s1");
  // Replayed, it is simply not there any more.
  assert.equal(takePendingFlow(state), undefined);
  assert.equal(takePendingFlow("never-issued"), undefined);
});

await test("the legacy SSE endpoint event is rewritten back through the proxy, once", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode("event: endpoint\ndata: /messages?sessionId=a1\n\nevent: mes"));
      controller.enqueue(enc.encode('sage\ndata: {"jsonrpc":"2.0"}\n\nevent: endpoint\ndata: /messages?sessionId=b2\n\n'));
      controller.close();
    },
  });
  const out = await new Response(stream.pipeThrough(rewriteEndpointSse("http://127.0.0.1:1/mx/k/s1"))).text();
  assert.match(out, /data: http:\/\/127\.0\.0\.1:1\/mx\/k\/s1\/messages\?sessionId=a1/);
  // A chunk boundary inside an event is buffered, not mis-parsed.
  assert.match(out, /data: \{"jsonrpc":"2\.0"\}/);
  // Only the first one — a second `endpoint` is the server's business.
  assert.match(out, /data: \/messages\?sessionId=b2/);
});

await test("the redirect base comes from this server's own host, never the client's origin", () => {
  const req = (headers: Record<string, string>) => new Request("http://127.0.0.1:4001/api/x", { headers });
  /* The Vite dev server is a different origin to the API, and the callback
     route lives on the API — so `Origin` is exactly the wrong answer. */
  assert.equal(redirectBase(req({ host: "127.0.0.1:4001", origin: "http://localhost:5173" })), "http://127.0.0.1:4001");
  // A proxy knows the public scheme and host where `Host` may not.
  assert.equal(
    redirectBase(req({ host: "internal:4001", "x-forwarded-host": "daedalus.example.com", "x-forwarded-proto": "https" })),
    "https://daedalus.example.com",
  );
});

/* ── the stand-in authorization server ── */

interface Registration {
  client_id: string;
  redirect_uris: string[];
}
const registrations: Registration[] = [];
/** Issued access tokens, and whether each is still good. */
const issued = new Map<string, { refresh: string; expiresIn: number | null }>();
let refreshCalls = 0;
/** Set to make the protected server refuse the *next* bearer, so the shim's
    401 → refresh → retry path can be driven. */
let rejectBearer: string | null = null;
/** Refuse *every* bearer, so the shim's second-401 path can be driven: a
    refresh that succeeds still cannot buy a token this server will take. */
let refuseAll = false;
let revoked: string[] = [];
let tokenCounter = 0;

const asServer = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${asPort}`);
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(200, {
        issuer: `http://127.0.0.1:${asPort}`,
        authorization_endpoint: `http://127.0.0.1:${asPort}/authorize`,
        token_endpoint: `http://127.0.0.1:${asPort}/token`,
        registration_endpoint: `http://127.0.0.1:${asPort}/register`,
        revocation_endpoint: `http://127.0.0.1:${asPort}/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["read", "write"],
      });
    }
    if (url.pathname === "/register") {
      const parsed = JSON.parse(body) as Registration;
      const client_id = `client-${registrations.length + 1}`;
      registrations.push({ ...parsed, client_id });
      return json(201, { ...parsed, client_id, client_id_issued_at: Math.floor(Date.now() / 1000) });
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(body);
      if (form.get("grant_type") === "refresh_token") refreshCalls += 1;
      const access = `access-${++tokenCounter}`;
      const refresh = `refresh-${tokenCounter}`;
      issued.set(access, { refresh, expiresIn: 3600 });
      return json(200, { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: "read write" });
    }
    if (url.pathname === "/revoke") {
      revoked.push(new URLSearchParams(body).get("token") ?? "");
      return json(200, {});
    }
    res.writeHead(404).end();
  });
});
await new Promise<void>((r) => asServer.listen(0, "127.0.0.1", r));
const asPort = (asServer.address() as { port: number }).port;

/* ── the stand-in protected MCP server ── */

const mcpSeen: { path: string; auth: string | undefined; extra: string | undefined; body: string }[] = [];
const mcpServer = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${mcpPort}`);
    const auth = req.headers.authorization;
    /* RFC 9728's document sits at the *origin* root while the server itself
       lives under /mcp, and it is public — answered before the auth check,
       which is exactly what makes the 401 chain followable. */
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          resource: `http://127.0.0.1:${mcpPort}/mcp`,
          authorization_servers: [`http://127.0.0.1:${asPort}`],
          scopes_supported: ["read", "write"],
        }),
      );
    }
    mcpSeen.push({ path: url.pathname + url.search, auth, extra: req.headers["x-tenant"] as string | undefined, body });
    const bearer = auth?.replace(/^Bearer /, "");
    if (refuseAll || !bearer || !issued.has(bearer) || bearer === rejectBearer) {
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": `Bearer resource_metadata="http://127.0.0.1:${mcpPort}/.well-known/oauth-protected-resource"`,
      });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    if (url.pathname === "/mcp/sse") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      return res.end("event: endpoint\ndata: /mcp/messages?sessionId=s9\n\n");
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "search" }] } }));
  });
});
await new Promise<void>((r) => mcpServer.listen(0, "127.0.0.1", r));
const mcpPort = (mcpServer.address() as { port: number }).port;

const resourceUrl = `http://127.0.0.1:${mcpPort}/mcp`;

/* ── discovery ── */

let probed: Awaited<ReturnType<typeof probeMcpAuth>>;

await test("an unauthenticated probe follows 401 → PRM → AS metadata", async () => {
  /* The challenge names the metadata document, which is the path a real
     server takes; the well-known fallbacks are for servers that name none. */
  probed = await probeMcpAuth(resourceUrl);
  assert.equal(probed.kind, "oauth");
  if (probed.kind !== "oauth") return;
  assert.equal(probed.issuer, `http://127.0.0.1:${asPort}`);
  assert.equal(probed.metadata.token_endpoint, `http://127.0.0.1:${asPort}/token`);
  assert.deepEqual(probed.scopesSupported, ["read", "write"]);
});

await test("a server that answers unauthenticated is `none`, and anything else is reported verbatim", async () => {
  const open = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
  });
  await new Promise<void>((r) => open.listen(0, "127.0.0.1", r));
  const openPort = (open.address() as { port: number }).port;
  assert.deepEqual(await probeMcpAuth(`http://127.0.0.1:${openPort}/mcp`), { kind: "none" });
  open.close();

  /* A 403 from a corporate proxy must not read as "needs OAuth". */
  const forbidden = createServer((_req, res) => {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("blocked by policy");
  });
  await new Promise<void>((r) => forbidden.listen(0, "127.0.0.1", r));
  const fPort = (forbidden.address() as { port: number }).port;
  const answer = await probeMcpAuth(`http://127.0.0.1:${fPort}/mcp`);
  assert.equal(answer.kind, "unknown");
  if (answer.kind === "unknown") {
    assert.equal(answer.status, 403);
    assert.match(answer.detail, /blocked by policy/);
  }
  forbidden.close();
});

/* ── registration, the authorize URL, the exchange ── */

const rowId = "mcp-oauth-test";
db.delete(mcpOauthTable).run();
db.delete(mcpServersTable).where((await import("drizzle-orm")).eq(mcpServersTable.id, rowId)).run();
db.insert(mcpServersTable)
  .values({ id: rowId, type: "http", name: "protected", url: resourceUrl, headers: [{ name: "x-tenant", value: "acme" }], auth: "oauth" })
  .run();

let redirectUri = "";

await test("dynamic registration, then an authorize URL carrying PKCE, the resource and the state", async () => {
  if (probed.kind !== "oauth") throw new Error("probe did not report oauth");
  redirectUri = "http://127.0.0.1:9999/oauth/mcp/callback";
  const client = await registerMcpClient(probed.metadata, redirectUri, probed.scopesSupported.join(" "));
  assert.equal(registrations.length, 1);
  assert.deepEqual(registrations[0]!.redirect_uris, [redirectUri]);

  const row = mcpOauth.put({
    mcpServerId: rowId,
    resource: probed.resource,
    issuer: probed.issuer,
    metadata: probed.metadata,
    clientId: client.client_id,
    clientSecret: client.client_secret ?? null,
    redirectUri,
    scope: "read write",
    accessToken: null,
    refreshToken: null,
    expiresAt: null,
    lastError: null,
  });

  const state = newFlowState();
  const { authorizationUrl, codeVerifier } = await startAuthorization(row.issuer, {
    metadata: row.metadata,
    clientInformation: { client_id: row.clientId },
    redirectUrl: redirectUri,
    state,
    resource: new URL(row.resource),
    scope: "read write",
  });
  const q = authorizationUrl.searchParams;
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.ok(q.get("code_challenge"));
  assert.equal(q.get("state"), state);
  // RFC 8707: bound to the real server, never the proxy.
  assert.equal(q.get("resource"), resourceUrl);
  assert.equal(q.get("redirect_uri"), redirectUri);

  parkPendingFlow(state, { serverId: rowId, verifier: codeVerifier, redirectUri, resource: row.resource, issuer: row.issuer });
  const flow = takePendingFlow(state)!;
  const after = await completeAuthorization(row, "the-code", flow.verifier, flow.redirectUri);
  assert.ok(after.accessToken);
  assert.ok(after.refreshToken);
  assert.ok(after.expiresAt && after.expiresAt > Date.now());
  assert.equal(isConnected(rowId), true);
  const state2 = authStateOf(rowId, "oauth");
  assert.equal(state2.kind === "oauth" ? state2.state : state2.kind, "connected");
});

/* ── the shim ── */

const app = new Hono();
app.all("/mx/*", (c) => proxyMcpRequest(c.req.raw));
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise<void>((r) => server.once("listening", r));
const shimPort = (server.address() as { port: number }).port;
configureMcpShim({ port: shimPort });
const proxied = mcpProxyUrlFor(rowId);

await test("a proxied call carries the bearer, keeps the row's own headers, and drops the child's", async () => {
  const res = await fetch(proxied, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer whatever-the-child-had" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json() as { result: unknown }).result, { tools: [{ name: "search" }] });
  const last = mcpSeen.at(-1)!;
  assert.equal(last.auth, `Bearer ${mcpOauth.get(rowId)!.accessToken}`);
  assert.equal(last.extra, "acme", "the user's own static header still travels");
  assert.equal(last.path, "/mcp");
});

await test("a wrong key is a 404 that says nothing, and so is an unknown server", async () => {
  const badKey = proxied.replace(/\/mx\/[0-9a-f]+\//, "/mx/0000/");
  assert.equal((await fetch(badKey)).status, 404);
  const badServer = `${proxied.slice(0, proxied.lastIndexOf("/"))}/no-such-server`;
  assert.equal((await fetch(badServer)).status, 404);
});

await test("an expired token is refreshed exactly once under five concurrent requests", async () => {
  refreshCalls = 0;
  mcpOauth.patch(rowId, { expiresAt: Date.now() - 1000 });
  const before = mcpOauth.get(rowId)!.accessToken;
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      fetch(proxied, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }).then((r) => r.status),
    ),
  );
  assert.deepEqual(results, [200, 200, 200, 200, 200]);
  // A refresh token is frequently single-use: two concurrent refreshes is how
  // an account ends up disconnected.
  assert.equal(refreshCalls, 1);
  assert.notEqual(mcpOauth.get(rowId)!.accessToken, before);
});

await test("an upstream 401 is refreshed once and retried", async () => {
  refreshCalls = 0;
  rejectBearer = mcpOauth.get(rowId)!.accessToken;
  const res = await fetch(proxied, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(res.status, 200);
  assert.equal(refreshCalls, 1);
  rejectBearer = null;
});

await test("a second 401 clears the connection and reports it, rather than hanging", async () => {
  /* Every bearer refused — including the one the refresh mints — so the retry
     is refused too and the shim has to give up rather than loop. */
  refuseAll = true;
  const res = await fetch(proxied, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(res.status, 401);
  const row = mcpOauth.get(rowId)!;
  assert.equal(row.accessToken, null);
  assert.equal(row.refreshToken, null);
  assert.match(row.lastError ?? "", /refused/);
  assert.equal(isConnected(rowId), false);
  assert.equal(await accessTokenFor(rowId), null);
  refuseAll = false;
});

await test("an unauthorized server is not advertised at spawn; a connected one is, as the proxy", async () => {
  const links = { mcpServerIds: [rowId] };
  const project = { id: "proj-1" };
  const off = mcpServersFor(links, project, getConfig());
  assert.deepEqual(off.servers, [], "a tool that cannot answer is not offered");
  assert.deepEqual(off.skipped, [rowId]);

  // Reconnect, and it comes back — as the shim's URL, never its own.
  mcpOauth.patch(rowId, { accessToken: "access-manual", refreshToken: "refresh-manual", expiresAt: Date.now() + 3600_000, lastError: null });
  issued.set("access-manual", { refresh: "refresh-manual", expiresIn: 3600 });
  const on = mcpServersFor(links, project, getConfig());
  assert.equal(on.servers.length, 1);
  assert.deepEqual(on.skipped, []);
  const [only] = on.servers as { type: string; url: string; headers: { name: string }[] }[];
  assert.equal(only!.url, proxied);
  assert.notEqual(only!.url, resourceUrl);
  assert.deepEqual(only!.headers.map((h) => h.name), ["x-tenant"]);

  // A row that does not use OAuth is handed its own URL exactly as before.
  const plain = mcpLibrary.create({ type: "http", name: "plain", url: "https://plain.example/mcp", headers: [], auth: "none" });
  const both = mcpServersFor({ mcpServerIds: [plain.id] }, project, getConfig());
  assert.equal((both.servers[0] as { url: string }).url, "https://plain.example/mcp");
  mcpLibrary.remove(plain.id);
});

await test("the legacy transport's endpoint event comes back through the proxy", async () => {
  const res = await fetch(`${proxied}/sse`);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes(`data: ${proxied}/mcp/messages?sessionId=s9`), text);
});

await test("disconnecting revokes what it can and always forgets locally", async () => {
  revoked = [];
  const result = await disconnectServer(rowId);
  assert.equal(result.revoked, true);
  assert.ok(revoked.length > 0);
  assert.equal(mcpOauth.get(rowId), undefined);
  const after = authStateOf(rowId, "oauth");
  assert.equal(after.kind === "oauth" ? after.state : after.kind, "disconnected");
});

await test("deleting the server takes its tokens with it", () => {
  mcpOauth.put({
    mcpServerId: rowId,
    resource: resourceUrl,
    issuer: `http://127.0.0.1:${asPort}`,
    metadata: { issuer: `http://127.0.0.1:${asPort}`, authorization_endpoint: "x", token_endpoint: "y" } as never,
    clientId: "c",
    clientSecret: null,
    redirectUri,
    scope: null,
    accessToken: "a",
    refreshToken: "r",
    expiresAt: null,
    lastError: null,
  });
  assert.ok(mcpOauth.get(rowId));
  mcpLibrary.remove(rowId);
  assert.equal(mcpOauth.get(rowId), undefined, "ON DELETE CASCADE");
});

server.close();
asServer.close();
mcpServer.close();

console.log(`mcp-oauth: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
