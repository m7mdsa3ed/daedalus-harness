/* ── The threads with a tab open ──
   The dock is the authority on which panels are open, but it renders in a
   subtree the sidebar is not inside (both are siblings under the app shell), so
   the sidebar cannot reach it through context. It reads this store instead,
   which the dock publishes into on every panel add, remove and move — the same
   module-store bargain `panel-status.ts` and `panel-pins.ts` make, and for the
   same reason: a surface outside the dock's tree has to hear what the dock
   knows.

   What is held is the *session ids of open chat panels, in the order they were
   opened*, and nothing else. Other kinds are panels, not threads, and are not
   listed. It is derived state, not storage: a reload rebuilds it from the
   restored layout through the same `onDidAddPanel` path, so there is no second
   copy of the dock to fall out of step with the first. */
import * as React from "react"

const EMPTY: readonly string[] = Object.freeze([])
let open: readonly string[] = EMPTY
const listeners = new Set<() => void>()

/** Replace the list. A no-op when it says the same thing — the dock calls this
    on every layout change, and a sash drag fires one per pointer frame. */
export function setOpenThreads(ids: readonly string[]): void {
  if (open.length === ids.length && open.every((id, index) => id === ids[index])) return
  open = Object.freeze([...ids])
  for (const listener of [...listeners]) listener()
}

export function openThreadIds(): readonly string[] {
  return open
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The open threads, in tab order, for the sidebar's "Opened" tier. */
export function useOpenThreads(): readonly string[] {
  return React.useSyncExternalStore(subscribe, openThreadIds, openThreadIds)
}
