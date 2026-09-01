/**
 * The pure-REST half of `useActions`: catalog refreshes and the
 * schedule/routine/trigger CRUD. Nothing here touches the socket runtime or
 * the hook's closures — each function takes the server settings and (where it
 * writes to the store) the dispatch, exactly the way `lib/settings.ts` shapes
 * its calls — which is what makes this half unit-testable while the
 * thread-lifecycle core stays in the hook.
 *
 * The mutations live beside their refresh for the reason the old in-hook block
 * gave: a mutation's job is not done when the server answers 200, it is done
 * when the list every screen reads has been re-read. A page calling `api()`
 * itself would leave a deleted routine on screen until something else happened
 * to refresh.
 */
import {
  api,
  updateScheduled,
  type CommandDef,
  type McpServerDef,
  type Persona,
  type Project,
  type Routine,
  type RoutineInput,
  type RoutinePatch,
  type RoutineRun,
  type RoutineTrigger,
  type RoutineTriggerInput,
  type RoutineTriggerPatch,
  type ScheduledMessage,
  type ScheduledPatch,
  type ServerSettings,
  type SkillDef,
} from "./settings"
import type { Action } from "./store"

type Dispatch = (action: Action) => void

// ---- catalog refreshes ----

export async function refreshProjects(settings: ServerSettings, dispatch: Dispatch) {
  const projects = await api<Project[]>(settings, "/api/projects")
  dispatch({ type: "projects", projects })
}

export async function refreshMcpServers(settings: ServerSettings, dispatch: Dispatch) {
  const mcpServers = await api<McpServerDef[]>(settings, "/api/mcp-servers")
  dispatch({ type: "mcp-servers", mcpServers })
}

export async function refreshSkills(settings: ServerSettings, dispatch: Dispatch) {
  const skills = await api<SkillDef[]>(settings, "/api/skills")
  dispatch({ type: "skills", skills })
}

export async function refreshCommands(settings: ServerSettings, dispatch: Dispatch) {
  const commands = await api<CommandDef[]>(settings, "/api/commands")
  dispatch({ type: "commands", commands })
}

export async function refreshPersonas(settings: ServerSettings, dispatch: Dispatch) {
  const personas = await api<Persona[]>(settings, "/api/personas")
  dispatch({ type: "personas", personas })
}

// ---- scheduled messages ----

export async function refreshScheduled(settings: ServerSettings, dispatch: Dispatch) {
  const scheduled = await api<ScheduledMessage[]>(settings, "/api/scheduled")
  dispatch({ type: "scheduled", scheduled })
}

export interface ScheduleInput {
  sessionId: string
  text: string
  nextAt: number
  everyMs?: number | null
}

/**
 * Schedule `text` to be sent to a thread's agent at `nextAt` (and again every
 * `everyMs`). The server owns delivery (scheduler.ts), so the message goes out
 * whether or not this tab is open — and a trashed thread never receives it.
 * The caller is responsible for materializing a draft thread first (the server
 * only schedules threads it knows) — see the hook's `createSchedule`.
 */
export async function createSchedule(
  settings: ServerSettings,
  dispatch: Dispatch,
  input: ScheduleInput,
) {
  await api<ScheduledMessage>(settings, "/api/scheduled", {
    method: "POST",
    body: JSON.stringify(input),
  })
  await refreshScheduled(settings, dispatch)
}

/**
 * Edit a schedule in place — text, time, recurrence, or pause/resume
 * (`enabled`). Any patch also resets the row's skip state server-side, so
 * resuming a parked schedule is just `{ enabled: true }`.
 */
export async function updateSchedule(
  settings: ServerSettings,
  dispatch: Dispatch,
  id: string,
  patch: ScheduledPatch,
) {
  await updateScheduled(settings, id, patch)
  await refreshScheduled(settings, dispatch)
}

export async function cancelSchedule(settings: ServerSettings, dispatch: Dispatch, id: string) {
  await api(settings, `/api/scheduled/${id}`, { method: "DELETE" })
  await refreshScheduled(settings, dispatch)
}

// ---- routines ----

export async function refreshRoutines(settings: ServerSettings, dispatch: Dispatch) {
  const routines = await api<Routine[]>(settings, "/api/routines")
  dispatch({ type: "routines", routines })
}

/**
 * A routine's runs, newest first. Read on demand — never at boot and never on
 * a timer: the list is per routine and grows without bound, and only the
 * routine's own page has ever wanted one. The store keys them by routine, so a
 * page that has not asked yet holds `undefined` rather than `[]` — "not read"
 * and "has never run" are different screens.
 */
export async function refreshRoutineRuns(
  settings: ServerSettings,
  dispatch: Dispatch,
  routineId: string,
  limit?: number,
) {
  const query = limit ? `?limit=${limit}` : ""
  const runs = await api<RoutineRun[]>(
    settings,
    `/api/routines/${encodeURIComponent(routineId)}/runs${query}`
  )
  dispatch({ type: "routine-runs", routineId, runs })
  return runs
}

export async function createRoutine(
  settings: ServerSettings,
  dispatch: Dispatch,
  input: RoutineInput,
) {
  const routine = await api<Routine>(settings, "/api/routines", {
    method: "POST",
    body: JSON.stringify(input),
  })
  await refreshRoutines(settings, dispatch)
  return routine
}

/**
 * Edit a routine in place. Everything the form holds is patchable except
 * `dryRunCompleted`, which the server refuses: it is the engine's own record
 * that a run has completed under this routine, and a patch that could set it
 * would make the blanket-`allow` gate it guards decorative.
 */
export async function updateRoutine(
  settings: ServerSettings,
  dispatch: Dispatch,
  id: string,
  patch: RoutinePatch,
) {
  const routine = await api<Routine>(settings, `/api/routines/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  })
  await refreshRoutines(settings, dispatch)
  return routine
}

export async function deleteRoutine(settings: ServerSettings, dispatch: Dispatch, id: string) {
  await api(settings, `/api/routines/${encodeURIComponent(id)}`, { method: "DELETE" })
  await refreshRoutines(settings, dispatch)
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
export async function runRoutine(
  settings: ServerSettings,
  dispatch: Dispatch,
  id: string,
  opts: { text?: string; dryRun?: boolean } = {},
) {
  const run = await api<RoutineRun>(
    settings,
    `/api/routines/${encodeURIComponent(id)}/run`,
    { method: "POST", body: JSON.stringify(opts) }
  )
  await Promise.all([refreshRoutines(settings, dispatch), refreshRoutineRuns(settings, dispatch, id)])
  return run
}

/* Stop a run that is still going — the one action here that is about what is
   happening rather than about what will. Takes the routine id as well as the
   run's so the list can be re-read: a run row carries its routine, but the
   store is keyed by routine and there is nothing to look it up with once the
   caller has only a run. */
export async function cancelRoutineRun(
  settings: ServerSettings,
  dispatch: Dispatch,
  routineId: string,
  runId: string,
) {
  await api<{ stopped: boolean }>(
    settings,
    `/api/routines/runs/${encodeURIComponent(runId)}/cancel`,
    { method: "POST" }
  )
  await refreshRoutineRuns(settings, dispatch, routineId)
}

// ---- routine triggers ----
/* Triggers are returned, not stored. They are read on one routine's detail
   page, they are the only thing on it that no other screen shows, and a slice
   for them would be a cache with exactly one reader. */

export async function listRoutineTriggers(settings: ServerSettings, routineId: string) {
  return api<RoutineTrigger[]>(
    settings,
    `/api/routines/${encodeURIComponent(routineId)}/triggers`
  )
}

export async function createRoutineTrigger(
  settings: ServerSettings,
  routineId: string,
  input: RoutineTriggerInput,
) {
  return api<RoutineTrigger>(
    settings,
    `/api/routines/${encodeURIComponent(routineId)}/triggers`,
    { method: "POST", body: JSON.stringify(input) }
  )
}

export async function updateRoutineTrigger(
  settings: ServerSettings,
  id: string,
  patch: RoutineTriggerPatch,
) {
  return api<RoutineTrigger>(
    settings,
    `/api/routines/triggers/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(patch) }
  )
}

export async function deleteRoutineTrigger(settings: ServerSettings, id: string) {
  await api(settings, `/api/routines/triggers/${encodeURIComponent(id)}`, {
    method: "DELETE",
  })
}

/**
 * Mint or rotate this trigger's long-lived token.
 *
 * The token is in this answer and nowhere else — only its sha-256 is stored —
 * so a caller that does not show it here cannot show it later, and a rotation
 * is a new mint. It is deliberately not put in the store: a credential that
 * outlives the dialog it was shown in is a credential in a state dump.
 */
export async function mintRoutineTriggerToken(settings: ServerSettings, id: string) {
  const { token } = await api<{ token: string }>(
    settings,
    `/api/routines/triggers/${encodeURIComponent(id)}/token`,
    { method: "POST" }
  )
  return token
}

/** Take the token away without deleting the trigger — a rotation backed out
    of, or one believed leaked. The trigger stays, inert to everything outside
    the server process. */
export async function revokeRoutineTriggerToken(settings: ServerSettings, id: string) {
  await api(settings, `/api/routines/triggers/${encodeURIComponent(id)}/token`, {
    method: "DELETE",
  })
}
