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
 * The transport — header rules, the raw-socket upgrade pipe — is
 * `reverse-proxy.ts`. What is this file's:
 *
 * - *`location` is re-prefixed.* A redirect to `/?folder=…` is code-server
 *   speaking in its own root, which is not the browser's; left alone it walks
 *   the iframe out of the prefix and loses the key with it.
 * - *The origin check.* code-server refuses a WebSocket whose `Origin` host is
 *   not its own host — the standard cross-site-hijack guard — and "its own
 *   host" is read from `x-forwarded-host` when a proxy sets it, else from
 *   `Host`. `Host` is rewritten to the loopback address by the connect, while
 *   `Origin` is still the harness's public address the browser was on, so
 *   without the forwarded host every browser upgrade came back 403 — relayed
 *   as a closed socket, which VS Code reports as "1006" and, from then on, as
 *   `ENOPRO` for every file it can no longer reach. curl never hit it, because
 *   curl sends no `Origin`.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { ideTarget } from "./ide.js";
import { forwardRequest, forwardUpgrade, refuseUpgrade } from "./reverse-proxy.js";

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
 * A key that names nothing is a 404 with a hint rather than a silent hang: the
 * common way to get here is an iframe still holding the prefix of an editor
 * that was swept, and "the editor is not running" is what the panel needs to
 * hear to offer to start it again.
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

  return forwardRequest(req, {
    port: target.port,
    path: parsed.rest,
    search: url.search,
    location: (value) => `/ide/${parsed.key}${value}`,
  });
}

/** Forward one WebSocket upgrade — see the origin-check note at the top. */
export function proxyIdeUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parsed = parseIdePath(url.pathname);
  const target = parsed ? ideTarget(parsed.key) : null;
  if (!parsed || !target) {
    refuseUpgrade(socket);
    return;
  }
  forwardUpgrade(req, socket, head, {
    port: target.port,
    path: parsed.rest || "/",
    search: url.search,
    forwardHost: true,
  });
}

const notFound = () => ({ status: 404, headers: { "content-type": "application/json" } }) as const;
