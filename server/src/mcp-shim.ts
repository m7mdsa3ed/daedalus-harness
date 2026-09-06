/* ── MCP OAuth shim ──
 *
 * `/mx/<key>/<serverId>/…` → the library row's real URL, with a fresh access
 * token attached.
 *
 * The same shape, and the same reasoning, as `gateway-shim.ts`: *the endpoint
 * and the credential are the shim's, not the child's*. An `http` MCP server
 * that demands OAuth is handed to the agent as this loopback URL, and the
 * token is resolved per request here — which buys four things that injecting a
 * bearer into the row's static headers at `session/new` cannot:
 *
 *  - **Every agent gets OAuth and none of them learn a word about it.**
 *    claude-agent-acp, codex-acp, opencode and the harness's own runtime all
 *    just see an HTTP MCP server with no auth. No per-agent knowledge, which
 *    is the standing rule; `agent/src/mcp.ts` does not change, which is the
 *    test of whether this is in the right place.
 *  - **Refresh is transparent and mid-turn.** Access tokens live an hour and a
 *    thread lives days: headers fixed at `session/new` would kill every tool
 *    on the server at the first refresh window, for the rest of the process,
 *    with no recovery short of a respawn. A credential that expires cannot be
 *    delivered as a constant.
 *  - **Revocation is immediate.** Disconnecting stops the next tool call
 *    rather than waiting for every thread holding it to respawn.
 *  - **A 401 is recoverable.** Upstream refuses → refresh once → retry. Only a
 *    second refusal is reported as a failure.
 *
 * The key in the path is the credential, exactly as `/gw/<key>/` and
 * `/ide/<key>/` are: minted per boot, never written to disk, and its only
 * readers are children this process spawns.
 *
 * The `resource` indicator is worth stating because the temptation is real:
 * tokens are bound to the *real* server's canonical URL, never the proxy's.
 * Nothing about being proxied changes what the upstream will accept.
 */
import { randomBytes } from "node:crypto";

import { mcpServers as mcpLibrary } from "./library.js";
import { accessTokenFor, mcpOauth, refreshTokens, safeParseUrl } from "./mcp-oauth.js";
import { safeKeyEqual } from "./gateway-shim.js";

/** Headers that describe a single connection and must not be forwarded. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

let shim: { key: string; port: number } | null = null;

/** Called once at boot with the port this server listens on. Until then
    `mcpProxyUrlFor` hands out nothing, which is what a test that never boots a
    server gets. */
export function configureMcpShim(opts: { port: number }): void {
  shim = { key: randomBytes(24).toString("hex"), port: opts.port };
}

/** The URL an agent is handed instead of the server's own, or `""` when there
    is no shim yet — in which case an OAuth server is simply not advertised
    (see `mcpServersFor`), because a URL with no credential on it cannot
    answer. */
export function mcpProxyUrlFor(serverId: string): string {
  if (!shim) return "";
  return `http://127.0.0.1:${shim.port}/mx/${shim.key}/${encodeURIComponent(serverId)}`;
}

/** `/mx/<key>/<serverId>/rest…` → its parts, or null when the shape is not
    ours. Dot segments are refused rather than normalised, exactly as the
    gateway path refuses them: rejoined verbatim they could walk the upstream
    URL out of the server's configured base. */
export function parseMcpPath(pathname: string): { key: string; serverId: string; rest: string } | null {
  if (!pathname.startsWith("/mx/")) return null;
  const [key, serverId, ...rest] = pathname.slice("/mx/".length).split("/");
  if (!key || !serverId) return null;
  for (const part of rest) {
    let decoded = part;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      /* malformed escapes stay raw — compared as-is below */
    }
    if (part === "." || part === ".." || decoded === "." || decoded === "..") return null;
  }
  return { key, serverId: decodeURIComponent(serverId), rest: rest.length ? `/${rest.join("/")}` : "" };
}

const notFound = (error: string) =>
  new Response(JSON.stringify({ error }), { status: 404, headers: { "content-type": "application/json" } });

const unauthorized = (error: string) =>
  new Response(JSON.stringify({ error }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });

/**
 * The legacy HTTP+SSE transport opens its stream with an `endpoint` event
 * carrying the URL for subsequent POSTs. Resolved against the proxy's origin
 * that path misses the `/mx/<key>/<serverId>` prefix entirely and the agent
 * posts into nothing — so this one event is rewritten back through the proxy.
 *
 * The only place the shim looks inside a body, and the exact shape
 * `renamespaceSse` already has: events split on the blank line, so a chunk
 * boundary inside one is buffered rather than mis-parsed, and whatever is left
 * at the end is flushed as it is.
 */
export function rewriteEndpointSse(prefix: string): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let done = false;
  const rewriteBlock = (block: string): string => {
    if (done) return block;
    const lines = block.split(/\r?\n/);
    if (!lines.some((line) => /^event:\s*endpoint\s*$/.test(line))) return block;
    return lines
      .map((line) => {
        if (!line.startsWith("data:")) return line;
        const value = line.slice("data:".length).trim();
        /* Only a same-origin path is ours to repair. An absolute URL to
           somewhere else is the server's own business and is left alone. */
        if (!value.startsWith("/")) return line;
        done = true;
        return `data: ${prefix}${value}`;
      })
      .join("\n");
  };
  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      for (;;) {
        const m = /\r?\n\r?\n/.exec(buffer);
        if (!m) break;
        const block = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);
        controller.enqueue(encoder.encode(rewriteBlock(block) + m[0]));
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) controller.enqueue(encoder.encode(rewriteBlock(buffer)));
    },
  });
}

/** How long the upstream gets to answer with *headers*. A streaming MCP
    response is open for as long as the tool takes, so there is no total
    deadline — but a server that never answers at all must not pin the
    request forever. */
const UPSTREAM_HEADERS_TIMEOUT_MS = 120_000;

/** Forward one request to the MCP server the path names, carrying the
    connection's own bearer. */
export async function proxyMcpRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const parsed = parseMcpPath(url.pathname);
  if (!parsed) return notFound("not an mcp path");
  /* A wrong key and an unknown server answer the same way, deliberately: a
     404 that distinguishes them is an oracle for guessing either. */
  if (!shim || !safeKeyEqual(parsed.key, shim.key)) return notFound("unknown mcp key");
  const server = mcpLibrary.list().find((s) => s.id === parsed.serverId);
  if (!server || server.type !== "http") return notFound("unknown mcp server");

  const token = await accessTokenFor(server.id);
  if (!token) {
    return unauthorized("this MCP server is not connected — authorize it in Settings › MCP servers");
  }

  const target = `${server.url.replace(/\/+$/, "")}${parsed.rest}${url.search}`;

  /* The body is read once, so the 401 retry can send it again — a stream can
     only be consumed once, and retrying is the whole point of this path. MCP
     requests are JSON-RPC calls: small by construction, unlike a model
     prompt, so buffering costs nothing here where it would cost a lot in the
     gateway shim. */
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();

  const send = async (bearer: string): Promise<Response> => {
    const headers = new Headers();
    req.headers.forEach((value, name) => {
      if (!HOP_BY_HOP.has(name.toLowerCase())) headers.set(name, value);
    });
    /* The user's own static headers still travel — a row may carry both a PAT
       for something else and an OAuth connection. The inbound `Authorization`
       is *dropped* rather than merged: whatever the child put there is not the
       credential this server wants. */
    for (const { name, value } of server.headers) headers.set(name, value);
    headers.set("authorization", `Bearer ${bearer}`);
    headers.delete("content-length");
    const connect = new AbortController();
    const timer = setTimeout(
      () => connect.abort(new Error(`the MCP server sent no response headers within ${UPSTREAM_HEADERS_TIMEOUT_MS}ms`)),
      UPSTREAM_HEADERS_TIMEOUT_MS,
    );
    try {
      return await fetch(target, {
        method: req.method,
        headers,
        ...(body ? { body } : {}),
        signal: connect.signal,
        redirect: "manual",
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let upstream: Response;
  try {
    upstream = await send(token);
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }

  /* Upstream refused: renew once and try again. A second refusal is the real
     answer — the tokens are cleared and `lastError` written so the settings
     row can say why instead of going quiet, and the 401 is returned so the
     agent reports a failure rather than hanging. */
  if (upstream.status === 401) {
    void upstream.body?.cancel();
    const row = mcpOauth.get(server.id);
    let renewed: string | null = null;
    if (row?.refreshToken) {
      try {
        renewed = (await refreshTokens(row)).accessToken;
      } catch {
        renewed = null;
      }
    }
    if (renewed) {
      try {
        upstream = await send(renewed);
      } catch (error) {
        return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      }
    }
    if (!renewed || upstream.status === 401) {
      void upstream.body?.cancel();
      mcpOauth.patch(server.id, {
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        lastError: "the MCP server refused this connection — reconnect it",
      });
      return unauthorized("this MCP server refused the connection — reconnect it in Settings › MCP servers");
    }
  }

  const out = new Headers();
  upstream.headers.forEach((value, name) => {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key)) return;
    // fetch already decoded the body; the old encoding and length would lie.
    if (key === "content-encoding" || key === "content-length") return;
    if (key === "location") return;
    out.append(name, value);
  });

  /* A redirect is not followed — the agent's transport is the one that decides
     whether to — but a same-origin `Location` has to come back through the
     proxy or the next hop leaves the tunnel and arrives with no credential. */
  const location = upstream.headers.get("location");
  if (location) out.set("location", rewriteLocation(location, server.url, parsed.serverId));

  const prefix = mcpProxyUrlFor(server.id);
  if (/text\/event-stream/i.test(upstream.headers.get("content-type") ?? "") && upstream.body && prefix) {
    return new Response(upstream.body.pipeThrough(rewriteEndpointSse(prefix)), { status: upstream.status, headers: out });
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

/** A `Location` that stays on the MCP server's own origin, put back through
    the proxy; anything else (an identity provider, a CDN) is left as it is. */
export function rewriteLocation(location: string, serverUrl: string, serverId: string): string {
  const base = safeParseUrl(serverUrl);
  if (!base) return location;
  const resolved = safeParseUrl(location, base);
  if (!resolved) return location;
  if (resolved.origin !== base.origin) return location;
  const prefix = mcpProxyUrlFor(serverId);
  if (!prefix) return location;
  /* The rest is relative to the server's configured base path, which is what
     the proxy's own prefix stands in for. */
  const basePath = base.pathname.replace(/\/+$/, "");
  const rest = resolved.pathname.startsWith(basePath) ? resolved.pathname.slice(basePath.length) : resolved.pathname;
  return `${prefix}${rest}${resolved.search}`;
}
