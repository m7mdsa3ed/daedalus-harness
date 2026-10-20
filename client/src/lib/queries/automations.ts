/* Automations (the server's routines), their runs and triggers — the one query
   family. A scheduled message is a `runsIn: "session"` automation now, so there
   is nothing here for `/api/scheduled`. A mutation is not done when the server
   answers 200, it is done when the cached list is invalidated. */
import { useQueries, useQueryClient } from "@tanstack/react-query"

import { api } from "@/lib/settings"
import type {
  Routine,
  RoutineInput,
  RoutinePatch,
  RoutineRun,
  RoutineTrigger,
  RoutineTriggerInput,
  RoutineTriggerPatch,
  ServerSettings,
} from "@/lib/settings"
import { useServer } from "@/lib/server-context"
import {
  allAutomationRunsKey,
  automationRunsFamilyKey,
  automationRunsKey,
  automationTriggersKey,
  automationsKey,
} from "./keys"
import { useApiMutation, useApiQuery } from "./helpers"

const routinePath = (id: string) => `/api/routines/${encodeURIComponent(id)}`

/* The old rest-actions spelled these out at every call site; one line each
   here so the hooks below read as their routes. */
const postJson = <T>(settings: ServerSettings, path: string, body: unknown): Promise<T> =>
  api<T>(settings, path, { method: "POST", body: JSON.stringify(body) })
const patchJson = <T>(settings: ServerSettings, path: string, body: unknown): Promise<T> =>
  api<T>(settings, path, { method: "PATCH", body: JSON.stringify(body) })
const delJson = (settings: ServerSettings, path: string): Promise<void> =>
  api<void>(settings, path, { method: "DELETE" })

// ---- automations ----

export function useAutomations() {
  const settings = useServer()
  return useApiQuery<Routine[]>(automationsKey(settings), "/api/routines")
}

/**
 * A routine's runs, newest first. Read on demand — never at boot and never on
 * a timer: the list is per routine and grows without bound, and only the
 * routine's own page has ever wanted one. The key carries the routine, so a
 * page that has not asked yet holds `undefined` rather than `[]` — "not read"
 * and "has never run" are different screens (read `isPending`, never
 * `data ?? []`).
 */
export function useAutomationRuns(
  routineId: string,
  limit?: number,
  options?: { enabled?: boolean }
) {
  const settings = useServer()
  return useApiQuery<RoutineRun[]>(
    automationRunsKey(settings, routineId, limit),
    `${routinePath(routineId)}/runs${limit ? `?limit=${limit}` : ""}`,
    options
  )
}

export function useCreateAutomation() {
  const settings = useServer()
  return useApiMutation<RoutineInput, Routine>(
    [automationsKey(settings)],
    (conn, input) => postJson<Routine>(conn, "/api/routines", input)
  )
}

/**
 * Edit a routine in place. Everything the form holds is patchable except
 * `dryRunCompleted`, which the server refuses: it is the engine's own record
 * that a run has completed under this routine, and a patch that could set it
 * would make the blanket-`allow` gate it guards decorative.
 */
export function useUpdateAutomation() {
  const settings = useServer()
  return useApiMutation<{ id: string; patch: RoutinePatch }, Routine>(
    [automationsKey(settings)],
    (conn, { id, patch }) => patchJson<Routine>(conn, routinePath(id), patch)
  )
}

/** A routine's runs go with it (the server cascades), so the whole runs
    family goes stale with the delete — the prefix match does that in one. */
export function useDeleteAutomation() {
  const settings = useServer()
  return useApiMutation<string, void>(
    [automationsKey(settings), allAutomationRunsKey(settings)],
    (conn, id) => delJson(conn, routinePath(id))
  )
}

/**
 * Fire a routine by hand. Answers as soon as the run row exists, not when the
 * run is over — the caller wants the row to link to, and a review that takes
 * half an hour would otherwise be a request that hangs for it. The returned
 * run therefore usually reads `running` with a null `sessionId`; the runs list
 * is what fills in afterwards.
 *
 * `dryRun` forces `ask` everywhere for this one run whatever the routine's
 * policy says, and it is the run that clears the routine's `dryRunCompleted`
 * gate — so the routine is re-read after it, not just the run list.
 */
export function useRunAutomation() {
  const settings = useServer()
  return useApiMutation<{ id: string; text?: string; dryRun?: boolean }, RoutineRun>(
    (_run, { id }) => [automationsKey(settings), automationRunsFamilyKey(settings, id)],
    (conn, { id, ...opts }) => postJson<RoutineRun>(conn, `${routinePath(id)}/run`, opts)
  )
}

/* Stop a run that is still going — the one action here that is about what is
   happening rather than about what will. Takes the routine id as well as the
   run's so the list can be re-read: a run row carries its routine, but the
   key is per routine and there is nothing to look it up with once the caller
   has only a run. */
export function useCancelAutomationRun() {
  const settings = useServer()
  return useApiMutation<{ routineId: string; runId: string }, { stopped: boolean }>(
    (_stopped, { routineId }) => [automationRunsFamilyKey(settings, routineId)],
    (conn, { runId }) =>
      postJson<{ stopped: boolean }>(conn, `/api/routines/runs/${encodeURIComponent(runId)}/cancel`, {})
  )
}

// ---- routine triggers ----
/* A routine's triggers are read on one routine's detail page — they are the
   only thing on it that no other screen shows. The query cache is exactly the
   one-reader cache the old comment said a reducer slice should not be. */

/** The triggers a new automation is written with, one after another (the
    server arms each clock on its next sweep). Not bound to an id because the
    id does not exist until the create answers. */
export function useCreateAutomationTriggers() {
  const settings = useServer()
  return useApiMutation<{ routineId: string; inputs: RoutineTriggerInput[] }, RoutineTrigger[]>(
    (_made, { routineId }) => [automationTriggersKey(settings, routineId)],
    async (conn, { routineId, inputs }) => {
      const made: RoutineTrigger[] = []
      for (const input of inputs)
        made.push(await postJson<RoutineTrigger>(conn, `${routinePath(routineId)}/triggers`, input))
      return made
    }
  )
}

export function useAutomationTriggers(routineId: string) {
  const settings = useServer()
  return useApiQuery<RoutineTrigger[]>(
    automationTriggersKey(settings, routineId),
    `${routinePath(routineId)}/triggers`
  )
}

export function useCreateAutomationTrigger(routineId: string) {
  const settings = useServer()
  return useApiMutation<RoutineTriggerInput, RoutineTrigger>(
    [automationTriggersKey(settings, routineId)],
    (conn, input) => postJson<RoutineTrigger>(conn, `${routinePath(routineId)}/triggers`, input)
  )
}

/** Optimistic at the call site (these are switches and a cron field being
    typed into — a full re-read per keystroke would fight the caret); the
    server's answer replaces the row, so a rejected patch snaps back. */
export function useUpdateAutomationTrigger(routineId: string) {
  const settings = useServer()
  const qc = useQueryClient()
  return useApiMutation<{ id: string; patch: RoutineTriggerPatch }, RoutineTrigger>(
    [automationTriggersKey(settings, routineId)],
    (conn, { id, patch }) =>
      patchJson<RoutineTrigger>(conn, `/api/routines/triggers/${encodeURIComponent(id)}`, patch),
    (updated) => {
      qc.setQueryData<RoutineTrigger[]>(automationTriggersKey(settings, routineId), (prev) =>
        prev?.map((t) => (t.id === updated.id ? updated : t))
      )
    }
  )
}

export function useDeleteAutomationTrigger(routineId: string) {
  const settings = useServer()
  return useApiMutation<string, void>(
    [automationTriggersKey(settings, routineId)],
    (conn, id) => delJson(conn, `/api/routines/triggers/${encodeURIComponent(id)}`)
  )
}

/**
 * Mint or rotate this trigger's long-lived token.
 *
 * The token is in this answer and nowhere else — only its sha-256 is stored —
 * so a caller that does not show it here cannot show it later, and a rotation
 * is a new mint. It is deliberately not put in the store: a credential that
 * outlives the dialog it was shown in is a credential in a state dump.
 */
export function useMintAutomationTriggerToken(routineId: string) {
  const settings = useServer()
  return useApiMutation<string, string>(
    [automationTriggersKey(settings, routineId)],
    (conn, id) =>
      postJson<{ token: string }>(conn, `/api/routines/triggers/${encodeURIComponent(id)}/token`, {}).then(
        ({ token }) => token
      )
  )
}

/** Take the token away without deleting the trigger — a rotation backed out
    of, or one believed leaked. The trigger stays, inert to everything outside
    the server process. */
export function useRevokeAutomationTriggerToken(routineId: string) {
  const settings = useServer()
  return useApiMutation<string, void>(
    [automationTriggersKey(settings, routineId)],
    (conn, id) => delJson(conn, `/api/routines/triggers/${encodeURIComponent(id)}/token`)
  )
}

// ---- list reads ----

/**
 * What the list page reads beyond the automations themselves: the newest run
 * and the triggers of each. One small request each, on the visit and never on
 * a timer; the mutations above invalidate the same keys, so a row moves with
 * the detail page. `undefined` = not read yet, `null` = never run.
 */
export function useAutomationReads(automations: Routine[]) {
  const settings = useServer()
  const runs = useQueries({
    queries: automations.map((r) => ({
      queryKey: automationRunsKey(settings, r.id, 1),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api<RoutineRun[]>(settings, `${routinePath(r.id)}/runs?limit=1`, { signal }),
    })),
  })
  const triggers = useQueries({
    queries: automations.map((r) => ({
      queryKey: automationTriggersKey(settings, r.id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api<RoutineTrigger[]>(settings, `${routinePath(r.id)}/triggers`, { signal }),
    })),
  })
  const latest: Record<string, RoutineRun | null | undefined> = {}
  const triggersOf: Record<string, RoutineTrigger[] | undefined> = {}
  automations.forEach((r, i) => {
    const data = runs[i]?.data
    latest[r.id] = data === undefined ? undefined : (data[0] ?? null)
    triggersOf[r.id] = triggers[i]?.data
  })
  return { latest, triggers: triggersOf }
}
