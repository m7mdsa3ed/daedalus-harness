/* Query hooks for the ad-hoc read surfaces — the ones that used to be a local
   useState/useEffect pair or a module-level store, each with its own loading
   flag, its own refresh button and its own idea of when to re-read. One hook
   family now owns each, with the freshness bargain from client.ts: cached
   data answered instantly, refreshed when stale or on window focus. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { errorText } from "@/lib/errors"
import { navigateTo, threadPath } from "@/lib/router"
import { fetchAllQuota, fetchProfileQuota, fetchQuota, type QuotaSnapshot } from "@/lib/quota"
import type { AppNotification } from "@/lib/notifications-inbox"
import { clearInbox, markRead } from "@/lib/notifications-inbox"
import {
  clearComposerHistory,
  recordComposerHistory,
  type ComposerHistoryEntry,
  type ComposerHistoryState,
} from "@/lib/composer-history"
import type { Project, ServerSettings } from "@/lib/settings"
import { api } from "@/lib/settings"
import { useServer } from "@/lib/server-context"

/* ── App meta ──
   The deployment's version and changelog, for Settings › General's About
   group. `staleTime` rather than the default because the answer only changes
   on a deploy, and the settings page reads it on every mount. */
export type ChangelogEntry = { version: string; date: string | null; markdown: string }
export type AppMeta = { version: string; changelog: ChangelogEntry[] }

export function useAppMeta() {
  const settings = useServer()
  return useApiQuery<AppMeta>(appMetaKey(settings), "/api/meta", { staleTime: 5 * 60_000 })
}
import {
  addKnowledge,
  deleteKnowledge,
  listAllKnowledge,
  listKnowledge,
  type KnowledgeEntry,
  type KnowledgeEntryAcross,
} from "@/lib/workspace/knowledge-api"
import { fetchProjectStats, type ProjectStats } from "@/lib/workspace/project-stats"
import type { BranchList, GitCommit, GitRepo, GitStatus } from "@/lib/workspace/git-api"
import {
  addHelper,
  deleteHelper,
  updateHelper,
  type HelperInput,
} from "@/lib/workspace/project-helpers"
import type { HelperCommand } from "@/lib/settings"
import type { ProjectScript, ShellUse } from "@/lib/workspace/project-helpers"
import {
  agentQuotaKey,
  allKnowledgeKey,
  allQuotaKey,
  appMetaKey,
  composerHistoryKey,
  notificationsKey,
  projectKnowledgeKey,
  projectGitBranchesKey,
  projectGitLogKey,
  projectGitStatusKey,
  projectReposKey,
  projectScriptsKey,
  projectStatsKey,
  projectsKey,
  profileQuotaKey,
  shellHistoryKey,
} from "./keys"
import { useApiMutation, useApiQuery } from "./helpers"

// ---- project overview ----

/** The settled half of a project's page. Same shape the page's local hook
    used to return, so the drawing code did not change — but the cache owns
    the fetch, the focus refetch and the abort now, and Refresh is a refetch
    instead of a nonce that re-ran an effect. */
export function useProjectStats(projectId: string) {
  const settings = useServer()
  const query = useApiQuery<ProjectStats>(
    projectStatsKey(settings, projectId),
    `/api/projects/${encodeURIComponent(projectId)}/stats`
  )
  return {
    stats: query.data ?? null,
    error: query.error ? errorText(query.error) : null,
    loading: query.isPending,
    refresh: () => void query.refetch(),
  }
}

/** Every repository under the project (its own first, then one walk down its
    subdirectories) with each one's branch. The server's `git/repos` already
    answers exactly that, so the page just reads it; `staleTime` because a
    branch changes on a checkout, not on a render. */
export function useProjectRepos(projectId: string) {
  return useApiQuery<GitRepo[]>(
    projectReposKey(useServer(), projectId),
    `/api/projects/${encodeURIComponent(projectId)}/git/repos`,
    { staleTime: 30_000 }
  )
}

/** The scripts a project's own package.json files declare (root and one
    directory deep), read off the disk and never stored — the `!`
    completer's second suggestion list, beside the saved helpers. Not asked
    for on a draft, which is offered no `!` line at all, and stale for the
    same minute the catalog is: a script list is a suggestion, not a row. */
export function useProjectScripts(projectId: string, enabled = true) {
  return useApiQuery<ProjectScript[]>(
    projectScriptsKey(useServer(), projectId),
    `/api/projects/${encodeURIComponent(projectId)}/scripts`,
    { enabled, staleTime: 60_000 }
  )
}

/** What this project's `!` lines are, most used first — the completer's third
    list. The server tallies it as lines run (`POST /api/sessions/:id/shell`),
    so nothing here writes; `useInvalidateShellHistory` is what the run calls
    to put the line it just ran at the top of the next menu. */
export function useShellHistory(projectId: string, enabled = true) {
  return useApiQuery<ShellUse[]>(
    shellHistoryKey(useServer(), projectId),
    `/api/projects/${encodeURIComponent(projectId)}/shell-history`,
    { enabled, staleTime: 60_000 }
  )
}

export function useInvalidateShellHistory() {
  const client = useQueryClient()
  const server = useServer()
  return (projectId: string) =>
    void client.invalidateQueries({ queryKey: shellHistoryKey(server, projectId) })
}

/** One repository's working set. Asked for by the surfaces that act on a
    repository rather than list them — the composer's, which only opens it when
    the popover does, hence `enabled`. */
export function useGitStatus(projectId: string, repo: string, enabled = true) {
  const search = repo ? `?repo=${encodeURIComponent(repo)}` : ""
  return useApiQuery<GitStatus>(
    projectGitStatusKey(useServer(), projectId, repo),
    `/api/projects/${encodeURIComponent(projectId)}/git/status${search}`,
    { enabled }
  )
}

/** The newest commits on one repository. `limit` is the caller's, because the
    surfaces asking differ by an order of magnitude — a glance in the composer's
    popover is five, the panel's history is a page. */
export function useGitLog(projectId: string, repo: string, limit: number, enabled = true) {
  const search = new URLSearchParams({ limit: String(limit) })
  if (repo) search.set("repo", repo)
  return useApiQuery<GitCommit[]>(
    projectGitLogKey(useServer(), projectId, repo).concat([limit]),
    `/api/projects/${encodeURIComponent(projectId)}/git/log?${search.toString()}`,
    { enabled }
  )
}

/** One repository's local branches and which one is checked out. Read when a
    surface offers the switch, not with the status: a branch list is a menu's
    worth of work that a reader who never opens the menu should not pay for —
    the same bargain the source-control panel's own branch menu makes. */
export function useGitBranches(projectId: string, repo: string, enabled = true) {
  const search = repo ? `?repo=${encodeURIComponent(repo)}` : ""
  return useApiQuery<BranchList>(
    projectGitBranchesKey(useServer(), projectId, repo),
    `/api/projects/${encodeURIComponent(projectId)}/git/branches${search}`,
    { enabled }
  )
}

// ---- subscription quota ----

/* The server's own quota cache is minutes deep, so a reading is stale long
   before React Query's default would re-ask. */

/** Every reading the machine can take, in one call.

    The Usage page no longer draws from this: its cards come from the catalog and
    each takes its own reading, so a provider that is slow holds up its own card
    and no one else's. What is left here is the two things a list is still good
    for — the **seed** (a card whose reading this already took is drawn from it
    without asking again) and **Refresh all**, which is one bypass of the
    server's cache rather than N. The server caches these; `?refresh=1` is its
    bypass and stays a write (a mutation that rewrites the cache) rather than a
    second key. */
export function useAllQuotaQuery() {
  const settings = useServer()
  const query = useQuery({
    queryKey: allQuotaKey(settings),
    queryFn: ({ signal }) => fetchAllQuota(settings, false, signal),
    staleTime: quotaFreshnessMs,
  })
  const qc = useQueryClient()
  const reload = useMutation({
    mutationFn: (refresh: boolean) => fetchAllQuota(settings, refresh),
    onSuccess: (data) => {
      qc.setQueryData(allQuotaKey(settings), data)
      /* And onto the per-card keys, or "Refresh all" would rewrite a list
         nothing draws from while every card kept the reading it took for
         itself. A reading names its own ids, so it is its own key. */
      for (const quota of data) {
        qc.setQueryData(
          quota.source === "profile"
            ? profileQuotaKey(settings, quota.profileId)
            : agentQuotaKey(settings, quota.agentId, quota.profileId),
          quota
        )
      }
    },
  })
  return {
    quotas: query.data ?? null,
    busy: reload.isPending,
    error: query.error,
    reload: (refresh = false) => reload.mutate(refresh),
  }
}

/** One (agent, profile) reading. Seeded from the list route's cache when it
    is the reading that list already took (the agent's Default), so opening a
    card costs nothing; any other profile is a reading nobody has taken yet
    and this query takes it. */
export function useAgentQuota(agentId: string, profileId: string, seed?: QuotaSnapshot | null) {
  const settings = useServer()
  const qc = useQueryClient()
  const seeded = seed != null && seed.profileId === profileId && seed.agentId === agentId
  const query = useQuery({
    queryKey: agentQuotaKey(settings, agentId, profileId),
    queryFn: ({ signal }) => fetchQuota(settings, agentId, { profileId, signal }),
    enabled: Boolean(agentId && profileId),
    initialData: seeded ? seed : undefined,
    initialDataUpdatedAt: seeded ? Date.now() - quotaFreshnessMs : undefined,
    staleTime: quotaFreshnessMs,
  })
  const refresh = useMutation({
    mutationFn: () => fetchQuota(settings, agentId, { profileId, refresh: true }),
    onSuccess: (data) => {
      qc.setQueryData(agentQuotaKey(settings, agentId, profileId), data)
      patchQuotaIn(qc, settings, data)
    },
  })
  return {
    quota: query.data ?? seed ?? null,
    /* The card draws its own failure: with every card reading on its own, a
       provider that cannot be reached is one empty card rather than a page that
       never loads, and an empty card that never says why is the same lie as an
       empty one that claims "no plan". The retry is this query's own refetch
       rather than the Refresh button's bypass, so a second failure lands in the
       same `error` the card is already drawing. */
    error: query.error ?? null,
    refetch: () => void query.refetch(),
    busy: refresh.isPending,
    refresh: () => refresh.mutate(),
  }
}

/** One profile's provider plan. Seeded from the list route the same way. */
export function useProfileQuota(profileId: string, seed?: QuotaSnapshot | null) {
  const settings = useServer()
  const qc = useQueryClient()
  const seeded = seed != null && seed.profileId === profileId
  const query = useQuery({
    queryKey: profileQuotaKey(settings, profileId),
    queryFn: ({ signal }) => fetchProfileQuota(settings, profileId, false, signal),
    enabled: Boolean(profileId),
    initialData: seeded ? seed : undefined,
    initialDataUpdatedAt: seeded ? Date.now() - quotaFreshnessMs : undefined,
    staleTime: quotaFreshnessMs,
  })
  const refresh = useMutation({
    mutationFn: () => fetchProfileQuota(settings, profileId, true),
    onSuccess: (data) => {
      qc.setQueryData(profileQuotaKey(settings, profileId), data)
      patchQuotaIn(qc, settings, data)
    },
  })
  return {
    quota: query.data ?? seed ?? null,
    error: query.error ?? null,
    refetch: () => void query.refetch(),
    busy: refresh.isPending,
    refresh: () => refresh.mutate(),
  }
}

const quotaFreshnessMs = 60_000

/** Keep the list route's entry for this reading in step, so a card refreshed
    alone does not read as stale the moment the page re-renders from `all`. */
function patchQuotaIn(
  qc: ReturnType<typeof useQueryClient>,
  settings: ServerSettings,
  next: QuotaSnapshot
) {
  qc.setQueryData<QuotaSnapshot[]>(allQuotaKey(settings), (prev) =>
    prev
      ? prev.map((q) =>
          q.agentId === next.agentId && q.profileId === next.profileId ? next : q
        )
      : prev
  )
}

// ---- knowledge base ----

/** Every entry across every project — Settings › Knowledge base. */
export function useAllKnowledge() {
  const settings = useServer()
  return useApiQuery<KnowledgeEntryAcross[]>(allKnowledgeKey(settings), "/api/knowledge", {
    staleTime: 60_000,
  })
}

/** One project's entries — the project form's section. */
export function useProjectKnowledge(projectId: string | null) {
  const settings = useServer()
  return useApiQuery<KnowledgeEntry[]>(
    projectKnowledgeKey(settings, projectId ?? ""),
    projectId
      ? `/api/projects/${encodeURIComponent(projectId)}/knowledge`
      : // Never hit; `enabled` keeps the query parked while no project is open.
        "",
    { enabled: Boolean(projectId), staleTime: 60_000 }
  )
}

/* A knowledge write lands in the cross-project list, the project's own list
   and the project's stats (its `knowledge` count) — all derived from the same
   rows, so all three go stale together. */
function useKnowledgeKeys() {
  const settings = useServer()
  return (projectId: string) => [
    allKnowledgeKey(settings),
    projectKnowledgeKey(settings, projectId),
    projectStatsKey(settings, projectId),
  ]
}

export function useAddKnowledge() {
  const keys = useKnowledgeKeys()
  return useApiMutation<
    { projectId: string; body: Parameters<typeof addKnowledge>[2] },
    KnowledgeEntry
  >(
    (_data, input) => keys(input.projectId),
    (settings, input) => addKnowledge(settings, input.projectId, input.body)
  )
}

export function useDeleteKnowledge() {
  const keys = useKnowledgeKeys()
  return useApiMutation<{ projectId: string; id: string }, { ok: boolean }>(
    (_data, input) => keys(input.projectId),
    (settings, input) => deleteKnowledge(settings, input.projectId, input.id)
  )
}

// ---- notification inbox ----

export interface Inbox {
  items: AppNotification[]
  unread: number
}

/** The inbox, live — the badge, the popover and the page read the same cache.
    staleTime 0: the number is only ever worth having when it is current, and
    refetchOnWindowFocus (the default) is what keeps a PWA that sits open for
    days honest without a poll — the same job the focus/visibility listeners
    in lib/notifications-inbox used to do by hand. */
export function useInbox() {
  const settings = useServer()
  const query = useApiQuery<Inbox>(notificationsKey(settings), "/api/notifications", {
    staleTime: 0,
  })
  return { inbox: query.data, isPending: query.isPending, refetch: () => void query.refetch() }
}

/** Mark one (or all) read. The server answers the authoritative unread count;
    the cache is patched rather than re-read — the rows' read flags follow the
    same rule the old store applied, and the count is the server's own. */
export function useMarkNotificationsRead() {
  const settings = useServer()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string | undefined) => markRead(settings, id),
    onSuccess: (result, id) => {
      qc.setQueryData<Inbox>(notificationsKey(settings), (prev) =>
        prev
          ? {
              unread: result.unread,
              items: id
                ? prev.items.map((n) => (n.id === id ? { ...n, read: true } : n))
                : prev.items.map((n) => ({ ...n, read: true })),
            }
          : prev
      )
    },
  })
}

/** Empty the inbox. Invalidates rather than patches — the server may also
    have aged rows out, and the next read should say what is actually there. */
export function useClearInbox() {
  const settings = useServer()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => clearInbox(settings),
    onSuccess: () => void qc.invalidateQueries({ queryKey: notificationsKey(settings) }),
  })
}

/** Open the thread a notice is about, and mark it read on the way — reading a
    notification from the inbox is the acknowledgement. */
export function useOpenNotification() {
  const mark = useMarkNotificationsRead()
  return (n: AppNotification) => {
    if (n.sessionId) navigateTo(threadPath(n.sessionId))
    if (!n.read) mark.mutate(n.id)
  }
}


// ---- the composer's prompt history ----

/** A row that can actually be recalled, or nothing.
 *
 * The list is read by three surfaces — the Up walk (which puts `text` back in
 * the composer), the history dialog, and the persisted cache that answers
 * before the first read — and all three take `text` for a string. A row without
 * one is not a prompt, and letting it through is how `setText` received an
 * `undefined` and the composer's caret math (`text.slice` in file-mentions)
 * threw on the next render. Normalized here, at the one place the list is read,
 * rather than defended at each reader — and it heals a cache an older build
 * wrote (the row is persisted) without waiting for the refetch to land. */
function isComposerHistoryEntry(entry: unknown): entry is ComposerHistoryEntry {
  const row = entry as Partial<ComposerHistoryEntry> | null
  return !!row && typeof row.id === "string" && typeof row.text === "string"
}

/**
 * Every prompt this server has been sent, newest first and global across
 * threads — what Up walks and what the history page lists.
 *
 * Read once and kept: unlike the inbox this has no badge to keep honest, and
 * the list only changes when *this* user sends something, which is a write
 * that patches the cache itself (`useRecordComposerHistory`). The staleness
 * that matters is another device's send, which window focus collects.
 *
 * The cache is the reason Up is instant. A keystroke cannot wait for a round
 * trip, so the recall list is whatever the persisted cache last held — it is
 * on screen before the first read answers, and the read only ever adds to it.
 */
export function useComposerHistory() {
  const settings = useServer()
  const query = useApiQuery<ComposerHistoryState>(composerHistoryKey(settings), "/api/composer-history")
  return {
    items: (query.data?.items ?? []).filter(isComposerHistoryEntry),
    isPending: query.isPending,
    refetch: () => void query.refetch(),
  }
}

/**
 * Record a prompt that has actually been sent.
 *
 * The cache is patched from the server's own row rather than invalidated: the
 * answer is authoritative (it is the row that de-duplicated a repeat), and a
 * re-read on every send would cost a round trip for a list this device already
 * knows the new head of. A failure is swallowed by the caller — a history that
 * did not record is never a send that failed.
 */
export function useRecordComposerHistory() {
  const settings = useServer()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (entry: { text: string; sessionId?: string | null; threadTitle?: string | null }) =>
      recordComposerHistory(settings, entry),
    onSuccess: (result) => {
      /* `isComposerHistoryEntry`, not a truthiness check: an older server
         answered this route with a serialized-to-`{}` promise, which passed
         `if (!result.entry)` and patched an entry-shaped hole in as the newest
         prompt. The read above filters the same way, so one bad row cannot
         reach the composer from either door. */
      const entry = result.entry
      if (!isComposerHistoryEntry(entry)) return
      qc.setQueryData<ComposerHistoryState>(composerHistoryKey(settings), (prev) => {
        /* The same de-duplication the server just did, applied to the copy on
           screen: the row moves to the head, it does not appear twice. */
        const rest = (prev?.items ?? []).filter((i) => i.id !== entry.id && i.text !== entry.text)
        return { items: [entry, ...rest] }
      })
    },
  })
}

/** Forget one line, or the whole history. Invalidates rather than patches —
    a clear is rare and the next read should say what is actually there. */
export function useClearComposerHistory() {
  const settings = useServer()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id?: string) => clearComposerHistory(settings, id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: composerHistoryKey(settings) }),
  })
}

/** The order projects are drawn in, as the ids in the order the list shows
    them. A fact about the projects, not about this device — so it goes to the
    server and the sidebar's folders follow it for free. */
export function useReorderProjects() {
  const settings = useServer()
  return useApiMutation<string[], Project[]>(
    () => [projectsKey(settings)],
    (s, ids) => api<Project[]>(s, "/api/projects/reorder", { method: "POST", body: JSON.stringify({ ids }) })
  )
}

// ---- project helper commands ----

/* The rows ride on `Project.helpers` (folded into `useProjects` by the
   server's list), so nothing here reads them — only the writes exist, and
   each invalidates the projects list, which is where the next header read
   comes from. Running one is not here at all: it opens a terminal rather than
   returning anything the cache holds (`openHelperTerminal`). */
export function useAddHelper() {
  const settings = useServer()
  return useApiMutation<{ projectId: string; input: HelperInput }, HelperCommand>(
    () => [projectsKey(settings)],
    (s, input) => addHelper(s, input.projectId, input.input)
  )
}

export function useUpdateHelper() {
  const settings = useServer()
  return useApiMutation<
    { projectId: string; helperId: string; input: HelperInput },
    HelperCommand
  >(
    () => [projectsKey(settings)],
    (s, input) => updateHelper(s, input.projectId, input.helperId, input.input)
  )
}

export function useDeleteHelper() {
  const settings = useServer()
  return useApiMutation<{ projectId: string; helperId: string }, { ok: boolean }>(
    () => [projectsKey(settings)],
    (s, input) => deleteHelper(s, input.projectId, input.helperId)
  )
}
