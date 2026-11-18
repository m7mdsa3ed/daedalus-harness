/* ── The browser panel's input mapping ──
   Pure functions between what the reader does to the canvas and the commands
   the `/browser` socket takes (`@daedalus/browser-protocol`). No DOM state, no
   React: a pointer is a pair of numbers and a key is the fields a
   `KeyboardEvent` carries, so all of it runs under Node in
   `browser-input.check.mjs`.

   **Every coordinate the server sees is in CSS pixels of the tab's viewport.**
   The canvas draws the frame letterboxed (contain-fit) inside itself, so a
   pointer is first placed inside that box, scaled to the device size the JPEG
   depicts (`deviceWidth`/`deviceHeight`, DIP), then shifted by the frame's
   `offsetTop` and divided by its `pageScaleFactor` -- the same conversion
   DevTools' own screencast view makes. `pageToElement` is the inverse, for
   drawing the agent's rect over the frame. */
import {
  browserModifiers,
  type BrowserFrameHeader,
  type BrowserKeyCommand,
  type BrowserMouseButton,
  type BrowserTabId,
  type BrowserWheelCommand,
} from "@daedalus/browser-protocol"

import { matchesChord } from "@/lib/shortcuts"

/** The part of the frame header the geometry needs. */
export type FrameGeometry = Pick<
  BrowserFrameHeader,
  "deviceWidth" | "deviceHeight" | "offsetTop" | "pageScaleFactor"
>

/** Where the frame is drawn inside the canvas element, in element CSS px. */
export interface FrameBox {
  x: number
  y: number
  width: number
  height: number
  /** Element px per device px. */
  scale: number
}

/** Contain-fit a `frameWidth` x `frameHeight` image in an element, centred. A
    panel whose size differs from the tab's viewport (an agent set it, or
    another panel did) gets bars rather than a stretched page. */
export function letterbox(
  elementWidth: number,
  elementHeight: number,
  frameWidth: number,
  frameHeight: number
): FrameBox {
  if (!(elementWidth > 0 && elementHeight > 0 && frameWidth > 0 && frameHeight > 0))
    return { x: 0, y: 0, width: 0, height: 0, scale: 0 }
  const scale = Math.min(elementWidth / frameWidth, elementHeight / frameHeight)
  const width = frameWidth * scale
  const height = frameHeight * scale
  return { x: (elementWidth - width) / 2, y: (elementHeight - height) / 2, width, height, scale }
}

const scaleOf = (frame: FrameGeometry) => (frame.pageScaleFactor > 0 ? frame.pageScaleFactor : 1)

/** A point in the element (offsetX/offsetY) as CSS px of the page's viewport,
    or null when it falls in the letterbox bars. */
export function elementToPage(
  x: number,
  y: number,
  elementWidth: number,
  elementHeight: number,
  frame: FrameGeometry
): { x: number; y: number } | null {
  const box = letterbox(elementWidth, elementHeight, frame.deviceWidth, frame.deviceHeight)
  if (box.scale <= 0) return null
  const dx = x - box.x
  const dy = y - box.y
  if (dx < 0 || dy < 0 || dx > box.width || dy > box.height) return null
  const psf = scaleOf(frame)
  return {
    x: round2(dx / box.scale / psf),
    y: round2((dy / box.scale - frame.offsetTop) / psf),
  }
}

/** The same point clamped into the frame: a drag that leaves the picture keeps
    reporting the nearest edge, so a release outside still lands. */
export function elementToPageClamped(
  x: number,
  y: number,
  elementWidth: number,
  elementHeight: number,
  frame: FrameGeometry
): { x: number; y: number } | null {
  const box = letterbox(elementWidth, elementHeight, frame.deviceWidth, frame.deviceHeight)
  if (box.scale <= 0) return null
  const cx = Math.min(Math.max(x, box.x), box.x + box.width)
  const cy = Math.min(Math.max(y, box.y), box.y + box.height)
  return elementToPage(cx, cy, elementWidth, elementHeight, frame)
}

/** A rect in page CSS px as a rect in element CSS px: the agent overlay. */
export function pageToElement(
  rect: { x: number; y: number; width: number; height: number },
  elementWidth: number,
  elementHeight: number,
  frame: FrameGeometry
): { x: number; y: number; width: number; height: number } | null {
  const box = letterbox(elementWidth, elementHeight, frame.deviceWidth, frame.deviceHeight)
  if (box.scale <= 0) return null
  const psf = scaleOf(frame)
  return {
    x: box.x + rect.x * psf * box.scale,
    y: box.y + (rect.y * psf + frame.offsetTop) * box.scale,
    width: rect.width * psf * box.scale,
    height: rect.height * psf * box.scale,
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100

/* ── Mouse ── */

/** DOM `MouseEvent.button` to CDP's name for it. */
export function mouseButton(domButton: number): BrowserMouseButton {
  switch (domButton) {
    case 0:
      return "left"
    case 1:
      return "middle"
    case 2:
      return "right"
    case 3:
      return "back"
    case 4:
      return "forward"
    default:
      return "none"
  }
}

/** The DOM `buttons` bit for a DOM `button`, for a synthesized press. */
export function buttonsBit(domButton: number): number {
  return [1, 4, 2, 8, 16][domButton] ?? 0
}

export interface ClickTracker {
  at: number
  x: number
  y: number
  button: number
  count: number
}

export const MULTI_CLICK_MS = 500
const MULTI_CLICK_SLOP = 4

/** The click count of a press: pointer events carry no `detail`, so a double
    click is counted here -- same button, close in time and in place. */
export function nextClick(
  last: ClickTracker | null,
  press: { at: number; x: number; y: number; button: number }
): ClickTracker {
  const again =
    !!last &&
    last.button === press.button &&
    press.at - last.at <= MULTI_CLICK_MS &&
    Math.abs(press.x - last.x) <= MULTI_CLICK_SLOP &&
    Math.abs(press.y - last.y) <= MULTI_CLICK_SLOP
  return { ...press, count: again && last ? Math.min(last.count + 1, 3) : 1 }
}

/** DOM `WheelEvent.deltaMode`: 0 pixels, 1 lines, 2 pages. */
const LINE_PX = 16

export function wheelCommand(
  tabId: BrowserTabId,
  point: { x: number; y: number },
  event: { deltaX: number; deltaY: number; deltaMode: number; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  pageHeight: number
): BrowserWheelCommand {
  const unit = event.deltaMode === 1 ? LINE_PX : event.deltaMode === 2 ? pageHeight : 1
  return {
    type: "wheel",
    tabId,
    x: point.x,
    y: point.y,
    deltaX: event.deltaX * unit,
    deltaY: event.deltaY * unit,
    modifiers: browserModifiers(event),
  }
}

/* ── Touch ── */

export const TOUCH = {
  /** Movement past this is a drag (scroll), never a tap. */
  slop: 8,
  /** Held this long without moving: a right click. */
  longPressMs: 500,
} as const

export type TouchGesture = "pending" | "drag" | "long-press"

/** What a finger that went down at `start` and is now at `now` is doing. A
    gesture that became a drag stays one. */
export function touchGesture(
  current: TouchGesture,
  start: { x: number; y: number; at: number },
  now: { x: number; y: number; at: number }
): TouchGesture {
  if (current !== "pending") return current
  if (Math.hypot(now.x - start.x, now.y - start.y) > TOUCH.slop) return "drag"
  if (now.at - start.at >= TOUCH.longPressMs) return "long-press"
  return "pending"
}

/* ── Keys ── */

/** The fields of a `KeyboardEvent` this module reads. */
export interface KeyLike {
  key: string
  code: string
  keyCode?: number
  location?: number
  repeat?: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  isComposing?: boolean
}

/** True while an IME owns the keystroke: its text arrives on `compositionend`
    as a `text` command, never as keys. */
export function isComposing(event: KeyLike): boolean {
  return !!event.isComposing || event.keyCode === 229 || event.key === "Process"
}

/** The text a key inserts, or undefined for one that inserts nothing. Enter
    carries "\r", which is what makes CDP fire `keypress` and submit a form. A
    Ctrl or Cmd chord types nothing -- except Ctrl+Alt, which is AltGr on
    Windows layouts and does. */
export function keyText(event: KeyLike): string | undefined {
  if (event.key === "Enter") return "\r"
  if ([...event.key].length !== 1) return undefined
  if (event.metaKey) return undefined
  if (event.ctrlKey && !event.altKey) return undefined
  return event.key
}

export function keyCommand(
  tabId: BrowserTabId,
  event: KeyLike,
  phase: "keyDown" | "keyUp"
): BrowserKeyCommand {
  const text = phase === "keyDown" ? keyText(event) : undefined
  return {
    type: "key",
    tabId,
    event: phase,
    key: event.key,
    code: event.code,
    modifiers: browserModifiers(event),
    ...(text !== undefined ? { text } : {}),
    ...(event.keyCode ? { keyCode: event.keyCode } : {}),
    ...(event.location ? { location: event.location } : {}),
    ...(event.repeat ? { repeat: true } : {}),
  }
}

/** Paste is read off the clipboard event, not sent as keys: the page's own
    Ctrl+V would read the *server's* clipboard. */
export function isPasteChord(event: KeyLike): boolean {
  return (
    ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "v") ||
    (event.shiftKey && event.key === "Insert")
  )
}

/** Whether a keypress is one of the harness's own chorded shortcuts and should
    be left to it: every key goes to the page *except* these. Only chords with
    a modifier qualify -- a bare `?` or arrow is the page's. */
export function isHarnessChord(event: KeyLike, chords: readonly string[]): boolean {
  if (!(event.metaKey || event.ctrlKey || event.altKey)) return false
  return chords.some(
    (chord) => /(^|\+)(mod|alt)\+/.test(chord) && matchesChord(event as unknown as KeyboardEvent, chord)
  )
}

/* ── The address bar ── */

/** Where typed text that is not an address goes. */
export const SEARCH_URL = "https://duckduckgo.com/?q="

const SCHEME = /^(https?|file|about|data|chrome|view-source|blob):/i
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$|\?|#)/i
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$|\?|#)/
const HOST = /^[^\s/?#:@]+\.[a-z][a-z0-9-]{1,62}\.?(:\d+)?(\/|$|\?|#)/i

/** What the address bar loads for what was typed: a URL as written, a host
    with `https://` assumed, or a search. A loopback or bare IP address is the
    exception that gets `http://`, because that is the dev server on the
    server's machine and it does not speak TLS. Null for nothing typed. */
export function addressToUrl(input: string, search = SEARCH_URL): string | null {
  const text = input.trim()
  if (!text) return null
  if (SCHEME.test(text)) return text
  if (/\s/.test(text)) return search + encodeURIComponent(text)
  if (LOOPBACK.test(text) || IPV4.test(text)) return `http://${text}`
  if (HOST.test(text)) return `https://${text}`
  return search + encodeURIComponent(text)
}
