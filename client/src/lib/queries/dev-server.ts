/* A project's dev server, as a query the stream keeps current.

   The GET answers the first paint and the NDJSON stream (`subscribeDevStatus`)
   writes every later state straight into the cache with `setQueryData` — so
   the cache stays the one owner of the reading and every panel on the same
   project shares one subscription, ref-counted in `lib/workspace/dev-server`.
   `staleTime: Infinity` because a refetch on focus would only re-read what
   the stream has already delivered, and `meta.persist: false` because the
   status carries a per-boot preview key and a process state — neither
   survives the page, and `queries/persist.ts` honours the flag. */
import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"

import type { DevAction, DevStatus } from "@/lib/settings"
import { useServer } from "@/lib/server-context"
import { devAction, getDevStatus, subscribeDevStatus } from "@/lib/workspace/dev-server"
import { devStatusKey } from "./keys"
import { useApiMutation } from "./helpers"

export function useDevStatus(projectId: string | null | undefined) {
  const settings = useServer()
  const qc = useQueryClient()
  const key = devStatusKey(settings, projectId ?? "")
  const query = useQuery<DevStatus, Error>({
    queryKey: key,
    queryFn: ({ signal }) => getDevStatus(settings, projectId as string, signal),
    enabled: !!projectId,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    meta: { persist: false },
  })

  React.useEffect(() => {
    if (!projectId) return
    const key = devStatusKey(settings, projectId)
    return subscribeDevStatus(settings, projectId, (status) => qc.setQueryData(key, status))
  }, [settings, projectId, qc])

  return query
}

/** Start / stop / restart. The server answers the new status, which is
    written to the cache at once — the stream will say the same thing a
    moment later, and nothing depends on which arrives first. */
export function useDevAction() {
  const settings = useServer()
  const qc = useQueryClient()
  return useApiMutation<{ projectId: string; action: DevAction }, DevStatus>(
    () => [],
    (conn, { projectId, action }) => devAction(conn, projectId, action),
    (status, { projectId }) => qc.setQueryData(devStatusKey(settings, projectId), status)
  )
}
