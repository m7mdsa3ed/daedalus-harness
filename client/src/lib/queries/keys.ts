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
/** The spaces this server holds (`GET /api/spaces`). Which one is active is
    device-local and not part of the key: the list is the same whichever you are
    in. */
export const spacesKey = (s: ServerSettings) => scope(s).concat(["spaces"])
/** The repositories a project can see (`GET …/git/repos`) — asked by the
    draft's worktree toggle, which needs only whether the project is one. */
export const gitReposKey = (s: ServerSettings, projectId: string) =>
  scope(s).concat(["git-repos", projectId])
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
/* Under the MCP family, so a catalog refresh (Check) invalidates what every
   composer offers from the same listing. */
export const threadMcpKey = (s: ServerSettings, sessionId: string) => mcpServersKey(s).concat(["thread", sessionId])
export const skillsKey = (s: ServerSettings) => scope(s).concat(["skills"])
export const commandsKey = (s: ServerSettings) => scope(s).concat(["commands"])
export const modelPromptsKey = (s: ServerSettings) => scope(s).concat(["model-prompts"])
/** The rules list (`GET /api/rules`) and individual rule CRUD. */
export const rulesKey = (s: ServerSettings) => scope(s).concat(["rules"])
/** A side lane's chosen (profile, model) — the composer's completion lane and
    the decision lane (`GET /api/fim`, `GET /api/decision`). Shared by every
    device, because the value belongs to the install. */
export const sideModelKey = (s: ServerSettings, lane: string) => scope(s).concat(["side-model", lane])
/** The model-role vocabulary (`GET /api/model-roles`) and its CRUD. */
export const modelRolesKey = (s: ServerSettings) => scope(s).concat(["model-roles"])
/** The coding-plan presets a new profile starts from — read once per session,
    since the list is the server build's and the catalogs are models.dev's. */
export const profilePresetsKey = (s: ServerSettings) => scope(s).concat(["profile-presets"])
/** A server's contract numbers (`GET /api/health`, unauthenticated), read by
    the compatibility gate for the active server and by the server menu for
    every stored one — so the key takes the server it is about, not the active. */
export const healthKey = (s: ServerSettings) => scope(s).concat(["health"])
/** The deployment's app version and parsed changelog (`GET /api/meta`). */
export const appMetaKey = (s: ServerSettings) => scope(s).concat(["app-meta"])
/** A pasted link's title and mark, the composer chip's (`GET /api/link-preview`).
    Keyed by URL, so two of the same link cost one fetch. */
export const linkPreviewKey = (s: ServerSettings, url: string) =>
  scope(s).concat(["link-preview", url])

/* Automations: one family. A routine is the row; the UI calls it an automation. */
export const automationsKey = (s: ServerSettings) => scope(s).concat(["automations"])
export const automationRunsKey = (s: ServerSettings, routineId: string, limit?: number) =>
  scope(s).concat(["automation-runs", routineId, limit ?? "all"])
/** Every read of one routine's runs whatever its `limit` — the list page reads
    the newest run alone, the detail page reads them all, and a fire or a stop
    goes stale for both. Mutations invalidate this, never one limit's key. */
export const automationRunsFamilyKey = (s: ServerSettings, routineId: string) =>
  scope(s).concat(["automation-runs", routineId])
/** The prefix every runs key hangs off — for invalidating a routine's runs
    without naming the routine (a delete cascades them all). */
export const allAutomationRunsKey = (s: ServerSettings) => scope(s).concat(["automation-runs"])
/** How many runs nobody has read (`GET /api/routines/runs/unread`) — under the
    runs prefix, so a routine's delete (which cascades its runs) takes it too.
    "unread" can never be a routine id: those are UUIDs. */
export const unreadAutomationRunsKey = (s: ServerSettings) =>
  scope(s).concat(["automation-runs", "unread"])
export const automationTriggersKey = (s: ServerSettings, routineId: string) =>
  scope(s).concat(["automation-triggers", routineId])

/* Ad-hoc read surfaces (Phase 2). */
export const projectStatsKey = (s: ServerSettings, projectId: string) =>
  scope(s).concat(["project-stats", projectId])
/** One directory of a project's working tree (`GET …/tree?path=`), read by the
    Preview panel's explorer. The flags are part of a leaf key because they
    change the answer; the family prefix is what a watch event invalidates, so
    only the directories actually on screen are re-read. */
export const projectTreeFamilyKey = (s: ServerSettings, projectId: string) =>
  scope(s).concat(["project-tree", projectId])
export const projectTreeKey = (
  s: ServerSettings,
  projectId: string,
  path: string,
  flags: { hidden: boolean; ignored: boolean }
) =>
  projectTreeFamilyKey(s, projectId).concat([
    path,
    flags.hidden ? "hidden" : "-",
    flags.ignored ? "ignored" : "-",
  ])
export const projectReposKey = (s: ServerSettings, projectId: string) =>
  scope(s).concat(["project-repos", projectId])
export const projectGitStatusKey = (s: ServerSettings, projectId: string, repo: string) =>
  scope(s).concat(["project-git-status", projectId, repo])
export const projectGitLogKey = (s: ServerSettings, projectId: string, repo: string) =>
  scope(s).concat(["project-git-log", projectId, repo])
export const projectGitBranchesKey = (s: ServerSettings, projectId: string, repo: string) =>
  scope(s).concat(["project-git-branches", projectId, repo])
export const projectGitRefsKey = (s: ServerSettings, projectId: string, repo: string) =>
  scope(s).concat(["project-git-refs", projectId, repo])
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
/** Branch and uncommitted line counts per thread (`GET /api/sessions/git-summary`). */
export const gitSummaryKey = (s: ServerSettings) => scope(s).concat(["git-summary"])
/** Every prompt this server has been sent, newest first — global across
    threads, which is why it hangs off the connection and not off a session.
    Persisted with the rest of the cache on purpose: Up must answer on the
    keystroke, so the list has to be in hand before the first read lands. */
export const composerHistoryKey = (s: ServerSettings) => scope(s).concat(["composer-history"])
export const agentOptionsKey = (s: ServerSettings, profileId: string, agentId: string, projectId?: string | null) =>
  scope(s).concat(["agent-options", profileId, agentId, projectId ?? ""])
/** A folder of the file library (`GET /api/files?parent=`); `null` is the root.
    One family, so a write invalidates every open level of the tree at once. */
export const filesKey = (s: ServerSettings, parentId?: string | null) =>
  scope(s).concat(parentId === undefined ? ["files"] : ["files", parentId ?? "root"])
/** A thread's model-call ledger (`GET /api/sessions/:id/calls`) — the Trace
    panel's cold read; the socket files the live ones. */
export const sessionCallsKey = (s: ServerSettings, sessionId: string) => scope(s).concat(["calls", sessionId])
/** Spend across threads, grouped (`GET /api/usage/calls?groupBy=`). */
export const spendKey = (s: ServerSettings, groupBy: string) => scope(s).concat(["spend", groupBy])
/** One harness workflow run's folded view (`GET /api/sessions/:id/workflows/:runId`):
    gates, state, artifacts, logs and budget meters — what the transcript's step
    rows cannot carry. */
export const workflowRunKey = (s: ServerSettings, sessionId: string, runId: string) =>
  scope(s).concat(["workflow-run", sessionId, runId])
/** The saved-workflow library of one project (`GET /api/workflows/saved?projectId=`);
    the family prefix is what a save or a delete invalidates. */
export const savedWorkflowsFamilyKey = (s: ServerSettings) => scope(s).concat(["saved-workflows"])
export const savedWorkflowsKey = (s: ServerSettings, projectId: string) =>
  savedWorkflowsFamilyKey(s).concat([projectId])
