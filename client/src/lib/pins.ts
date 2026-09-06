import { createLocalStore } from "./local-store"

/* ── Pinned threads ──
   A pin is this device's opinion about which threads matter, so it lives in
   localStorage next to drafts rather than on the server: the harness's session
   list is shared by every connected client, and one person pinning a thread
   should not reorder everyone else's sidebar.

   Order is preserved — newest pin last — so the pinned group stays stable
   instead of reshuffling whenever the underlying session list is refetched. */

const store = createLocalStore<string[]>(
  "ui.pinnedThreads",
  (raw) => (Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : []),
  []
)

export const pinnedSnapshot = store.get

export const subscribePins = store.subscribe


export function togglePin(sessionId: string): void {
  const pins = store.get()
  store.set(
    pins.includes(sessionId) ? pins.filter((id) => id !== sessionId) : [...pins, sessionId]
  )
}

/** Drop pins for sessions the server no longer lists — same contract as drafts. */
export function prunePins(sessionIds: Iterable<string>): void {
  const live = new Set(sessionIds)
  const kept = store.get().filter((id) => live.has(id))
  if (kept.length !== store.get().length) store.set(kept)
}

/** The pinned ids, live — the sidebar and the palette read the same list. */
export const usePins = store.use
