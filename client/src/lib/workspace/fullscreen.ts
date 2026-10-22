import type { DockviewApi, IDockviewPanel } from "dockview-react"

import { reportError } from "@/lib/errors"
import { createStore } from "@/lib/local-store"
import { getSidebarOpen, setSidebarOpen } from "@/lib/sidebar-layout"

/* ── Full screen ──
   The panel in front takes the whole window: its group fills the dock (the same
   maximize "Fill the dock" does), the sidebar is put away, and the page asks the
   browser for its own Fullscreen API (the desktop shell's window included).
   Three things move, so three things are put back — and the one `leave` below is
   the only door out, whichever of them the reader used to leave: the chord, the
   menu row, the browser's Esc, or dockview's own restore.

   The mode itself is not persisted — a reload is a way out. The sidebar's open
   state *is* (`ui.sidebarLayout`), so the page handing it back on `pagehide` is
   what keeps a reload from leaving it collapsed. */
const store = createStore(false)

export const useThreadFullscreen = () => store.use()
export const isThreadFullscreen = () => store.get()

interface Held {
  api: DockviewApi
  sidebarWasOpen: boolean
  /** We maximized the group, so we are the ones who restore it. A group the
      reader had already filled stays filled on the way out. */
  maximized: boolean
  /** The browser accepted the request, so only then is its Esc ours to hear. */
  browser: boolean
  dispose: () => void
}

let held: Held | null = null

function leave(): void {
  const h = held
  if (!h) return
  held = null
  h.dispose()
  store.set(false)
  setSidebarOpen(h.sidebarWasOpen)
  if (h.maximized && h.api.hasMaximizedGroup()) h.api.exitMaximizedGroup()
  if (h.browser && document.fullscreenElement) {
    document.exitFullscreen().catch((err) => reportError(err, "Couldn't leave full screen"))
  }
}

function enter(api: DockviewApi, panel: IDockviewPanel): void {
  /* A lone group has nothing to fill over; maximizing it is a state with no
     picture, and `canFill` in the thread dock says the same. */
  const maximized = !api.hasMaximizedGroup() && api.groups.length > 1
  panel.api.setActive()
  if (maximized) api.maximizeGroup(panel)
  const h: Held = { api, sidebarWasOpen: getSidebarOpen(), maximized, browser: false, dispose: () => {} }
  held = h
  setSidebarOpen(false)
  store.set(true)

  const onBrowser = () => {
    if (held === h && h.browser && !document.fullscreenElement) leave()
  }
  document.addEventListener("fullscreenchange", onBrowser)
  const onHide = () => setSidebarOpen(h.sidebarWasOpen)
  window.addEventListener("pagehide", onHide)
  const maxSub = api.onDidMaximizedGroupChange(() => {
    if (held === h && h.maximized && !api.hasMaximizedGroup()) leave()
  })
  h.dispose = () => {
    document.removeEventListener("fullscreenchange", onBrowser)
    window.removeEventListener("pagehide", onHide)
    maxSub.dispose()
  }

  /* Absent on an iPhone's Safari, so asked about first: there the mode is the
     in-app half alone, which is still the whole point. A refusal where it is
     offered is said, not swallowed. */
  if (document.fullscreenEnabled) {
    document.documentElement
      .requestFullscreen()
      .then(() => {
        if (held === h) h.browser = true
        else if (document.fullscreenElement) void document.exitFullscreen()
      })
      .catch((err) => reportError(err, "Couldn't go full screen"))
  }
}

export function toggleFullscreen(api: DockviewApi, panel: IDockviewPanel | undefined): void {
  if (held) leave()
  else if (panel) enter(api, panel)
}
