import type { Action } from "../../storyboard.js";

/**
 * One internal shape for both accepted dialects (Chrome Recorder steps and Playwright-style
 * actions). A locator is an ordered list of Playwright selector strings: the first that
 * matches wins, which is how Recorder's alternative selectors are meant to be used.
 */
export type Loc = string[];

export type NormalizedAction =
  | { kind: "goto"; url: string }
  | { kind: "click"; loc: Loc; double?: boolean; offsetX?: number; offsetY?: number }
  | { kind: "hover"; loc: Loc }
  | { kind: "fill"; loc: Loc; value: string }
  | { kind: "type"; loc: Loc; value: string }
  | { kind: "press"; key: string; loc?: Loc }
  | { kind: "keyDown" | "keyUp"; key: string }
  | { kind: "wait"; ms: number }
  | { kind: "waitFor"; loc: Loc }
  | { kind: "waitExpr"; expression: string }
  // y/x are absolute scroll offsets (Recorder's meaning), with loc: scroll that element into view.
  | { kind: "scroll"; loc?: Loc; x?: number; y?: number }
  // Accepted and deliberately not executed (setViewport: the recording size is the storyboard's).
  | { kind: "noop" }
  // Not understood: the capture records a warning and carries on.
  | { kind: "unknown"; what: string };

/**
 * A Recorder selector ("aria/Name[role=\"button\"]", "xpath//a", "text/Hi", "pierce/#x", "#x")
 * or an already-Playwright one ("role=button[name=\"x\"]", "text=Hi", "css=...") as a
 * Playwright selector string. ponytail: aria/ is name+role only; Playwright has no accessible-name
 * engine for a bare name, so that case falls back to visible text.
 */
export function toPlaywrightSelector(s: string): string {
  const q = (t: string) => JSON.stringify(t);
  if (s.startsWith("aria/")) {
    const m = /^aria\/(.*?)(?:\[role="([^"]+)"\])?$/s.exec(s)!;
    const name = m[1].trim();
    return m[2] ? `role=${m[2]}[name=${q(name)}i]` : `text=${q(name)}`;
  }
  if (s.startsWith("xpath/")) return `xpath=${s.slice(6)}`;
  if (s.startsWith("text/")) return `text=${q(s.slice(5))}`;
  if (s.startsWith("pierce/")) return `css=${s.slice(7)}`; // Playwright css already pierces open shadow roots
  if (/^(css|xpath|text|role|id|data-testid|internal:[a-z-]+)=/.test(s) || s.startsWith("//") || s.startsWith("..")) return s;
  return `css=${s}`;
}

const recorderLoc = (selectors: string[][] | undefined): Loc =>
  // An inner list is a path through shadow roots / frames, chained with >>. ponytail: frames are not entered, so only the shadow-root case works.
  (selectors ?? []).map((chain) => chain.map(toPlaywrightSelector).join(" >> "));

const one = (selector: string | undefined): Loc | undefined => (selector ? [toPlaywrightSelector(selector)] : undefined);

export function normalizeAction(raw: Action): NormalizedAction {
  const a = raw as Record<string, any>;
  if (typeof a.type === "string") {
    switch (a.type) {
      case "navigate": return { kind: "goto", url: a.url };
      case "click": return { kind: "click", loc: recorderLoc(a.selectors), offsetX: a.offsetX, offsetY: a.offsetY };
      case "doubleClick": return { kind: "click", double: true, loc: recorderLoc(a.selectors), offsetX: a.offsetX, offsetY: a.offsetY };
      case "hover": return { kind: "hover", loc: recorderLoc(a.selectors) };
      case "change": return { kind: "fill", loc: recorderLoc(a.selectors), value: a.value };
      case "keyDown": return { kind: "keyDown", key: a.key };
      case "keyUp": return { kind: "keyUp", key: a.key };
      case "waitForElement": return { kind: "waitFor", loc: recorderLoc(a.selectors) };
      case "scroll": return { kind: "scroll", loc: a.selectors ? recorderLoc(a.selectors) : undefined, x: a.x, y: a.y };
      case "setViewport": return { kind: "noop" };
      case "waitForExpression": return { kind: "waitExpr", expression: a.expression };
      default: return { kind: "unknown", what: `type "${a.type}"` };
    }
  }
  switch (a.action) {
    case "goto": return { kind: "goto", url: a.url };
    case "click": return { kind: "click", loc: one(a.selector) ?? [] };
    case "fill": return { kind: "fill", loc: one(a.selector) ?? [], value: a.value };
    case "type": return { kind: "type", loc: one(a.selector) ?? [], value: a.value };
    case "press": return { kind: "press", key: a.key, loc: one(a.selector) };
    case "hover": return { kind: "hover", loc: one(a.selector) ?? [] };
    case "wait": return { kind: "wait", ms: a.ms };
    case "scroll": return { kind: "scroll", loc: one(a.selector), y: a.y };
    default: return { kind: "unknown", what: `action "${String(a.action)}"` };
  }
}

/** Short human text for warnings. */
export function describe(a: NormalizedAction): string {
  switch (a.kind) {
    case "goto": return `goto ${a.url}`;
    case "click": case "hover": case "waitFor": return `${a.kind} ${a.loc[0] ?? "(no selector)"}`;
    case "fill": case "type": return `${a.kind} ${a.loc[0] ?? "(no selector)"}`;
    case "press": case "keyDown": case "keyUp": return `${a.kind} ${a.key}`;
    case "unknown": return a.what;
    default: return a.kind;
  }
}
