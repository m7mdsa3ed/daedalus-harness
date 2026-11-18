/*
 * The `browser` MCP server's tools, as data: one catalogue read by the stdio
 * child (`browser-mcp.ts`, which registers them) and by the `/bm` route
 * (`routes/browser.ts`, which validates a call against the same shape), so what
 * the model is told and what the server accepts cannot disagree.
 *
 * Flat schemas only — no unions, no `oneOf`: some providers reject them. The
 * whole list is held under ~2k tokens (asserted in test/browser-mcp.test.ts),
 * so descriptions stay short and `tabId` is described once per tool.
 *
 * Kept free of puppeteer and of the server's config: the child imports it.
 */
import { z } from "zod";

export const BROWSER_SERVER_NAME = "browser";

const tabId = z.string().optional().describe("Tab id; default is this thread's tab.");
const snapshot = z.boolean().optional().describe("Return a fresh snapshot (default true).");

type Annotations = { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
interface BrowserToolDef {
  title: string;
  description: string;
  shape: z.ZodRawShape;
  annotations: Annotations;
}

const read: Annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const drive: Annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

export const BROWSER_TOOLS = {
  tabs: {
    title: "Browser tabs",
    description: "List the project browser's tabs (* = yours), open one (`new`, optional url), `select` one as yours, or `close` one.",
    shape: {
      action: z.enum(["list", "new", "select", "close"]).optional().describe("Default list."),
      url: z.string().optional().describe("For new."),
      tabId,
    },
    annotations: drive,
  },
  navigate: {
    title: "Navigate",
    description: "Go to `url` (https:// assumed), or `back`/`forward`/`reload`. Waits for the page to settle; returns url, title, status and a snapshot.",
    shape: {
      url: z.string().optional(),
      action: z.enum(["back", "forward", "reload"]).optional(),
      snapshot,
      tabId,
    },
    annotations: drive,
  },
  snapshot: {
    title: "Page snapshot",
    description: "The page's accessibility tree, one line per node: `[uid] role \"name\"`. Uids are valid until the next snapshot or navigation.",
    shape: { tabId },
    annotations: read,
  },
  act: {
    title: "Act on the page",
    description:
      "Real input on an element `uid` from the latest snapshot: click, dblclick, hover, fill (replace with `text`), type (`text`), press (`key`, e.g. Enter or Control+A), select (`values`), scroll (uid into view, or by dx/dy), drag (to `toUid`), dialog (`accept`, prompt `text`). Waits for settle; returns a snapshot.",
    shape: {
      action: z.enum(["click", "dblclick", "hover", "fill", "type", "press", "select", "scroll", "drag", "dialog"]),
      uid: z.string().optional(),
      text: z.string().optional(),
      key: z.string().optional(),
      values: z.array(z.string()).optional().describe("Option values or labels."),
      toUid: z.string().optional(),
      accept: z.boolean().optional().describe("Default true."),
      dx: z.number().optional(),
      dy: z.number().optional(),
      snapshot,
      tabId,
    },
    annotations: drive,
  },
  screenshot: {
    title: "Screenshot",
    description: "JPEG of the visible tab, or of one element `uid`, at most 1280px wide.",
    shape: { uid: z.string().optional(), tabId },
    annotations: read,
  },
  evaluate: {
    title: "Run JavaScript",
    description: "Run JavaScript in the page: an expression, a function, or statements that `return` a value. Answers the JSON result.",
    shape: { function: z.string().min(1), tabId },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  wait_for: {
    title: "Wait for",
    description: "Wait until `text` appears on the page or element `uid` is visible.",
    shape: {
      text: z.string().optional(),
      uid: z.string().optional(),
      timeoutMs: z.number().int().min(100).max(30_000).optional().describe("Default 5000."),
      tabId,
    },
    annotations: read,
  },
  logs: {
    title: "Console and network",
    description: "Console messages or network requests since cursor `since` (pass back `next`), or one request's detail by its #number.",
    shape: {
      kind: z.enum(["console", "network"]).optional().describe("Default console."),
      errorsOnly: z.boolean().optional().describe("Console errors; failed or 4xx/5xx requests."),
      since: z.number().int().min(0).optional(),
      request: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(500).optional().describe("Default 50, newest."),
      tabId,
    },
    annotations: read,
  },
  viewport: {
    title: "Viewport",
    description: "Set the tab's viewport (CSS px), `mobile` for a 390x844 @3x phone size, or `reset` to follow the panel.",
    shape: {
      width: z.number().int().min(200).max(4096).optional(),
      height: z.number().int().min(150).max(4096).optional(),
      mobile: z.boolean().optional(),
      reset: z.boolean().optional(),
      tabId,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
} as const satisfies Record<string, BrowserToolDef>;

export type BrowserToolName = keyof typeof BROWSER_TOOLS;
export type BrowserToolArgs<K extends BrowserToolName> = z.output<z.ZodObject<(typeof BROWSER_TOOLS)[K]["shape"]>>;

export function isBrowserTool(name: string): name is BrowserToolName {
  return Object.hasOwn(BROWSER_TOOLS, name);
}

/** What the `/bm` route answers for a call; the child turns it into MCP content. */
export interface BrowserToolResult {
  text: string;
  image?: { data: string; mimeType: string };
  /** A legitimate answer that is still a failed step (a wait that timed out). */
  isError?: boolean;
}

export const BROWSER_INSTRUCTIONS =
  "Drive this project's browser, the one a person sees in the Browser panel. Call snapshot (navigate and act return one) and act on elements by their [uid]; uids go stale after a navigation or a new snapshot, so take a fresh one when told. Every tool works on this thread's tab unless you pass tabId; use tabs to list, open or switch. Prefer act and snapshot over evaluate and screenshot.";
