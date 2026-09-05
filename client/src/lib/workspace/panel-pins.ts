/* ── Pinned panels ──
   A tab you have said you are keeping: it sits at the front of its group, it
   does not carry a close button, and every bulk close steps over it.

   Dockview 8 has a pinned-tabs module of its own, but it is not in the package
   this app installs (`api.setPinned` is inert without it), and pinning here has
   to mean slightly more than "renders first" anyway: the point of pinning a
   thread beside four scratch tabs is that "close others" does not take it. So
   the set is ours.

   Device-local and keyed by server, like every other reader's-property store
   (`lib/drafts.ts`, `lib/pins.ts`, `lib/view-options.ts`): what you keep open
   is yours, not the conversation's. Keyed by **panel id** rather than by
   descriptor because that is what the dock, the tab and the layout all already
   agree a panel is called. */
import * as React from "react"

import { loadSettings } from "@/lib/settings"

const PREFIX = "daedalus.dock.pins.v1"

const storeKey = (): string => `${PREFIX}:${loadSettings()?.id ?? "none"}`

let pins: ReadonlySet<string> | null = null
/* The key the cache was filled from. Connecting to a second server changes it,
   and a cache that did not notice would show one server's pins on another's
   tabs — the same mistake the v1 layout key made (see `layout.ts`). */
let cachedKey: string | null = null
const listeners = new Set<() => void>()

function read(): ReadonlySet<string> {
  const key = storeKey()
  if (pins && cachedKey === key) return pins
  cachedKey = key
  try {
    const raw = localStorage.getItem(key)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    pins = new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [])
  } catch {
    pins = new Set()
  }
  return pins
}

function write(next: ReadonlySet<string>): void {
  pins = next
  cachedKey = storeKey()
  try {
    localStorage.setItem(cachedKey, JSON.stringify([...next]))
  } catch (error) {
    // Quota, or private-mode storage. Pinning still works for this session.
    console.warn("Could not persist the pinned tabs", error)
  }
  for (const listener of [...listeners]) listener()
}

export function isPanelPinned(panelId: string): boolean {
  return read().has(panelId)
}

/** The new state, so a caller can act on it (the dock moves a freshly pinned
    tab to the front of its group). */
export function togglePanelPin(panelId: string): boolean {
  const next = new Set(read())
  const pinned = !next.has(panelId)
  if (pinned) next.add(panelId)
  else next.delete(panelId)
  write(next)
  return pinned
}

/** A panel that is gone cannot be pinned: a stale id would silently pin
    whatever panel next earns that name — a new terminal in the same project, a
    thread restored from Trash. Called from the dock's own close and prune. */
export function forgetPanelPin(panelId: string): void {
  const current = read()
  if (!current.has(panelId)) return
  const next = new Set(current)
  next.delete(panelId)
  write(next)
}

/** The whole set, for the dock's ordering pass. */
export function pinnedPanels(): ReadonlySet<string> {
  return read()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePanelPinned(panelId: string): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => read().has(panelId),
    () => false
  )
}
