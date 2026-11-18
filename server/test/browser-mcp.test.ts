// Run: pnpm test:browser-mcp
// The `browser` MCP end to end: the real stdio child (browser-mcp.ts) through an
// MCP client, POSTing to the `/bm` route served on a loopback port, driving a
// real Chrome. The tool-list budget and the key check need no Chrome; the rest
// skip without one.
// First: routes/browser.ts reaches projects.ts, which opens the database.
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Hono } from "hono";

import { locateChrome } from "../src/browser-status.js";
import { findTab, killProjectBrowsers, listTabs } from "../src/browsers.js";
import { DATA_DIR } from "../src/config.js";
import { HttpError } from "../src/http-error.js";
import { browserRoutes } from "../src/routes/browser.js";

assert.ok(DATA_DIR.startsWith("/tmp/"), "run through `pnpm test:browser-mcp`, which points DAEDALUS_DATA_DIR at /tmp");
rmSync(join(DATA_DIR, "browsers"), { recursive: true, force: true });

const KEY = "test-key";
const SESSION = "sess-bm";
const PROJECT = "proj-bm";

const announced: { sessionId: string; projectId: string; tabId: string }[] = [];
const app = new Hono();
browserRoutes(app, {
  runner: { resolveCaller: (key, sessionId) => (key === KEY && sessionId === SESSION ? { id: SESSION, projectId: PROJECT } : null) },
  announce: (sessionId, projectId, tabId) => announced.push({ sessionId, projectId, tabId }),
});
// The real server's error shape (index.ts `app.onError`).
app.onError((err, c) => c.json({ error: err.message }, (err instanceof HttpError ? err.status : 500) as 400));

const listener = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise<void>((resolve) => listener.once("listening", () => resolve()));
const port = (listener.address() as AddressInfo).port;

const here = dirname(fileURLToPath(import.meta.url));
const client = new Client({ name: "browser-mcp-test", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(import.meta.resolve("tsx/cli")), join(here, "../src/browser-mcp.ts")],
    env: { ...(process.env as Record<string, string>), BROWSER_URL: `http://127.0.0.1:${port}/bm/${KEY}/${SESSION}` },
    stderr: "ignore",
  }),
);

type Content = { type: string; text?: string; data?: string; mimeType?: string }[];
async function call(name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as { content: Content; isError?: boolean };
  const text = result.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  return { ...result, text };
}
const uidOf = (snapshot: string, pattern: RegExp): string => {
  const line = snapshot.split("\n").find((l) => pattern.test(l));
  assert.ok(line, `no line matching ${pattern} in:\n${snapshot}`);
  return /\[(\d+_\d+)\]/.exec(line)![1]!;
};

test("the tool list is the plan's nine, flat, and under ~2k tokens", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ["act", "evaluate", "logs", "navigate", "screenshot", "snapshot", "tabs", "viewport", "wait_for"],
  );
  const size = JSON.stringify(tools).length;
  assert.ok(size < 8000, `tool list is ${size} chars`);
  const json = JSON.stringify(tools);
  assert.ok(!/"(oneOf|anyOf|allOf)"/.test(json), "no unions in any schema");
  assert.equal(tools.find((t) => t.name === "evaluate")?.annotations?.destructiveHint, true);
  console.log(`# tool list: ${size} chars`);
});

test("a wrong /bm key is a 404, and so is an unknown tool", async () => {
  const wrong = await app.request(`/bm/nope/${SESSION}/snapshot`, { method: "POST", body: "{}" });
  assert.equal(wrong.status, 404);
  const otherThread = await app.request(`/bm/${KEY}/someone-else/snapshot`, { method: "POST", body: "{}" });
  assert.equal(otherThread.status, 404);
  const unknown = await app.request(`/bm/${KEY}/${SESSION}/nope`, { method: "POST", body: "{}" });
  assert.equal(unknown.status, 404);
});

const chrome = await locateChrome();
const skip = "reason" in chrome ? `no Chrome: ${chrome.reason}` : false;

const PAGE = `data:text/html,${encodeURIComponent(
  `<!doctype html><title>Form</title><h1>Hello</h1>
   <button onclick="document.getElementById('out').textContent='clicked ' + (++window.n || (window.n = 1))">Save</button>
   <p id="out">idle</p><input aria-label="Name">`,
)}`;

test("data: page: snapshot -> act click changes the DOM; fill; stale uid refused", { skip, timeout: 60_000 }, async () => {
  const nav = await call("navigate", { url: PAGE });
  assert.ok(!nav.isError, nav.text);
  assert.match(nav.text, /\[\d+_\d+\] button "Save"/);
  assert.equal(announced.length, 1, "first call announces browser_activity");
  assert.deepEqual(Object.keys(announced[0]!).sort(), ["projectId", "sessionId", "tabId"]);
  assert.equal(announced[0]!.projectId, PROJECT);

  const snap = await call("snapshot");
  assert.match(snap.text, /heading "Hello"/);
  const save = uidOf(snap.text, /button "Save"/);

  const clicked = await call("act", { action: "click", uid: save });
  assert.ok(!clicked.isError, clicked.text);
  assert.match(clicked.text, /clicked 1/, "the returned snapshot shows the change");
  const tab = findTab(PROJECT, announced[0]!.tabId)!;
  assert.equal(await tab.page.$eval("#out", (el) => el.textContent), "clicked 1");

  // `save` is from the snapshot before the click's own report; it is stale now.
  const stale = await call("act", { action: "click", uid: save });
  assert.equal(stale.isError, true);
  assert.match(stale.text, /snapshot again/);
  assert.equal(await tab.page.$eval("#out", (el) => el.textContent), "clicked 1", "nothing was clicked");

  const name = uidOf(clicked.text, /textbox "Name"/);
  const filled = await call("act", { action: "fill", uid: name, text: "Ada", snapshot: false });
  assert.ok(!filled.isError, filled.text);
  assert.equal(await tab.page.$eval("input", (el) => (el as HTMLInputElement).value), "Ada");

  const value = await call("evaluate", { function: "() => document.title" });
  assert.equal(value.text, '"Form"');

  const shot = await call("screenshot");
  const image = shot.content.find((c) => c.type === "image");
  assert.equal(image?.mimeType, "image/jpeg");
  assert.equal(Buffer.from(image!.data!, "base64")[0], 0xff);

  const tabs = await call("tabs");
  assert.match(tabs.text, new RegExp(`\\* ${announced[0]!.tabId}`));
  assert.equal(announced.length, 1, "announced once per thread");
});

test("settle: act waits for the navigation it started and the fetch after it", { skip, timeout: 60_000 }, async () => {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url === "/start") {
      res.end(`<!doctype html><title>Start</title><a href="/next">Next</a>`);
    } else if (req.url === "/next") {
      res.end(`<!doctype html><title>Next</title><p id="p">waiting</p>
        <script>fetch('/slow').then(r => r.text()).then(t => { document.getElementById('p').textContent = t; })</script>`);
    } else if (req.url === "/slow") {
      setTimeout(() => res.end("loaded late"), 800);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const start = await call("navigate", { url: `${base}/start` });
    assert.match(start.text, /status 200/);
    const link = uidOf(start.text, /link "Next"/);
    const went = await call("act", { action: "click", uid: link });
    assert.ok(!went.isError, went.text);
    assert.match(went.text, new RegExp(`${base}/next`));
    assert.match(went.text, /loaded late/, "the snapshot waited for network quiet");
    assert.doesNotMatch(went.text, /settle cap hit/);

    const logs = await call("logs", { kind: "network" });
    assert.match(logs.text, /GET 200 \d+ms fetch .*\/slow/);

    const back = await call("navigate", { action: "back" });
    assert.match(back.text, /Start/);
  } finally {
    server.close();
  }
});

test("tabs: new, select by id, close", { skip, timeout: 30_000 }, async () => {
  const opened = await call("tabs", { action: "new", url: PAGE });
  const mine = opened.text.split("\n").find((l) => l.startsWith("*"));
  assert.ok(mine, opened.text);
  const id = mine.slice(2).split(" ")[0]!;
  assert.ok(findTab(PROJECT, id), "the new tab is live and is this thread's");
  const closed = await call("tabs", { action: "close", tabId: id });
  assert.ok(!closed.isError, closed.text);
  assert.ok(!closed.text.includes(id), closed.text);
  const missing = await call("snapshot", { tabId: id });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /no tab/);
});

test("a click that opens an alert answers, and the dialog is answerable", { skip, timeout: 60_000 }, async () => {
  const page = `data:text/html,${encodeURIComponent(`<title>Ask</title><button onclick="alert('hi');document.title='after'">Ask</button>`)}`;
  const nav = await call("navigate", { url: page });
  const ask = uidOf(nav.text, /button "Ask"/);
  // Before the fix this never answered: the blocked click held the tab's queue.
  const clicked = await call("act", { action: "click", uid: ask });
  assert.ok(!clicked.isError, clicked.text);
  assert.match(clicked.text, /alert dialog is open: "hi"/);
  const shot = await call("screenshot");
  assert.equal(shot.isError, true, "a page evaluate under a dialog is refused, not hung");
  assert.match(shot.text, /dialog is open/);
  const answered = await call("act", { action: "dialog", accept: true, snapshot: false });
  assert.ok(!answered.isError, answered.text);
  assert.equal(await call("evaluate", { function: "() => document.title" }).then((r) => r.text), '"after"');
});

test.after(async () => {
  await client.close();
  await killProjectBrowsers(undefined, { deleteProfile: true });
  listener.close();
});
