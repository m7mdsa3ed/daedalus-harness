/* The catalog query family — profiles, agents, projects, the tool libraries.
   These were reducer slices refilled by `bootstrap` and by
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
  type McpCheckResult,
  type ThreadMcpServer,
  type McpServerDef,
  type ModelPrompt,
  type Profile,
  type ProfilePreset,
  type Project,
  type ServerSettings,
  type SkillDef,
  type Space,
} from "@/lib/settings"
import { useServer } from "@/lib/server-context"
import { setActiveSpace, useActiveSpaceId } from "@/lib/spaces"
import {
  agentsKey,
  agentsStatusKey,
  commandsKey,
  mcpCatalogKey,
  threadMcpKey,
  mcpServersKey,
  modelPromptsKey,
  profilePresetsKey,
  profilesKey,
  projectsKey,
  rulesKey,
  scope,
  skillsKey,
  spacesKey,
} from "./keys"
import { useApiQuery, useApiMutation } from "./helpers"

const EMPTY = [] as never[]

/** `data`, but only when it is the list the caller asked for.

   The query cache is persisted (`queries/persist.ts`), and a dump is
   rehydrated *before* the refetch that would correct it — so one bad body,
   written to storage once, is restored on every load until something replaces
   it. A `{}` where a list belongs then reaches the consumers as
   `x.find is not a function`, which is a white screen rather than a wrong
   list. Empty is what "not yet" already draws here, and the read behind it
   lands a moment later. */
const list = <T,>(data: unknown): T[] => (Array.isArray(data) ? (data as T[]) : (EMPTY as T[]))

const CATALOG_STALE_MS = 60_000

export function useProfiles(): Profile[] {
  const settings = useServer()
  return list<Profile>(useApiQuery<Profile[]>(profilesKey(settings), "/api/profiles", {
    staleTime: CATALOG_STALE_MS,
  }).data)
}

/** Hide or disable a profile, or set its helper model, without editing it. A dedicated `PATCH`, not the
    editor's `PUT`: the client never holds the API key, so changing one flag
    must not have to mean "keep the stored key". One route, either field. */
export function useSetProfileFlags() {
  const settings = useServer()
  return useApiMutation<{ id: string; hidden?: boolean; disabled?: boolean; smallModel?: string; voiceProvider?: string }, Profile>(
    [profilesKey(settings), agentsKey(settings)],
    (s, { id, ...flags }) =>
      api<Profile>(s, `/api/profiles/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ ...flags }),
      }),
  )
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
  return { presets: list<ProfilePreset>(query.data?.presets), loading: query.isPending, error: query.error }
}

export function useAgents(): AgentDef[] {
  const settings = useServer()
  return list<AgentDef>(useApiQuery<AgentDef[]>(agentsKey(settings), "/api/agents", {
    staleTime: CATALOG_STALE_MS,
  }).data)
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

/** One model appended to a profile's catalog, for the composer's model menu
    (`POST /api/profiles/:id/models`). A dedicated route for the same reason
    the flags PATCH is one — see `useSetProfileFlags`. */
export function useAddProfileModel() {
  const settings = useServer()
  return useApiMutation<{ profileId: string; id: string; label: string }, Profile>(
    [profilesKey(settings), agentsKey(settings)],
    (s, { profileId, ...model }) =>
      api<Profile>(s, `/api/profiles/${encodeURIComponent(profileId)}/models`, {
        method: "POST",
        body: JSON.stringify(model),
      }),
  )
}

/** Every project on this server. Deliberately *not* narrowed to the active
    space: the same list is what a thread's project name, the project page and
    the "does this project still exist" guard are read through, and a space
    filter would hide the very row they are looking for. The readers that *are*
    about the space in front of you filter this list themselves. */
export function useProjects(): Project[] {
  const settings = useServer()
  return list<Project>(useApiQuery<Project[]>(projectsKey(settings), "/api/projects", {
    staleTime: CATALOG_STALE_MS,
  }).data)
}

/** The spaces this server holds, in their switcher order. */
export function useSpaces(): Space[] {
  const settings = useServer()
  return list<Space>(useApiQuery<Space[]>(spacesKey(settings), "/api/spaces", {
    staleTime: CATALOG_STALE_MS,
  }).data)
}

/**
 * The space the app is showing: this device's choice when it names one of the
 * server's spaces, else the first. The fallback is *adopted* on read, so a
 * device that has never chosen — and one whose chosen space was deleted on
 * another device — lands on a space that exists rather than on nothing.
 */
export function useActiveSpace(): {
  spaces: Space[]
  id: string | null
  active: Space | null
  setActive: (id: string) => void
} {
  const settings = useServer()
  const spaces = useSpaces()
  const chosen = useActiveSpaceId(settings.id)
  const active = spaces.find((s) => s.id === chosen) ?? spaces[0] ?? null
  React.useEffect(() => {
    if (active && active.id !== chosen) setActiveSpace(settings.id, active.id)
  }, [active, chosen, settings.id])
  return {
    spaces,
    id: active?.id ?? null,
    active,
    setActive: React.useCallback((id: string) => setActiveSpace(settings.id, id), [settings.id]),
  }
}

/** A new space. It lands at the end of the switcher; the caller usually makes
    it the active one straight after — so it is written into the cache before
    the mutation resolves. The invalidation alone refetches *after*, and
    `useActiveSpace` would read the new id as a deleted one and adopt the
    first space in its place. */
export function useCreateSpace() {
  const settings = useServer()
  const qc = useQueryClient()
  return useApiMutation<{ name: string }, Space>(
    [spacesKey(settings)],
    (s, input) => api<Space>(s, "/api/spaces", { method: "POST", body: JSON.stringify(input) }),
    (space) => qc.setQueryData<Space[]>(spacesKey(settings), (old) => [...(old ?? []), space])
  )
}

export function useUpdateSpace() {
  const settings = useServer()
  return useApiMutation<{ id: string; name: string }, Space>([spacesKey(settings)], (s, { id, ...input }) =>
    api<Space>(s, `/api/spaces/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) })
  )
}

export function useDeleteSpace() {
  const settings = useServer()
  return useApiMutation<{ id: string }, { ok: boolean }>([spacesKey(settings), projectsKey(settings)], (s, { id }) =>
    /* Projects too: a project also filed elsewhere loses this membership. */
    api<{ ok: boolean }>(s, `/api/spaces/${encodeURIComponent(id)}`, { method: "DELETE" })
  )
}

export function useMcpServers(): McpServerDef[] {
  const settings = useServer()
  return list<McpServerDef>(useApiQuery<McpServerDef[]>(mcpServersKey(settings), "/api/mcp-servers", {
    staleTime: CATALOG_STALE_MS,
  }).data)
}

/**
 * What one MCP server advertises — tools, prompts and resources.
 *
 * The one catalog read, shared by the library row's reading and the server's
 * own page, so opening the page draws what the list already knew rather than
 * connecting again. The whole query is returned, not just the data: both
 * callers draw the failure and the in-flight state.
 *
 * `staleTime: Infinity` because the listing already expires server-side
 * (`mcp_catalog`'s TTL) — refetching on a tab switch would spend a connect to
 * be told the same thing. The Check button is the live door.
 */
export function useMcpCatalog(id: string, enabled = true) {
  const settings = useServer()
  return useApiQuery<McpCheckResult>(mcpCatalogKey(settings, id), `/api/mcp-servers/${id}/catalog`, {
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
    enabled,
  })
}

/**
 * The MCP servers a thread's agent was handed, with the prompts and resources
 * each offers — what the composer's `/` and `@` menus draw from. Read from the
 * server's stored listings, so it costs no connect while they are fresh; off
 * for a draft, which has no links the server knows of yet.
 */
export function useThreadMcp(sessionId: string, enabled: boolean): ThreadMcpServer[] {
  const settings = useServer()
  return list<ThreadMcpServer>(useApiQuery<ThreadMcpServer[]>(threadMcpKey(settings, sessionId), `/api/sessions/${sessionId}/mcp`, {
    enabled,
    staleTime: CATALOG_STALE_MS,
    refetchOnWindowFocus: false,
    retry: false,
  }).data)
}

export function useSkills(): SkillDef[] {
  const settings = useServer()
  return list<SkillDef>(useApiQuery<SkillDef[]>(skillsKey(settings), "/api/skills", {
    staleTime: CATALOG_STALE_MS,
  }).data)
}

/** The `SKILL.md` a thread's skill-load row loaded, read server-side by name. */
export function useSkillContent(sessionId: string, name: string, enabled: boolean): string {
  const settings = useServer()
  return (
    useApiQuery<{ content: string }>(
      skillsKey(settings).concat([sessionId, name, "content"]),
      `/api/sessions/${sessionId}/skills/${encodeURIComponent(name)}/content`,
      { enabled: enabled && !!sessionId, staleTime: CATALOG_STALE_MS, retry: false }
    ).data?.content ?? ""
  )
}

export function useCommands(): CommandDef[] {
  const settings = useServer()
  return list<CommandDef>(useApiQuery<CommandDef[]>(commandsKey(settings), "/api/commands", {
    staleTime: CATALOG_STALE_MS,
  }).data)
}

export function useModelPrompts(): ModelPrompt[] {
  const settings = useServer()
  return list<ModelPrompt>(useApiQuery<ModelPrompt[]>(modelPromptsKey(settings), "/api/model-prompts", {
    staleTime: CATALOG_STALE_MS,
  }).data)
}

/** A single rule row. */
export interface Rule {
  id: string
  projectId: string | null
  title: string
  content: string
  sortOrder: number
  createdAt: number
  updatedAt: number
}

/** All global rules. */
export function useRules(): Rule[] {
  const settings = useServer()
  return list<Rule>(
    useApiQuery<Rule[]>(rulesKey(settings), "/api/rules", { staleTime: CATALOG_STALE_MS }).data,
  )
}

/** Project rules for a given project; parked while there is no saved project. */
export function useProjectRules(projectId: string | null): Rule[] {
  const settings = useServer()
  return list<Rule>(
    useApiQuery<Rule[]>(
      rulesKey(settings).concat([projectId ?? ""]),
      projectId ? `/api/rules/project/${projectId}` : "",
      { enabled: Boolean(projectId), staleTime: CATALOG_STALE_MS },
    ).data,
  )
}

/** Create a new rule. */
export function useCreateRule() {
  const settings = useServer()
  return useApiMutation<{ projectId: string | null; title: string; content: string }, Rule>(
    [rulesKey(settings)],
    (s, input) => api(s, "/api/rules", { method: "POST", body: JSON.stringify(input) }),
  )
}

/** Update an existing rule. */
export function useUpdateRule() {
  const settings = useServer()
  return useApiMutation<{ id: string; title?: string; content?: string; sortOrder?: number }, Rule>(
    [rulesKey(settings)],
    (s, input) => api(s, `/api/rules/${input.id}`, { method: "PUT", body: JSON.stringify(input) }),
  )
}

/** Delete a rule. */
export function useDeleteRule() {
  const settings = useServer()
  return useApiMutation<{ id: string }, { ok: boolean }>(
    [rulesKey(settings)],
    (s, input) => api(s, `/api/rules/${input.id}`, { method: "DELETE" }),
  )
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
  | "model-prompts"

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
