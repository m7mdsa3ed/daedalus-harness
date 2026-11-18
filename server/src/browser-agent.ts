/*
 * The agent's half of the project browser: what each `browser` MCP tool does,
 * on top of `browsers.ts` (docs/plans/browser.md, "The MCP").
 *
 * The stdio child (`browser-mcp.ts`) holds no state; `/bm` (routes/browser.ts)
 * resolves the calling thread and hands its project and session id here. Every
 * input goes through the tab's queue (`runExclusive`) and through puppeteer's
 * handle methods, which dispatch real `Input.*` events — so a click is visible
 * in the panel's stream — and every action fans an `agent` activity frame with
 * the element's rect to the viewers.
 *
 * Snapshots: `page.accessibility.snapshot({interestingOnly: true})`, each node's
 * handle kept under a uid `<generation>_<n>`. The generation is the tab's,
 * bumped per snapshot and never reset, and the slot is cleared on main-frame
 * navigation, so a uid from an older snapshot fails loudly rather than
 * clicking whatever now stands where its element was.
 */
import type { ElementHandle, KeyInput, SerializedAXNode } from "puppeteer-core";
import type { BrowserAgentAction, BrowserRect, BrowserTabId } from "./browser-protocol.js";
import { z } from "zod";
import { BROWSER_TOOLS, type BrowserToolArgs, type BrowserToolName, type BrowserToolResult } from "./browser-mcp-tools.js";
import {
  BrowserError,
  closeTab,
  defaultTabFor,
  emitAgentActivity,
  findTab,
  listTabs,
  openTab,
  runExclusive,
  selectTabFor,
  setAgentViewport,
  untilDialog,
  type BrowserTabState,
} from "./browsers.js";

/** Network quiet: no request in flight for this long. */
const QUIET_MS = 500;
/** The quiet wait gives up after this, from when it started. */
const QUIET_CAP_MS = 3_000;
/** The whole settle — navigation, quiet, a frame — is bounded here. */
const SETTLE_CAP_MS = 10_000;
/** How long an action waits to see whether it started a navigation. */
const NAV_GRACE_MS = 150;
/** A snapshot longer than this is cut, with a line saying so. */
const SNAPSHOT_MAX_CHARS = 40_000;
const SCREENSHOT_MAX_WIDTH = 1280;

export interface BrowserCaller {
  projectId: string;
  sessionId: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// The thread's tab
// ---------------------------------------------------------------------------

/** The tab a call works on: the one it named, else the thread's own (the one
    in front of a viewer in its dock, else the one it last selected), else a
    new tab opened for it. */
async function resolveTab(caller: BrowserCaller, tabId: string | undefined): Promise<BrowserTabState> {
  const { projectId, sessionId } = caller;
  if (tabId) {
    const tab = findTab(projectId, tabId);
    if (!tab) throw new BrowserError("no_tab", `no tab ${tabId} — call tabs to list them`);
    selectTabFor(projectId, sessionId, tab.id);
    return tab;
  }
  const own = defaultTabFor(projectId, sessionId);
  const found = own ? findTab(projectId, own) : undefined;
  if (found) return found;
  const opened = await openTab(projectId, { openedBy: { kind: "agent", sessionId } });
  selectTabFor(projectId, sessionId, opened.id);
  const tab = findTab(projectId, opened.id);
  if (!tab) throw new BrowserError("browser_failed", "the new tab closed before it opened");
  return tab;
}

/** The tab this thread works on without opening one: null when it has none. */
function currentTabId(caller: BrowserCaller): BrowserTabId | null {
  return defaultTabFor(caller.projectId, caller.sessionId);
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

function describeNode(node: SerializedAXNode): string {
  let line = node.role;
  if (node.name) line += ` ${JSON.stringify(node.name)}`;
  const value = node.valuetext ?? node.value;
  if (value !== undefined && value !== "" && value !== node.name) line += ` value=${JSON.stringify(String(value))}`;
  if (node.description) line += ` desc=${JSON.stringify(node.description)}`;
  if (node.level !== undefined) line += ` level=${node.level}`;
  if (node.checked !== undefined) line += node.checked === "mixed" ? " checked=mixed" : node.checked ? " checked" : " unchecked";
  if (node.pressed !== undefined) line += node.pressed === "mixed" ? " pressed=mixed" : node.pressed ? " pressed" : "";
  if (node.selected) line += " selected";
  if (node.expanded !== undefined) line += node.expanded ? " expanded" : " collapsed";
  if (node.disabled) line += " disabled";
  if (node.focused) line += " focused";
  return line;
}

/** Take a snapshot of the tab, replacing its uids. Called inside the tab's queue. */
async function takeSnapshot(tab: BrowserTabState): Promise<string> {
  const root = await tab.page.accessibility.snapshot({ interestingOnly: true });
  const generation = ++tab.snapshotGeneration;
  const handles = new Map<string, ElementHandle>();
  const lines: string[] = [];
  let counter = 0;
  const walk = async (node: SerializedAXNode, depth: number) => {
    const handle = await node.elementHandle().catch(() => null);
    const uid = `${generation}_${++counter}`;
    if (handle) handles.set(uid, handle);
    lines.push(`${"  ".repeat(depth)}[${uid}] ${describeNode(node)}`);
    for (const child of node.children ?? []) await walk(child, depth + 1);
  };
  if (root) await walk(root, 0);
  if (tab.snapshot) for (const old of tab.snapshot.handles.values()) void old.dispose().catch(() => {});
  tab.snapshot = { generation, handles };
  let text = lines.join("\n") || "(empty page)";
  if (text.length > SNAPSHOT_MAX_CHARS) {
    const cut = text.lastIndexOf("\n", SNAPSHOT_MAX_CHARS);
    text = `${text.slice(0, cut)}\n… snapshot cut at ${SNAPSHOT_MAX_CHARS} characters`;
  }
  return text;
}

/** The handle behind a uid from the tab's latest snapshot, or a loud refusal. */
function handleFor(tab: BrowserTabState, uid: string): ElementHandle {
  const generation = Number(uid.split("_")[0]);
  const slot = tab.snapshot;
  if (!slot || slot.generation !== generation) {
    throw new BrowserError("bad_command", `uid ${uid} is from an old snapshot (the page changed or was snapshotted again) — call snapshot again`);
  }
  const handle = slot.handles.get(uid);
  if (!handle) throw new BrowserError("bad_command", `uid ${uid} is not an element you can act on — pick another from the snapshot`);
  return handle;
}

/** Evaluating in a page whose dialog is up waits for its answer — which the
    queue this call holds would keep from ever arriving. Refuse instead. */
function refuseUnderDialog(tab: BrowserTabState): void {
  if (tab.dialog) throw new BrowserError("bad_command", `a ${tab.dialog.state.type} dialog is open — answer it with act action=dialog first`);
}

const requireUid = (uid: string | undefined, action: string): string => {
  if (!uid) throw new BrowserError("bad_command", `${action} needs a uid from snapshot`);
  return uid;
};

// ---------------------------------------------------------------------------
// Settle
// ---------------------------------------------------------------------------

/**
 * Wait for what an action set off: a navigation it started (Chrome reports the
 * main frame loading), then network quiet — nothing in flight for 500 ms,
 * capped at 3 s — then one rendered frame. Bounded at 10 s overall; the result
 * says when a cap was what ended it, so the model knows the page may still be
 * moving.
 */
async function settle(tab: BrowserTabState, startedAt: number): Promise<string | null> {
  const deadline = startedAt + SETTLE_CAP_MS;
  const notes: string[] = [];
  await sleep(Math.max(0, Math.min(NAV_GRACE_MS, deadline - Date.now())));
  while (tab.loading && Date.now() < deadline && !tab.closed && !tab.dialog) await sleep(50);
  if (tab.loading && !tab.dialog) notes.push(`the page was still loading after ${SETTLE_CAP_MS / 1000}s`);
  const quietStart = Date.now();
  const quietDeadline = Math.min(deadline, quietStart + QUIET_CAP_MS);
  for (;;) {
    if (tab.closed || tab.dialog) break;
    const quietFor = Date.now() - tab.networkChangedAt;
    if (tab.inflight.size === 0 && quietFor >= QUIET_MS) break;
    if (Date.now() >= quietDeadline) {
      notes.push(`${tab.inflight.size} request(s) still in flight after ${Math.round((Date.now() - quietStart) / 1000)}s`);
      break;
    }
    await sleep(50);
  }
  if (!tab.closed && !tab.dialog) {
    // One frame, so a DOM change the action made has been laid out and painted.
    await Promise.race([
      tab.page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))).catch(() => {}),
      sleep(Math.max(0, deadline - Date.now())),
    ]);
  }
  return notes.length ? `settle cap hit: ${notes.join("; ")}` : null;
}

/** The text an action answers: where the tab is now, what is pending, and
    (unless turned off) a fresh snapshot. */
async function report(tab: BrowserTabState, head: string[], withSnapshot: boolean): Promise<string> {
  const lines = [...head];
  if (tab.closed) return [...lines, "The tab closed."].join("\n");
  /* While a dialog is open the page's main thread is blocked, so evaluating
     anything (`page.title()` is an evaluate) waits for an answer that this very
     report is what asks for. Read the title only with no dialog up. */
  const title = tab.dialog ? tab.title : await tab.page.title().catch(() => tab.title);
  lines.push(`tab ${tab.id}: ${tab.page.url()} — ${title}`);
  if (tab.dialog) {
    const { type, message } = tab.dialog.state;
    lines.push(`A ${type} dialog is open: ${JSON.stringify(message)}. Answer it with act action=dialog.`);
    return lines.join("\n");
  }
  if (withSnapshot) lines.push("", await takeSnapshot(tab));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

async function rectOf(handle: ElementHandle | null): Promise<BrowserRect | null> {
  if (!handle) return null;
  const box = await handle.boundingBox().catch(() => null);
  return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
}

/** Run an action with the overlay told what it is, and cleared after. */
async function withActivity<T>(
  caller: BrowserCaller,
  tab: BrowserTabState,
  action: BrowserAgentAction,
  handle: ElementHandle | null,
  fn: () => Promise<T>,
): Promise<T> {
  emitAgentActivity(caller.projectId, tab.id, {
    sessionId: caller.sessionId,
    tabId: tab.id,
    action,
    rect: await rectOf(handle),
    at: Date.now(),
  });
  try {
    return await fn();
  } finally {
    emitAgentActivity(caller.projectId, tab.id, null);
  }
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

type Handler<K extends BrowserToolName> = (caller: BrowserCaller, args: BrowserToolArgs<K>) => Promise<BrowserToolResult>;

const text = (value: string): BrowserToolResult => ({ text: value });

/** A typed-in address: a scheme is kept, a bare host gets `https://`. */
function normaliseUrl(url: string): string {
  const trimmed = url.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

const tabs: Handler<"tabs"> = async (caller, args) => {
  const { projectId, sessionId } = caller;
  const action = args.action ?? "list";
  if (action === "new") {
    const opened = await openTab(projectId, {
      url: args.url ? normaliseUrl(args.url) : undefined,
      openedBy: { kind: "agent", sessionId },
    });
    selectTabFor(projectId, sessionId, opened.id);
  } else if (action === "select" || action === "close") {
    if (!args.tabId) throw new BrowserError("bad_command", `${action} needs a tabId`);
    if (action === "select") {
      if (!findTab(projectId, args.tabId)) throw new BrowserError("no_tab", `no tab ${args.tabId}`);
      selectTabFor(projectId, sessionId, args.tabId);
    } else if (!(await closeTab(projectId, args.tabId))) throw new BrowserError("no_tab", `no tab ${args.tabId}`);
  }
  const { running, tabs: list } = listTabs(projectId);
  if (!running) return text("The browser is not running; navigate or tabs action=new starts it.");
  const mine = currentTabId(caller);
  const lines = list.map((t) => `${t.id === mine ? "*" : " "} ${t.id}  ${t.title || "(untitled)"} — ${t.url}`);
  return text(lines.length ? lines.join("\n") : "No tabs open.");
};

const navigate: Handler<"navigate"> = async (caller, args) => {
  if (!args.url && !args.action) throw new BrowserError("bad_command", "navigate needs a url or an action");
  const tab = await resolveTab(caller, args.tabId);
  return runExclusive(caller.projectId, tab.id, async () => {
    const startedAt = Date.now();
    const verb: BrowserAgentAction = args.url ? "navigate" : (args.action ?? "navigate");
    let status: number | null = null;
    const notes: string[] = [];
    await withActivity(caller, tab, verb, null, async () => {
      const options = { waitUntil: "domcontentloaded" as const, timeout: SETTLE_CAP_MS };
      try {
        const response = args.url
          ? await tab.page.goto(normaliseUrl(args.url), options)
          : args.action === "back"
            ? await tab.page.goBack(options)
            : args.action === "forward"
              ? await tab.page.goForward(options)
              : await tab.page.reload(options);
        status = response?.status() ?? null;
        if (!response && args.action && args.action !== "reload") notes.push(`there was no page to go ${args.action} to`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/timeout/i.test(message)) notes.push(`the page did not finish loading in ${SETTLE_CAP_MS / 1000}s`);
        else throw new BrowserError("navigation_failed", message);
      }
      const capped = await settle(tab, startedAt);
      if (capped) notes.push(capped);
    });
    const head = [status === null ? "navigated" : `status ${status}`, ...notes];
    return text(await report(tab, head, args.snapshot !== false));
  });
};

const snapshot: Handler<"snapshot"> = async (caller, args) => {
  const tab = await resolveTab(caller, args.tabId);
  return runExclusive(caller.projectId, tab.id, async () => text(await report(tab, [], true)));
};

const act: Handler<"act"> = async (caller, args) => {
  const tab = await resolveTab(caller, args.tabId);
  return runExclusive(caller.projectId, tab.id, async () => {
    const startedAt = Date.now();
    const { action } = args;
    if (action === "dialog") {
      const pending = tab.dialog;
      if (!pending) throw new BrowserError("bad_command", "no dialog is open on this tab");
      tab.dialog = null;
      await withActivity(caller, tab, "dialog", null, async () => {
        if (args.accept === false) await pending.handle.dismiss();
        else await pending.handle.accept(args.text);
      });
    } else {
      // press and scroll act on the page when no uid is given; the rest need one.
      const optional = action === "press" || action === "scroll";
      const handle = optional && !args.uid ? null : handleFor(tab, requireUid(args.uid, action));
      const el = (): ElementHandle => handle ?? handleFor(tab, requireUid(args.uid, action));
      // A click that opens an alert answers now, saying so (`report`), rather
      // than holding the tab's queue the `dialog` action needs.
      await withActivity(caller, tab, action, handle, () => untilDialog(tab, perform()));
      async function perform(): Promise<void> {
        switch (action) {
          case "click":
            await el().click();
            break;
          case "dblclick":
            await el().click({ count: 2 });
            break;
          case "hover":
            await el().hover();
            break;
          case "fill": {
            const value = args.text ?? "";
            await el().click({ count: 3 });
            await tab.page.keyboard.press("Backspace");
            // A select-all that missed (a contenteditable) still clears via the value.
            await el().evaluate((el) => {
              if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
                el.value = "";
                el.dispatchEvent(new Event("input", { bubbles: true }));
              }
            });
            if (value) await tab.page.keyboard.type(value);
            break;
          }
          case "type":
            if (args.text === undefined) throw new BrowserError("bad_command", "type needs text");
            await el().focus();
            await tab.page.keyboard.type(args.text);
            break;
          case "press": {
            if (!args.key) throw new BrowserError("bad_command", "press needs a key, e.g. Enter or Control+A");
            if (handle) await handle.focus();
            await pressChord(tab, args.key);
            break;
          }
          case "select": {
            if (!args.values?.length) throw new BrowserError("bad_command", "select needs values");
            const values = await el().evaluate((el, wanted) => {
              if (!(el instanceof HTMLSelectElement)) return null;
              return wanted.map((w) => [...el.options].find((o) => o.value === w || o.label === w || o.text.trim() === w)?.value ?? w);
            }, args.values);
            if (!values) throw new BrowserError("bad_command", "select works on a <select> element");
            await el().select(...values);
            break;
          }
          case "scroll":
            if (handle && args.dx === undefined && args.dy === undefined) await handle.scrollIntoView();
            else {
              if (handle) await handle.hover();
              await tab.page.mouse.wheel({ deltaX: args.dx ?? 0, deltaY: args.dy ?? 0 });
            }
            break;
          case "drag": {
            const target = handleFor(tab, requireUid(args.toUid, "drag (toUid)"));
            const from = await el().clickablePoint();
            const to = await target.clickablePoint();
            await tab.page.mouse.move(from.x, from.y);
            await tab.page.mouse.down();
            await tab.page.mouse.move(to.x, to.y, { steps: 10 });
            await tab.page.mouse.up();
            break;
          }
        }
      }
    }
    const capped = await settle(tab, startedAt);
    return text(await report(tab, [`${action} done`, ...(capped ? [capped] : [])], args.snapshot !== false));
  });
};

/** `Control+Shift+K`: modifiers held down around the last key. */
async function pressChord(tab: BrowserTabState, chord: string): Promise<void> {
  const parts = chord.split("+").map((p) => p.trim()).filter(Boolean);
  const key = parts.pop();
  if (!key) throw new BrowserError("bad_command", `not a key: ${chord}`);
  const alias: Record<string, string> = { ctrl: "Control", cmd: "Meta", command: "Meta", option: "Alt", esc: "Escape", return: "Enter" };
  const name = (k: string) => (alias[k.toLowerCase()] ?? k) as KeyInput;
  const modifiers = parts.map(name);
  try {
    for (const m of modifiers) await tab.page.keyboard.down(m);
    await tab.page.keyboard.press(name(key));
  } catch (error) {
    throw new BrowserError("bad_command", `unknown key in ${chord}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    for (const m of modifiers.reverse()) await tab.page.keyboard.up(m).catch(() => {});
  }
}

const screenshot: Handler<"screenshot"> = async (caller, args) => {
  const tab = await resolveTab(caller, args.tabId);
  return runExclusive(caller.projectId, tab.id, async () => {
    refuseUnderDialog(tab);
    const handle = args.uid ? handleFor(tab, args.uid) : null;
    return withActivity(caller, tab, "screenshot", handle, async () => {
      if (handle) await handle.scrollIntoView().catch(() => {});
      /* The clip is in document coordinates (puppeteer intersects it with the
         visual viewport), and `scale` multiplies CSS pixels — so the image is
         at most 1280 px wide whatever the tab's DPR. */
      const view = await tab.page.evaluate(() => ({
        x: visualViewport?.pageLeft ?? scrollX,
        y: visualViewport?.pageTop ?? scrollY,
        width: visualViewport?.width ?? innerWidth,
        height: visualViewport?.height ?? innerHeight,
        dpr: devicePixelRatio,
      }));
      let area = { x: view.x, y: view.y, width: view.width, height: view.height };
      if (handle) {
        const box = await handle.boundingBox();
        if (!box || box.width < 1 || box.height < 1) throw new BrowserError("bad_command", `uid ${args.uid} is not visible`);
        area = { x: view.x + box.x, y: view.y + box.y, width: box.width, height: box.height };
      }
      const scale = Math.min(view.dpr, SCREENSHOT_MAX_WIDTH / area.width);
      const data = await tab.page.screenshot({ type: "jpeg", quality: 70, encoding: "base64", clip: { ...area, scale } });
      return { text: `screenshot of ${handle ? `uid ${args.uid}` : `tab ${tab.id}`} (${tab.page.url()})`, image: { data, mimeType: "image/jpeg" } };
    });
  });
};

const evaluate: Handler<"evaluate"> = async (caller, args) => {
  const tab = await resolveTab(caller, args.tabId);
  return runExclusive(caller.projectId, tab.id, () =>
    withActivity(caller, tab, "evaluate", null, async () => {
      const source = args.function;
      /* An expression or a function is evaluated and, if a function, called;
         anything else is a body. Done in the page so the shape is decided by
         the page's own parser, not by a regex here. */
      const run = tab.page.evaluate(async (code: string) => {
        let value: unknown;
        try {
          value = (0, eval)(`(${code})`);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          value = new Function(`return (async () => {\n${code}\n})()`)();
        }
        if (typeof value === "function") value = (value as () => unknown)();
        value = await value;
        if (value === undefined) return "undefined";
        try {
          return JSON.stringify(value, null, 2) ?? String(value);
        } catch {
          return String(value);
        }
      }, source);
      const outcome = await untilDialog(tab, run);
      if (outcome.dialog) return text(await report(tab, ["the script opened a dialog; its result is lost"], false));
      const result = outcome.value;
      const cut = result.length > SNAPSHOT_MAX_CHARS ? `${result.slice(0, SNAPSHOT_MAX_CHARS)}\n… cut at ${SNAPSHOT_MAX_CHARS} characters` : result;
      return text(cut);
    }),
  );
};

const waitFor: Handler<"wait_for"> = async (caller, args) => {
  if (!args.text && !args.uid) throw new BrowserError("bad_command", "wait_for needs text or a uid");
  const tab = await resolveTab(caller, args.tabId);
  const timeout = args.timeoutMs ?? 5_000;
  return runExclusive(caller.projectId, tab.id, () =>
    withActivity(caller, tab, "wait_for", args.uid ? handleFor(tab, args.uid) : null, async () => {
      refuseUnderDialog(tab);
      const startedAt = Date.now();
      try {
        if (args.uid) {
          const handle = handleFor(tab, args.uid);
          await tab.page.waitForFunction(
            (el: Element) => {
              const style = getComputedStyle(el);
              const box = el.getBoundingClientRect();
              return el.isConnected && style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
            },
            { timeout, polling: 100 },
            handle,
          );
        } else {
          await tab.page.waitForFunction((needle: string) => document.body?.innerText.includes(needle) ?? false, { timeout, polling: 100 }, args.text!);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/timeout/i.test(message)) throw error;
        return { text: `not seen after ${timeout}ms: ${args.uid ? `uid ${args.uid}` : JSON.stringify(args.text)}`, isError: true };
      }
      return text(`seen after ${Date.now() - startedAt}ms`);
    }),
  );
};

const logs: Handler<"logs"> = async (caller, args) => {
  const tab = await resolveTab(caller, args.tabId);
  const limit = args.limit ?? 50;
  if (args.request !== undefined) {
    const entry = tab.network.since(args.request - 1).find((item) => item.seq === args.request);
    if (!entry) return { text: `no request #${args.request} (it may have aged out)`, isError: true };
    return text(JSON.stringify(entry.value, null, 2));
  }
  if ((args.kind ?? "console") === "network") {
    let items = tab.network.since(args.since);
    if (args.errorsOnly) items = items.filter(({ value }) => value.failure !== null || (value.status !== null && value.status >= 400));
    const shown = items.slice(-limit);
    const lines = shown.map(({ seq, value }) => {
      const outcome = value.failure ?? (value.status === null ? "pending" : String(value.status));
      const time = value.durationMs === null ? "" : ` ${value.durationMs}ms`;
      return `#${seq} ${value.method} ${outcome}${time} ${value.resourceType} ${value.url}`;
    });
    return text(`${lines.join("\n") || "no requests"}\nnext: ${tab.network.cursor}`);
  }
  let items = tab.console.since(args.since);
  if (args.errorsOnly) items = items.filter(({ value }) => value.level === "error" || value.level === "exception");
  const lines = items.slice(-limit).map(({ seq, value }) => `#${seq} ${value.level}: ${value.text}${value.url ? ` (${value.url})` : ""}`);
  return text(`${lines.join("\n") || "no messages"}\nnext: ${tab.console.cursor}`);
};

const viewport: Handler<"viewport"> = async (caller, args) => {
  const tab = await resolveTab(caller, args.tabId);
  return withActivity(caller, tab, "viewport", null, async () => {
    if (args.reset) {
      await setAgentViewport(caller.projectId, tab.id, caller.sessionId, null);
      return text("viewport reset: it follows the panel again");
    }
    const size = args.mobile
      ? { width: args.width ?? 390, height: args.height ?? 844, dpr: 3 }
      : args.width && args.height
        ? { width: args.width, height: args.height }
        : null;
    if (!size) throw new BrowserError("bad_command", "viewport needs width and height, mobile, or reset");
    await setAgentViewport(caller.projectId, tab.id, caller.sessionId, size);
    return text(`viewport ${tab.viewport?.width ?? size.width}x${tab.viewport?.height ?? size.height}`);
  });
};

/** Parse one tool's arguments against the catalogue's own shape — the one the
    child advertised — so the route accepts exactly that and nothing else. */
function parse<K extends BrowserToolName>(tool: K, raw: unknown): BrowserToolArgs<K> {
  const parsed = z.object(BROWSER_TOOLS[tool].shape).safeParse(raw ?? {});
  if (parsed.success) return parsed.data as BrowserToolArgs<K>;
  const issue = parsed.error.issues[0];
  throw new BrowserError("bad_command", issue ? `${issue.path.join(".") || tool}: ${issue.message}` : `bad arguments for ${tool}`);
}

/** Run one tool for one thread. Throws `BrowserError` for a refusal. */
export function runBrowserTool(caller: BrowserCaller, tool: BrowserToolName, raw: unknown): Promise<BrowserToolResult> {
  switch (tool) {
    case "tabs":
      return tabs(caller, parse(tool, raw));
    case "navigate":
      return navigate(caller, parse(tool, raw));
    case "snapshot":
      return snapshot(caller, parse(tool, raw));
    case "act":
      return act(caller, parse(tool, raw));
    case "screenshot":
      return screenshot(caller, parse(tool, raw));
    case "evaluate":
      return evaluate(caller, parse(tool, raw));
    case "wait_for":
      return waitFor(caller, parse(tool, raw));
    case "logs":
      return logs(caller, parse(tool, raw));
    case "viewport":
      return viewport(caller, parse(tool, raw));
  }
}

/** The tab a thread's call landed on, for the `browser_activity` event. */
export function browserTabOf(caller: BrowserCaller): BrowserTabId | null {
  return currentTabId(caller);
}
