/* ── Reverse proxy ──
 *
 * The one place a browser request is turned into a loopback one. Two callers:
 * `ide-proxy.ts` (`/ide/<key>/…` → code-server, prefix stripped) and
 * `preview-proxy.ts` (`/preview/<key>/<projectId>/…` → a project's dev server,
 * prefix kept). Each decides *where* a request goes and *what path* it carries;
 * this file owns *how* it travels, so the header rules below exist exactly
 * once and a fix to one proxy cannot leave the other broken.
 *
 * Two halves, because a proxy that only does HTTP proxies a blank screen. VS
 * Code's entire editor session rides one WebSocket, and Vite's HMR is another;
 * the upgrade path is not an optional extra here the way it is for a REST
 * backend.
 *
 * **The header rules, all deliberate:**
 *
 * - *Hop-by-hop headers do not travel.* `connection`, `keep-alive`,
 *   `transfer-encoding` and friends describe one TCP hop; copying them onto
 *   the next one is how a proxy produces a response the client cannot frame.
 * - *`host` is rewritten to the loopback target.* Node's `fetch` and
 *   `http.request` set it from the URL once the incoming one is dropped, and
 *   both upstreams check it: code-server's origin guard and Vite's
 *   `allowedHosts` each refuse a request whose Host is not one of their own.
 * - *`x-frame-options` and `frame-ancestors` are dropped.* Both upstreams may
 *   refuse to be framed, which is right for the open internet and wrong for the
 *   one caller that exists here — a panel in this app, on a page that already
 *   holds the bearer token. Stripping it is a decision made on purpose at the
 *   only place that can make it, not an accident of copying headers.
 * - *`content-encoding` and `content-length` are dropped.* `fetch` decodes the
 *   upstream body per spec, so what this proxy forwards is already plain — but
 *   the headers still describe the compressed bytes. Passing `gzip` on makes
 *   the browser gunzip plaintext (`ERR_CONTENT_DECODING_FAILED`, on a 200), and
 *   passing the old length truncates whatever survives that.
 * - *`location` is the caller's to repair.* A redirect to `/…` is the upstream
 *   speaking in its own root, which may not be the browser's; the caller that
 *   strips a prefix is the one that knows what to put back.
 */
import type { IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import type { Duplex } from "node:stream";

/** Headers that describe a single connection and must not be forwarded. */
export const HOP_BY_HOP = new Set([
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

export interface ForwardTarget {
  /** Loopback port to reach. */
  port: number;
  /** The path (no query) the upstream is asked for. */
  path: string;
  /** Query string, `?…` or "". */
  search: string;
  /** Rewrite an absolute-path `location` the upstream answered with. Absent
      leaves it alone. */
  location?: (value: string) => string;
}

/**
 * Forward one ordinary request and hand back the `Response` for a Hono route.
 *
 * A connection failure is a 502 with the error's own words: the common way to
 * get one is an upstream that died between the lookup and the connect, and the
 * panel wants to say so rather than hang.
 */
export async function forwardRequest(req: Request, target: ForwardTarget): Promise<Response> {
  const url = new URL(req.url);
  const headers = new Headers();
  req.headers.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name.toLowerCase())) headers.set(name, value);
  });
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
  headers.set("x-forwarded-host", url.host);

  let upstream: Response;
  try {
    upstream = await fetch(`http://127.0.0.1:${target.port}${target.path}${target.search}`, {
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
    if (key === "x-frame-options") return;
    if (key === "content-security-policy" || key === "content-security-policy-report-only") {
      const stripped = value
        .split(";")
        .filter((directive) => !/^\s*frame-ancestors\b/i.test(directive))
        .join(";");
      if (stripped.trim()) out.set(name, stripped);
      return;
    }
    if (key === "location" && target.location && value.startsWith("/") && !value.startsWith("//")) {
      out.set(name, target.location(value));
      return;
    }
    out.append(name, value);
  });

  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export interface UpgradeTarget {
  port: number;
  path: string;
  search: string;
  /** Tell the upstream which host the browser was on (`x-forwarded-host`).
      code-server needs it for its origin check; Vite must NOT get it — its
      host check reads that header first and the browser's host is not one it
      allows. */
  forwardHost: boolean;
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
export function forwardUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  target: UpgradeTarget,
): void {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (name.toLowerCase() === "host") continue;
    headers[name] = value;
  }
  if (target.forwardHost && req.headers.host) headers["x-forwarded-host"] = req.headers.host;
  headers["x-forwarded-proto"] = "http";

  const proxied = httpRequest({
    host: "127.0.0.1",
    port: target.port,
    method: req.method,
    path: `${target.path || "/"}${target.search}`,
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
     upstream died between the lookup and the connect, or turned the socket
     down. Pass the status on rather than leaving a socket that never speaks. */
  proxied.on("response", (upstreamRes) => {
    socket.end(`HTTP/1.1 ${upstreamRes.statusCode ?? 502} Bad Gateway\r\nConnection: close\r\n\r\n`);
  });

  proxied.end();
}

/** A refusal on the raw socket, for an upgrade whose path names nothing. */
export function refuseUpgrade(socket: Duplex, status = 404): void {
  socket.end(`HTTP/1.1 ${status} ${status === 404 ? "Not Found" : "Service Unavailable"}\r\nConnection: close\r\n\r\n`);
}
