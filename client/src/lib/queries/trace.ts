/* The Trajectory's data — one thread's OpenTelemetry spans, as
   `GET /api/sessions/:id/spans` serves them (`SpansPage` in
   server/src/protocol.ts), and one span whole from `…/spans/:spanId` for the
   attributes the list elided.

   The list is re-read on a short interval while the thread's turn runs (open
   spans close, new ones start) and invalidated once when it ends, so the last
   spans a turn wrote land without a refresh. Idle, it is history. */
import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"

import { api } from "@/lib/settings"
import { useServer } from "@/lib/server-context"
import type { SpansPage, TraceSpan } from "@daedalus/protocol"
import { spanDetailKey, threadSpansKey } from "./keys"

const LIVE_POLL_MS = 1500
const IDLE_STALE_MS = 60_000

const spansPath = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/spans`

export function useThreadSpans(sessionId: string, { live }: { live: boolean }) {
  const settings = useServer()
  const qc = useQueryClient()
  const key = threadSpansKey(settings, sessionId)

  /* A turn ending is the one moment the list is certainly stale. */
  const wasLive = React.useRef(live)
  React.useEffect(() => {
    if (wasLive.current && !live) void qc.invalidateQueries({ queryKey: threadSpansKey(settings, sessionId) })
    wasLive.current = live
  }, [live, qc, settings, sessionId])

  return useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api<SpansPage>(settings, spansPath(sessionId), { signal }),
    enabled: Boolean(sessionId),
    staleTime: live ? 0 : IDLE_STALE_MS,
    refetchInterval: live ? LIVE_POLL_MS : false,
  })
}

/** One span whole — asked only for a span whose list copy elided something.
    An open span is re-read with the list while the turn runs. */
export function useSpanDetail(sessionId: string, span: TraceSpan | null, live: boolean) {
  const settings = useServer()
  const spanId = span?.spanId ?? ""
  const open = span?.end === null
  return useQuery({
    queryKey: spanDetailKey(settings, sessionId, spanId),
    queryFn: ({ signal }) =>
      api<TraceSpan>(settings, `${spansPath(sessionId)}/${encodeURIComponent(spanId)}`, { signal }),
    enabled: Boolean(sessionId && span?.elided?.length),
    staleTime: open ? 0 : Infinity,
    refetchInterval: live && open ? LIVE_POLL_MS : false,
  })
}

/** Every span of the thread, the elided ones fetched whole — what Export
    downloads. */
export function useFetchWholeSpans(sessionId: string) {
  const settings = useServer()
  const qc = useQueryClient()
  return React.useCallback(
    async (spans: TraceSpan[]): Promise<TraceSpan[]> =>
      Promise.all(
        spans.map((span) =>
          span.elided?.length
            ? qc.fetchQuery({
                queryKey: spanDetailKey(settings, sessionId, span.spanId),
                queryFn: () =>
                  api<TraceSpan>(settings, `${spansPath(sessionId)}/${encodeURIComponent(span.spanId)}`),
                staleTime: span.end === null ? 0 : Infinity,
              })
            : span
        )
      ),
    [qc, settings, sessionId]
  )
}
