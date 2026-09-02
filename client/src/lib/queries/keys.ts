/* Query-key grammar. Every key is prefixed with the server's id (`scope`), so
   an invalidation or a stale read can never cross a connection even if a
   component forgot which server it is on. This used to be belt-and-braces on
   top of a hard reload — but a key that is only safe because of a reload is not
   safe, and switching servers is a state change now (see `switchServer` in
   App.tsx), which is the case this was written for.

   Keys are built by the helpers here and nowhere else, the way chord strings
   are built by lib/shortcuts: a hand-typed key in a component is an
   invalidation that silently matches nothing. */
import type { ServerSettings } from "@/lib/settings"

/** The per-connection prefix every key starts with. */
export const scope = (settings: ServerSettings): readonly unknown[] => ["srv", settings.id]

/* Catalog (Phase 4 moves these out of the reducer). */
export const profilesKey = (s: ServerSettings) => scope(s).concat(["profiles"])
export const agentsKey = (s: ServerSettings) => scope(s).concat(["agents"])
export const projectsKey = (s: ServerSettings) => scope(s).concat(["projects"])
export const mcpServersKey = (s: ServerSettings) => scope(s).concat(["mcp-servers"])
export const skillsKey = (s: ServerSettings) => scope(s).concat(["skills"])
export const commandsKey = (s: ServerSettings) => scope(s).concat(["commands"])
export const personasKey = (s: ServerSettings) => scope(s).concat(["personas"])

/* Automations (Phase 3 moves these out of the reducer). */
export const scheduledKey = (s: ServerSettings) => scope(s).concat(["scheduled"])
export const routinesKey = (s: ServerSettings) => scope(s).concat(["routines"])
export const routineRunsKey = (s: ServerSettings, routineId: string, limit?: number) =>
  scope(s).concat(["routine-runs", routineId, limit ?? "all"])
/** The prefix every runs key hangs off — for invalidating a routine's runs
    without naming the routine (a delete cascades them all). */
export const allRoutineRunsKey = (s: ServerSettings) => scope(s).concat(["routine-runs"])
export const routineTriggersKey = (s: ServerSettings, routineId: string) =>
  scope(s).concat(["routine-triggers", routineId])

/* Ad-hoc read surfaces (Phase 2). */
export const projectStatsKey = (s: ServerSettings, projectId: string) =>
  scope(s).concat(["project-stats", projectId])
export const allQuotaKey = (s: ServerSettings) => scope(s).concat(["quota", "all"])
export const agentQuotaKey = (s: ServerSettings, agentId: string, profileId?: string) =>
  scope(s).concat(["quota", agentId, profileId ?? ""])
export const profileQuotaKey = (s: ServerSettings, profileId: string) =>
  scope(s).concat(["quota", "profile", profileId])
export const allKnowledgeKey = (s: ServerSettings) => scope(s).concat(["knowledge", "all"])
export const projectKnowledgeKey = (s: ServerSettings, projectId: string) =>
  scope(s).concat(["knowledge", "project", projectId])
export const boardsKey = (s: ServerSettings) => scope(s).concat(["boards"])
export const tasksKey = (s: ServerSettings) => scope(s).concat(["tasks"])
export const notificationsKey = (s: ServerSettings) => scope(s).concat(["notifications"])
export const agentOptionsKey = (s: ServerSettings, profileId: string, agentId: string, projectId?: string | null) =>
  scope(s).concat(["agent-options", profileId, agentId, projectId ?? ""])
