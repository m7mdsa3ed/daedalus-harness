/* A project's commits, as the preview's History drawer reads them, and the
   two writes over them — checkpoint and restore. Both answer the refreshed
   list, which is written straight into the cache; the dev-status stream and
   the editor's watcher carry on as they were, because a restore is an
   ordinary write to the tree as far as they are concerned. */
import { useQueryClient } from "@tanstack/react-query"

import { api, type GitCommit, type HistoryAction, type HistoryResult } from "@/lib/settings"
import { useServer } from "@/lib/server-context"
import { projectHistoryKey } from "./keys"
import { useApiMutation, useApiQuery } from "./helpers"

const EMPTY: GitCommit[] = []

export function useProjectHistory(projectId: string | null | undefined, enabled = true) {
  const settings = useServer()
  const query = useApiQuery<GitCommit[]>(
    projectHistoryKey(settings, projectId ?? ""),
    `/api/projects/${encodeURIComponent(projectId ?? "")}/history?limit=60`,
    {
      enabled: !!projectId && enabled,
      staleTime: 15_000,
      meta: { persist: false },
    }
  )
  return { commits: query.data ?? EMPTY, ...query }
}

export function useHistoryAction(projectId: string) {
  const settings = useServer()
  const qc = useQueryClient()
  return useApiMutation<HistoryAction, HistoryResult>(
    () => [],
    (conn, input) =>
      api<HistoryResult>(conn, `/api/projects/${encodeURIComponent(projectId)}/history`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    (result) => qc.setQueryData(projectHistoryKey(settings, projectId), result.commits)
  )
}
