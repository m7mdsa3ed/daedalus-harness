/* ── Writing a project's start defaults ──
 *
 * The values a thread started in a project opens with — the profile/agent
 * pair, the model and effort, the permission mode, the agent's other
 * selectors, the persona, the tool picks and the two instruction toggles
 * (`ProjectDefaults`). They live on the project row, because that is the scope
 * they are about: "the model I use for this codebase" belongs to the codebase
 * exactly as `session_project` belongs to the thread, so a pick follows the
 * person to every device and changing the project changes the model.
 *
 * Reading is not done here. The whole set is on the project row the rest of
 * the app already holds (`useProjects()`), which is what lets the draft menu
 * draw "the project's model" without a second query — and is why the write
 * answers the whole row: the cache it lands in is the list.
 *
 * Two things about the write are worth knowing before calling it:
 *
 * - It **coalesces per project**. A menu sends model and effort on every call
 *   and a draft's picks arrive in a run (agent, then profile, then model), so
 *   an uncoalesced `PATCH` per pick was a burst of requests writing the same
 *   row. Picks merge and one request goes out, the same shape the thread
 *   config buffer uses (`actions/config.ts`) and for the same reason.
 * - It is **fire and forget**. A defaults write is a convenience the menus
 *   read back; a failure costs the pick, not the message being typed, so it is
 *   logged and dropped rather than raised into a composer that has nowhere to
 *   put it. `flushProjectDefaults` is what a caller that wants it landed
 *   awaits.
 */
import type { QueryClient } from "@tanstack/react-query"
import { projectsKey } from "@/lib/queries/keys"
import { api, type Project, type ProjectDefaults, type ServerSettings } from "@/lib/settings"

/** What a write may move: any part of the defaults, and nothing else. Absent
    means unchanged; `""` is a real value (the empty pick). */
export type ProjectDefaultsPatch = Partial<ProjectDefaults>

/* How long picks are merged before a request goes out. Bounded below the
   thread config buffer's 450ms because nothing here costs a restart: the worst
   case of waiting is a menu that has not been told yet, and the selector is
   drawing the value the user just picked either way. */
const COALESCE_MS = 350

interface Pending {
  settings: ServerSettings
  qc: QueryClient
  patch: ProjectDefaultsPatch
  timer: ReturnType<typeof setTimeout> | null
}

/** Module-level, like the thread config buffer: these outlive any one render
    and the picks they merge arrive from a menu that has already closed. */
const pending = new Map<string, Pending>()

/** Merge one or more fields into a project's defaults. Fire and forget — see
    the module note. */
export function saveProjectDefaults(
  settings: ServerSettings,
  qc: QueryClient,
  projectId: string,
  patch: ProjectDefaultsPatch
): void {
  if (!projectId) return
  const held = pending.get(projectId)
  if (held?.timer) clearTimeout(held.timer)
  const merged: Pending = {
    settings,
    qc,
    patch: { ...(held?.patch ?? {}), ...patch },
    timer: setTimeout(() => void flushProjectDefaults(projectId), COALESCE_MS),
  }
  pending.set(projectId, merged)
}

/** Send whatever is buffered for a project, now. Safe to call with nothing
    buffered, which is most of the times a menu closes. */
export async function flushProjectDefaults(projectId: string): Promise<void> {
  const held = pending.get(projectId)
  if (!held) return
  if (held.timer) clearTimeout(held.timer)
  pending.delete(projectId)
  if (Object.keys(held.patch).length === 0) return
  try {
    const row = await api<Project>(held.settings, `/api/projects/${projectId}/defaults`, {
      method: "PATCH",
      body: JSON.stringify(held.patch),
    })
    /* The server answers the whole project, so the cache is corrected from its
       own row rather than re-read by hand — the same bargain `useApiMutation`'s
       `apply` makes, without a list round trip per pick. Only this row is
       touched; the other projects' rows in the list are still the ones the
       server last sent. */
    held.qc.setQueryData<Project[]>(projectsKey(held.settings), (rows) =>
      rows?.map((entry) => (entry.id === row.id ? row : entry))
    )
  } catch (error) {
    /* Nowhere to put it and nothing to undo: the menu drew the pick because
       the user made it, and the next visit to the project will show what the
       server actually holds. A console line is the honest surface. */
    console.warn(`Couldn't remember the settings for this project`, error)
  }
}
