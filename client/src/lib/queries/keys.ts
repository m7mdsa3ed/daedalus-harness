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
/** Whether each agent's binary is installed and what version answers
    (`GET /api/agents/status`) — a reading about this machine, not a row. */
export const agentsStatusKey = (s: ServerSettings) => scope(s).concat(["agents-status"])
export const projectsKey = (s: ServerSettings) => scope(s).concat(["projects"])
export const mcpServersKey = (s: ServerSettings) => scope(s).concat(["mcp-servers"])
export const skillsKey = (s: ServerSettings) => scope(s).concat(["skills"])
export const commandsKey = (s: ServerSettings) => scope(s).concat(["commands"])
export const personasKey = (s: ServerSettings) => scope(s).concat(["personas"])
/** The coding-plan presets a new profile starts from — read once per session,
    since the list is the server build's and the catalogs are models.dev's. */
export const profilePresetsKey = (s: ServerSettings) => scope(s).concat(["profile-presets"])

/* Automations (Phase 3 moves these out of the reducer). */
export const scheduledKey = (s: ServerSettings) => scope(s).concat(["scheduled"])
export const routinesKey = (s: ServerSettings) => scope(s).concat(["routines"])
export const routineRunsKey = (s: ServerSettings, routineId: string, limit?: number) =>
  scope(s).concat(["routine-runs", routineId, limit ?? "all"])
/** Every read of one routine's runs whatever its `limit` — the list page reads
    the newest run alone, the detail page reads them all, and a fire or a stop
    goes stale for both. Mutations invalidate this, never one limit's key. */
export const routineRunsFamilyKey = (s: ServerSettings, routineId: string) =>
  scope(s).concat(["routine-runs", routineId])
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
/** One task's comments, activity, links and children. Without an id it is the
    prefix every detail hangs off — for invalidating them all after a bulk edit. */
export const taskDetailKey = (s: ServerSettings, taskId?: string) =>
  taskId === undefined ? scope(s).concat(["task-detail"]) : scope(s).concat(["task-detail", taskId])
export const notificationsKey = (s: ServerSettings) => scope(s).concat(["notifications"])
/** Every prompt this server has been sent, newest first — global across
    threads, which is why it hangs off the connection and not off a session.
    Persisted with the rest of the cache on purpose: Up must answer on the
    keystroke, so the list has to be in hand before the first read lands. */
export const composerHistoryKey = (s: ServerSettings) => scope(s).concat(["composer-history"])
export const agentOptionsKey = (s: ServerSettings, profileId: string, agentId: string, projectId?: string | null) =>
  scope(s).concat(["agent-options", profileId, agentId, projectId ?? ""])

/* App builder (the starters, and each project's dev server). The dev status
   is the one key in this file that must never be persisted: it carries a
   per-boot preview key, and it is a process state that is wrong the moment
   the page is closed — see `meta.persist` in `queries/dev-server.ts`. */
export const templatesKey = (s: ServerSettings) => scope(s).concat(["templates"])
export const devStatusKey = (s: ServerSettings, projectId: string) =>
  scope(s).concat(["dev-status", projectId])
/** The project's commits — the preview's History drawer. Refetched on the
    file watcher's say-so and after every checkpoint/restore, never persisted:
    a list of restore points that is a day stale is worse than a spinner. */
export const projectHistoryKey = (s: ServerSettings, projectId: string) =>
  scope(s).concat(["project-history", projectId])
