/* ── Workflow runs and the saved-workflow library ──
   The transcript draws a run's *steps* (they are subagent rows, folded by
   `mergeWorkflowRuns`); this family is what the transcript cannot carry: the
   run's gates, `state`, artifacts, logs and budget meters, and the richer step
   statuses (retrying, awaiting approval, sleeping, waiting for a signal) the
   engine folds from its journal. The shapes mirror `RunView`/`GateView` in
   server/src/workflows/types.ts — restated here, because the client never
   imports the server.

   A read is polled by its card only while the run is live and the card is
   open (the caller says how often); a write is not done when the server
   answers 200 but when the run it touched has been read again. */
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/settings"
import type { ServerSettings } from "@/lib/settings"
import { useServer } from "@/lib/server-context"
import { savedWorkflowsFamilyKey, savedWorkflowsKey, workflowRunKey } from "./keys"
import { useApiMutation } from "./helpers"

export type WorkflowRunStatus =
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "budget_exceeded"

export const isTerminalRun = (status: WorkflowRunStatus): boolean =>
  status !== "running" && status !== "paused"

export type WorkflowStepStatus =
  | "pending"
  | "running"
  | "retrying"
  | "awaiting_approval"
  | "sleeping"
  | "waiting_signal"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped"

export interface WorkflowStepView {
  name: string
  key: string
  phase: string | null
  status: WorkflowStepStatus
  sessionId: string | null
  attempt: number
  error: string | null
  startedAt: number | null
  endedAt: number | null
  tokens: number
  toolUses: number
  costUsd: number
}

export interface WorkflowGateView {
  key: string
  kind: "approval" | "timer" | "signal"
  status: "waiting" | "resolved" | "timed_out"
  text?: string
  options?: string[]
  /** A timer's wake-up time, epoch ms. */
  fireAt?: number
  /** When a waiting approval/signal gives up, epoch ms — drawn as a countdown
      when the server says it; `GateView` carries it for timers (`fireAt`) only. */
  expiresAt?: number
  signal?: string
  choice?: string | null
}

export interface WorkflowBudgets {
  tokens?: number
  costUsd?: number
  agents?: number
  wallSec?: number
}

export interface WorkflowRunView {
  id: string
  name: string
  status: WorkflowRunStatus
  error: string | null
  createdAt: number
  endedAt: number | null
  steps: WorkflowStepView[]
  gates: WorkflowGateView[]
  state: Record<string, unknown>
  artifacts: { name: string; relPath: string; bytes: number }[]
  logs: string[]
  usage: { tokens: number; costUsd: number; agents: number }
  budgets: WorkflowBudgets
  result?: unknown
}

const enc = encodeURIComponent
const runPath = (sessionId: string, runId: string) =>
  `/api/sessions/${enc(sessionId)}/workflows/${enc(runId)}`
const postJson = <T>(settings: ServerSettings, path: string, body: unknown): Promise<T> =>
  api<T>(settings, path, { method: "POST", body: JSON.stringify(body) })

/**
 * One run's folded view. `poll` is the card's wish (open and live → fast);
 * a settled run is never polled and never goes stale, and a read that failed
 * (a server without the route, a run that is gone) is not retried — the card
 * simply draws from the transcript alone. Not persisted: a run is live state.
 */
export function useWorkflowRun(
  sessionId: string | undefined,
  runId: string | undefined,
  options: { enabled: boolean; poll: number | false }
) {
  const settings = useServer()
  return useQuery({
    queryKey: workflowRunKey(settings, sessionId ?? "", runId ?? ""),
    queryFn: ({ signal }) => api<WorkflowRunView>(settings, runPath(sessionId!, runId!), { signal }),
    enabled: options.enabled && !!sessionId && !!runId,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: (query) =>
      query.state.data && isTerminalRun(query.state.data.status) ? Infinity : 2_000,
    refetchInterval: (query) =>
      query.state.status === "error" || (query.state.data && isTerminalRun(query.state.data.status))
        ? false
        : options.poll,
    meta: { persist: false },
  })
}

interface RunRef {
  sessionId: string
  runId: string
}

/** Every write below is answered by the run's own read key, so the card
    redraws from the server's word and not from what the click assumed. */
const runKeys = (settings: ServerSettings) => (_data: unknown, input: RunRef) =>
  [workflowRunKey(settings, input.sessionId, input.runId)] as const

export function useCancelWorkflowRun() {
  const settings = useServer()
  return useApiMutation<RunRef, unknown>(runKeys(settings), (conn, { sessionId, runId }) =>
    postJson(conn, `${runPath(sessionId, runId)}/cancel`, {})
  )
}

/** Answer a parked approval by its gate key. A lost race (answered in the
    inbox first) is the server's 409. */
export function useApproveWorkflowGate() {
  const settings = useServer()
  return useApiMutation<RunRef & { gateKey: string; choice: string }, unknown>(
    runKeys(settings),
    (conn, { sessionId, runId, gateKey, choice }) =>
      postJson(conn, `${runPath(sessionId, runId)}/approve`, { gateKey, choice })
  )
}

/** Deliver an external signal; `value` is already parsed JSON. */
export function useSignalWorkflowRun() {
  const settings = useServer()
  return useApiMutation<RunRef & { name: string; value: unknown }, unknown>(
    runKeys(settings),
    (conn, { sessionId, runId, name, value }) =>
      postJson(conn, `${runPath(sessionId, runId)}/signal`, { name, value })
  )
}

// ---- the saved-workflow library ----

export interface SavedWorkflow {
  id: string
  name: string
  scope: "project" | "personal"
  projectId: string | null
  description: string
  whenToUse?: string
  /** First 16 hex of the source's sha256. */
  version: string
  /** `meta.inputs`: JSON Schema for the run's `args`, or null. */
  inputs: Record<string, unknown> | null
  updatedAt: number
}

/** The workflows a project can run: its own and the personal ones. */
export function useSavedWorkflows(projectId: string) {
  const settings = useServer()
  return useQuery({
    queryKey: savedWorkflowsKey(settings, projectId),
    queryFn: async ({ signal }) => {
      const body = await api<SavedWorkflow[] | { workflows: SavedWorkflow[] }>(
        settings,
        `/api/workflows/saved?projectId=${enc(projectId)}`,
        { signal }
      )
      return Array.isArray(body) ? body : (body.workflows ?? [])
    },
    retry: false,
  })
}

export function useDeleteSavedWorkflow(projectId: string) {
  const settings = useServer()
  return useApiMutation<{ id: string; scope: SavedWorkflow["scope"] }, unknown>(
    [savedWorkflowsFamilyKey(settings)],
    (conn, { id, scope }) =>
      api(conn, `/api/workflows/saved/${enc(id)}?projectId=${enc(projectId)}&scope=${scope}`, {
        method: "DELETE",
      })
  )
}

/** What starting a saved workflow answers: the run's header (`RunView`). */
export interface StartedWorkflow {
  id: string
  name?: string
  status?: WorkflowRunStatus
}

/**
 * Run a saved workflow in a project: `POST /api/projects/:id/workflows/run`.
 * The engine hangs a run on a thread (its card is drawn in that transcript),
 * so the button names one: `sessionId` is a live thread of the project, and
 * the server answers 501 until a parentless run exists.
 */
export function useRunSavedWorkflow(projectId: string) {
  return useApiMutation<{ name: string; args?: unknown; sessionId?: string }, StartedWorkflow>(
    [],
    (conn, input) =>
      postJson<StartedWorkflow>(conn, `/api/projects/${enc(projectId)}/workflows/run`, input)
  )
}
