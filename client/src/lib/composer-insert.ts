/* ── Handing text to a thread's composer ──
   The Preview's "Pick element" runs in a panel beside the transcript, not in
   it, so it cannot reach the box's imperative handle. This is the same
   request/consume bargain `composer-focus.ts` makes for the caret — one module,
   keyed by session, read by the composer that owns the box — but carrying a
   line to add.

   It is an *insert*, not a fill: the picked element is a phrase the person adds
   their instruction to, so it is appended under whatever is already typed
   rather than replacing it. */
import { useSyncExternalStore } from "react"

export interface ComposerInsert {
  revision: number
  text: string
}

const requests = new Map<string, ComposerInsert>()
const listeners = new Set<() => void>()
let revision = 0

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function notify() {
  for (const listener of listeners) listener()
}

export function requestComposerInsert(sessionId: string, text: string): void {
  requests.set(sessionId, { revision: ++revision, text })
  notify()
}

export function useComposerInsertRequest(sessionId: string): ComposerInsert | null {
  return useSyncExternalStore(
    subscribe,
    () => requests.get(sessionId) ?? null,
    () => null
  )
}

export function consumeComposerInsertRequest(sessionId: string, revision: number): void {
  if (requests.get(sessionId)?.revision === revision) {
    requests.delete(sessionId)
    notify()
  }
}
