/* ── Model calls ──
   The two route reads of the `model_calls` ledger: a thread's own records
   (the Trace panel's cold read — the socket files the live ones, and the
   route answers the turns the window withheld and a retired thread), and
   spend across the install grouped one way (Settings › Usage › Spend). */
import { useQuery } from "@tanstack/react-query"

import type { ModelCall } from "@daedalus/protocol"
import { api } from "@/lib/settings"
import { useServer } from "@/lib/server-context"
import type { ThreadCall } from "@/lib/trace"
import { sessionCallsKey, spendKey } from "./keys"

export function useThreadCalls(sessionId: string, enabled = true) {
  const settings = useServer()
  return useQuery({
    queryKey: sessionCallsKey(settings, sessionId),
    queryFn: ({ signal }) => api<{ calls: (ModelCall & { turnId: string | null })[] }>(settings, `/api/sessions/${sessionId}/calls`, { signal }),
    /* Newest first on the wire; the panel reads oldest first like the transcript. */
    select: (data): ThreadCall[] => [...data.calls].reverse(),
    enabled,
    staleTime: 60_000,
  })
}

export const SPEND_GROUPS = ["profile", "model", "project", "agent", "source"] as const
export type SpendGroupBy = (typeof SPEND_GROUPS)[number]

export interface SpendGroup {
  key: string | null
  name: string | null
  calls: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning: number
  costUsd: number | null
}

export function useSpend(groupBy: SpendGroupBy) {
  const settings = useServer()
  return useQuery({
    queryKey: spendKey(settings, groupBy),
    queryFn: ({ signal }) =>
      api<{ groupBy: SpendGroupBy; groups: SpendGroup[] }>(settings, `/api/usage/calls?groupBy=${groupBy}`, { signal }),
    /* Postgres bigint sums arrive as strings through node-postgres. */
    select: (data) =>
      data.groups.map((g) => ({
        ...g,
        calls: Number(g.calls),
        input: Number(g.input),
        cacheRead: Number(g.cacheRead),
        cacheWrite: Number(g.cacheWrite),
        output: Number(g.output),
        reasoning: Number(g.reasoning),
        costUsd: g.costUsd === null ? null : Number(g.costUsd),
      })),
    staleTime: 30_000,
  })
}
