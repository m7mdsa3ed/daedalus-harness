import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";
import { captureOffsetMs, findChrome } from "../../config.js";
import { childEnv, redact, run } from "../../exec.js";
import type { CaptureMark, CaptureProvider, CaptureResult, Rect } from "../../types.js";
import { describe, normalizeAction, toPlaywrightSelector, type Loc, type NormalizedAction } from "./actions.js";

/**
 * Video t=0 is the screencast's first frame, whose timestamp (epoch ms) onFrame hands us, so a
 * mark is `Date.now() - firstFrame + offset` with no guess about when the page was created.
 * (recordVideo is not used: its clock starts at the first *paint*, which on a blank page is
 * anywhere from 0 to 500 ms after newPage.) Measured with test/calibrate.mjs, which paints a cue
 * at a known time and finds it in the frames: video lags the mark by -30 ms, but the cue is read
 * after two animation frames (~+30 ms), so the honest default is 0. Frames are 40 ms apart, so
 * finer than that is noise. VIDEO_CAPTURE_OFFSET_MS shifts every mark if a machine drifts.
 */
const DEFAULT_OFFSET_MS = 0;

const FIND_TIMEOUT_MS = 3000;
const TYPE_DELAY_MS = 45;
const SCROLL_MS = 700;

// Injected into every document before its own scripts. The arrow is a DOM overlay, so it is
// in the recorded pixels (Playwright's video has no OS cursor). Position survives navigation
// through sessionStorage. Style is set through the CSSOM only, so a strict CSP cannot block it.
const CURSOR_JS = `(() => {
  if (window.top !== window || window.__vm) return;
  const KEY = "__vm_pos", NS = "http://www.w3.org/2000/svg", Z = "2147483647";
  let pos = { x: 60, y: 60 }, cur;
  try { const s = JSON.parse(sessionStorage.getItem(KEY)); if (s && isFinite(s.x) && isFinite(s.y)) pos = s; } catch {}
  const place = () => { if (cur) cur.style.transform = "translate(" + pos.x + "px," + pos.y + "px)"; };
  const mount = () => {
    if (cur && cur.isConnected) return;
    if (!document.documentElement) return;
    cur = document.createElementNS(NS, "svg");
    cur.setAttribute("width", "18"); cur.setAttribute("height", "26"); cur.setAttribute("viewBox", "0 0 13 20");
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", "M0 0 L0 17 L4.5 13 L7.3 19.5 L9.8 18.4 L7 12 L12.5 12 Z");
    p.setAttribute("fill", "#fff"); p.setAttribute("stroke", "#111"); p.setAttribute("stroke-width", "1.2"); p.setAttribute("stroke-linejoin", "round");
    cur.appendChild(p);
    Object.assign(cur.style, { position: "fixed", left: "0", top: "0", pointerEvents: "none", zIndex: Z, overflow: "visible", filter: "drop-shadow(0 2px 3px rgba(0,0,0,.35))" });
    document.documentElement.appendChild(cur);
    place();
  };
  mount();
  document.addEventListener("DOMContentLoaded", mount);
  window.addEventListener("load", mount);
  window.__vm = {
    move(x, y) {
      mount();
      const from = { x: pos.x, y: pos.y }, dx = x - from.x, dy = y - from.y, dist = Math.hypot(dx, dy);
      if (dist < 4) return Promise.resolve();
      const ms = Math.min(900, 400 + dist * 0.6);
      // quadratic bezier whose control point bows off the straight line, like a hand
      const bow = Math.min(120, dist * 0.2) * (dx >= 0 ? 1 : -1);
      const c = { x: from.x + dx / 2 + (-dy / dist) * bow, y: from.y + dy / 2 + (dx / dist) * bow };
      const t0 = performance.now();
      return new Promise((resolve) => {
        const tick = (now) => {
          const t = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - t, 4), u = 1 - e;
          pos = { x: u * u * from.x + 2 * u * e * c.x + e * e * x, y: u * u * from.y + 2 * u * e * c.y + e * e * y };
          place();
          if (t < 1) requestAnimationFrame(tick);
          else { try { sessionStorage.setItem(KEY, JSON.stringify(pos)); } catch {} resolve(); }
        };
        requestAnimationFrame(tick);
      });
    },
    ripple(x, y) {
      if (!document.documentElement) return;
      const r = document.createElement("div");
      Object.assign(r.style, { position: "fixed", left: x - 18 + "px", top: y - 18 + "px", width: "36px", height: "36px", boxSizing: "border-box", borderRadius: "50%", border: "3px solid rgba(59,130,246,.9)", pointerEvents: "none", zIndex: Z });
      document.documentElement.appendChild(r);
      r.animate([{ transform: "scale(.3)", opacity: 0.9 }, { transform: "scale(1.5)", opacity: 0 }], { duration: 450, easing: "ease-out" }).onfinish = () => r.remove();
    },
  };
})();`;

class NotFound extends Error {}

function linkLocal(addr: string): boolean {
  const ip = addr.toLowerCase();
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 169 && b === 254;
  }
  const mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):[0-9a-f]{1,4})$/.exec(ip); // v4-mapped, dotted or as the URL parser writes it
  if (mapped) return linkLocal(mapped[1] ?? `${parseInt(mapped[2], 16) >> 8}.${parseInt(mapped[2], 16) & 255}.0.0`);
  return (parseInt(ip.split(":")[0] || "0", 16) & 0xffc0) === 0xfe80; // fe80::/10
}

/**
 * Why a page may not be opened, or undefined. Only http(s) (file: with VIDEO_ALLOW_FILE_URLS=1); link-local and cloud-metadata
 * targets never, localhost and private ranges yes (a local dev server is the main use). A page's pixels go to the agent.
 * ponytail: checks the goto target only. DNS rebinding and a redirect from an allowed host onto a refused one are not covered
 * (Playwright does not re-route a redirect the network stack follows); a request interceptor that fetches with maxRedirects 0 would close it.
 */
export async function urlRefusal(href: string): Promise<string | undefined> {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return `"${href}" is not a URL`;
  }
  if (u.protocol === "file:") return process.env.VIDEO_ALLOW_FILE_URLS === "1" ? undefined : "file: URLs are refused (set VIDEO_ALLOW_FILE_URLS=1 to allow them)";
  if (u.protocol !== "http:" && u.protocol !== "https:") return `${u.protocol} URLs are refused (only http and https)`;
  const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host === "metadata.google.internal") return `${host} is a cloud metadata address and is always refused`;
  const addrs = isIP(host) ? [host] : await lookup(host, { all: true }).then((r) => r.map((x) => x.address), () => []); // unresolvable: let the browser say so
  if (addrs.some(linkLocal)) return `${host} is a link-local/metadata address and is always refused`;
  return undefined;
}

const firstLine = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0];

/** First candidate that matches a visible element, polled until the deadline. */
async function find(page: Page, loc: Loc, timeoutMs = FIND_TIMEOUT_MS): Promise<Locator> {
  if (!loc.length) throw new NotFound("no selector given");
  const end = Date.now() + timeoutMs;
  do {
    for (const sel of loc) {
      try {
        const l = page.locator(sel).filter({ visible: true });
        if ((await l.count()) > 0) return l.first();
      } catch {} // an unparseable candidate is just a candidate that does not match
    }
    await delay(100);
  } while (Date.now() < end);
  throw new NotFound(`nothing visible matched ${loc.map((s) => JSON.stringify(s)).join(" or ")} within ${timeoutMs}ms`);
}

interface Pt {
  x: number;
  y: number;
  box: Rect;
}

/** Scroll the element into view and glide the on-screen cursor (and the real mouse) onto it. */
async function pointAt(page: Page, el: Locator, offsetX?: number, offsetY?: number): Promise<Pt> {
  await el.scrollIntoViewIfNeeded({ timeout: 2000 });
  await delay(120); // let a smooth scroll settle before measuring
  const b = await el.boundingBox();
  if (!b) throw new NotFound("element has no box");
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 1), Math.max(max - 1, 1));
  const x = b.x + (offsetX === undefined ? b.width / 2 : clamp(offsetX, b.width));
  const y = b.y + (offsetY === undefined ? b.height / 2 : clamp(offsetY, b.height));
  await page.evaluate(`window.__vm?.move(${x}, ${y})`);
  await page.mouse.move(x, y);
  return { x, y, box: { x: b.x, y: b.y, w: b.width, h: b.height } };
}

interface Ctx {
  page: Page;
  baseUrl?: string;
  /** Box of the last element acted on: what a zoom frames. */
  last?: Rect;
  /** The capture clock, and the keystroke times of the current step. */
  now: () => number;
  keys: number[];
}

async function perform(c: Ctx, a: NormalizedAction): Promise<void> {
  const { page } = c;
  switch (a.kind) {
    case "goto": {
      let url = a.url;
      try {
        url = new URL(a.url, c.baseUrl).href;
      } catch {
        throw new Error(`cannot resolve "${a.url}"${c.baseUrl ? "" : " (no baseUrl in the storyboard)"}`);
      }
      const why = await urlRefusal(url);
      if (why) throw new Error(`refused: ${why}`);
      await page.goto(url, { waitUntil: "load", timeout: 20000 });
      return;
    }
    case "click": {
      const p = await pointAt(page, await find(page, a.loc), a.offsetX, a.offsetY);
      c.last = p.box;
      await page.evaluate(`window.__vm?.ripple(${p.x}, ${p.y})`);
      if (a.double) await page.mouse.dblclick(p.x, p.y);
      else await page.mouse.click(p.x, p.y);
      return;
    }
    case "hover":
      c.last = (await pointAt(page, await find(page, a.loc))).box;
      return;
    case "fill":
    case "type": {
      const el = await find(page, a.loc);
      if (a.kind === "fill" && (await el.evaluate((n) => n.tagName)) === "SELECT") {
        c.last = (await pointAt(page, el)).box;
        await el.selectOption(a.value); // a native dropdown is not in the recorded pixels, so skip opening it
        return;
      }
      const p = await pointAt(page, el);
      c.last = p.box;
      await page.evaluate(`window.__vm?.ripple(${p.x}, ${p.y})`);
      await page.mouse.click(p.x, p.y);
      if (a.kind === "fill") await page.keyboard.press("ControlOrMeta+a");
      if (a.value === "") await page.keyboard.press("Backspace");
      else
        for (const ch of a.value) {
          c.keys.push(c.now());
          await page.keyboard.type(ch);
          await delay(TYPE_DELAY_MS);
        }
      return;
    }
    case "press":
      if (a.loc) await (await find(page, a.loc)).focus();
      await page.keyboard.press(a.key);
      return;
    case "keyDown":
      await page.keyboard.down(a.key);
      return;
    case "keyUp":
      await page.keyboard.up(a.key);
      return;
    case "wait":
      await delay(a.ms);
      return;
    case "waitFor":
      await find(page, a.loc, 10000);
      return;
    case "waitExpr":
      await page.waitForFunction(a.expression, undefined, { timeout: 10000 });
      return;
    case "scroll":
      if (a.loc) await (await find(page, a.loc)).evaluate((n) => n.scrollIntoView({ behavior: "smooth", block: "center" }));
      else await page.evaluate(`scrollTo({ left: ${a.x ?? "scrollX"}, top: ${a.y ?? "scrollY"}, behavior: "smooth" })`);
      await delay(SCROLL_MS);
      return;
    case "noop":
      return;
    case "unknown":
      throw new Error(`not understood, skipped`);
  }
}

async function probe(path: string): Promise<{ width: number; height: number; fps: number; durationMs: number }> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,avg_frame_rate:format=duration", "-of", "json", path]);
  const j = JSON.parse(stdout) as { streams: { width: number; height: number; avg_frame_rate: string }[]; format: { duration?: string } };
  const s = j.streams[0];
  const [n, d] = s.avg_frame_rate.split("/").map(Number);
  const fps = d ? Math.round(n / d) : 25;
  return { width: s.width, height: s.height, fps: fps > 0 ? fps : 25, durationMs: Math.round(Number(j.format.duration) * 1000) };
}

export const playwrightCapture: CaptureProvider = {
  id: "playwright",
  capabilities: { headless: true, cursor: true },
  async capture({ storyboard, steps, dir, signal }): Promise<CaptureResult> {
    const executablePath = findChrome();
    if (!executablePath) throw new Error("no Chrome/Chromium found: install one or set VIDEO_CHROME_PATH");
    const viewport = storyboard.viewport;
    const warnings: string[] = [];
    // ponytail: the screencast webm is VP8 at the viewport's CSS size whatever deviceScaleFactor is; raise storyboard.viewport for more pixels.

    const browser = await chromium.launch({ executablePath, headless: true, env: childEnv() });
    const onAbort = () => void browser.close().catch(() => {});
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1, ignoreHTTPSErrors: process.env.VIDEO_IGNORE_HTTPS_ERRORS === "1" });
      await context.addInitScript(CURSOR_JS);
      const page = await context.newPage();
      const videoPath = join(dir, "capture.webm");
      let firstTs: number | undefined;
      let gotFirst!: () => void;
      const firstFrame = new Promise<void>((r) => (gotFirst = r));
      try {
        await page.screencast.start({ path: videoPath, size: viewport, onFrame: (f) => void (firstTs === undefined && ((firstTs = f.timestamp), gotFirst())) });
      } catch (e) {
        if (/ffmpeg/i.test(String(e))) throw new Error("Playwright's video recorder needs its own ffmpeg build: run `npx playwright-core install ffmpeg`");
        throw e;
      }
      await Promise.race([firstFrame, delay(2000)]);
      if (firstTs === undefined) warnings.push("the recorder sent no first frame in 2s: marks are timed from the start call and may be early");
      const t0 = firstTs ?? Date.now();
      const offset = captureOffsetMs(DEFAULT_OFFSET_MS);
      const now = () => Math.round(Date.now() - t0 + offset);

      const ctx: Ctx = { page, baseUrl: storyboard.baseUrl, now, keys: [] };
      const marks: CaptureMark[] = [];
      let startMs = 0;
      for (const step of steps) {
        signal?.throwIfAborted();
        const began = performance.now();
        const w: string[] = [];
        ctx.last = undefined;
        ctx.keys = [];
        for (const raw of step.actions) {
          const a = normalizeAction(raw);
          try {
            await perform(ctx, a);
          } catch (e) {
            signal?.throwIfAborted();
            w.push(redact(`${describe(a)}: ${e instanceof NotFound ? e.message : firstLine(e)}`));
          }
        }
        let targetRect: Rect | undefined;
        if (step.zoom) {
          const sel = step.zoom === true ? undefined : step.zoom.selector;
          if (sel) {
            try {
              const b = await (await find(page, [toPlaywrightSelector(sel)], 1500)).boundingBox();
              if (b) targetRect = { x: b.x, y: b.y, w: b.width, h: b.height };
            } catch {
              w.push(`zoom selector ${JSON.stringify(sel)} not found`);
            }
          } else targetRect = ctx.last;
        }
        // let the viewer read the screen: the step lasts at least what narration + hold asked for
        const rest = step.minDurationMs - (performance.now() - began);
        if (rest > 0) await delay(rest, undefined, { signal });
        // contiguous marks: a step starts where the last one ended, so clips tile the video
        const endMs = Math.max(now(), startMs);
        marks.push({ stepId: step.id, startMs, endMs, targetRect, keys: ctx.keys.length ? ctx.keys : undefined, warnings: w });
        startMs = endMs;
      }

      await page.screencast.stop(); // flushes the webm
      await context.close();
      const info = await probe(videoPath);
      if (marks.length) marks[marks.length - 1].endMs = Math.min(marks[marks.length - 1].endMs, info.durationMs);
      return { videoPath, ...info, marks, warnings };
    } catch (e) {
      signal?.throwIfAborted();
      throw e;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await browser.close().catch(() => {});
    }
  },
};
