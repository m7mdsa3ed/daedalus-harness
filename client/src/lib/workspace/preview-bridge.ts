/* ── The preview bridge, from the parent's side ──
   `server/src/preview-bridge.js` is injected into every HTML page the
   preview proxy serves and talks to this window with `postMessage`. The
   iframe is sandboxed without `allow-same-origin`, so its origin is opaque:
   the messages carry no origin worth checking and the panel verifies
   `event.source === iframe.contentWindow` instead. This file is the
   vocabulary (mirroring the bridge's), the guard that reads a message off
   the wire, and the one prompt shape an error is handed to the agent in. */

import type { PanelDescriptor } from "@/lib/workspace/panels"

/** The preview panel's descriptor, named once: the Browser panel on the
    project's own dev server. Every opener — the build page, the project
    page, the header, ⌘K, the chord — says it this way, so a layout holds one
    preview per project. */
export function previewPanel(projectId: string): PanelDescriptor {
  return { kind: "web", trust: "project", projectId, viewId: "preview" }
}

export type PreviewErrorKind =
  | "runtime"
  | "rejection"
  | "console"
  | "vite"
  | "disconnect"
  | "network"

export type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug"

export type PreviewMessage =
  | { type: "daedalus:ready"; path: string; title: string }
  | { type: "daedalus:console"; level: ConsoleLevel; text: string; at: number }
  | {
      type: "daedalus:error"
      kind: PreviewErrorKind
      message: string
      stack?: string
      file?: string
      line?: number
      column?: number
      frame?: string
    }
  | {
      type: "daedalus:pick"
      tag: string
      id?: string
      classes: string[]
      text: string
      selector: string
      component?: string
      /** React ancestry, nearest first — "Button", "TodoItem", "App". */
      components: string[]
      /** The element's outerHTML, whitespace-folded, cut at 400 characters. */
      html: string
      rect: { x: number; y: number; width: number; height: number }
    }

export type ParentMessage =
  | { type: "daedalus:inspect"; on: boolean }
  | { type: "daedalus:navigate"; path: string }
  | { type: "daedalus:history"; delta: number }
  | { type: "daedalus:reload" }

/** Reads a message off `MessageEvent.data`; anything not shaped like one of
    ours is null. A preview runs code the user is writing, so a field is
    checked before it is trusted, never cast. */
export function parsePreviewMessage(data: unknown): PreviewMessage | null {
  if (!data || typeof data !== "object") return null
  const m = data as Record<string, unknown>
  switch (m.type) {
    case "daedalus:ready":
      return typeof m.path === "string"
        ? { type: "daedalus:ready", path: m.path, title: typeof m.title === "string" ? m.title : "" }
        : null
    case "daedalus:console": {
      if (typeof m.text !== "string") return null
      const level = LEVELS.has(m.level as ConsoleLevel) ? (m.level as ConsoleLevel) : "log"
      return { type: "daedalus:console", level, text: m.text, at: typeof m.at === "number" ? m.at : Date.now() }
    }
    case "daedalus:error": {
      if (typeof m.message !== "string") return null
      const kind = KINDS.has(m.kind as PreviewErrorKind) ? (m.kind as PreviewErrorKind) : "runtime"
      return {
        type: "daedalus:error",
        kind,
        message: m.message,
        ...(typeof m.stack === "string" ? { stack: m.stack } : {}),
        ...(typeof m.file === "string" ? { file: m.file } : {}),
        ...(typeof m.line === "number" ? { line: m.line } : {}),
        ...(typeof m.column === "number" ? { column: m.column } : {}),
        ...(typeof m.frame === "string" ? { frame: m.frame } : {}),
      }
    }
    case "daedalus:pick": {
      if (typeof m.selector !== "string" || typeof m.tag !== "string") return null
      const rect = (m.rect ?? {}) as Record<string, unknown>
      const num = (v: unknown) => (typeof v === "number" ? v : 0)
      return {
        type: "daedalus:pick",
        tag: m.tag,
        ...(typeof m.id === "string" ? { id: m.id } : {}),
        classes: Array.isArray(m.classes) ? m.classes.filter((c): c is string => typeof c === "string") : [],
        text: typeof m.text === "string" ? m.text : "",
        selector: m.selector,
        ...(typeof m.component === "string" && m.component ? { component: m.component } : {}),
        components: Array.isArray(m.components)
          ? m.components.filter((c): c is string => typeof c === "string").slice(0, 6)
          : [],
        html: typeof m.html === "string" ? m.html.slice(0, 400) : "",
        rect: { x: num(rect.x), y: num(rect.y), width: num(rect.width), height: num(rect.height) },
      }
    }
    default:
      return null
  }
}

const KINDS = new Set<PreviewErrorKind>(["runtime", "rejection", "console", "vite", "disconnect", "network"])
const LEVELS = new Set<ConsoleLevel>(["log", "info", "warn", "error", "debug"])

/** One console line as the panel's drawer lists it. */
export interface ConsoleLine {
  id: string
  level: ConsoleLevel
  text: string
  at: number
  /** How many identical lines in a row this one stands for. */
  count: number
}

/** One error as the panel lists it, whichever side reported it: the bridge
    inside the frame or the server reading the dev process's output. */
export interface PreviewError {
  id: string
  /** The headline — the first line of what was reported. */
  message: string
  /** Stack, frame or the grouped lines under a terminal error; may be empty. */
  detail: string
  source: "preview" | "terminal" | "build" | "check"
  at: number
}

/** What an error *is* for the auto-fix ledger: the same failure reported
    twice (a reload, a second render) must count as one round, not two. */
export function errorSignature(e: Pick<PreviewError, "message" | "source">): string {
  return `${e.source}:${e.message.replace(/\d+/g, "#").slice(0, 200)}`
}

export function previewErrorFromMessage(
  m: Extract<PreviewMessage, { type: "daedalus:error" }>,
  at = Date.now()
): PreviewError {
  const where = m.file ? `${m.file}${m.line ? `:${m.line}${m.column ? `:${m.column}` : ""}` : ""}` : ""
  const detail = [where, m.frame, m.stack].filter((s): s is string => !!s && s.trim().length > 0).join("\n")
  return {
    id: `preview:${at}:${Math.random().toString(36).slice(2, 8)}`,
    message: m.kind === "disconnect" ? "Lost the connection to the dev server" : m.message,
    detail,
    source: "preview",
    at,
  }
}

/** A terminal error's `text` is the matching line plus the indented lines
    the server grouped under it — headline first, the rest is detail. */
export function previewErrorFromTerminal(e: {
  id: string
  at: number
  text: string
  source?: "terminal" | "build" | "check"
}): PreviewError {
  const [first = "", ...rest] = e.text.split("\n")
  const source = e.source ?? "terminal"
  return { id: `${source}:${e.id}`, message: first.trim(), detail: rest.join("\n").trimEnd(), source, at: e.at }
}

const DETAIL_LINES = 30

/** The prompt an error is handed to the agent as. One block per error: the
    message, then the stack or frame cut at thirty lines — enough to name the
    file and the frame, not enough to be the whole console. */
export function fixPrompt(errors: PreviewError[]): string {
  const blocks = errors.map((e) => {
    const detail = e.detail.split("\n").slice(0, DETAIL_LINES).join("\n").trimEnd()
    return "```\n" + e.message + (detail ? "\n" + detail : "") + "\n```"
  })
  const head = errors.length === 1 ? "Fix this preview error:" : "Fix these preview errors:"
  return `${head}\n${blocks.join("\n")}`
}

/** The line a picked element becomes in the composer: the selector, the
    component chain when React is there to name it, the text, and the markup
    on a second line — enough to find the file and the JSX, not the whole DOM. */
export function pickLine(pick: Extract<PreviewMessage, { type: "daedalus:pick" }>): string {
  const text = pick.text.replace(/\s+/g, " ").trim()
  const clipped = text.length > 80 ? `${text.slice(0, 79)}…` : text
  const chain = pick.components.length > 0 ? ` in ${pick.components.join(" < ")}` : pick.component ? ` (${pick.component})` : ""
  const head = `Selected element: ${pick.selector}${chain}${clipped ? ` — "${clipped}"` : ""}`
  return pick.html ? `${head}\n  ${pick.html}` : head
}

/** A console line handed to the agent, when the user asks for it. */
export function consolePrompt(line: ConsoleLine): string {
  return `The preview's console printed this (${line.level}):\n\`\`\`\n${line.text}\n\`\`\``
}
