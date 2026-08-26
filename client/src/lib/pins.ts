import { useSyncExternalStore } from "react"

/* ── Pinned threads ──
   A pin is this device's opinion about which threads matter, so it lives in
   localStorage next to drafts rather than on the server: the harness's session
   list is shared by every connected client, and one person pinning a thread
   should not reorder everyone else's sidebar.

   Order is preserved — newest pin last — so the pinned group stays stable
   instead of reshuffling whenever the underlying session list is refetched. */

const STORAGE_KEY = "ui.pinnedThreads"

function read(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : []
  } catch {
    return []
  }
}

let cache = read()
const listeners = new Set<() => void>()

function write(ids: string[]) {
  cache = ids
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch {
    // Losing a pin is survivable; throwing out of a click handler is not.
  }
  for (const listener of listeners) listener()
}

export const pinnedSnapshot = (): string[] => cache

export function subscribePins(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const isPinned = (sessionId: string): boolean => cache.includes(sessionId)

export function togglePin(sessionId: string): void {
  write(
    cache.includes(sessionId)
      ? cache.filter((id) => id !== sessionId)
      : [...cache, sessionId]
  )
}

/** Drop pins for sessions the server no longer lists — same contract as drafts. */
export function prunePins(sessionIds: Iterable<string>): void {
  const live = new Set(sessionIds)
  const kept = cache.filter((id) => live.has(id))
  if (kept.length !== cache.length) write(kept)
}

/* Another tab pinning a thread pinned it for this device too. */
window.addEventListener("storage", (event) => {
  if (event.key !== null && event.key !== STORAGE_KEY) return
  cache = read()
  for (const listener of listeners) listener()
})

/** The pinned ids, live — the sidebar and the palette read the same list. */
export function usePins(): string[] {
  return useSyncExternalStore(subscribePins, pinnedSnapshot, pinnedSnapshot)
}
