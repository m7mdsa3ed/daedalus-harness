/* ── One reading of a thread, for every list that draws one ──
   The sidebar, the dock tabs, the project page and the landing page all say the
   same word about the same thread, and they say it by calling the same
   function. That is not tidiness: the reading is composed from two independent
   things (whether we are attached, and whether a turn is running), and the last
   time two surfaces composed it separately a thread whose socket had died
   thirty seconds ago read "Idle" in every list on screen.

   `markFor` in ./phase.ts is the vocabulary. These two are how a list gets at
   it — the pure one for a single row, the hook for a whole list. */
import * as React from "react"

import type { SessionMeta } from "@/lib/settings"
import { useStoreSelect, type ThreadState } from "@/lib/store"
import { IDLE_PHASE, markFor, type ThreadActivity } from "@/lib/thread/phase"

/**
 * What one thread is doing, as far as this device can tell.
 *
 * The live thread is the truth about a running turn. `SessionMeta.promptActive`
 * is a server snapshot refetched only on bootstrap and on mutations, so on its
 * own it never lights up mid-turn — it is the fallback, and the only signal
 * there is for a thread this client has never connected to.
 *
 * "Waiting on you" (an open permission or elicitation) is likewise only known
 * for a thread with a live connection, so it is best-effort by construction and
 * correct whenever a tab has the thread open.
 */
export function threadStatus(
  session: SessionMeta,
  thread: ThreadState | undefined
): ThreadActivity {
  const waiting = !!thread && (thread.permissions.length > 0 || thread.elicitations.length > 0)
  return markFor(
    thread?.phase ?? IDLE_PHASE,
    thread?.turnActive ?? session.promptActive,
    waiting,
    !!session.lastTurnError
  )
}

/**
 * Every thread's reading at once, as a map that keeps its identity for as long
 * as the readings do.
 *
 * The derivation lives *inside* the selector on purpose: the store's own
 * `Object.is` on the returned map is then what decides whether the caller
 * re-renders at all. `state.threads` is replaced on every streamed token of
 * every thread, so a caller that selected it directly would re-render on each
 * one and merely skip the memos below it.
 *
 * The cached ref is safe because the selector is idempotent — the same state
 * yields the same map — and it is replaced only when a status word actually
 * differs.
 */
export function useThreadStatuses(): Map<string, ThreadActivity> {
  const prev = React.useRef<Map<string, ThreadActivity>>(new Map())
  return useStoreSelect((state) => {
    const next = new Map<string, ThreadActivity>()
    for (const session of state.sessions) {
      next.set(session.id, threadStatus(session, state.threads[session.id]))
    }
    let same = next.size === prev.current.size
    if (same) {
      for (const [id, value] of next) {
        if (prev.current.get(id) !== value) {
          same = false
          break
        }
      }
    }
    if (!same) prev.current = next
    return prev.current
  })
}
