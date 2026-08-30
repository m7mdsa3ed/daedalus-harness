/* ── IDE proxy ──
 *
 * `/ide/<key>/…` → the loopback code-server that `key` names.
 *
 * This is the only door to an editor process: `ide.ts` binds them to
 * `127.0.0.1` on an ephemeral port precisely so that nothing but this file can
 * reach one. The prefix is stripped before forwarding, which is the sub-path
 * shape code-server documents (`uri strip_prefix /code` in their Caddy recipe)
 * — its own asset URLs are relative, so the browser puts the prefix back on
 * every one of them without code-server needing to know it exists.
 *
 * Two halves, because a proxy that only does HTTP proxies a blank screen. VS
 * Code's entire editor session — the extension host, the file watcher, every
 * keystroke — rides one WebSocket, so the upgrade path is not an optional
 * extra here the way it is for a REST backend.
 *
 * **Three header rules, all deliberate:**
 *
 * - *Hop-by-hop headers do not travel.* `connection`, `keep-alive`,
 *   `transfer-encoding` and friends describe one TCP hop; copying them onto
 *   the next one is how a proxy produces a response the client cannot frame.
 * - *`x-frame-options` and `frame-ancestors` are dropped.* code-server refuses
 *   to be framed, which is right for the open internet and wrong for the one
 *   caller that exists here — a panel in this app, on a page that already holds
 *   the bearer token. Stripping it is a decision made on purpose at the only
 *   place that can make it, not an accident of copying headers.
 * - *`location` is re-prefixed.* A redirect to `/?folder=…` is code-server
 *   speaking in its own root, which is not the browser's; left alone it walks
 *   the iframe out of the prefix and loses the key with it.
 * - *`content-encoding` and `content-length` are dropped.* `fetch` decodes the
 *   upstream body per spec, so what this proxy forwards is already plain — but
 *   the headers still describe the compressed bytes. Passing `gzip` on makes
 *   the browser gunzip plaintext (`ERR_CONTENT_DECODING_FAILED`, on a 200), and
 *   passing the old length truncates whatever survives that.
 */
import type { IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import type { Duplex } from "node:stream";

import { ideTarget } from "./ide.js";

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

/** `/ide/<key>/rest…` → its parts, or null when the shape is not ours. */
export function parseIdePath(pathname: string): { key: string; rest: string } | null {
  if (!pathname.startsWith("/ide/")) return null;
  const after = pathname.slice("/ide/".length);
  const slash = after.indexOf("/");
  const key = slash === -1 ? after : after.slice(0, slash);
  if (!key) return null;
  return { key, rest: slash === -1 ? "" : after.slice(slash) };
}

/**
 * Forward one ordinary request.
 *
 * Returns a `Response` for the Hono route to hand back. A key that names
 * nothing is a 404 with a hint rather than a silent hang: the common way to
 * get here is an iframe still holding the prefix of an editor that was swept,
 * and "the editor is not running" is what the panel needs to hear to offer to
 * start it again.
 */
export async function proxyIdeRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const parsed = parseIdePath(url.pathname);
  if (!parsed) return new Response(JSON.stringify({ error: "not an ide path" }), notFound());

  const target = ideTarget(parsed.key);
  if (!target)
    return new Response(JSON.stringify({ error: "that editor is not running" }), notFound());

  /* `/ide/<key>` with no trailing slash would make every relative asset resolve
     against `/ide/`, one level too high, and the key would fall off the first
     request. Redirect rather than paper over it. */
  if (parsed.rest === "")
    return new Response(null, {
      status: 308,
      headers: { location: `/ide/${parsed.key}/${url.search}` },
    });

  const headers = new Headers();
  req.headers.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name.toLowerCase())) headers.set(name, value);
  });
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
  headers.set("x-forwarded-host", url.host);

  let upstream: Response;
  try {
    upstream = await fetch(`http://127.0.0.1:${target.port}${parsed.rest}${url.search}`, {
      method: req.method,
      headers,
      body: req.body,
      // Streaming a request body without buffering it needs this; without it
      // Node's fetch refuses a ReadableStream body outright.
      ...(req.body ? { duplex: "half" } : {}),
      redirect: "manual",
    } as RequestInit);
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }

  const out = new Headers();
  upstream.headers.forEach((value, name) => {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key)) return;
    // The body has already been decoded on the way in — see the header rules.
    if (key === "content-encoding" || key === "content-length") return;
    // See the header rules at the top of the file.
    if (key === "x-frame-options") return;
    if (key === "content-security-policy" || key === "content-security-policy-report-only") {
      const stripped = value
        .split(";")
        .filter((directive) => !/^\s*frame-ancestors\b/i.test(directive))
        .join(";");
      if (stripped.trim()) out.set(name, stripped);
      return;
    }
    if (key === "location" && value.startsWith("/") && !value.startsWith("//")) {
      out.set(name, `/ide/${parsed.key}${value}`);
      return;
    }
    out.append(name, value);
  });

  return new Response(upstream.body, { status: upstream.status, headers: out });
}

/**
 * Forward one WebSocket upgrade.
 *
 * Raw sockets rather than a second `ws` server: this end has nothing to say
 * about the protocol. Parsing the frames only to re-encode them would cost a
 * copy per keystroke and add a place for a subprotocol or a `permessage-deflate`
 * negotiation to be mistranslated. The handshake is replayed byte for byte and
 * the two sockets are piped together.
 */
export function proxyIdeUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parsed = parseIdePath(url.pathname);
  const target = parsed ? ideTarget(parsed.key) : null;
  if (!parsed || !target) {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }

  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (name.toLowerCase() === "host") continue;
    headers[name] = value;
  }
  /* **The origin check is the one header rule this path cannot skip.**
     code-server refuses a WebSocket whose `Origin` host is not its own host —
     the standard cross-site-hijack guard — and "its own host" is read from
     `x-forwarded-host` when a proxy sets it, else from `Host`. `Host` here is
     rewritten to the loopback address by the connect below, while `Origin` is
     still the harness's public address the browser was on, so without the
     forwarded host every browser upgrade came back 403 — relayed as a closed
     socket, which VS Code reports as "1006" and, from then on, as `ENOPRO`
     for every file it can no longer reach. curl never hit it, because curl
     sends no `Origin`. */
  if (req.headers.host) headers["x-forwarded-host"] = req.headers.host;
  headers["x-forwarded-proto"] = "http";

  const proxied = httpRequest({
    host: "127.0.0.1",
    port: target.port,
    method: req.method,
    path: `${parsed.rest || "/"}${url.search}`,
    headers,
  });

  /* Bytes the client already sent past the handshake belong to the tunnel, not
     to the request being replayed upstream — put them back at the front of the
     client socket so the pipe below carries them in order. */
  if (head?.length) socket.unshift(head);

  const bail = () => {
    if (!socket.destroyed) socket.destroy();
  };

  proxied.on("error", bail);
  proxied.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
    const lines = [`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}`];
    for (const [name, value] of Object.entries(upstreamRes.headers)) {
      if (value === undefined) continue;
      for (const single of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${single}`);
    }
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    if (upstreamHead?.length) socket.write(upstreamHead);
    upstreamSocket.on("error", bail);
    socket.on("error", () => upstreamSocket.destroy());
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });
  /* An upgrade that comes back as an ordinary response is a refusal — the
     editor died between the lookup and the connect. Pass the status on rather
     than leaving a socket that never speaks. */
  proxied.on("response", (upstreamRes) => {
    socket.end(`HTTP/1.1 ${upstreamRes.statusCode ?? 502} Bad Gateway\r\nConnection: close\r\n\r\n`);
  });

  proxied.end();
}

const notFound = () => ({ status: 404, headers: { "content-type": "application/json" } }) as const;
