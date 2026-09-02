/* ── Preview proxy ──
 *
 * `/preview/<key>/<projectId>/…` → the loopback dev server `dev-server.ts`
 * runs for that project.
 *
 * **The key is the credential.** The preview is an iframe, and an iframe cannot
 * send the bearer token; what it *can* repeat on every asset, fetch and HMR
 * socket is the path prefix it was loaded under. So the prefix carries 24
 * random bytes minted per boot and never stored — exactly `/gw/<key>/` and
 * `/ide/<key>/` — compared in constant time, and registered outside `/api/*`
 * so the bearer middleware does not stand in front of it. A restart mints a
 * new key, which is fine: it restarts every dev server too, and the panel
 * re-reads `DevStatus.url` rather than persisting the old one.
 *
 * **The prefix is kept, not stripped.** Unlike code-server, a Vite app cannot
 * be served under a path it does not know about — its asset URLs are absolute
 * (`/assets/…`, `/@vite/client`, `/src/main.tsx`). So the dev server is told
 * the prefix as `BASE_PATH` (Vite's `base`), the path is forwarded unchanged,
 * and everything the app emits already carries the prefix. The one thing the
 * upstream must not see is the browser's `Host`, which Vite's `allowedHosts`
 * refuses; the transport rewrites it to the loopback address.
 *
 * **One script is injected.** An HTML answer gets `preview-bridge.ts` inserted
 * right after `<head>`, served from under the same prefix so the sandboxed
 * frame can load it as a same-path asset. That is the whole channel between
 * the app being built and the panel around it — navigation, errors, the
 * element picker. Nothing else about the response is touched.
 *
 * **Not ready is a page, not an error.** While the server installs or starts,
 * the frame holds a self-contained "Starting…" page that reloads itself; once
 * it is off, failed or exited, a page that says so and stays put — the panel
 * beside it has the real controls, and a reload loop against a server that is
 * not coming back is just noise in the log.
 */
import type { IncomingMessage } from "node:http";
import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";

import { safeKeyEqual } from "./gateway-shim.js";
import type { DevState } from "./protocol.js";
import { PREVIEW_BRIDGE_JS } from "./preview-bridge.js";
import { forwardRequest, forwardUpgrade, refuseUpgrade } from "./reverse-proxy.js";

/** What the proxy needs to know about a project's dev server, right now. */
export interface PreviewTarget {
  state: DevState;
  port: number | null;
  message: string | null;
}

type PreviewResolver = (projectId: string) => PreviewTarget | null;

/* The manager hands its lookup over at module load (`dev-server.ts` imports
   this file, not the other way round, so there is no cycle); until it does,
   every project is "off" — which is what a test that drives the proxy alone
   replaces with its own answer. */
let resolve: PreviewResolver = () => null;

export function setPreviewResolver(fn: PreviewResolver): void {
  resolve = fn;
}

const KEY = randomBytes(24).toString("hex");
const BRIDGE_PATH = "/__daedalus/bridge.js";

/** The prefix a project's preview answers under — `DevStatus.url`, and the
    `BASE_PATH` its dev server is spawned with. Trailing slash included. */
export function previewBase(projectId: string): string {
  return `/preview/${KEY}/${encodeURIComponent(projectId)}/`;
}

/** `/preview/<key>/<projectId>/rest…` → its parts, or null when the shape is
    not ours. `rest` is "" for the slash-less form and "/" for the root. The
    key is only *parsed* here; whether it is the right one is `previewTarget`. */
export function parsePreviewPath(
  pathname: string,
): { key: string; projectId: string; rest: string } | null {
  if (!pathname.startsWith("/preview/")) return null;
  const after = pathname.slice("/preview/".length);
  const firstSlash = after.indexOf("/");
  if (firstSlash <= 0) return null;
  const key = after.slice(0, firstSlash);
  const remainder = after.slice(firstSlash + 1);
  const secondSlash = remainder.indexOf("/");
  const projectId = decodeURIComponent(secondSlash === -1 ? remainder : remainder.slice(0, secondSlash));
  if (!projectId) return null;
  return { key, projectId, rest: secondSlash === -1 ? "" : remainder.slice(secondSlash) };
}

/** The dev server behind a parsed path, or null for a key that is not this
    boot's. Compared in constant time: the key is the route's whole credential. */
function previewTarget(parsed: { key: string; projectId: string }): PreviewTarget | null {
  if (!safeKeyEqual(parsed.key, KEY)) return null;
  return resolve(parsed.projectId) ?? { state: "off", port: null, message: null };
}

/** Forward one ordinary request, or answer it here: the bridge script, a
    redirect to the slash form, and the holding pages for a server that is not
    answering yet. */
export async function proxyPreviewRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const parsed = parsePreviewPath(url.pathname);
  const target = parsed ? previewTarget(parsed) : null;
  if (!parsed || !target) return json(404, { error: "no such preview" });

  /* `/preview/<key>/<id>` with no trailing slash: the app's `BASE_PATH` ends in
     one, and Vite answers its shell only at exactly that path. */
  if (parsed.rest === "")
    return new Response(null, {
      status: 308,
      headers: { location: `${previewBase(parsed.projectId)}${url.search}` },
    });

  if (parsed.rest === BRIDGE_PATH)
    return new Response(PREVIEW_BRIDGE_JS, {
      status: 200,
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      },
    });

  if (target.state !== "ready" || target.port === null) return holdingPage(target);

  const upstream = await forwardRequest(req, {
    port: target.port,
    path: url.pathname,
    search: url.search,
  });
  const type = upstream.headers.get("content-type") ?? "";
  if (!/^text\/html\b/i.test(type)) return upstream;

  /* The one rewrite. Read whole rather than streamed: an HTML shell is a few
     kilobytes, and a streaming injector that has to find `<head>` across chunk
     boundaries is a parser for a problem that does not exist. */
  const html = injectBridge(await upstream.text(), `${previewBase(parsed.projectId)}__daedalus/bridge.js`);
  const headers = new Headers(upstream.headers);
  headers.delete("content-length");
  return new Response(html, { status: upstream.status, headers });
}

/** Put the bridge `<script>` right after `<head>`; failing that, at the top of
    `<body>`; failing that, in front of everything. Exported for the test. */
export function injectBridge(html: string, src: string): string {
  const tag = `<script src="${src}"></script>`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  const body = /<body(\s[^>]*)?>/i.exec(html);
  if (body) {
    const at = body.index + body[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  return tag + html;
}

/** Forward one WebSocket upgrade — Vite's HMR socket, at the app's base path
    with the `vite-hmr` subprotocol. Same transport as the editor's, minus the
    forwarded host (see `UpgradeTarget.forwardHost`). */
export function proxyPreviewUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parsed = parsePreviewPath(url.pathname);
  const target = parsed ? previewTarget(parsed) : null;
  if (!parsed || !target) {
    refuseUpgrade(socket, 404);
    return;
  }
  if (target.state !== "ready" || target.port === null) {
    refuseUpgrade(socket, 503);
    return;
  }
  forwardUpgrade(req, socket, head, {
    port: target.port,
    path: url.pathname,
    search: url.search,
    forwardHost: false,
  });
}

/* ── Holding pages ──
   Self-contained on purpose: no stylesheet, no font, no script from anywhere —
   the frame is sandboxed and the only origin it could fetch from is this one,
   through the very proxy that is saying "not yet". */

function holdingPage(target: PreviewTarget): Response {
  const waiting = target.state === "installing" || target.state === "starting";
  const title = waiting
    ? target.state === "installing"
      ? "Installing dependencies…"
      : "Starting…"
    : target.state === "failed"
      ? "The dev server failed to start"
      : target.state === "exited"
        ? "The dev server has exited"
        : "The dev server is not running";
  const detail = waiting
    ? "The preview will appear as soon as the app answers."
    : target.message
      ? escapeHtml(target.message)
      : "Use the controls in the panel to start it.";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>${
    waiting ? '<meta http-equiv="refresh" content="2">' : ""
  }<meta name="viewport" content="width=device-width,initial-scale=1"><style>
html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#555;background:#fafafa}
main{text-align:center;max-width:32rem;padding:2rem}h1{font-size:1.1rem;font-weight:600;color:#222;margin:0 0 .5rem}p{margin:0;white-space:pre-wrap;word-break:break-word}
.spin{width:22px;height:22px;border:2px solid #ddd;border-top-color:#3b82f6;border-radius:50%;margin:0 auto 1rem;animation:s .8s linear infinite}@keyframes s{to{transform:rotate(360deg)}}
@media(prefers-color-scheme:dark){body{background:#111;color:#aaa}h1{color:#eee}.spin{border-color:#333;border-top-color:#60a5fa}}
</style></head><body><main>${waiting ? '<div class="spin"></div>' : ""}<h1>${escapeHtml(title)}</h1><p>${detail}</p></main></body></html>`;
  return new Response(html, {
    status: 503,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-daedalus-preview": target.state,
    },
  });
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
