import * as React from "react"

/* ── The Window Controls Overlay, as one store ──
   Chromium's Windows-only PWA feature (`window-controls-overlay` display mode):
   the OS title bar is hidden and the app's own top strip becomes draggable,
   with the caption buttons floating over its right end. Two halves consume it:

   - CSS does the layout: under the display mode the browser resolves
     `env(titlebar-area-*)` to the caption buttons' bounds and honours
     `-webkit-app-region: drag`/`no-drag`. The one thing CSS cannot see is
     whether the overlay is *engaged* (the API exists on any desktop-Chromium
     window; the overlay is off in a plain tab), which is what
     `html[data-window-controls-overlay]` — published here from
     `navigator.windowControlsOverlay.visible` — tells the rules in index.css,
     in the same language Electron's preload uses (`html[data-desktop]`).
   - `useWindowsControlsOverlay` exposes the same state to React, for anything
     that must lay out around the title bar in JS. */

export interface WindowControlsOverlayState {
  /** `navigator.windowControlsOverlay` exists — Chromium on desktop Windows. */
  supported: boolean
  /** The overlay is engaged in this window right now. */
  visible: boolean
  /** Bounds of the title bar area — the strip beside the caption buttons,
      which is also what `env(titlebar-area-*)` measures in CSS. */
  rect: DOMRectReadOnly | null
}

const NONE: WindowControlsOverlayState = { supported: false, visible: false, rect: null }

type WindowControlsOverlayLike = EventTarget & {
  visible: boolean
  getBoundingClientRect(): DOMRectReadOnly
}

function overlay(): WindowControlsOverlayLike | null {
  const candidate = (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlayLike })
    .windowControlsOverlay
  // `"visible" in` rather than a truthiness check: a stale polyfill could
  // expose an object that is not the real API, and then there is nothing to
  // read (mirrors the keyboard-inset guard). `getBoundingClientRect` is gated
  // the same way — some Chromium builds (older ones, Electron's) expose the
  // object with `visible` but no usable rect method, and a call on that must
  // not take the app down.
  return candidate && "visible" in candidate && typeof candidate.getBoundingClientRect === "function"
    ? candidate
    : null
}

function read(): WindowControlsOverlayState {
  const api = overlay()
  if (!api) return NONE
  /* Guarded even with the check above: the API can exist and still refuse the
     call (the window between engines on a desktop). The overlay itself (the
     attribute, the drag regions) is driven by `visible`, which needs nothing
     from the rect, so a failed read only degrades the JS consumers. */
  let rect: DOMRectReadOnly | null = null
  try {
    rect = api.getBoundingClientRect()
  } catch {
    rect = null
  }
  return { supported: true, visible: api.visible, rect }
}

let state: WindowControlsOverlayState = NONE
const listeners = new Set<() => void>()
let installed = false

function publish(next: WindowControlsOverlayState) {
  state = next
  /* The attribute mirrors `visible`, so the CSS only ever needs to check the
     one thing — the same contract the Electron preload's data-desktop attrs
     follow. Removed (never "false") when the overlay leaves, so a stale mode
     cannot linger after the window moves to a monitor without one. */
  const root = document.documentElement
  if (next.visible) root.dataset.windowControlsOverlay = "true"
  else delete root.dataset.windowControlsOverlay
  /* ── The caption buttons, as three numbers ──
     `env(titlebar-area-*)` says the same thing to CSS, and index.css keeps it
     as the fallback — but only the API answers in the two cases the band's
     right end was running under the buttons regardless:

     - the title bar area is the window less the overlay, so the overlay's
       width is only `100vw - width - x` while the *viewport* is the window.
       A visible scrollbar, a zoom level, a fractional device pixel ratio: any
       of them and that subtraction is short by a few pixels of exactly the
       thing being cleared.
     - the buttons are not always on the right. On a left-handed caption band
       `x` is their width and the arithmetic above collapses to zero, which is
       the correct clearance on the wrong side.

     So both ends are published, measured off the rect, and the rules pad by
     whichever is theirs. Removed with the overlay, so nothing keeps a stale
     reservation once the OS title bar is back. */
  const rect = next.visible ? next.rect : null
  const px = (value: number) => `${Math.max(0, Math.round(value))}px`
  if (rect) {
    root.style.setProperty("--wco-inset-left", px(rect.x))
    root.style.setProperty("--wco-inset-right", px(window.innerWidth - (rect.x + rect.width)))
    root.style.setProperty("--wco-titlebar-h", px(rect.height))
  } else {
    root.style.removeProperty("--wco-inset-left")
    root.style.removeProperty("--wco-inset-right")
    root.style.removeProperty("--wco-titlebar-h")
  }
  for (const listener of listeners) listener()
}

/** Installed once from main.tsx, before render, so the drag regions and the
    caption-button clearance are live from the first paint. Returns a cleanup. */
export function installWindowControlsOverlay(): () => void {
  if (installed) return () => {}
  installed = true
  const api = overlay()
  publish(read())
  if (!api) return () => {}

  /* Two paths, one answer, like the keyboard-inset module: `geometrychange`
     is the API's own event (it fires when the overlay shows, hides, resizes
     or the window moves to a monitor whose controls sit the other way), and
     the media query says the same thing in terms the page can also see. A
     browser that speaks only one of them still converges. */
  const mq = window.matchMedia("(display-mode: window-controls-overlay)")
  const update = () => publish(read())
  api.addEventListener("geometrychange", update)
  mq.addEventListener("change", update)
  /* The right-hand inset is the rect against `innerWidth`, so it is stale the
     moment the window is resized. `geometrychange` covers that in Chromium, but
     it is one event from one engine holding up a number the tab band lays out
     by — and a resize listener costs a rect read at the same rate. */
  window.addEventListener("resize", update)
  return () => {
    api.removeEventListener("geometrychange", update)
    mq.removeEventListener("change", update)
    window.removeEventListener("resize", update)
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Whether the Window Controls Overlay is supported and engaged, live. */
export function useWindowsControlsOverlay(): WindowControlsOverlayState {
  if (!installed) installWindowControlsOverlay()
  return React.useSyncExternalStore(subscribe, () => state, () => NONE)
}