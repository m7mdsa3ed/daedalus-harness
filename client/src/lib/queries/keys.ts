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
/** The scripts a project's package.json files declare, read off the disk —
    suggested by the composer's `!` completer, so its staleness is a
    suggestion's, not a catalog's. */
export const projectScriptsKey = (s: ServerSettings, projectId: string) =>
  scope(s).concat(["project-scripts", projectId])
/** The `!` lines a project keeps running, most used first — the completer's
    third list, and the one the server tallies as lines run. Invalidated by
    the run itself, so it is fresh on the menu that follows it. */
export const shellHistoryKey = (s: ServerSettings, projectId: string) =>
  scope(s).concat(["shell-history", projectId])
export const mcpServersKey = (s: ServerSettings) => scope(s).concat(["mcp-servers"])
/** What one MCP server advertises. Under the servers key, so invalidating the
    library takes every listing with it. */
export const mcpCatalogKey = (s: ServerSettings, id: string) => mcpServersKey(s).concat(["catalog", id])
export const skillsKey = (s: ServerSettings) => scope(s).concat(["skills"])
export const commandsKey = (s: ServerSettings) => scope(s).concat(["commands"])
export const personasKey = (s: ServerSettings) => scope(s).concat(["personas"])
export const modelPromptsKey = (s: ServerSettings) => scope(s).concat(["model-prompts"])
/** The rules list (`GET /api/rules`) and individual rule CRUD. */
export const rulesKey = (s: ServerSettings) => scope(s).concat(["rules"])
/** The coding-plan presets a new profile starts from — read once per session,
    since the list is the server build's and the catalogs are models.dev's. */
export const profilePresetsKey = (s: ServerSettings) => scope(s).concat(["profile-presets"])
/** The deployment's app version and parsed changelog (`GET /api/meta`). */
export const appMetaKey = (s: ServerSettings) => scope(s).concat(["app-meta"])

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
export const projectReposKey = (s: ServerSettings, projectId: string) =>
  scope(s).concat(["project-repos", projectId])
export const projectGitStatusKey = (s: ServerSettings, projectId: string, repo: string) =>
  scope(s).concat(["project-git-status", projectId, repo])
export const projectGitLogKey = (s: ServerSettings, projectId: string, repo: string) =>
  scope(s).concat(["project-git-log", projectId, repo])
export const projectGitBranchesKey = (s: ServerSettings, projectId: string, repo: string) =>
  scope(s).concat(["project-git-branches", projectId, repo])
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
/** Every question a live agent is blocked on, across threads (`GET /api/pending`). */
export const pendingKey = (s: ServerSettings) => scope(s).concat(["pending"])
/** Every prompt this server has been sent, newest first — global across
    threads, which is why it hangs off the connection and not off a session.
    Persisted with the rest of the cache on purpose: Up must answer on the
    keystroke, so the list has to be in hand before the first read lands. */
export const composerHistoryKey = (s: ServerSettings) => scope(s).concat(["composer-history"])
export const agentOptionsKey = (s: ServerSettings, profileId: string, agentId: string, projectId?: string | null) =>
  scope(s).concat(["agent-options", profileId, agentId, projectId ?? ""])
/** The raw journaled events of one thread, as `GET /api/sessions/:id/trace`
    pages them (newest page first). One key per thread — the pages of a long
    tail are near-static history, invalidated rather than refetched. */
export const threadTraceKey = (s: ServerSettings, sessionId: string) =>
  scope(s).concat(["thread-trace", sessionId])

