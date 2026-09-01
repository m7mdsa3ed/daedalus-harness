/* The catalog query family — profiles, agents, projects, the tool libraries
   and personas. These were reducer slices refilled by `bootstrap` and by
   `refreshX` after every mutation; the cache owns them now, one read per
   slice, invalidated (never mirrored back) by the writes.

   The hooks return the array itself, not the query object: a catalog read is
   always wanted whole, and a stable module-level fallback keeps a pending
   read from re-rendering the consumers that treat "not yet" as empty. */
import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"

import type {
  AgentDef,
  CommandDef,
  McpServerDef,
  Persona,
  Profile,
  Project,
  ServerSettings,
  SkillDef,
} from "@/lib/settings"
import { useServer } from "@/lib/server-context"
import {
  agentsKey,
  commandsKey,
  mcpServersKey,
  personasKey,
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

export function useAgents(): AgentDef[] {
  const settings = useServer()
  return useApiQuery<AgentDef[]>(agentsKey(settings), "/api/agents", {
    staleTime: CATALOG_STALE_MS,
  }).data ?? (EMPTY as AgentDef[])
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
      profiles: (): Profile[] =>
        qc.getQueryData<Profile[]>(profilesKey(settings)) ?? (EMPTY as Profile[]),
      agents: (): AgentDef[] =>
        qc.getQueryData<AgentDef[]>(agentsKey(settings)) ?? (EMPTY as AgentDef[]),
    }),
    [qc, settings]
  )
}
