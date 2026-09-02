/* The catalog query family — profiles, agents, projects, the tool libraries
   and personas. These were reducer slices refilled by `bootstrap` and by
   `refreshX` after every mutation; the cache owns them now, one read per
   slice, invalidated (never mirrored back) by the writes.

   The hooks return the array itself, not the query object: a catalog read is
   always wanted whole, and a stable module-level fallback keeps a pending
   read from re-rendering the consumers that treat "not yet" as empty. */
import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"

import {
  api,
  type AgentDef,
  type AgentsStatus,
  type CommandDef,
  type McpServerDef,
  type Persona,
  type Profile,
  type ProfilePreset,
  type Project,
  type ServerSettings,
  type SkillDef,
} from "@/lib/settings"
import { useServer } from "@/lib/server-context"
import {
  agentsKey,
  agentsStatusKey,
  commandsKey,
  mcpServersKey,
  personasKey,
  profilePresetsKey,
  profilesKey,
  projectsKey,
  scope,
  skillsKey,
} from "./keys"
import { useApiQuery } from "./helpers"

const EMPTY = [] as never[]

const CATALOG_STALE_MS = 60_000

export function useProfiles(): Profile[] {
  const settings = useServer()
  return useApiQuery<Profile[]>(profilesKey(settings), "/api/profiles", {
    staleTime: CATALOG_STALE_MS,
  }).data ?? (EMPTY as Profile[])
}

/** The coding-plan presets (`GET /api/profile-presets`). Read lazily — only
    the new-profile form asks — and kept for the session: the answer is the
    server build's list plus models.dev's catalogs, neither of which moves
    while a form is open. */
export function useProfilePresets(): { presets: ProfilePreset[]; loading: boolean; error: Error | null } {
  const settings = useServer()
  const query = useApiQuery<{ presets: ProfilePreset[] }>(profilePresetsKey(settings), "/api/profile-presets", {
    staleTime: 10 * 60_000,
  })
  return { presets: query.data?.presets ?? (EMPTY as ProfilePreset[]), loading: query.isPending, error: query.error }
}

export function useAgents(): AgentDef[] {
  const settings = useServer()
  return useApiQuery<AgentDef[]>(agentsKey(settings), "/api/agents", {
    staleTime: CATALOG_STALE_MS,
  }).data ?? (EMPTY as AgentDef[])
}

/** Install state and reported versions of every agent, read once per page
    load and kept for the TTL the server measures on: a handshake per agent is
    what a read costs, so nothing polls it. `refresh` asks the server to
    measure again (`?refresh=1`) and writes the answer straight into the cache,
    which is the one case a reader bypasses a query's own fetch on purpose —
    the fresh read is the same route with a flag, not a different resource. */
export function useAgentsStatus(): {
  status: AgentsStatus | undefined
  loading: boolean
  error: Error | null
  refresh: () => Promise<AgentsStatus>
} {
  const settings = useServer()
  const qc = useQueryClient()
  const key = agentsStatusKey(settings)
  const query = useApiQuery<AgentsStatus>(key, "/api/agents/status", { staleTime: 5 * 60_000 })
  const refresh = React.useCallback(async () => {
    const fresh = await api<AgentsStatus>(settings, "/api/agents/status?refresh=1")
    qc.setQueryData(key, fresh)
    return fresh
  }, [settings, qc, key])
  return { status: query.data, loading: query.isPending, error: query.error, refresh }
}

export function useProjects(): Project[] {
  const settings = useServer()
  return useApiQuery<Project[]>(projectsKey(settings), "/api/projects", {
    staleTime: CATALOG_STALE_MS,
  }).data ?? (EMPTY as Project[])
}

export function useMcpServers(): McpServerDef[] {
  const settings = useServer()
  return useApiQuery<McpServerDef[]>(mcpServersKey(settings), "/api/mcp-servers", {
    staleTime: CATALOG_STALE_MS,
  }).data ?? (EMPTY as McpServerDef[])
}

export function useSkills(): SkillDef[] {
  const settings = useServer()
  return useApiQuery<SkillDef[]>(skillsKey(settings), "/api/skills", {
    staleTime: CATALOG_STALE_MS,
  }).data ?? (EMPTY as SkillDef[])
}

export function useCommands(): CommandDef[] {
  const settings = useServer()
  return useApiQuery<CommandDef[]>(commandsKey(settings), "/api/commands", {
    staleTime: CATALOG_STALE_MS,
  }).data ?? (EMPTY as CommandDef[])
}

export function usePersonas(): Persona[] {
  const settings = useServer()
  return useApiQuery<Persona[]>(personasKey(settings), "/api/personas", {
    staleTime: CATALOG_STALE_MS,
  }).data ?? (EMPTY as Persona[])
}

/** Whether the two catalogs the shell gates on have answered at all.
    The old `bootstrap` read every catalog before it resolved, so one
    `loading` flag covered them; now each slice is its own query, and this is
    what keeps the shell from drawing "Finish the setup" — which is what an
    empty projects list means — while the first read is still in flight. Same
    keys as the hooks above, so it shares their request rather than adding
    one. */
export function useCatalogLoaded(): boolean {
  const settings = useServer()
  const profiles = useApiQuery<Profile[]>(profilesKey(settings), "/api/profiles", {
    staleTime: CATALOG_STALE_MS,
  })
  const projects = useApiQuery<Project[]>(projectsKey(settings), "/api/projects", {
    staleTime: CATALOG_STALE_MS,
  })
  return !profiles.isPending && !projects.isPending
}

/* The slices whose keys hang directly off the scope — the invalidating
   callbacks are built from these names, so a page never hand-builds a key. */
export type CatalogSlice =
  | "profiles"
  | "agents"
  | "projects"
  | "mcp-servers"
  | "skills"
  | "commands"
  | "personas"

/** Invalidate catalog slices after an out-of-band write — the same job the
    `refreshX` actions did, without the round trip when nobody is looking.
    Profiles and agents are one logical read (the virtual Default profiles are
    derived from the registry), so `"profiles"` callers usually pass both. */
export function useInvalidateCatalog() {
  const settings = useServer()
  const qc = useQueryClient()
  return async (...slices: CatalogSlice[]) => {
    await Promise.all(
      slices.map((slice) => qc.invalidateQueries({ queryKey: scope(settings).concat([slice]) }))
    )
  }
}

/** The profiles+agents pair as one invalidation — every profile write needs
    it, for the reason above. */
export function useInvalidateProfileCatalog() {
  const invalidate = useInvalidateCatalog()
  return () => invalidate("profiles", "agents")
}

/** Non-React readers of the catalog (the session creator, the connection's
    deleted-project guard) read the cache inside callbacks, exactly like
    `getState()` — last-committed rows, no subscription. */
export function useCatalogReader() {
  const qc = useQueryClient()
  const settings = useServer()
  /* Memoized because `useActions` captures this in a `useMemo` whose deps it
     is deliberately not in — a new object per render would be captured once
     and then be the stale one forever if its closure ever mattered. Both
     things it closes over are stable per connection, so one object is. */
  return React.useMemo(
    () => ({
      projects: (): Project[] =>
        qc.getQueryData<Project[]>(projectsKey(settings)) ?? (EMPTY as Project[]),
      /* `undefined` until the projects read has answered at all. An empty
         array from the cache-miss above is indistinguishable from "every
         project was deleted", and a guard that reads it as the latter fails a
         perfectly good thread on a cold boot — which is exactly what the
         "project no longer exists" message did on a fresh load, and why a
         refresh made it go away. */
      projectsLoaded: (): Project[] | undefined =>
        qc.getQueryData<Project[]>(projectsKey(settings)),
      profiles: (): Profile[] =>
        qc.getQueryData<Profile[]>(profilesKey(settings)) ?? (EMPTY as Profile[]),
      agents: (): AgentDef[] =>
        qc.getQueryData<AgentDef[]>(agentsKey(settings)) ?? (EMPTY as AgentDef[]),
    }),
    [qc, settings]
  )
}
