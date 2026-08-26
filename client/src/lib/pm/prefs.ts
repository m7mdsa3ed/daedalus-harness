import { useSyncExternalStore } from "react"
import type { ViewName } from "./types"

/* ── Board view preferences ──
   Which view a board opens in, which of its columns are folded, and when the
   notifications inbox was last read. All three are this device's opinion — the
   board itself is shared by every client of the harness, and one person
   collapsing a column should not fold it for everyone — so they live in
   localStorage next to pins and drafts rather than on the server.

   Same shape as lib/pins.ts: one module-level cache, a listener set, and a
   `storage` listener so a second tab's change lands here too. */

const VIEW_KEY = "ui.pm.view"
const COLLAPSED_KEY = "ui.pm.collapsedColumns"
const INBOX_KEY = "ui.pm.inboxReadAt"

/** Per-board keys are suffixed with the board id — `ui.pm.view.<boardId>`. */
const viewKey = (boardId: string) => `${VIEW_KEY}.${boardId}`
const collapsedKey = (boardId: string) => `${COLLAPSED_KEY}.${boardId}`

interface Prefs {
  /** boardId -> the view it was last left on. */
  view: Record<string, ViewName>
  /** boardId -> folded column ids. */
  collapsed: Record<string, string[]>
  /** Epoch ms the inbox was last marked read; 0 = never. */
  inboxReadAt: number
}

function readAll(): Prefs {
  const prefs: Prefs = { view: {}, collapsed: {}, inboxReadAt: 0 }
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key) continue
      if (key.startsWith(`${VIEW_KEY}.`)) {
        const value = localStorage.getItem(key)
        if (value) prefs.view[key.slice(VIEW_KEY.length + 1)] = value as ViewName
      } else if (key.startsWith(`${COLLAPSED_KEY}.`)) {
        const raw = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown
        prefs.collapsed[key.slice(COLLAPSED_KEY.length + 1)] = Array.isArray(raw)
          ? raw.filter((id): id is string => typeof id === "string")
          : []
      }
    }
    prefs.inboxReadAt = Number(localStorage.getItem(INBOX_KEY) ?? 0) || 0
  } catch {
    // Corrupt or unavailable storage reads as "no preferences".
  }
  return prefs
}

let cache = readAll()
const listeners = new Set<() => void>()

function notify() {
  for (const listener of listeners) listener()
}

function put(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Losing a fold is survivable; throwing out of a click handler is not.
  }
  cache = readAll()
  notify()
}

export const prefsSnapshot = (): Prefs => cache

export function subscribePmPrefs(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// ---------------------------------------------------------------------------
// View per board

export const boardView = (boardId: string): ViewName | undefined => cache.view[boardId]

export function setBoardView(boardId: string, view: ViewName): void {
  put(viewKey(boardId), view)
}

// ---------------------------------------------------------------------------
// Collapsed columns per board

export const collapsedColumns = (boardId: string): string[] => cache.collapsed[boardId] ?? []

export function toggleColumnCollapsed(boardId: string, columnId: string): void {
  const current = collapsedColumns(boardId)
  const next = current.includes(columnId)
    ? current.filter((id) => id !== columnId)
    : [...current, columnId]
  put(collapsedKey(boardId), JSON.stringify(next))
}

export function setColumnCollapsed(boardId: string, columnId: string, collapsed: boolean): void {
  const current = collapsedColumns(boardId)
  if (current.includes(columnId) === collapsed) return
  toggleColumnCollapsed(boardId, columnId)
}

// ---------------------------------------------------------------------------
// Inbox read mark

export const inboxReadAt = (): number => cache.inboxReadAt

export function markInboxRead(at: number = Date.now()): void {
  put(INBOX_KEY, String(at))
}

/** Drop preferences for boards the server no longer lists — same contract as
    `prunePins`: the device's opinions outlive a refresh, not a deletion. */
export function prunePmPrefs(boardIds: Iterable<string>): void {
  const live = new Set(boardIds)
  const dead: string[] = []
  for (const id of Object.keys(cache.view)) if (!live.has(id)) dead.push(viewKey(id))
  for (const id of Object.keys(cache.collapsed)) if (!live.has(id)) dead.push(collapsedKey(id))
  if (dead.length === 0) return
  try {
    for (const key of dead) localStorage.removeItem(key)
  } catch {
    // See put().
  }
  cache = readAll()
  notify()
}

/* Another tab's change is this device's change too. */
window.addEventListener("storage", (event) => {
  if (
    event.key !== null &&
    !event.key.startsWith(VIEW_KEY) &&
    !event.key.startsWith(COLLAPSED_KEY) &&
    event.key !== INBOX_KEY
  )
    return
  cache = readAll()
  notify()
})

/** The whole preference set, live. Components read the slice they need. */
export function usePmPrefs(): Prefs {
  return useSyncExternalStore(subscribePmPrefs, prefsSnapshot, prefsSnapshot)
}
