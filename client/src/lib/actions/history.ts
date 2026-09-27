/* Paging the transcript backwards: the button, the prefetch behind it, and the
   jump that has to fold history until a named turn is on screen.

   Split out of the one 1500-line `useActions` memo; see `lib/actions.ts`. */

import { reportError } from "../errors"
import type { ActionsCore } from "./core"

export function historyActions(core: ActionsCore) {
  const { dispatch, getState, known } = core

  return {
    /**
     * Fetch the page of history above the transcript and fold it in.
     *
     * The socket owns the mechanics (it is the only thing holding the events
     * the re-fold needs); this only guards against stacking two pages and
     * marks the button busy while one is in flight.
     */
    async loadEarlier(sessionId: string) {
      const thread = known(sessionId)?.live
      if (!thread || getState().threads[sessionId]?.loadingEarlier) return
      dispatch({ type: "thread-window", id: sessionId, loadingEarlier: true })
      try {
        await thread.loadEarlier()
      } catch (error) {
        dispatch({ type: "thread-window", id: sessionId, loadingEarlier: false })
        reportError(error, "Couldn't load earlier messages")
      }
    },

    /**
     * The reader is approaching the top of the transcript: get the next page
     * of history over the wire now, so the click that asks for it pays only
     * the re-fold. Silent, idempotent and safe to call on every scroll — the
     * socket drops the ones it does not need.
     */
    prefetchEarlier(sessionId: string) {
      known(sessionId)?.live?.prefetchEarlier()
    },

    /**
     * Page history back until the turn named by `turnId` is folded, so a
     * jump to a tick whose messages are still withheld lands on the turn
     * instead of falling off the top of the transcript. `seq` is that
     * turn's `turn_started` seq from the journal's turn list; the item id
     * returned is the user bubble's row id after the fold — or null when
     * the turn never made it on screen (the jump then stays where it is).
     * Shares `loadEarlier`'s busy guard, so the earlier-steps button says
     * so while this runs.
     */
    async loadUntilTurn(sessionId: string, turnId: string, seq: number): Promise<string | null> {
      const thread = known(sessionId)?.live
      if (!thread || getState().threads[sessionId]?.loadingEarlier) return null
      dispatch({ type: "thread-window", id: sessionId, loadingEarlier: true })
      try {
        await thread.loadUntil(seq)
      } catch (error) {
        dispatch({ type: "thread-window", id: sessionId, loadingEarlier: false })
        reportError(error, "Couldn't load earlier messages")
        return null
      }
      const item = getState().threads[sessionId]?.items.find(
        (entry) => entry.kind === "user" && entry.turnId === turnId
      )
      return item?.id ?? null
    },

    /** Search-result counterpart to the turn rail's unloaded-history jump. */
    async jumpToTurn(sessionId: string, turnId: string | null, seq: number | null): Promise<string | null> {
      if (!turnId || seq === null) return null
      const thread = known(sessionId)?.live
      if (!thread) return null
      const existing = getState().threads[sessionId]?.items.find(
        (entry) => entry.kind === "user" && entry.turnId === turnId
      )
      if (existing) return existing.id
      if (getState().threads[sessionId]?.loadingEarlier) return null
      dispatch({ type: "thread-window", id: sessionId, loadingEarlier: true })
      try {
        await thread.loadUntil(seq)
      } catch (error) {
        dispatch({ type: "thread-window", id: sessionId, loadingEarlier: false })
        reportError(error, "Couldn't load the matching message")
        return null
      }
      return getState().threads[sessionId]?.items.find(
        (entry) => entry.kind === "user" && entry.turnId === turnId
      )?.id ?? null
    },
  }
}
