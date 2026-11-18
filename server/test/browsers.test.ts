// Run: pnpm test:browsers
// Lifecycle on a fake puppeteer (cap, LRU, idle sweep, kill, tabs.json), then
// the real thing against Chrome when one is installed.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test from "node:test";
import type { WebSocket } from "ws";

import { decodeBrowserFrame, type BrowserServerMessage } from "../src/browser-protocol.js";
import { getBrowserStatus, locateChrome } from "../src/browser-status.js";
import {
  BrowserError,
  IDLE_MS,
  MAX_BROWSERS,
  _setLauncherForTest,
  _setNowForTest,
  attachBrowserViewer,
  closeTab,
  emitAgentActivity,
  findTab,
  getOrLaunch,
  isBrowserRunning,
  killProjectBrowsers,
  listTabs,
  openTab,
  profileDir,
  readSavedTabs,
  runExclusive,
  runningBrowserCount,
  sweepBrowsers,
  type BrowserLauncher,
} from "../src/browsers.js";
import { DATA_DIR } from "../src/config.js";

assert.ok(DATA_DIR.startsWith("/tmp/"), "run through `pnpm test:browsers`, which points DAEDALUS_DATA_DIR at /tmp");
rmSync(join(DATA_DIR, "browsers"), { recursive: true, force: true });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// A fake puppeteer: just the surface browsers.ts touches
// ---------------------------------------------------------------------------

let targetSeq = 0;

class FakeCdp extends EventEmitter {
  targetId: string;
  sent: { method: string; params: unknown }[] = [];
  constructor(targetId: string) {
    super();
    this.targetId = targetId;
  }
  async send(method: string, params?: unknown) {
    this.sent.push({ method, params });
    if (method === "Target.getTargetInfo") return { targetInfo: { targetId: this.targetId } };
    return {};
  }
}

class FakePage extends EventEmitter {
  private current = "about:blank";
  private closedFlag = false;
  readonly frame = {};
  readonly cdp = new FakeCdp(`T${++targetSeq}`);
  browser: FakeBrowser;
  constructor(browser: FakeBrowser) {
    super();
    this.browser = browser;
  }
  url() {
    return this.current;
  }
  mainFrame() {
    return this.frame;
  }
  isClosed() {
    return this.closedFlag;
  }
  async createCDPSession() {
    return this.cdp;
  }
  async goto(url: string) {
    this.current = url;
    this.emit("framenavigated", this.frame);
    return null;
  }
  async title() {
    return `title of ${this.current}`;
  }
  async evaluate() {
    return null;
  }
  async setViewport() {}
  async bringToFront() {}
  async close() {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.browser.pagesList = this.browser.pagesList.filter((page) => page !== this);
    this.emit("close");
  }
}

class FakeBrowser extends EventEmitter {
  pagesList: FakePage[] = [];
  closed = false;
  constructor() {
    super();
    // Like Chrome: a launch opens one blank tab.
    this.pagesList.push(new FakePage(this));
  }
  async version() {
    return "FakeChrome/1.0";
  }
  async pages() {
    return [...this.pagesList];
  }
  async newPage() {
    const page = new FakePage(this);
    this.pagesList.push(page);
    return page;
  }
  async close() {
    this.closed = true;
    for (const page of [...this.pagesList]) await page.close();
    this.emit("disconnected");
  }
  process() {
    return null;
  }
}

const launched: { projectId: string; browser: FakeBrowser }[] = [];
const fakeLauncher: BrowserLauncher = async ({ projectId }) => {
  const browser = new FakeBrowser();
  launched.push({ projectId, browser });
  return { browser: browser as never, executablePath: "/fake/chrome" };
};

let clock = 1_000_000;

async function resetFake() {
  _setLauncherForTest(fakeLauncher);
  clock = 1_000_000;
  _setNowForTest(() => clock);
  await killProjectBrowsers();
  launched.length = 0;
}

// ---------------------------------------------------------------------------
// A fake viewer socket
// ---------------------------------------------------------------------------

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  json: BrowserServerMessage[] = [];
  frames: Uint8Array[] = [];
  closedWith: { code: number; reason: string } | null = null;
  send(data: string | Uint8Array) {
    if (typeof data === "string") this.json.push(JSON.parse(data) as BrowserServerMessage);
    else this.frames.push(data);
  }
  close(code: number, reason: string) {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.closedWith = { code, reason };
    this.emit("close");
  }
  command(body: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(body)), false);
  }
}
const socket = () => new FakeSocket();
const asWs = (s: FakeSocket) => s as unknown as WebSocket;

async function until<T>(read: () => T | undefined | null | false, ms = 5_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(20);
  }
}

// ---------------------------------------------------------------------------
// Fake-browser cases
// ---------------------------------------------------------------------------

test("concurrent getOrLaunch shares one launch", async () => {
  await resetFake();
  const [a, b] = await Promise.all([getOrLaunch("p1"), getOrLaunch("p1")]);
  assert.equal(a, b);
  assert.equal(launched.length, 1);
  assert.equal(runningBrowserCount(), 1);
});

test("cap: the least recently active idle browser is evicted", async () => {
  await resetFake();
  for (let i = 0; i < MAX_BROWSERS; i++) {
    clock += 1_000;
    await getOrLaunch(`p${i}`);
  }
  assert.equal(runningBrowserCount(), MAX_BROWSERS);
  // p0 was oldest; make p1 the least recently active instead.
  clock += 1_000;
  await openTab("p0", {});
  await getOrLaunch(`p${MAX_BROWSERS}`);
  assert.equal(runningBrowserCount(), MAX_BROWSERS);
  assert.equal(isBrowserRunning("p1"), false, "p1 was the LRU idle browser");
  assert.equal(isBrowserRunning("p0"), true);
  assert.equal(launched.find((l) => l.projectId === "p1")?.browser.closed, true);
});

test("cap: a browser with a viewer is never evicted, and a full house refuses", async () => {
  await resetFake();
  const sockets: FakeSocket[] = [];
  for (let i = 0; i < MAX_BROWSERS; i++) {
    const s = socket();
    sockets.push(s);
    await attachBrowserViewer(`v${i}`, null, asWs(s));
    assert.equal(s.json[0]?.type, "hello");
  }
  await assert.rejects(getOrLaunch("extra"), (error: unknown) => error instanceof BrowserError && error.code === "limit");
  const refused = socket();
  await attachBrowserViewer("extra2", null, asWs(refused));
  assert.equal(refused.closedWith?.code, 4029);
  // One viewer leaves: that browser becomes evictable.
  sockets[2]!.close(1000, "bye");
  await getOrLaunch("extra");
  assert.equal(isBrowserRunning("v2"), false);
  assert.equal(isBrowserRunning("extra"), true);
});

test("cap: a tab running an exclusive operation is not idle", async () => {
  await resetFake();
  const tabs: string[] = [];
  for (let i = 0; i < MAX_BROWSERS; i++) {
    clock += 1_000;
    tabs.push((await openTab(`b${i}`, {})).id);
  }
  let release!: () => void;
  const held = runExclusive("b0", tabs[0]!, () => new Promise<void>((resolve) => (release = resolve)));
  await getOrLaunch("b-next");
  assert.equal(isBrowserRunning("b0"), true, "busy b0 skipped");
  assert.equal(isBrowserRunning("b1"), false, "b1 evicted instead");
  release();
  await held;
});

test("runExclusive serialises per tab", async () => {
  await resetFake();
  const tab = await openTab("q", {});
  const order: string[] = [];
  const slow = runExclusive("q", tab.id, async () => {
    await sleep(50);
    order.push("first");
  });
  const fast = runExclusive("q", tab.id, async () => {
    order.push("second");
  });
  const failing = runExclusive("q", tab.id, async () => {
    throw new Error("boom");
  });
  const after = runExclusive("q", tab.id, async () => order.push("third"));
  await Promise.all([slow, fast, assert.rejects(failing, /boom/), after]);
  assert.deepEqual(order, ["first", "second", "third"]);
  assert.throws(() => runExclusive("q", "nope", async () => {}), (error: unknown) => error instanceof BrowserError && error.code === "no_tab");
});

test("idle sweep on a fake clock: viewers and activity keep a browser up", async () => {
  await resetFake();
  await getOrLaunch("idle-a");
  const watched = socket();
  await attachBrowserViewer("idle-b", null, asWs(watched));
  const tab = await openTab("idle-c", {});

  clock += IDLE_MS - 1_000;
  assert.deepEqual(await sweepBrowsers(), []);
  emitAgentActivity("idle-c", tab.id, null); // a tool call counts as activity
  clock += 2_000;
  assert.deepEqual(await sweepBrowsers(), ["idle-a"]);
  assert.equal(isBrowserRunning("idle-a"), false);
  assert.equal(isBrowserRunning("idle-b"), true, "a viewer keeps it");
  assert.equal(isBrowserRunning("idle-c"), true, "recent activity keeps it");

  watched.close(1000, "bye"); // leaving touches it, so the clock starts then
  clock += IDLE_MS + 1;
  assert.deepEqual((await sweepBrowsers()).sort(), ["idle-b", "idle-c"]);
  assert.equal(runningBrowserCount(), 0);
});

test("killProjectBrowsers closes viewers with 4000 and deletes the profile on request", async () => {
  await resetFake();
  const viewer = socket();
  await attachBrowserViewer("gone", null, asWs(viewer));
  await openTab("gone", { url: "https://example.com/a" });
  await openTab("kept", {});
  assert.ok(existsSync(profileDir("gone")));

  assert.equal(await killProjectBrowsers("gone", { deleteProfile: true }), 1);
  assert.equal(viewer.closedWith?.code, 4000);
  assert.equal(isBrowserRunning("gone"), false);
  assert.equal(existsSync(profileDir("gone")), false, "profile deleted");
  assert.equal(isBrowserRunning("kept"), true, "other projects untouched");

  assert.equal(await killProjectBrowsers("kept"), 1);
  assert.ok(existsSync(profileDir("kept")), "plain close keeps the profile");
});

test("tabs.json round trip: written on close, reopened on launch", async () => {
  await resetFake();
  const a = await openTab("rt", { url: "https://example.com/one" });
  await openTab("rt", { url: "https://example.com/two", openedBy: { kind: "agent", sessionId: "s-1" } });
  await openTab("rt", { url: "data:text/html,not-restorable" });
  assert.equal(listTabs("rt").running, true);
  await killProjectBrowsers("rt");

  const saved = readSavedTabs("rt");
  assert.deepEqual(
    saved.map((t) => [t.url, t.openedBy]),
    [
      ["https://example.com/one", { kind: "user" }],
      ["https://example.com/two", { kind: "agent", sessionId: "s-1" }],
    ],
  );
  const offline = listTabs("rt");
  assert.equal(offline.running, false);
  assert.deepEqual(offline.tabs.map((t) => t.url), ["https://example.com/one", "https://example.com/two"]);

  await getOrLaunch("rt");
  const reopened = await until(() => {
    const live = listTabs("rt");
    return live.running && live.tabs.length === 2 ? live.tabs : null;
  });
  assert.deepEqual(reopened.map((t) => t.url), ["https://example.com/one", "https://example.com/two"]);
  assert.deepEqual(reopened[1]!.openedBy, { kind: "agent", sessionId: "s-1" });
  // The launch's own blank tab took the first URL rather than leaving a stray.
  assert.equal(launched.at(-1)!.browser.pagesList.length, 2);
  assert.equal(findTab("rt", a.id), undefined, "old tab ids do not survive a relaunch");

  // A tab closed is a tab forgotten.
  await closeTab("rt", reopened[0]!.id);
  await killProjectBrowsers("rt");
  assert.deepEqual(readSavedTabs("rt").map((t) => t.url), ["https://example.com/two"]);
});

test("tabs.json: garbage and missing files read as no tabs", async () => {
  mkdirSync(profileDir("junk"), { recursive: true });
  writeFileSync(join(profileDir("junk"), "tabs.json"), "{not json");
  assert.deepEqual(readSavedTabs("junk"), []);
  writeFileSync(join(profileDir("junk"), "tabs.json"), JSON.stringify({ tabs: [{ url: 7 }, { url: "about:blank" }, { url: "https://x.test/" }] }));
  assert.deepEqual(readSavedTabs("junk").map((t) => t.url), ["https://x.test/"]);
  assert.deepEqual(readSavedTabs("never-existed"), []);
  assert.throws(() => profileDir("../escape"), BrowserError);
});

test("viewer protocol on the fake: hello, tabs, front, bad commands, tab select", async () => {
  await resetFake();
  const s = socket();
  await attachBrowserViewer("proto", "sess-1", asWs(s));
  assert.deepEqual(s.json.map((m) => m.type).slice(0, 3), ["hello", "tabs", "front"]);
  const hello = s.json[0] as Extract<BrowserServerMessage, { type: "hello" }>;
  assert.equal(hello.browserVersion, "FakeChrome/1.0");

  s.command({ type: "nonsense" });
  s.command({ type: "mouse", tabId: "x" });
  await until(() => s.json.filter((m) => m.type === "error" && m.code === "bad_command").length === 2);

  s.command({ type: "tab", action: "new", url: "https://example.com/" });
  const front = await until(() => {
    const last = s.json.filter((m) => m.type === "front").at(-1) as Extract<BrowserServerMessage, { type: "front" }> | undefined;
    const first = (s.json[2] as Extract<BrowserServerMessage, { type: "front" }>).tabId;
    return last && last.tabId !== first ? last.tabId : null;
  });
  assert.ok(findTab("proto", front!));

  s.command({ type: "navigate", tabId: "missing", action: "reload" });
  await until(() => s.json.some((m) => m.type === "error" && m.code === "no_tab" && m.command === "navigate"));
});

// ---------------------------------------------------------------------------
// Real Chrome
// ---------------------------------------------------------------------------

const chrome = await locateChrome();
const skip = "reason" in chrome ? `no Chrome: ${chrome.reason}` : false;

test("real Chrome: status, frames to a viewer, input, tabs.json reopen", { skip, timeout: 60_000 }, async () => {
  _setLauncherForTest(null);
  _setNowForTest(null);
  await killProjectBrowsers();

  const status = await getBrowserStatus({ refresh: true });
  assert.equal(status.available, true);
  if (status.available) assert.match(status.version, /Chrome\/\d+/);

  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><title>Spike ${req.url}</title><input id="i" autofocus>
      <button id="b" style="position:absolute;left:10px;top:60px;width:200px;height:40px"
        onclick="document.title='clicked'">Press</button>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const s = socket();
    await attachBrowserViewer("real", null, asWs(s));
    s.command({ type: "viewport", width: 800, height: 600, dpr: 1 });
    s.command({ type: "tab", action: "new", url: `${base}/page` });
    const tabId = await until(() => {
      const tabs = s.json.filter((m) => m.type === "tabs").at(-1) as Extract<BrowserServerMessage, { type: "tabs" }> | undefined;
      return tabs?.tabs.find((t) => t.url === `${base}/page` && t.title === "Spike /page" && !t.loading)?.id;
    }, 15_000);
    await until(() => (s.json.filter((m) => m.type === "front").at(-1) as { tabId: string } | undefined)?.tabId === tabId);

    const frame = await until(() => {
      const decoded = s.frames.map((f) => decodeBrowserFrame(f)).filter((f) => f && f.header.tabId === tabId);
      return decoded.at(-1) ?? null;
    }, 15_000);
    assert.equal(frame.jpeg[0], 0xff, "JPEG SOI");
    assert.equal(frame.jpeg[1], 0xd8);
    assert.ok(Math.abs(frame.header.deviceWidth - 800) < 2, `deviceWidth ${frame.header.deviceWidth}`);

    const viewport = await until(() => s.json.find((m) => m.type === "viewport" && m.tabId === tabId) as Extract<BrowserServerMessage, { type: "viewport" }> | undefined);
    assert.equal(viewport.owner.kind, "viewer");

    // Click the button through the socket, as the panel would.
    for (const event of ["mousePressed", "mouseReleased"] as const)
      s.command({ type: "mouse", tabId, event, x: 50, y: 80, button: "left", buttons: event === "mousePressed" ? 1 : 0, clickCount: 1, modifiers: 0 });
    const tab = findTab("real", tabId)!;
    await sleep(300);
    assert.equal(await tab.page.title(), "clicked");

    // Type into the input via insertText.
    await runExclusive("real", tabId, (t) => t.page.focus("#i"));
    s.command({ type: "text", tabId, text: "hello" });
    await sleep(300);
    assert.equal(await tab.page.$eval("#i", (el) => (el as HTMLInputElement).value), "hello");

    // A second viewer gets the cached frame immediately.
    const late = socket();
    await attachBrowserViewer("real", null, asWs(late));
    late.command({ type: "watch", tabId });
    await until(() => late.frames.some((f) => decodeBrowserFrame(f)?.header.tabId === tabId), 5_000);

    // Close and relaunch: the page comes back from tabs.json.
    await killProjectBrowsers("real");
    assert.equal(s.closedWith?.code, 4000);
    const saved = JSON.parse(readFileSync(join(profileDir("real"), "tabs.json"), "utf8")) as { tabs: { url: string }[] };
    assert.ok(saved.tabs.some((t) => t.url === `${base}/page`));
    await getOrLaunch("real");
    await until(() => listTabs("real").tabs.some((t) => t.url === `${base}/page`), 15_000);
  } finally {
    await killProjectBrowsers(undefined, { deleteProfile: true });
    server.close();
  }
});

test.after(async () => {
  await killProjectBrowsers();
});
