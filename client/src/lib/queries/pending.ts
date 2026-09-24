/* ── What the agents are blocked on, across threads ──
   `GET /api/pending` is read straight off every live bridge's `pending` map on
   the server — never journaled, so there is no event to replay it from and no
   global socket to push it. Freshness is three things: a modest poll while a
   reader is mounted (the phone's nav badge, the inbox page), a refetch on
   focus (the client default), and an invalidation whenever this device's own
   sockets see a question open or close — the count of cards across every
   thread in the store moving is exactly that moment. */
import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"

import type { PendingItem } from "@daedalus/protocol"
import { api } from "@/lib/settings"
import { useServer } from "@/lib/server-context"
import { useStoreSelect } from "@/lib/store"
import { useApiMutation, useApiQuery } from "./helpers"
import { pendingKey } from "./keys"

export type { PendingItem }

const POLL_MS = 15_000

export function usePending() {
  const settings = useServer()
  const qc = useQueryClient()
  const query = useApiQuery<PendingItem[]>(pendingKey(settings), "/api/pending", {
    staleTime: 0,
    refetchInterval: POLL_MS,
  })
  /* A number, so the selector is stable between frames and a streamed token
     never re-renders the reader. */
  const openCards = useStoreSelect((state) => {
    let n = 0
    for (const id in state.threads) {
      const t = state.threads[id]
      n += t.permissions.length + t.elicitations.length
    }
    return n
  })
  const first = React.useRef(true)
  React.useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    void qc.invalidateQueries({ queryKey: pendingKey(settings) })
  }, [openCards, qc, settings])
  return query
}

/** Answer one permission with the option picked. A 409 is a slower answerer
    losing the race — the item is gone either way, so both outcomes invalidate. */
export function useAnswerPending() {
  const settings = useServer()
  const qc = useQueryClient()
  return useApiMutation<{ sessionId: string; requestId: string; optionId: string }, { ok: true }>(
    [pendingKey(settings)],
    (s, { sessionId, requestId, optionId }) =>
      api(s, `/api/sessions/${encodeURIComponent(sessionId)}/pending/${encodeURIComponent(requestId)}`, {
        method: "POST",
        body: JSON.stringify({ optionId }),
      }),
    undefined,
    { onError: () => void qc.invalidateQueries({ queryKey: pendingKey(settings) }) }
  )
}
