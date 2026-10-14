/* The model-role vocabulary — the free-form, ordered list a profile's models
   tag themselves with, so a subagent is spawned on a role rather than on a
   hardcoded "small" model (docs/model-roles.md). Global, one list per server,
   edited in Settings, the same shape the rules family takes.

   The hooks return the array itself, not the query object — a catalog read is
   always wanted whole — and a write invalidates the key rather than patching
   the cache, so the Settings page and the profile editor's role picker, which
   reads the same key, both see the change. */
import {
  api,
  type ModelRole,
  type ServerSettings,
} from "@/lib/settings"
import { useServer } from "@/lib/server-context"
import { modelRolesKey } from "./keys"
import { useApiQuery, useApiMutation } from "./helpers"

/* A persisted dump can hold a bad body (`queries/persist.ts`), which reaches a
   consumer as `x.map is not a function` — a white screen. Empty is what "not
   yet" already draws. */
const EMPTY = [] as never[]
const list = <T,>(data: unknown): T[] => (Array.isArray(data) ? (data as T[]) : (EMPTY as T[]))

const CATALOG_STALE_MS = 60_000

/** The whole model-role vocabulary, ordered. */
export function useModelRoles(): ModelRole[] {
  const settings = useServer()
  return list<ModelRole>(
    useApiQuery<ModelRole[]>(modelRolesKey(settings), "/api/model-roles", {
      staleTime: CATALOG_STALE_MS,
    }).data,
  )
}

/** Add a role. `id` is optional: the server mints one when the caller names
    none. */
export function useCreateModelRole() {
  const settings = useServer()
  return useApiMutation<
    { id?: string; label: string; description?: string; sortOrder?: number },
    ModelRole
  >([modelRolesKey(settings)], (s: ServerSettings, input) =>
    api(s, "/api/model-roles", { method: "POST", body: JSON.stringify(input) }),
  )
}

/** Update a role's label/description/order. `id` is stable and not changed by
    an update — it is what every assignment points at. */
export function useUpdateModelRole() {
  const settings = useServer()
  return useApiMutation<
    { id: string; label?: string; description?: string; sortOrder?: number },
    ModelRole
  >([modelRolesKey(settings)], (s: ServerSettings, input) =>
    api(s, `/api/model-roles/${input.id}`, { method: "PUT", body: JSON.stringify(input) }),
  )
}

/** Delete a role. Assignments naming it are left dangling on purpose — the
    readers ignore an id no row answers for. */
export function useDeleteModelRole() {
  const settings = useServer()
  return useApiMutation<{ id: string }, { ok: boolean }>(
    [modelRolesKey(settings)],
    (s: ServerSettings, input) => api(s, `/api/model-roles/${input.id}`, { method: "DELETE" }),
  )
}
