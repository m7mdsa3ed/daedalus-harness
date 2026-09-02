/* Scheduled messages, routines and their runs/triggers — the automations
   query family. These were reducer slices read with `refetch-after-mutate`
   (lib/rest-actions.ts); the rule carries over unchanged, only its mechanism
   moved: a mutation is not done when the server answers 200, it is done when
   the cached list is invalidated. */
import { useQueryClient } from "@tanstack/react-query"

import { api, updateScheduled } from "@/lib/settings"
import type {
  Routine,
  RoutineInput,
  RoutinePatch,
  RoutineRun,
  RoutineTrigger,
  RoutineTriggerInput,
  RoutineTriggerPatch,
  ScheduledMessage,
  ScheduledPatch,
  ServerSettings,
} from "@/lib/settings"
import { useServer } from "@/lib/server-context"
import {
  allRoutineRunsKey,
  routineRunsFamilyKey,
  routineRunsKey,
  routineTriggersKey,
  routinesKey,
  scheduledKey,
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

// ---- scheduled messages ----

/** Scheduled prompts, soonest first. The server owns delivery (scheduler.ts),
    so the message goes out whether or not this tab is open. */
export function useScheduled() {
  const settings = useServer()
  return useApiQuery<ScheduledMessage[]>(scheduledKey(settings), "/api/scheduled")
}

export interface ScheduleInput {
  sessionId: string
  text: string
  nextAt: number
  everyMs?: number | null
}

/** Schedule `text` to be sent to a thread's agent at `nextAt` (and again every
    `everyMs`). The caller is responsible for materializing a draft thread
    first (the server only schedules threads it knows) — the action in
    lib/actions does that half and then calls this. */
export function useCreateSchedule() {
  const settings = useServer()
  return useApiMutation<ScheduleInput, ScheduledMessage>(
    [scheduledKey(settings)],
    (conn, input) => postJson<ScheduledMessage>(conn, "/api/scheduled", input)
  )
}

/** Edit a schedule in place — text, time, recurrence, or pause/resume
    (`enabled`). Any patch also resets the row's skip state server-side, so
    resuming a parked schedule is just `{ enabled: true }`. */
export function useUpdateSchedule() {
  const settings = useServer()
  return useApiMutation<{ id: string; patch: ScheduledPatch }, ScheduledMessage>(
    [scheduledKey(settings)],
    (conn, { id, patch }) => updateScheduled(conn, id, patch)
  )
}

export function useCancelSchedule() {
  const settings = useServer()
  return useApiMutation<string, void>(
    [scheduledKey(settings)],
    (conn, id) => delJson(conn, `/api/scheduled/${encodeURIComponent(id)}`)
  )
}

// ---- routines ----

export function useRoutines() {
  const settings = useServer()
  return useApiQuery<Routine[]>(routinesKey(settings), "/api/routines")
}

/**
 * A routine's runs, newest first. Read on demand — never at boot and never on
 * a timer: the list is per routine and grows without bound, and only the
 * routine's own page has ever wanted one. The key carries the routine, so a
 * page that has not asked yet holds `undefined` rather than `[]` — "not read"
 * and "has never run" are different screens (read `isPending`, never
 * `data ?? []`).
 */
export function useRoutineRuns(
  routineId: string,
  limit?: number,
  options?: { enabled?: boolean }
) {
  const settings = useServer()
  return useApiQuery<RoutineRun[]>(
    routineRunsKey(settings, routineId, limit),
    `${routinePath(routineId)}/runs${limit ? `?limit=${limit}` : ""}`,
    options
  )
}

export function useCreateRoutine() {
  const settings = useServer()
  return useApiMutation<RoutineInput, Routine>(
    [routinesKey(settings)],
    (conn, input) => postJson<Routine>(conn, "/api/routines", input)
  )
}

/**
 * Edit a routine in place. Everything the form holds is patchable except
 * `dryRunCompleted`, which the server refuses: it is the engine's own record
 * that a run has completed under this routine, and a patch that could set it
 * would make the blanket-`allow` gate it guards decorative.
 */
export function useUpdateRoutine() {
  const settings = useServer()
  return useApiMutation<{ id: string; patch: RoutinePatch }, Routine>(
    [routinesKey(settings)],
    (conn, { id, patch }) => patchJson<Routine>(conn, routinePath(id), patch)
  )
}

/** A routine's runs go with it (the server cascades), so the whole runs
    family goes stale with the delete — the prefix match does that in one. */
export function useDeleteRoutine() {
  const settings = useServer()
  return useApiMutation<string, void>(
    [routinesKey(settings), allRoutineRunsKey(settings)],
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
export function useRunRoutine() {
  const settings = useServer()
  return useApiMutation<{ id: string; text?: string; dryRun?: boolean }, RoutineRun>(
    (_run, { id }) => [routinesKey(settings), routineRunsFamilyKey(settings, id)],
    (conn, { id, ...opts }) => postJson<RoutineRun>(conn, `${routinePath(id)}/run`, opts)
  )
}

/* Stop a run that is still going — the one action here that is about what is
   happening rather than about what will. Takes the routine id as well as the
   run's so the list can be re-read: a run row carries its routine, but the
   key is per routine and there is nothing to look it up with once the caller
   has only a run. */
export function useCancelRoutineRun() {
  const settings = useServer()
  return useApiMutation<{ routineId: string; runId: string }, { stopped: boolean }>(
    (_stopped, { routineId }) => [routineRunsFamilyKey(settings, routineId)],
    (conn, { runId }) =>
      postJson<{ stopped: boolean }>(conn, `/api/routines/runs/${encodeURIComponent(runId)}/cancel`, {})
  )
}

// ---- routine triggers ----
/* A routine's triggers are read on one routine's detail page — they are the
   only thing on it that no other screen shows. The query cache is exactly the
   one-reader cache the old comment said a reducer slice should not be. */

export function useRoutineTriggers(routineId: string) {
  const settings = useServer()
  return useApiQuery<RoutineTrigger[]>(
    routineTriggersKey(settings, routineId),
    `${routinePath(routineId)}/triggers`
  )
}

export function useCreateRoutineTrigger(routineId: string) {
  const settings = useServer()
  return useApiMutation<RoutineTriggerInput, RoutineTrigger>(
    [routineTriggersKey(settings, routineId)],
    (conn, input) => postJson<RoutineTrigger>(conn, `${routinePath(routineId)}/triggers`, input)
  )
}

/** Optimistic at the call site (these are switches and a cron field being
    typed into — a full re-read per keystroke would fight the caret); the
    server's answer replaces the row, so a rejected patch snaps back. */
export function useUpdateRoutineTrigger(routineId: string) {
  const settings = useServer()
  const qc = useQueryClient()
  return useApiMutation<{ id: string; patch: RoutineTriggerPatch }, RoutineTrigger>(
    [routineTriggersKey(settings, routineId)],
    (conn, { id, patch }) =>
      patchJson<RoutineTrigger>(conn, `/api/routines/triggers/${encodeURIComponent(id)}`, patch),
    (updated) => {
      qc.setQueryData<RoutineTrigger[]>(routineTriggersKey(settings, routineId), (prev) =>
        prev?.map((t) => (t.id === updated.id ? updated : t))
      )
    }
  )
}

export function useDeleteRoutineTrigger(routineId: string) {
  const settings = useServer()
  return useApiMutation<string, void>(
    [routineTriggersKey(settings, routineId)],
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
export function useMintRoutineTriggerToken(routineId: string) {
  const settings = useServer()
  return useApiMutation<string, string>(
    [routineTriggersKey(settings, routineId)],
    (conn, id) =>
      postJson<{ token: string }>(conn, `/api/routines/triggers/${encodeURIComponent(id)}/token`, {}).then(
        ({ token }) => token
      )
  )
}

/** Take the token away without deleting the trigger — a rotation backed out
    of, or one believed leaked. The trigger stays, inert to everything outside
    the server process. */
export function useRevokeRoutineTriggerToken(routineId: string) {
  const settings = useServer()
  return useApiMutation<string, void>(
    [routineTriggersKey(settings, routineId)],
    (conn, id) => delJson(conn, `/api/routines/triggers/${encodeURIComponent(id)}/token`)
  )
}
