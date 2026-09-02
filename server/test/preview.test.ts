// Self-check for the preview proxy: the path grammar, the per-boot key, the
// holding pages, the bridge injection and the header rules — against a
// stand-in dev server on node:http that echoes what it was asked and accepts
// an HMR-shaped WebSocket at its base path. Then the dev-server manager end to
// end: a real PTY running a tiny node server, watched to `ready`, reached
// through the proxy, and stopped.
// Run: pnpm test:preview
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { WebSocket, WebSocketServer } from "ws";

import {
  injectBridge,
  parsePreviewPath,
  previewBase,
  proxyPreviewRequest,
  proxyPreviewUpgrade,
  setPreviewResolver,
  type PreviewTarget,
} from "../src/preview-proxy.js";
import { PREVIEW_BRIDGE_JS } from "../src/preview-bridge.js";
import { DATA_DIR } from "../src/config.js";
import { createProject, deleteProject } from "../src/projects.js";
import {
  devStatus,
  startDevServer,
  stopDevServer,
  subscribeDevStatus,
  stopAllDevServers,
} from "../src/dev-server.js";
import { killProjectTerminals } from "../src/terminals.js";
import type { DevStatus } from "../src/protocol.js";

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

const PROJECT = "proj-1";
const base = previewBase(PROJECT);
const key = base.split("/")[2]!;

await test("previewBase is /preview/<key>/<projectId>/ and parses back", () => {
  assert.match(base, /^\/preview\/[0-9a-f]{48}\/proj-1\/$/);
  assert.deepEqual(parsePreviewPath(base), { key, projectId: PROJECT, rest: "/" });
  assert.deepEqual(parsePreviewPath(`${base}src/main.tsx`), { key, projectId: PROJECT, rest: "/src/main.tsx" });
  assert.deepEqual(parsePreviewPath(`/preview/${key}/${PROJECT}`), { key, projectId: PROJECT, rest: "" });
  assert.equal(parsePreviewPath("/preview/"), null);
  assert.equal(parsePreviewPath(`/preview/${key}`), null);
  assert.equal(parsePreviewPath("/ide/x/"), null);
});

await test("the bridge goes after <head>, else into <body>, else in front", () => {
  const tag = '<script src="/p/__daedalus/bridge.js"></script>';
  assert.equal(
    injectBridge('<!doctype html><html><head lang="en"><title>t</title></head><body></body></html>', "/p/__daedalus/bridge.js"),
    `<!doctype html><html><head lang="en">${tag}<title>t</title></head><body></body></html>`,
  );
  assert.equal(injectBridge("<html><body>x</body></html>", "/p/__daedalus/bridge.js"), `<html><body>${tag}x</body></html>`);
  assert.equal(injectBridge("plain", "/p/__daedalus/bridge.js"), `${tag}plain`);
});

await test("the bridge script is plain JS that parses and posts the three message kinds", () => {
  new Function(PREVIEW_BRIDGE_JS); // throws on a syntax error
  for (const kind of ["daedalus:ready", "daedalus:error", "daedalus:pick", "daedalus:inspect", "daedalus:navigate", "daedalus:reload"])
    assert.ok(PREVIEW_BRIDGE_JS.includes(kind), kind);
  assert.ok(PREVIEW_BRIDGE_JS.includes("__reactFiber$"));
});

/* ── the fake dev server ── */

const HTML = '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>';
const gz = gzipSync(HTML);
const seen: Array<{ url: string; host: string | undefined }> = [];

const fake = createServer((req, res) => {
  seen.push({ url: req.url ?? "", host: req.headers.host });
  if (req.url === base) {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-encoding": "gzip",
      "content-length": String(gz.length),
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
    });
    res.end(gz);
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ url: req.url, host: req.headers.host }));
});
const hmr = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has("vite-hmr") ? "vite-hmr" : false) });
fake.on("upgrade", (req: IncomingMessage, socket, head) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname !== base) {
    socket.destroy();
    return;
  }
  hmr.handleUpgrade(req, socket, head, (ws) => {
    ws.on("message", (data) => ws.send(`echo:${String(data)}`));
  });
});
await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
const fakePort = (fake.address() as { port: number }).port;

/* ── the proxy in front of it ── */

const targets = new Map<string, PreviewTarget>();
setPreviewResolver((id) => targets.get(id) ?? null);

const app = new Hono();
app.all("/preview/*", (c) => proxyPreviewRequest(c.req.raw));
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise<void>((r) => server.once("listening", r));
server.on("upgrade", (req, socket, head) => {
  if (parsePreviewPath(new URL(req.url ?? "/", "http://x").pathname)) proxyPreviewUpgrade(req, socket, head);
  else socket.destroy();
});
const port = (server.address() as { port: number }).port;
const origin = `http://127.0.0.1:${port}`;

await test("a wrong key is a 404, before anything is looked up", async () => {
  targets.set(PROJECT, { state: "ready", port: fakePort, message: null });
  const res = await fetch(`${origin}/preview/${"0".repeat(48)}/${PROJECT}/`);
  assert.equal(res.status, 404);
  const res2 = await fetch(`${origin}/preview/${key.slice(0, 40)}/${PROJECT}/`);
  assert.equal(res2.status, 404);
});

await test("the slash-less form is redirected to the base, query kept", async () => {
  const res = await fetch(`${origin}/preview/${key}/${PROJECT}?a=1`, { redirect: "manual" });
  assert.equal(res.status, 308);
  assert.equal(res.headers.get("location"), `${base}?a=1`);
});

await test("starting answers a reloading holding page; failed one that stays put; off likewise", async () => {
  targets.set(PROJECT, { state: "starting", port: null, message: null });
  const starting = await fetch(`${origin}${base}`);
  assert.equal(starting.status, 503);
  assert.match(starting.headers.get("content-type") ?? "", /text\/html/);
  const text = await starting.text();
  assert.ok(text.includes('http-equiv="refresh"'));
  assert.ok(text.includes("Starting"));
  assert.ok(!/<(link|script)\s[^>]*src=|href=/i.test(text), "no external assets");

  targets.set(PROJECT, { state: "failed", port: null, message: "pnpm dev exited with code 1: <boom>" });
  const failed = await fetch(`${origin}${base}`);
  assert.equal(failed.status, 503);
  const ftext = await failed.text();
  assert.ok(!ftext.includes('http-equiv="refresh"'));
  assert.ok(ftext.includes("&lt;boom&gt;"), "message is escaped");

  targets.delete(PROJECT);
  const off = await fetch(`${origin}${base}`);
  assert.equal(off.status, 503);
  assert.equal(off.headers.get("x-daedalus-preview"), "off");
});

await test("the bridge is served by the proxy itself, no-store, whatever the state", async () => {
  targets.set(PROJECT, { state: "installing", port: null, message: null });
  const before = seen.length;
  const res = await fetch(`${origin}${base}__daedalus/bridge.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /javascript/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(await res.text(), PREVIEW_BRIDGE_JS);
  assert.equal(seen.length, before, "never forwarded");
});

await test("HTML gets the bridge tag after <head> and loses the encoding, length and framing headers", async () => {
  targets.set(PROJECT, { state: "ready", port: fakePort, message: null });
  const res = await fetch(`${origin}${base}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.startsWith(`<!doctype html><html><head><script src="${base}__daedalus/bridge.js"></script><meta`), html.slice(0, 120));
  assert.equal(res.headers.get("content-encoding"), null);
  assert.notEqual(res.headers.get("content-length"), String(gz.length));
  assert.equal(res.headers.get("x-frame-options"), null);
  assert.equal(res.headers.get("content-security-policy"), "default-src 'self'");
});

await test("the path travels unchanged with its query, and Host is the loopback target", async () => {
  const res = await fetch(`${origin}${base}api/health?x=1&y=2`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { url: string; host: string };
  assert.equal(body.url, `${base}api/health?x=1&y=2`);
  assert.equal(body.host, `127.0.0.1:${fakePort}`);
  assert.equal(res.headers.get("content-type"), "application/json");
});

await test("an HMR upgrade at the base path goes through as a 101 with the subprotocol", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${base}?token=abc`, "vite-hmr");
  const reply = await new Promise<string>((resolve, reject) => {
    ws.once("open", () => ws.send("ping"));
    ws.once("message", (data) => resolve(String(data)));
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`unexpected ${res.statusCode}`)));
  });
  assert.equal(ws.protocol, "vite-hmr");
  assert.equal(reply, "echo:ping");
  ws.close();
});

await test("an upgrade with a wrong key, or while not ready, is refused", async () => {
  const status = (url: string) =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(url, "vite-hmr");
      ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.once("error", () => resolve(-1));
      ws.once("open", () => resolve(101));
    });
  assert.equal(await status(`ws://127.0.0.1:${port}/preview/${"0".repeat(48)}/${PROJECT}/`), 404);
  targets.set(PROJECT, { state: "starting", port: null, message: null });
  assert.equal(await status(`ws://127.0.0.1:${port}${base}`), 503);
});

/* ── the manager, end to end ── */

const appDir = join(DATA_DIR, "preview-app");
rmSync(appDir, { recursive: true, force: true });
mkdirSync(appDir, { recursive: true });
// A dev server in one line: listens on PORT, answers the shell at BASE_PATH.
const devCommand =
  `node -e "const h=require('http');const b=process.env.BASE_PATH;` +
  `h.createServer((q,r)=>{if(q.url===b){r.writeHead(200,{'content-type':'text/html'});r.end('<html><head></head><body>app</body></html>')}` +
  `else{r.writeHead(404);r.end('nope')}}).listen(Number(process.env.PORT),process.env.HOST||'127.0.0.1',()=>console.log('listening'))"`;

const project = createProject({ name: "Preview App", cwd: appDir, description: null, devCommand });
const waitFor = (id: string, state: DevStatus["state"], ms = 20_000) =>
  new Promise<DevStatus>((resolve, reject) => {
    const now = devStatus(id);
    if (now.state === state) return resolve(now);
    const timer = setTimeout(() => {
      off();
      reject(new Error(`still ${devStatus(id).state} (${devStatus(id).message}) after ${ms}ms`));
    }, ms);
    const off = subscribeDevStatus(id, (s) => {
      if (s.state === state) {
        clearTimeout(timer);
        off();
        resolve(s);
      }
    });
  });

await test("a project without a dev command cannot be started", async () => {
  const bare = createProject({ name: "Bare", cwd: appDir, description: null });
  await assert.rejects(() => startDevServer(bare.id), /no dev command/);
  assert.equal(devStatus(bare.id).state, "off");
  deleteProject(bare.id);
});

await test("start spawns the command in a dev terminal, waits for the base path, and the proxy reaches it", async () => {
  setPreviewResolver((id) => {
    const s = devStatus(id);
    return { state: s.state, port: s.port, message: s.message };
  });
  const started = await startDevServer(project.id, { install: null });
  assert.ok(started.state === "starting" || started.state === "ready", started.state);
  assert.equal(started.url, previewBase(project.id));
  assert.ok(started.terminalId);
  assert.equal(started.command, devCommand);
  const ready = await waitFor(project.id, "ready");
  assert.ok(ready.port);
  const res = await fetch(`http://127.0.0.1:${port}${ready.url}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes(`<head><script src="${ready.url}__daedalus/bridge.js"></script></head>`), html);
  // Idempotent: a second start is the same run.
  const again = await startDevServer(project.id);
  assert.equal(again.terminalId, ready.terminalId);
});

await test("stop kills it, clears the url and answers off", async () => {
  const stopped = stopDevServer(project.id);
  assert.equal(stopped.state, "off");
  assert.equal(stopped.url, null);
  assert.equal(stopped.terminalId, null);
  const res = await fetch(`http://127.0.0.1:${port}${previewBase(project.id)}`);
  assert.equal(res.status, 503);
});

await test("a command that dies before answering is failed, with its last line and an error entry", async () => {
  const dying = createProject({
    name: "Dying",
    cwd: appDir,
    description: null,
    devCommand: `node -e "console.error('Error: cannot bind');console.error('    at boot');process.exit(2)"`,
  });
  await startDevServer(dying.id, { install: null });
  const failed = await waitFor(dying.id, "failed");
  assert.match(failed.message ?? "", /exited with code 2/);
  assert.equal(failed.url, null);
  assert.ok(failed.errors.length >= 1, JSON.stringify(failed.errors));
  assert.ok(failed.errors[0]!.text.startsWith("Error: cannot bind"), failed.errors[0]!.text);
  assert.ok(failed.errors[0]!.text.includes("at boot"), "indented lines join the group");
  stopDevServer(dying.id);
  killProjectTerminals(dying.id);
  deleteProject(dying.id);
});

stopAllDevServers();
killProjectTerminals();
deleteProject(project.id);
rmSync(appDir, { recursive: true, force: true });
hmr.close();
server.close();
fake.close();

console.log(`preview: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
