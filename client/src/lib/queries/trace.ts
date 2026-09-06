/* The trace view's data — one thread's journaled events as raw pages, read
   backwards from the head of the log (the newest page first), oldest first
   within a page. Served by `GET /api/sessions/:id/trace`; the shapes are the
   server's (`TracePage` in server/src/protocol.ts).

   An infinite query, because a trace is paged: the first page is the newest
   events, `next` is the seq to page older from, null when the log's head is
   reached. The pages are near-static history, so they stay fresh for minutes
   and are invalidated (never merged by hand) when a refresh is asked for. */
import { useInfiniteQuery } from "@tanstack/react-query"

import { api, type ServerSettings } from "@/lib/settings"
import { useServer } from "@/lib/server-context"
import type { TracePage } from "@daedalus/protocol"
import { threadTraceKey } from "./keys"

const TRACE_STALE_MS = 5 * 60_000

export function fetchTracePage(
  settings: ServerSettings,
  sessionId: string,
  before: number | null,
  signal?: AbortSignal
): Promise<TracePage> {
  const query = before === null ? "" : `?before=${encodeURIComponent(String(before))}`
  return api<TracePage>(settings, `/api/sessions/${encodeURIComponent(sessionId)}/trace${query}`, {
    signal,
  })
}

/** Every page of the thread's trace, flattened oldest-last — the order the
    server serves them in, newest page first. The component reverses for
    display so the thread reads the same direction as the transcript. */
export function useThreadTrace(sessionId: string) {
  const settings = useServer()
  const query = useInfiniteQuery({
    queryKey: threadTraceKey(settings, sessionId),
    queryFn: ({ pageParam, signal }) => fetchTracePage(settings, sessionId, pageParam, signal),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.next,
    enabled: Boolean(sessionId),
    staleTime: TRACE_STALE_MS,
  })
  return {
    pages: query.data?.pages ?? [],
    loading: query.isPending,
    error: query.error,
    loadingOlder: query.isFetchingNextPage,
    hasOlder: query.hasNextPage ?? false,
    loadOlder: () => void query.fetchNextPage(),
    refresh: () => void query.refetch(),
    refreshing: query.isRefetching,
  }
}
