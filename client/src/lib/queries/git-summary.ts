/* ── Branch and uncommitted lines, per thread ──
   One poll for the whole sidebar (`GET /api/sessions/git-summary`); each row
   reads its own entry through `select`, which structural sharing keeps the same
   object until that entry changes — so a refresh re-renders only the rows that
   moved. `enabled` is the row's: a trashed thread has no checkout to ask about. */
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/settings"
import { useServer } from "@/lib/server-context"
import { gitSummaryKey } from "./keys"

export interface GitSummary {
  branch: string | null
  files: number
  additions: number
  deletions: number
}

export function useGitSummary(sessionId: string, enabled: boolean): GitSummary | undefined {
  const settings = useServer()
  return useQuery({
    queryKey: gitSummaryKey(settings),
    queryFn: ({ signal }) => api<Record<string, GitSummary>>(settings, "/api/sessions/git-summary", { signal }),
    select: (all) => all[sessionId],
    enabled,
    staleTime: 10_000,
    refetchInterval: 20_000,
  }).data
}
