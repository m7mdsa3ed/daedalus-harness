/* ── The window's own material ──
   macOS vibrancy and Windows 11 mica put a real material *behind the window*,
   and the shell is deliberately transparent over it: the `data-desktop-vibrancy`
   blocks in index.css drop the page ground so the sidebar, the gutters and the
   header band show the desktop through. That is the blur this switch is for,
   and it is a property of the *window*, not of any theme — which is why it is a
   device preference and nothing reaches the server.

   Turning it off is not a second ground painted over the first: the attribute
   is the whole of it. The blocks it turns on are exactly what took the page
   ground away, and that ground is opaque and `inset: 0`, so with them off the
   material behind the window is covered and the app is solid. Nothing native
   has to move — a window may keep its mica and simply not show it.

   Only a shell that *has* a material may touch any of this. Everywhere else
   there is nothing behind the window but the browser, and setting the attribute
   there would put a translucent `body::before` over a bare canvas — so the row
   is not offered (`WINDOW_MATERIAL`) and this module leaves the attribute
   alone. */
import { useSyncExternalStore } from "react"

const KEY = "ui.windowMaterial"

/** Whether this window has an OS material to turn off at all. Set by the
    Electron preload (`window.desktop.vibrancy`), false in every browser and in
    a shell on a platform with no material (Linux). The settings row reads it so
    it is only offered where it does something. */
export const WINDOW_MATERIAL =
  typeof window !== "undefined" && !!window.desktop?.vibrancy

/** On by default: a shell with a material has always shown it, and a preference
    nobody chose must not silently change what the window looks like. */
function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== "false"
  } catch {
    return true
  }
}

function apply(on: boolean): void {
  if (!WINDOW_MATERIAL) return
  const el = document.documentElement
  if (on) el.dataset.desktopVibrancy = "true"
  else delete el.dataset.desktopVibrancy
}

let value = read()
/* Applied at import, so the window never paints the default before the stored
   choice lands — the same rule the appearance sliders follow. main.tsx imports
   this for the side effect, and the preload reads the same key even earlier so
   the frame before the bundle parses does not flash the material on. */
if (typeof window !== "undefined") apply(value)

const listeners = new Set<() => void>()

export function setWindowMaterial(on: boolean): void {
  if (on === value) return
  value = on
  try {
    localStorage.setItem(KEY, on ? "true" : "false")
  } catch {
    // A forgotten preference is not worth throwing out of a click handler.
  }
  apply(on)
  for (const listener of listeners) listener()
}

export function useWindowMaterial(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => value,
    () => value
  )
  return [on, setWindowMaterial]
}
