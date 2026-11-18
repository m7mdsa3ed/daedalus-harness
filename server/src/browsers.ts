/* ── Browsers ──
 *
 * One headless Chrome per project, driven over puppeteer-core with
 * `--remote-debugging-pipe` (no TCP port, so nothing else on the machine can
 * attach), with a persistent profile in `data/browsers/<projectId>` so logins
 * survive a relaunch. The server holds the only CDP connection: the browser
 * panel (the `/browser` socket, `browser-protocol.ts`) and, later, the browser
 * MCP are both clients of this module, so input from each is serialised per
 * tab and the panel can draw what the agent does. docs/plans/browser.md.
 *
 * Modelled on `terminals.ts`, and bounded the same way, because a browser is a
 * process that outlives the request that started it:
 *   - `MAX_BROWSERS` server-wide; launching one more evicts the least recently
 *     active idle one (no viewer, nothing running in a tab), else refuses.
 *   - an idle close after `IDLE_MS` with no viewer and no activity, found by a
 *     minute sweep. Closing keeps the profile, and the open URLs are written to
 *     `tabs.json` and reopened on the next launch — Chrome's own session
 *     restore does nothing headless (phase 0 spike), so this is the restore.
 *   - `killProjectBrowsers` on project delete (which also deletes the profile)
 *     and on shutdown.
 *
 * Not on the thread socket, for the terminal's reason: a frame stream is not a
 * journal. Frames are a screencast per *watched* tab only, fanned to every
 * viewer watching it, acked once per frame, and the last one cached so a new
 * viewer draws at once.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WebSocket } from "ws";
import puppeteer from "puppeteer-core";
import type { Browser, CDPSession, Dialog, ElementHandle, HTTPRequest, Page, Target } from "puppeteer-core";
import { z } from "zod";

import {
  BROWSER_CLOSE,
  BROWSER_PROTOCOL_VERSION,
  encodeBrowserFrame,
  type BrowserAgentActivity,
  type BrowserCommand,
  type BrowserDialog,
  type BrowserErrorCode,
  type BrowserServerMessage,
  type BrowserTab,
  type BrowserTabId,
  type BrowserViewportMessage,
} from "./browser-protocol.js";
import { locateChrome, recordBrowserVersion } from "./browser-status.js";
import { DATA_DIR } from "./config.js";
import { HttpError } from "./http-error.js";

/** Browsers running at once, server-wide. ~430 MB PSS for one with a tab. */
export const MAX_BROWSERS = 4;
/** How long a browser with no viewer and no activity lives. */
export const IDLE_MS = 15 * 60 * 1000;
/** How often the sweeper looks for idle browsers. */
const SWEEP_MS = 60 * 1000;
/** Entries kept per tab in each of the console and network rings. */
const RING_SIZE = 500;
/** A graceful `browser.close()` that has not finished by now is a SIGKILL. */
const CLOSE_TIMEOUT_MS = 3_000;
/** A viewer whose socket has this much queued skips frames until it drains. */
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
/** Quiet time before the panel that last had input takes the viewport. */
const VIEWPORT_DEBOUNCE_MS = 150;
const TABS_WRITE_DEBOUNCE_MS = 500;
const TABS_BROADCAST_DEBOUNCE_MS = 50;
/** Used until a viewer says how big it is. */
const DEFAULT_VIEWPORT = { width: 1280, height: 800, dpr: 1 };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type BrowserFailure = BrowserErrorCode | "unavailable" | "limit";

const STATUS: Record<BrowserFailure, number> = {
  bad_command: 400,
  no_tab: 404,
  navigation_failed: 502,
  browser_failed: 502,
  internal: 500,
  unavailable: 503,
  limit: 429,
};

/** A refusal with its HTTP status (routes) and its wire code (the socket). */
export class BrowserError extends HttpError {
  code: BrowserFailure;
  constructor(code: BrowserFailure, message: string) {
    super(message, STATUS[code]);
    this.code = code;
    this.name = "BrowserError";
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** A bounded log with a monotonic cursor, so a reader can ask "since N". */
export class Ring<T> {
  readonly capacity: number;
  private items: { seq: number; value: T }[] = [];
  private next = 1;
  constructor(capacity: number) {
    this.capacity = capacity;
  }
  push(value: T): number {
    const seq = this.next++;
    this.items.push({ seq, value });
    if (this.items.length > this.capacity) this.items.shift();
    return seq;
  }
  /** Entries with a seq greater than `cursor`, oldest first. */
  since(cursor = 0): { seq: number; value: T }[] {
    return this.items.filter((item) => item.seq > cursor);
  }
  /** The seq the next push gets; a reader's cursor for "from now". */
  get cursor(): number {
    return this.next - 1;
  }
}

export interface ConsoleEntry {
  at: number;
  /** `console.*` level, or `"exception"` for an uncaught page error. */
  level: string;
  text: string;
  url: string | null;
}

export interface RequestEntry {
  at: number;
  url: string;
  method: string;
  resourceType: string;
  status: number | null;
  /** Chrome's error text when the request failed. */
  failure: string | null;
  durationMs: number | null;
}

/** Filled by the MCP step: element handles under uids that embed the
    generation, so a stale uid fails loudly. Cleared on main-frame navigation. */
export interface SnapshotSlot {
  generation: number;
  handles: Map<string, ElementHandle>;
}

interface TabViewport {
  width: number;
  height: number;
  dpr: number;
  owner: BrowserViewportMessage["owner"];
}

export interface BrowserTabState {
  id: BrowserTabId;
  projectId: string;
  page: Page;
  cdp: CDPSession;
  openedBy: BrowserTab["openedBy"];
  url: string;
  title: string;
  favicon: string | null;
  loading: boolean;
  /** Tail of the per-tab input chain (`runExclusive`). */
  queue: Promise<unknown>;
  /** Exclusive operations in flight; a host with any is not idle. */
  busy: number;
  snapshot: SnapshotSlot | null;
  /** Bumped per snapshot, never reset, so uids from before a reset stay stale. */
  snapshotGeneration: number;
  console: Ring<ConsoleEntry>;
  network: Ring<RequestEntry>;
  /** Requests in flight, for the settle wait. */
  inflight: Set<HTTPRequest>;
  /** When `inflight` last changed. */
  networkChangedAt: number;
  dialog: { handle: Dialog; state: BrowserDialog } | null;
  /** Called once when a dialog opens (`untilDialog`). */
  dialogWaiters: Set<() => void>;
  agent: BrowserAgentActivity | null;
  viewport: TabViewport | null;
  cast: {
    running: { maxWidth: number; maxHeight: number } | null;
    /** Serialises start/stop so a quick watch/unwatch cannot interleave. */
    op: Promise<unknown>;
    seq: number;
    lastFrame: Uint8Array | null;
  };
  viewportTimer: ReturnType<typeof setTimeout> | null;
  /** The pending `viewportTimer` is a person's resize, not just input. */
  viewportForced: boolean;
  closed: boolean;
}

interface Viewer {
  id: string;
  ws: WebSocket;
  sessionId: string | null;
  /** The tab this viewer gets frames for. */
  front: BrowserTabId | null;
  /** What the panel last said its canvas is. */
  viewport: { width: number; height: number; dpr: number } | null;
}

export interface BrowserHost {
  projectId: string;
  browser: Browser | null;
  launching: Promise<BrowserHost> | null;
  version: string;
  tabs: Map<BrowserTabId, BrowserTabState>;
  adopting: Map<Page, Promise<BrowserTabState | null>>;
  viewers: Set<Viewer>;
  lastActivity: number;
  /** The tab last brought to the front for the browser as a whole. */
  front: BrowserTabId | null;
  /** The tab each thread last selected — the agent's fallback default. */
  sessionTabs: Map<string, BrowserTabId>;
  /** Set while the browser is being torn down, so the page closes it causes
      neither rewrite `tabs.json` nor fan out. */
  closing: boolean;
  /** False until launch has reopened the saved tabs. */
  ready: boolean;
  tabsWriteTimer: ReturnType<typeof setTimeout> | null;
  tabsBroadcastTimer: ReturnType<typeof setTimeout> | null;
}

const hosts = new Map<string, BrowserHost>();
/** Closes still running, by project: a relaunch waits for one, because two
    Chromes cannot hold one profile (`SingletonLock`). */
const closing = new Map<string, Promise<void>>();
let sweeper: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Seams for tests
// ---------------------------------------------------------------------------

export type BrowserLauncher = (spec: { projectId: string; userDataDir: string }) => Promise<{
  browser: Browser;
  executablePath: string;
}>;

let now: () => number = Date.now;
let launcher: BrowserLauncher = launchChrome;

/** For tests: a fake clock. */
export function _setNowForTest(fn: (() => number) | null): void {
  now = fn ?? Date.now;
}

/** For tests: launch something other than Chrome. Null restores Chrome. */
export function _setLauncherForTest(fn: BrowserLauncher | null): void {
  launcher = fn ?? launchChrome;
}

async function launchChrome({ userDataDir }: { userDataDir: string }) {
  const found = await locateChrome();
  if ("reason" in found) throw new BrowserError("unavailable", found.reason);
  const args = ["--window-size=1280,800", "--no-first-run", "--no-default-browser-check"];
  // Chrome refuses to start its sandbox as root; pm2 under root is common.
  if (process.getuid?.() === 0) args.push("--no-sandbox");
  const browser = await puppeteer.launch({
    executablePath: found.path,
    headless: true,
    pipe: true,
    userDataDir,
    // The panel sizes each tab; puppeteer's 800x600 emulation would fight it.
    defaultViewport: null,
    args,
    // The server's own shutdown closes browsers (`killProjectBrowsers`).
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  return { browser, executablePath: found.path };
}

// ---------------------------------------------------------------------------
// Profile and tabs.json
// ---------------------------------------------------------------------------

const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** `data/browsers/<projectId>`, the Chrome profile; `tabs.json` lives in it. */
export function profileDir(projectId: string): string {
  // The id becomes a path component; anything else is not a project id.
  if (!PROJECT_ID_RE.test(projectId)) throw new BrowserError("bad_command", "invalid project id");
  return join(DATA_DIR, "browsers", projectId);
}

interface SavedTab {
  url: string;
  title: string;
  favicon: string | null;
  openedBy: BrowserTab["openedBy"];
}

const tabsFile = (projectId: string) => join(profileDir(projectId), "tabs.json");

/** URLs a relaunch can usefully reopen. A blank tab is what launch gives
    anyway, a data: URL can be megabytes, and an error page is not a place. */
const restorable = (url: string) =>
  url !== "" && url !== "about:blank" && !url.startsWith("data:") && !url.startsWith("chrome-error:");

/** What `tabs.json` says, oldest first. Missing or unreadable is no tabs. */
export function readSavedTabs(projectId: string): SavedTab[] {
  let raw: string;
  try {
    raw = readFileSync(tabsFile(projectId), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { tabs?: unknown };
    if (!Array.isArray(parsed.tabs)) return [];
    return parsed.tabs.flatMap((entry): SavedTab[] => {
      const tab = entry as Partial<SavedTab>;
      if (typeof tab.url !== "string" || !restorable(tab.url)) return [];
      const openedBy =
        tab.openedBy && tab.openedBy.kind === "agent" && typeof tab.openedBy.sessionId === "string"
          ? { kind: "agent" as const, sessionId: tab.openedBy.sessionId }
          : { kind: "user" as const };
      return [{ url: tab.url, title: typeof tab.title === "string" ? tab.title : "", favicon: typeof tab.favicon === "string" ? tab.favicon : null, openedBy }];
    });
  } catch (error) {
    console.warn(`[browser ${projectId}] tabs.json unreadable, ignored:`, error);
    return [];
  }
}

function writeSavedTabs(host: BrowserHost): void {
  if (host.tabsWriteTimer) clearTimeout(host.tabsWriteTimer);
  host.tabsWriteTimer = null;
  const tabs: SavedTab[] = [...host.tabs.values()]
    .filter((tab) => restorable(tab.url))
    .map((tab) => ({ url: tab.url, title: tab.title, favicon: tab.favicon, openedBy: tab.openedBy }));
  const path = tabsFile(host.projectId);
  try {
    mkdirSync(profileDir(host.projectId), { recursive: true });
    // Write-then-rename, so a crash mid-write cannot leave half a file.
    writeFileSync(`${path}.tmp`, JSON.stringify({ version: 1, tabs }, null, 2));
    renameSync(`${path}.tmp`, path);
  } catch (error) {
    console.error(`[browser ${host.projectId}] could not write tabs.json:`, error);
  }
}

/** The saved tabs as the REST shape, for a project with no browser running. */
function savedAsTabs(projectId: string): BrowserTab[] {
  return readSavedTabs(projectId).map((tab, index) => ({
    id: `saved:${index}`,
    url: tab.url,
    title: tab.title,
    favicon: tab.favicon,
    loading: false,
    openedBy: tab.openedBy,
  }));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function newHost(projectId: string): BrowserHost {
  return {
    projectId,
    browser: null,
    launching: null,
    version: "",
    tabs: new Map(),
    adopting: new Map(),
    viewers: new Set(),
    lastActivity: now(),
    front: null,
    sessionTabs: new Map(),
    closing: false,
    ready: false,
    tabsWriteTimer: null,
    tabsBroadcastTimer: null,
  };
}

const running = (host: BrowserHost) => host.browser !== null || host.launching !== null;
const isIdle = (host: BrowserHost) =>
  host.viewers.size === 0 && !host.launching && [...host.tabs.values()].every((tab) => tab.busy === 0);

/** Is a browser up (or coming up) for this project. */
export function isBrowserRunning(projectId: string): boolean {
  const host = hosts.get(projectId);
  return host ? running(host) : false;
}

/** How many browsers are running or launching, server-wide. */
export function runningBrowserCount(): number {
  return [...hosts.values()].filter(running).length;
}

/**
 * The project's browser, launching it if it is not up. Concurrent callers
 * share one launch. At `MAX_BROWSERS` the least recently active idle browser
 * is closed to make room; with none idle this throws `limit`.
 */
export async function getOrLaunch(projectId: string): Promise<BrowserHost> {
  const dir = profileDir(projectId);
  await closing.get(projectId);
  let host = hosts.get(projectId);
  if (host?.browser && !host.closing) return host;
  if (host?.launching) return host.launching;
  if (!host) {
    host = newHost(projectId);
    hosts.set(projectId, host);
  }
  const target = host;
  target.closing = false;
  target.ready = false;
  // Eviction is inside the launch promise, so a second caller for this project
  // joins it and a concurrent launch elsewhere counts this one as running.
  target.launching = makeRoom(target)
    .then(() => launch(target, dir))
    .catch((error: unknown) => {
      if (target.viewers.size === 0 && !target.browser) hosts.delete(projectId);
      throw error;
    })
    .finally(() => {
      target.launching = null;
    });
  return target.launching;
}

/** Close least-recently-active idle browsers until `target` fits under the cap. */
async function makeRoom(target: BrowserHost): Promise<void> {
  for (;;) {
    const others = [...hosts.values()].filter((other) => other !== target && running(other));
    if (others.length < MAX_BROWSERS) return;
    const victim = others
      .filter((other) => other.browser && !other.closing && isIdle(other))
      .sort((a, b) => a.lastActivity - b.lastActivity)[0];
    if (!victim) throw new BrowserError("limit", `${MAX_BROWSERS} browsers are already running and none is idle`);
    console.log(`[browser ${victim.projectId}] closed to make room for ${target.projectId}`);
    await closeHost(victim, { forget: true });
  }
}

async function launch(host: BrowserHost, userDataDir: string): Promise<BrowserHost> {
  mkdirSync(userDataDir, { recursive: true });
  const saved = readSavedTabs(host.projectId);
  let launched: Awaited<ReturnType<BrowserLauncher>>;
  try {
    launched = await launcher({ projectId: host.projectId, userDataDir });
  } catch (error) {
    if (error instanceof BrowserError) throw error;
    throw new BrowserError("browser_failed", `Chrome did not start: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { browser } = launched;
  try {
    return await adoptLaunched(host, browser, launched.executablePath, saved);
  } catch (error) {
    /* Chrome is up but the host never became usable. The caller forgets a
       host whose launch failed, so a process left here would be reachable by
       nothing — not the sweep, not shutdown. */
    if (host.browser === browser) host.browser = null;
    dropTabs(host);
    await closeBrowser(browser);
    throw error instanceof BrowserError
      ? error
      : new BrowserError("browser_failed", `Chrome did not start: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A graceful close, then SIGKILL if it has not finished in time. */
async function closeBrowser(browser: Browser): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = await Promise.race([
    browser.close().then(
      () => true,
      () => false,
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), CLOSE_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
  if (!closed) browser.process()?.kill("SIGKILL");
}

async function adoptLaunched(host: BrowserHost, browser: Browser, executablePath: string, saved: SavedTab[]): Promise<BrowserHost> {
  host.browser = browser;
  host.lastActivity = now();
  host.version = await browser.version().catch(() => "");
  if (host.version) recordBrowserVersion(executablePath, host.version);
  startSweeper();

  browser.on("targetcreated", (target: Target) => {
    if (target.type() !== "page") return;
    void target.page().then((page) => {
      if (page) void adoptPage(host, page);
    });
  });
  browser.on("disconnected", () => {
    if (host.browser !== browser) return;
    const expected = host.closing;
    host.browser = null;
    dropTabs(host);
    if (!expected) {
      console.error(`[browser ${host.projectId}] Chrome went away`);
      for (const viewer of host.viewers) {
        sendJson(viewer, { type: "error", code: "browser_failed", message: "The browser stopped. The next action relaunches it." });
        sendJson(viewer, { type: "tabs", tabs: [] });
        viewer.front = null;
        sendJson(viewer, { type: "front", tabId: null });
      }
      if (host.viewers.size === 0) hosts.delete(host.projectId);
    }
  });

  const initial = await browser.pages();
  const adopted = (await Promise.all(initial.map((page) => adoptPage(host, page)))).filter(
    (tab): tab is BrowserTabState => tab !== null,
  );
  // Reopen what was open: the launch's own blank tab takes the first URL.
  for (const [index, entry] of saved.entries()) {
    const reuse = index === 0 ? adopted.find((tab) => tab.url === "about:blank" || tab.url === "") : undefined;
    const tab = reuse ?? (await adoptPage(host, await browser.newPage(), entry.openedBy));
    if (!tab) continue;
    tab.openedBy = entry.openedBy;
    tab.title = entry.title;
    tab.favicon = entry.favicon;
    tab.url = entry.url;
    tab.loading = true;
    // Not awaited: a slow page must not hold the panel's first frame.
    void tab.page.goto(entry.url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch((error: unknown) => {
      if (host.closing || tab.closed) return;
      console.warn(`[browser ${host.projectId}] could not reopen ${entry.url}:`, error instanceof Error ? error.message : error);
    });
  }
  host.front = host.tabs.keys().next().value ?? null;
  host.ready = true;
  scheduleTabsChanged(host);
  return host;
}

/** Make a puppeteer page one of the host's tabs. Idempotent per page: the
    `targetcreated` event and `newPage()` both arrive here for one tab. */
function adoptPage(host: BrowserHost, page: Page, openedBy?: BrowserTab["openedBy"]): Promise<BrowserTabState | null> {
  const existing = host.adopting.get(page);
  const run =
    existing ??
    (async () => {
      const cdp = await page.createCDPSession();
      const info = (await cdp.send("Target.getTargetInfo")) as { targetInfo: { targetId: string } };
      const tab = newTab(host, page, cdp, info.targetInfo.targetId);
      wireTab(host, tab);
      await cdp.send("Page.enable");
      host.tabs.set(tab.id, tab);
      scheduleTabsChanged(host);
      return tab;
    })().catch((error: unknown) => {
      // The page closed while it was being adopted — nothing to keep.
      if (!page.isClosed()) console.warn(`[browser ${host.projectId}] could not adopt a tab:`, error);
      host.adopting.delete(page);
      return null;
    });
  if (!existing) host.adopting.set(page, run);
  return run.then((tab) => {
    if (tab && openedBy) {
      tab.openedBy = openedBy;
      scheduleTabsChanged(host);
    }
    return tab;
  });
}

function newTab(host: BrowserHost, page: Page, cdp: CDPSession, id: string): BrowserTabState {
  return {
    id,
    projectId: host.projectId,
    page,
    cdp,
    openedBy: { kind: "user" },
    url: page.url(),
    title: "",
    favicon: null,
    loading: false,
    queue: Promise.resolve(),
    busy: 0,
    snapshot: null,
    snapshotGeneration: 0,
    console: new Ring(RING_SIZE),
    network: new Ring(RING_SIZE),
    inflight: new Set(),
    networkChangedAt: now(),
    dialog: null,
    dialogWaiters: new Set(),
    agent: null,
    viewport: null,
    cast: { running: null, op: Promise.resolve(), seq: 0, lastFrame: null },
    viewportTimer: null,
    viewportForced: false,
    closed: false,
  };
}

function wireTab(host: BrowserHost, tab: BrowserTabState): void {
  const { page, cdp } = tab;
  const refresh = () => void refreshTabInfo(host, tab);

  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    tab.url = page.url();
    clearSnapshot(tab);
    refresh();
  });
  cdp.on("Page.frameStartedLoading", (event: { frameId: string }) => {
    // A top-level page's main frame id is its target id.
    if (event.frameId !== tab.id) return;
    tab.loading = true;
    scheduleTabsChanged(host);
  });
  cdp.on("Page.frameStoppedLoading", (event: { frameId: string }) => {
    if (event.frameId !== tab.id) return;
    tab.loading = false;
    refresh();
  });
  cdp.on("Page.screencastFrame", (frame: ScreencastFrame) => onFrame(host, tab, frame));
  cdp.on("Page.javascriptDialogClosed", () => {
    if (!tab.dialog) return;
    tab.dialog = null;
    broadcast(host, { type: "dialog", tabId: tab.id, dialog: null });
  });

  page.on("dialog", (dialog) => {
    const handle = dialog as Dialog;
    const state: BrowserDialog = { type: handle.type(), message: handle.message() };
    if (state.type === "prompt") state.defaultValue = handle.defaultValue();
    tab.dialog = { handle, state };
    broadcast(host, { type: "dialog", tabId: tab.id, dialog: state });
    for (const wake of [...tab.dialogWaiters]) wake();
  });
  page.on("console", (message) => {
    const location = message.location();
    tab.console.push({ at: now(), level: message.type(), text: message.text(), url: location.url ?? null });
  });
  page.on("pageerror", (error) => {
    tab.console.push({ at: now(), level: "exception", text: error instanceof Error ? error.message : String(error), url: null });
  });

  const entries = new Map<HTTPRequest, RequestEntry>();
  page.on("request", (request) => {
    const entry: RequestEntry = {
      at: now(),
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      status: null,
      failure: null,
      durationMs: null,
    };
    entries.set(request, entry);
    tab.network.push(entry);
    tab.inflight.add(request);
    tab.networkChangedAt = now();
  });
  const settle = (request: HTTPRequest, failed: boolean) => {
    const entry = entries.get(request);
    entries.delete(request);
    tab.inflight.delete(request);
    tab.networkChangedAt = now();
    if (!entry) return;
    entry.durationMs = now() - entry.at;
    if (failed) entry.failure = request.failure()?.errorText ?? "failed";
    else entry.status = request.response()?.status() ?? null;
  };
  page.on("requestfinished", (request) => settle(request, false));
  page.on("requestfailed", (request) => settle(request, true));

  page.on("close", () => removeTab(host, tab));
}

async function refreshTabInfo(host: BrowserHost, tab: BrowserTabState): Promise<void> {
  try {
    tab.url = tab.page.url();
    tab.title = await tab.page.title();
    tab.favicon = await tab.page.evaluate(() => {
      const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
      if (link?.href) return link.href;
      return location.protocol === "http:" || location.protocol === "https:" ? `${location.origin}/favicon.ico` : null;
    });
  } catch {
    /* navigated again, or closed, mid-read; the next event refreshes */
  }
  scheduleTabsChanged(host);
}

function removeTab(host: BrowserHost, tab: BrowserTabState): void {
  if (tab.closed) return;
  tab.closed = true;
  host.adopting.delete(tab.page);
  if (tab.viewportTimer) clearTimeout(tab.viewportTimer);
  clearSnapshot(tab);
  const order = [...host.tabs.keys()];
  const index = order.indexOf(tab.id);
  host.tabs.delete(tab.id);
  if (host.closing) return;
  const neighbour = order[index + 1] ?? order[index - 1] ?? null;
  const fallback = neighbour && host.tabs.has(neighbour) ? neighbour : (host.tabs.keys().next().value ?? null);
  if (host.front === tab.id) host.front = fallback;
  for (const [sessionId, tabId] of host.sessionTabs) if (tabId === tab.id) host.sessionTabs.delete(sessionId);
  for (const viewer of host.viewers) {
    if (viewer.front !== tab.id) continue;
    setFront(host, viewer, fallback);
  }
  scheduleTabsChanged(host);
}

function dropTabs(host: BrowserHost): void {
  const wasClosing = host.closing;
  host.closing = true;
  for (const tab of [...host.tabs.values()]) removeTab(host, tab);
  host.closing = wasClosing;
  host.tabs.clear();
  host.adopting.clear();
  host.front = null;
  host.ready = false;
}

function clearSnapshot(tab: BrowserTabState): void {
  if (!tab.snapshot) return;
  for (const handle of tab.snapshot.handles.values()) void handle.dispose().catch(() => {});
  tab.snapshot = null;
}

/** Close Chrome, keeping the profile and writing `tabs.json` first. With
    `forget` the host is dropped and its viewers are closed (4000). */
function closeHost(host: BrowserHost, options: { forget: boolean }): Promise<void> {
  host.closing = true;
  const previous = closing.get(host.projectId) ?? Promise.resolve();
  const run = previous.then(() => doClose(host, options));
  const settled = run.finally(() => {
    if (closing.get(host.projectId) === settled) closing.delete(host.projectId);
  });
  closing.set(host.projectId, settled);
  return settled;
}

async function doClose(host: BrowserHost, { forget }: { forget: boolean }): Promise<void> {
  if (host.launching) await host.launching.catch(() => {});
  const browser = host.browser;
  if (host.ready) writeSavedTabs(host);
  host.closing = true;
  if (host.tabsBroadcastTimer) clearTimeout(host.tabsBroadcastTimer);
  host.tabsBroadcastTimer = null;
  if (host.tabsWriteTimer) clearTimeout(host.tabsWriteTimer);
  host.tabsWriteTimer = null;
  if (forget) {
    hosts.delete(host.projectId);
    for (const viewer of [...host.viewers]) {
      try {
        viewer.ws.close(BROWSER_CLOSE.closed, "browser closed");
      } catch {
        /* already gone */
      }
    }
    host.viewers.clear();
  }
  if (browser) await closeBrowser(browser);
  host.browser = null;
  dropTabs(host);
  host.closing = false;
}

function startSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => void sweepBrowsers(), SWEEP_MS);
  sweeper.unref?.();
}

/** Close every browser that has had no viewer and no activity for `IDLE_MS`.
    The minute sweep calls this; tests call it with a fake clock. */
export async function sweepBrowsers(): Promise<string[]> {
  const reclaimed: string[] = [];
  const t = now();
  for (const host of [...hosts.values()]) {
    if (!host.browser || host.closing || !isIdle(host)) continue;
    if (t - host.lastActivity <= IDLE_MS) continue;
    console.log(`[browser ${host.projectId}] closed (idle)`);
    reclaimed.push(host.projectId);
    await closeHost(host, { forget: true });
  }
  if (hosts.size === 0 && sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
  return reclaimed;
}

/**
 * Close a project's browser, or every browser without `projectId` (shutdown).
 * `deleteProfile` also removes `data/browsers/<projectId>` — logins, cache and
 * `tabs.json` — which is what deleting the project means. Viewers are closed
 * with 4000. Resolves to how many browsers were closed.
 */
export async function killProjectBrowsers(
  projectId?: string,
  { deleteProfile = false }: { deleteProfile?: boolean } = {},
): Promise<number> {
  const targets = [...hosts.values()].filter((host) => !projectId || host.projectId === projectId);
  let killed = 0;
  await Promise.all(
    targets.map(async (host) => {
      if (running(host)) killed += 1;
      await closeHost(host, { forget: true });
    }),
  );
  if (deleteProfile) {
    const ids = projectId ? [projectId] : targets.map((host) => host.projectId);
    for (const id of ids) {
      try {
        rmSync(profileDir(id), { recursive: true, force: true });
      } catch (error) {
        if (!(error instanceof BrowserError)) console.error(`[browser ${id}] could not delete the profile:`, error);
      }
    }
  }
  if (hosts.size === 0 && sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
  return killed;
}

// ---------------------------------------------------------------------------
// Tabs: the internal API (routes, the socket, the MCP route to come)
// ---------------------------------------------------------------------------

const describeTab = (tab: BrowserTabState): BrowserTab => ({
  id: tab.id,
  url: tab.url,
  title: tab.title,
  favicon: tab.favicon,
  loading: tab.loading,
  openedBy: tab.openedBy,
});

/** The project's tabs: the live ones, or what `tabs.json` will reopen. */
export function listTabs(projectId: string): { running: boolean; tabs: BrowserTab[] } {
  const host = hosts.get(projectId);
  if (host?.browser && host.ready) return { running: true, tabs: [...host.tabs.values()].map(describeTab) };
  return { running: false, tabs: savedAsTabs(projectId) };
}

/** A live tab of this project, or undefined. Scoped by project, so an id from
    one project's browser is never usable against another. */
export function findTab(projectId: string, tabId: BrowserTabId): BrowserTabState | undefined {
  const tab = hosts.get(projectId)?.tabs.get(tabId);
  return tab && !tab.closed ? tab : undefined;
}

function requireTab(projectId: string, tabId: BrowserTabId): BrowserTabState {
  const tab = findTab(projectId, tabId);
  if (!tab) throw new BrowserError("no_tab", "no such tab");
  return tab;
}

/** Open a tab (about:blank without a URL), launching the browser if needed.
    Navigation is started, not waited for. */
export async function openTab(
  projectId: string,
  { url, openedBy = { kind: "user" } }: { url?: string; openedBy?: BrowserTab["openedBy"] } = {},
): Promise<BrowserTab> {
  const target = url === undefined ? undefined : checkUrl(url);
  const host = await getOrLaunch(projectId);
  touch(host);
  if (!host.browser) throw new BrowserError("browser_failed", "the browser stopped while opening a tab");
  const page = await host.browser.newPage();
  const tab = await adoptPage(host, page, openedBy);
  if (!tab) throw new BrowserError("browser_failed", "the new tab closed before it opened");
  if (target) startNavigation(host, tab, () => tab.page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 }));
  return describeTab(tab);
}

/** Close a tab. False when there is no such tab. Never launches. */
export async function closeTab(projectId: string, tabId: BrowserTabId): Promise<boolean> {
  const tab = findTab(projectId, tabId);
  if (!tab) return false;
  const host = hosts.get(projectId);
  if (host) touch(host);
  /* `page.close()` can wait forever when it lands within a few ms of a
     navigation committing (seen ~1 in 15 on a fresh tab's `data:` load,
     puppeteer-core 25 / Chrome 151). The browser-level `Target.closeTarget`
     finishes it, and puppeteer's own close handler then removes the tab. */
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stuck = new Promise<"stuck">((resolve) => {
    timer = setTimeout(() => resolve("stuck"), CLOSE_TIMEOUT_MS);
  });
  const outcome = await Promise.race([tab.page.close({ runBeforeUnload: false }), stuck]);
  clearTimeout(timer);
  if (outcome === "stuck" && host?.browser) {
    const root = await host.browser.target().createCDPSession();
    try {
      await root.send("Target.closeTarget", { targetId: tab.id });
    } finally {
      await root.detach().catch(() => {});
    }
    removeTab(host, tab);
  }
  return true;
}

/**
 * Run `fn` with the tab to itself: one input stream per tab, so a person's
 * keystrokes and an agent's click land in order rather than interleaved.
 * Counts as activity, and the browser is not idle (or evictable) while it runs.
 */
export function runExclusive<T>(projectId: string, tabId: BrowserTabId, fn: (tab: BrowserTabState) => Promise<T>): Promise<T> {
  const tab = requireTab(projectId, tabId);
  const host = hosts.get(projectId);
  if (host) touch(host);
  tab.busy += 1;
  const result = tab.queue.then(() => {
    if (tab.closed) throw new BrowserError("no_tab", "the tab closed");
    return fn(tab);
  });
  tab.queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result.finally(() => {
    tab.busy -= 1;
    if (host) touch(host);
  });
}

/**
 * `work`, or `{ dialog: true }` as soon as a JavaScript dialog opens on the tab.
 * An `alert()` fired by a click or an evaluate blocks the CDP call that caused
 * it until the dialog is answered — and that call holds the tab's queue, which
 * the answer would otherwise wait behind. Use inside `runExclusive`. The
 * abandoned call finishes once the dialog closes; its outcome is dropped.
 */
export async function untilDialog<T>(tab: BrowserTabState, work: Promise<T>): Promise<{ dialog: false; value: T } | { dialog: true }> {
  work.catch(() => {});
  if (tab.dialog) return { dialog: true };
  let wake: (() => void) | undefined;
  const opened = new Promise<{ dialog: true }>((resolve) => {
    wake = () => resolve({ dialog: true });
    tab.dialogWaiters.add(wake);
  });
  try {
    return await Promise.race([work.then((value) => ({ dialog: false as const, value })), opened]);
  } finally {
    if (wake) tab.dialogWaiters.delete(wake);
  }
}

/** The tab an agent in `sessionId` acts on by default: the one in front of a
    viewer in that thread's dock, else the one that thread last selected.
    Null means the caller opens one. */
export function defaultTabFor(projectId: string, sessionId: string): BrowserTabId | null {
  const host = hosts.get(projectId);
  if (!host) return null;
  for (const viewer of host.viewers) if (viewer.sessionId === sessionId && viewer.front && host.tabs.has(viewer.front)) return viewer.front;
  const selected = host.sessionTabs.get(sessionId);
  return selected && host.tabs.has(selected) ? selected : null;
}

/** Remember that `sessionId` is working in `tabId` (an agent's `tabs select`). */
export function selectTabFor(projectId: string, sessionId: string, tabId: BrowserTabId): void {
  const host = hosts.get(projectId);
  if (host && host.tabs.has(tabId)) host.sessionTabs.set(sessionId, tabId);
}

/** What an agent is doing in a tab (null when it finished), fanned to every
    viewer for the overlay. Counts as activity. */
export function emitAgentActivity(projectId: string, tabId: BrowserTabId, activity: BrowserAgentActivity | null): void {
  const host = hosts.get(projectId);
  const tab = host?.tabs.get(tabId);
  if (!host || !tab) return;
  touch(host);
  tab.agent = activity;
  broadcast(host, { type: "agent", tabId, activity });
}

/** An agent's `viewport` call: it wins until a person resizes. Null resets
    the tab to the panel that last had input. */
export async function setAgentViewport(
  projectId: string,
  tabId: BrowserTabId,
  sessionId: string,
  size: { width: number; height: number; dpr?: number } | null,
): Promise<void> {
  const host = hosts.get(projectId);
  const tab = requireTab(projectId, tabId);
  if (!host) return;
  touch(host);
  if (size) {
    await applyViewport(host, tab, { ...clampViewport({ dpr: 1, ...size }), owner: { kind: "agent", sessionId } });
    return;
  }
  const viewer = [...host.viewers].find((v) => v.front === tabId && v.viewport);
  if (viewer?.viewport) await applyViewport(host, tab, { ...viewer.viewport, owner: { kind: "viewer", viewerId: viewer.id } });
  else await applyViewport(host, tab, null);
}

/** Activity: input, a tool call, a viewer arriving or leaving. */
function touch(host: BrowserHost): void {
  host.lastActivity = now();
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/** A URL the browser may be sent to. No blocking beyond refusing what is not
    a navigation at all: v1 browses from the server's network like its
    terminal does (docs/plans/browser.md, Risks). */
function checkUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BrowserError("bad_command", `not a URL: ${url}`);
  }
  if (parsed.protocol === "javascript:") throw new BrowserError("bad_command", "javascript: URLs are not navigations");
  return parsed.href;
}

/** Start a navigation without holding anything for its duration, and report
    a failure that is not just another navigation superseding it. */
function startNavigation(host: BrowserHost, tab: BrowserTabState, go: () => Promise<unknown>, viewer?: Viewer): void {
  touch(host);
  void go().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/ERR_ABORTED|frame was detached|Target closed|Session closed/i.test(message)) return;
    const report = { type: "error", code: "navigation_failed", message, command: "navigate", tabId: tab.id } as const;
    if (viewer) sendJson(viewer, report);
    else broadcast(host, report);
  });
}

// ---------------------------------------------------------------------------
// Viewers
// ---------------------------------------------------------------------------

function sendJson(viewer: Viewer, message: BrowserServerMessage): void {
  const { ws } = viewer;
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(message));
  } catch {
    /* the socket is going away; its close handler detaches it */
  }
}

function sendFrame(viewer: Viewer, frame: Uint8Array): void {
  const { ws } = viewer;
  if (ws.readyState !== ws.OPEN || ws.bufferedAmount > MAX_BUFFERED_BYTES) return;
  try {
    ws.send(frame, { binary: true });
  } catch {
    /* as above */
  }
}

function broadcast(host: BrowserHost, message: BrowserServerMessage): void {
  for (const viewer of host.viewers) sendJson(viewer, message);
}

/** Tabs changed: fan the list (coalesced) and rewrite `tabs.json` (debounced). */
function scheduleTabsChanged(host: BrowserHost): void {
  if (host.closing || !host.ready) return;
  if (!host.tabsBroadcastTimer) {
    host.tabsBroadcastTimer = setTimeout(() => {
      host.tabsBroadcastTimer = null;
      broadcast(host, { type: "tabs", tabs: [...host.tabs.values()].map(describeTab) });
    }, TABS_BROADCAST_DEBOUNCE_MS);
    host.tabsBroadcastTimer.unref?.();
  }
  if (host.tabsWriteTimer) clearTimeout(host.tabsWriteTimer);
  host.tabsWriteTimer = setTimeout(() => writeSavedTabs(host), TABS_WRITE_DEBOUNCE_MS);
  host.tabsWriteTimer.unref?.();
}

function viewportMessage(tab: BrowserTabState): BrowserViewportMessage | null {
  if (!tab.viewport) return null;
  const { width, height, dpr, owner } = tab.viewport;
  return { type: "viewport", tabId: tab.id, width, height, dpr, owner };
}

/** Move a viewer to a tab (or none), restart the casts that changes, and send
    it `front` plus the cached frame so it draws at once. */
function setFront(host: BrowserHost, viewer: Viewer, tabId: BrowserTabId | null): void {
  const previous = viewer.front;
  viewer.front = tabId && host.tabs.has(tabId) ? tabId : null;
  sendJson(viewer, { type: "front", tabId: viewer.front });
  if (previous && previous !== viewer.front) {
    const old = host.tabs.get(previous);
    if (old) updateCast(host, old);
  }
  const tab = viewer.front ? host.tabs.get(viewer.front) : undefined;
  if (!tab) return;
  if (tab.cast.lastFrame) sendFrame(viewer, tab.cast.lastFrame);
  // A tab nobody sized yet takes this viewer's size.
  if (!tab.viewport && viewer.viewport) scheduleViewport(host, tab, viewer, 0);
  updateCast(host, tab);
}

/**
 * Attach a viewer socket to a project's browser, launching it if needed. The
 * caller has checked the token and that the project exists. Refusals close
 * the socket with the contract's code and the reason as the close text.
 */
export async function attachBrowserViewer(projectId: string, sessionId: string | null, ws: WebSocket): Promise<void> {
  const viewer: Viewer = { id: randomUUID(), ws, sessionId, front: null, viewport: null };
  let host: BrowserHost;
  // Commands that arrive while Chrome launches wait for it, in order.
  const pending: unknown[] = [];
  let attached = false;
  let gone = false;
  ws.on("message", (raw, isBinary) => {
    if (isBinary) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      sendJson(viewer, { type: "error", code: "bad_command", message: "not JSON" });
      return;
    }
    if (!attached) pending.push(parsed);
    else void handleRaw(parsed);
  });
  const detach = () => {
    gone = true;
    const live = hosts.get(projectId);
    if (!live || !live.viewers.delete(viewer)) return;
    touch(live);
    const tab = viewer.front ? live.tabs.get(viewer.front) : undefined;
    if (tab) updateCast(live, tab);
  };
  ws.on("close", detach);
  ws.on("error", detach);

  let chain: Promise<void> = Promise.resolve();
  const handleRaw = (parsed: unknown) => {
    chain = chain.then(() => handleCommand(projectId, viewer, parsed));
    return chain;
  };

  try {
    host = await getOrLaunch(projectId);
  } catch (error) {
    const failure = error instanceof BrowserError ? error : new BrowserError("browser_failed", String(error));
    const code =
      failure.code === "unavailable" ? BROWSER_CLOSE.unavailable : failure.code === "limit" ? BROWSER_CLOSE.limit : BROWSER_CLOSE.closed;
    // A close reason is capped at 123 bytes.
    ws.close(code, failure.message.slice(0, 120));
    return;
  }
  if (gone) return;
  host.viewers.add(viewer);
  touch(host);
  attached = true;

  sendJson(viewer, { type: "hello", version: BROWSER_PROTOCOL_VERSION, viewerId: viewer.id, browserVersion: host.version });
  sendJson(viewer, { type: "tabs", tabs: [...host.tabs.values()].map(describeTab) });
  const front =
    (sessionId && host.sessionTabs.get(sessionId)) || (host.front && host.tabs.has(host.front) ? host.front : null) || (host.tabs.keys().next().value ?? null);
  viewer.front = front;
  sendJson(viewer, { type: "front", tabId: front });
  for (const tab of host.tabs.values()) {
    if (tab.dialog) sendJson(viewer, { type: "dialog", tabId: tab.id, dialog: tab.dialog.state });
    if (tab.agent) sendJson(viewer, { type: "agent", tabId: tab.id, activity: tab.agent });
    const viewport = viewportMessage(tab);
    if (viewport) sendJson(viewer, viewport);
  }
  const frontTab = front ? host.tabs.get(front) : undefined;
  if (frontTab) {
    if (frontTab.cast.lastFrame) sendFrame(viewer, frontTab.cast.lastFrame);
    updateCast(host, frontTab);
  }
  for (const parsed of pending.splice(0)) void handleRaw(parsed);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const tabIdField = z.string().min(1).max(200);
const finite = z.number().finite();
const modifiers = z.number().int().min(0).max(15);

const CommandSchema = z.union([
  z.object({ type: z.literal("navigate"), tabId: tabIdField, action: z.literal("url"), url: z.string().min(1).max(32_768) }),
  z.object({ type: z.literal("navigate"), tabId: tabIdField, action: z.enum(["back", "forward", "reload", "stop"]) }),
  z.object({ type: z.literal("tab"), action: z.literal("new"), url: z.string().min(1).max(32_768).optional() }),
  z.object({ type: z.literal("tab"), action: z.enum(["close", "select"]), tabId: tabIdField }),
  z.object({ type: z.literal("viewport"), width: finite, height: finite, dpr: finite }),
  z.object({
    type: z.literal("mouse"),
    tabId: tabIdField,
    event: z.enum(["mousePressed", "mouseReleased", "mouseMoved"]),
    x: finite,
    y: finite,
    button: z.enum(["none", "left", "middle", "right", "back", "forward"]),
    buttons: z.number().int().min(0),
    clickCount: z.number().int().min(0).max(3),
    modifiers,
  }),
  z.object({ type: z.literal("wheel"), tabId: tabIdField, x: finite, y: finite, deltaX: finite, deltaY: finite, modifiers }),
  z.object({
    type: z.literal("key"),
    tabId: tabIdField,
    event: z.enum(["keyDown", "keyUp"]),
    key: z.string().max(64),
    code: z.string().max(64),
    modifiers,
    text: z.string().max(16).optional(),
    keyCode: z.number().int().optional(),
    location: z.number().int().min(0).max(3).optional(),
    repeat: z.boolean().optional(),
  }),
  z.object({ type: z.literal("text"), tabId: tabIdField, text: z.string().max(100_000) }),
  z.object({ type: z.literal("dialog"), tabId: tabIdField, accept: z.boolean(), promptText: z.string().max(100_000).optional() }),
  z.object({ type: z.literal("watch"), tabId: tabIdField.nullable() }),
]);

// The schema and the contract must describe the same commands.
type ParsedCommand = z.infer<typeof CommandSchema>;
const _contractCheck: (command: ParsedCommand) => BrowserCommand = (command) => command;
void _contractCheck;

async function handleCommand(projectId: string, viewer: Viewer, raw: unknown): Promise<void> {
  const parsed = CommandSchema.safeParse(raw);
  const type = (raw as { type?: unknown } | null)?.type;
  const named = typeof type === "string" ? (type as BrowserCommand["type"]) : undefined;
  if (!parsed.success) {
    sendJson(viewer, { type: "error", code: "bad_command", message: parsed.error.issues[0]?.message ?? "bad command", command: named });
    return;
  }
  const command = parsed.data;
  const tabId = "tabId" in command && command.tabId ? command.tabId : undefined;
  try {
    // A crashed browser comes back on the next command, as the contract says.
    const host = await getOrLaunch(projectId);
    if (!host.viewers.has(viewer)) return;
    touch(host);
    await run(host, viewer, command);
  } catch (error) {
    const failure =
      error instanceof BrowserError
        ? error
        : new BrowserError("internal", error instanceof Error ? error.message : String(error));
    const code: BrowserErrorCode =
      failure.code === "unavailable" || failure.code === "limit" ? "browser_failed" : failure.code;
    sendJson(viewer, { type: "error", code, message: failure.message, command: command.type, tabId });
  }
}

async function run(host: BrowserHost, viewer: Viewer, command: ParsedCommand): Promise<void> {
  const { projectId } = host;
  switch (command.type) {
    case "navigate": {
      const tab = requireTab(projectId, command.tabId);
      if (command.action === "url") {
        const url = checkUrl(command.url);
        startNavigation(host, tab, () => tab.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }), viewer);
      } else if (command.action === "back") {
        startNavigation(host, tab, () => tab.page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 }), viewer);
      } else if (command.action === "forward") {
        startNavigation(host, tab, () => tab.page.goForward({ waitUntil: "domcontentloaded", timeout: 30_000 }), viewer);
      } else if (command.action === "reload") {
        startNavigation(host, tab, () => tab.page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }), viewer);
      } else {
        await tab.cdp.send("Page.stopLoading");
      }
      return;
    }
    case "tab": {
      if (command.action === "new") {
        const tab = await openTab(projectId, { url: command.url, openedBy: { kind: "user" } });
        await selectTab(host, viewer, tab.id);
      } else if (command.action === "close") {
        if (!(await closeTab(projectId, command.tabId))) throw new BrowserError("no_tab", "no such tab");
      } else {
        requireTab(projectId, command.tabId);
        await selectTab(host, viewer, command.tabId);
      }
      return;
    }
    case "watch":
      if (command.tabId !== null) requireTab(projectId, command.tabId);
      setFront(host, viewer, command.tabId);
      return;
    case "viewport": {
      const size = clampViewport(command);
      const resized =
        !viewer.viewport ||
        viewer.viewport.width !== size.width ||
        viewer.viewport.height !== size.height ||
        viewer.viewport.dpr !== size.dpr;
      viewer.viewport = size;
      const tab = viewer.front ? host.tabs.get(viewer.front) : undefined;
      if (!tab) return;
      // A resize is a person taking the size back; a repeat is just "this
      // panel had input", which does not override an agent.
      if (resized || tab.viewport?.owner.kind !== "agent") scheduleViewport(host, tab, viewer, 0, resized);
      return;
    }
    case "dialog": {
      const tab = requireTab(projectId, command.tabId);
      const pending = tab.dialog;
      if (!pending) throw new BrowserError("bad_command", "this tab has no dialog open");
      tab.dialog = null;
      broadcast(host, { type: "dialog", tabId: tab.id, dialog: null });
      if (command.accept) await pending.handle.accept(command.promptText);
      else await pending.handle.dismiss();
      return;
    }
    case "mouse":
    case "wheel":
    case "key":
    case "text": {
      const tab = requireTab(projectId, command.tabId);
      followInput(host, tab, viewer);
      // A click that opens an alert must not hold the queue the answer needs.
      await runExclusive(projectId, tab.id, (t) => untilDialog(t, dispatchInput(t.cdp, command)));
      return;
    }
  }
}

async function selectTab(host: BrowserHost, viewer: Viewer, tabId: BrowserTabId): Promise<void> {
  const tab = requireTab(host.projectId, tabId);
  host.front = tabId;
  if (viewer.sessionId) host.sessionTabs.set(viewer.sessionId, tabId);
  setFront(host, viewer, tabId);
  await tab.page.bringToFront();
}

type InputCommand = Extract<ParsedCommand, { type: "mouse" | "wheel" | "key" | "text" }>;

/** The panel's input as CDP `Input.*`, CSS pixels unchanged. */
async function dispatchInput(cdp: CDPSession, command: InputCommand): Promise<void> {
  switch (command.type) {
    case "mouse":
      await cdp.send("Input.dispatchMouseEvent", {
        type: command.event,
        x: command.x,
        y: command.y,
        button: command.button,
        buttons: command.buttons,
        clickCount: command.clickCount,
        modifiers: command.modifiers,
      });
      return;
    case "wheel":
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: command.x,
        y: command.y,
        deltaX: command.deltaX,
        deltaY: command.deltaY,
        modifiers: command.modifiers,
      });
      return;
    case "key":
      await cdp.send("Input.dispatchKeyEvent", {
        type: command.event === "keyUp" ? "keyUp" : command.text ? "keyDown" : "rawKeyDown",
        key: command.key,
        code: command.code,
        modifiers: command.modifiers,
        ...(command.text ? { text: command.text, unmodifiedText: command.text } : {}),
        ...(command.keyCode !== undefined
          ? { windowsVirtualKeyCode: command.keyCode, nativeVirtualKeyCode: command.keyCode }
          : {}),
        ...(command.location !== undefined ? { location: command.location } : {}),
        ...(command.repeat ? { autoRepeat: true } : {}),
      });
      return;
    case "text":
      await cdp.send("Input.insertText", { text: command.text });
      return;
  }
}

// ---------------------------------------------------------------------------
// Viewport
// ---------------------------------------------------------------------------

function clampViewport(size: { width: number; height: number; dpr: number }) {
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  return {
    width: Math.round(clamp(size.width, 200, 4096)),
    height: Math.round(clamp(size.height, 150, 4096)),
    dpr: Math.round(clamp(size.dpr, 1, 3) * 100) / 100,
  };
}

/** The panel that sent input takes the viewport, unless an agent set it. */
function followInput(host: BrowserHost, tab: BrowserTabState, viewer: Viewer): void {
  if (!viewer.viewport) return;
  const owner = tab.viewport?.owner;
  if (owner?.kind === "agent") return;
  if (owner?.kind === "viewer" && owner.viewerId === viewer.id) return;
  scheduleViewport(host, tab, viewer, VIEWPORT_DEBOUNCE_MS);
}

function scheduleViewport(host: BrowserHost, tab: BrowserTabState, viewer: Viewer, delay: number, force = false): void {
  /* One timer per tab, so two viewers resizing at once are last-writer-wins.
     But a person's resize (forced) is never replaced by another panel merely
     having input (unforced): that dropped the resize, and the panel does not
     send its size again until it changes. */
  if (tab.viewportTimer) {
    if (tab.viewportForced && !force) return;
    clearTimeout(tab.viewportTimer);
  }
  tab.viewportForced = force;
  tab.viewportTimer = setTimeout(() => {
    tab.viewportTimer = null;
    tab.viewportForced = false;
    if (!viewer.viewport || tab.closed || !host.viewers.has(viewer)) return;
    if (!force && tab.viewport?.owner.kind === "agent") return;
    void applyViewport(host, tab, { ...viewer.viewport, owner: { kind: "viewer", viewerId: viewer.id } }).catch(
      (error: unknown) => console.warn(`[browser ${host.projectId}] viewport:`, error),
    );
  }, delay);
  tab.viewportTimer.unref?.();
}

async function applyViewport(host: BrowserHost, tab: BrowserTabState, next: TabViewport | null): Promise<void> {
  const current = tab.viewport;
  const same =
    current &&
    next &&
    current.width === next.width &&
    current.height === next.height &&
    current.dpr === next.dpr &&
    JSON.stringify(current.owner) === JSON.stringify(next.owner);
  if (same) return;
  tab.viewport = next;
  const size = next ?? { ...DEFAULT_VIEWPORT };
  await tab.page.setViewport({ width: size.width, height: size.height, deviceScaleFactor: size.dpr });
  const message = viewportMessage(tab);
  if (message) broadcast(host, message);
  updateCast(host, tab);
}

// ---------------------------------------------------------------------------
// Screencast
// ---------------------------------------------------------------------------

interface ScreencastFrame {
  data: string;
  sessionId: number;
  metadata: {
    offsetTop: number;
    pageScaleFactor: number;
    deviceWidth: number;
    deviceHeight: number;
    scrollOffsetX: number;
    scrollOffsetY: number;
    timestamp?: number;
  };
}

const watchers = (host: BrowserHost, tab: BrowserTabState) => [...host.viewers].filter((viewer) => viewer.front === tab.id);

/** Start, restart (the cap changed) or stop a tab's screencast to match who
    is watching it. Capped at the largest watcher's canvas x DPR. */
function updateCast(host: BrowserHost, tab: BrowserTabState): void {
  tab.cast.op = tab.cast.op
    .then(async () => {
      if (tab.closed) return;
      const watching = watchers(host, tab);
      if (watching.length === 0 || host.closing) {
        if (tab.cast.running) {
          tab.cast.running = null;
          await tab.cdp.send("Page.stopScreencast");
        }
        return;
      }
      const sizes = watching.map((viewer) => viewer.viewport ?? tab.viewport ?? DEFAULT_VIEWPORT);
      const maxWidth = Math.round(Math.max(...sizes.map((s) => s.width * s.dpr)));
      const maxHeight = Math.round(Math.max(...sizes.map((s) => s.height * s.dpr)));
      const current = tab.cast.running;
      if (current && current.maxWidth === maxWidth && current.maxHeight === maxHeight) return;
      if (current) await tab.cdp.send("Page.stopScreencast");
      tab.cast.running = { maxWidth, maxHeight };
      await tab.cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth, maxHeight, everyNthFrame: 1 });
    })
    .catch((error: unknown) => {
      tab.cast.running = null;
      if (!tab.closed) console.warn(`[browser ${host.projectId}] screencast:`, error instanceof Error ? error.message : error);
    });
}

function onFrame(host: BrowserHost, tab: BrowserTabState, frame: ScreencastFrame): void {
  // Ack first: Chrome sends nothing more until it is acked.
  void tab.cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
  const { metadata } = frame;
  tab.cast.seq = (tab.cast.seq + 1) >>> 0;
  const encoded = encodeBrowserFrame(
    {
      tabId: tab.id,
      seq: tab.cast.seq,
      timestamp: metadata.timestamp ?? 0,
      offsetTop: metadata.offsetTop,
      pageScaleFactor: metadata.pageScaleFactor,
      deviceWidth: metadata.deviceWidth,
      deviceHeight: metadata.deviceHeight,
      scrollOffsetX: metadata.scrollOffsetX,
      scrollOffsetY: metadata.scrollOffsetY,
    },
    Buffer.from(frame.data, "base64"),
  );
  tab.cast.lastFrame = encoded;
  for (const viewer of watchers(host, tab)) sendFrame(viewer, encoded);
}
