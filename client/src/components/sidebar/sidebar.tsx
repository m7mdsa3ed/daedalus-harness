/* ── The main sidebar ──
   Laid out after the Claude desktop app's session sidebar, because that is the
   shape people arrive already knowing: one list of every active and recent
   session, filtered by status and grouped by project on demand.

     ┌ brand · Search                              (app-shell.tsx)
     │ New session                                 the one primary row
     │ Tasks · Routines · Scheduled                the places, as plain rows
      ├ Sessions   needs-you ·  search · refresh · view
      │ Pinned                                     the ones you said matter
      │ Today / Yesterday / …                      flat, newest activity first,
      │                                            each row naming its project —
      │   or, "By project":
      │ ▸ harness                + ·               one folder per project, ALL
      │ ▸ website                                  its threads; + starts one in it
      │ Trash                                      folded shut
     └ usage · server · notifications · Settings   the footer (app-shell.tsx)

   Rows are one line: the agent's mark, the title, and its status (a running
   turn spins, a thread waiting on you says so) or how long ago it last spoke.
   The model and project are the row's tooltip; everything else about a thread is
   in the `ThreadInfoCard`, the header of the row's ⋯ dropdown.

   The sort/filter (`view.tsx`), pins and fold state are device-local: the
   harness's session list is shared, and one person's sidebar must not reorder
   another's.

   Routines and scheduled messages are not listed here at all. Each is a page
   of its own (`/routines`, `/schedules`), so the header carries one row per page.

   This folder is the sidebar: the spacing scale (`scale.ts`), the nav rows
   (`nav.tsx`), the sort/filter store and its menu (`view.tsx`), the
   folder/group primitives (`groups.tsx`), the memoized row and list
   (`thread-row.tsx`, `thread-list.tsx`) and the Trash's own action
   (`trash.tsx`). This file is the layout that stacks them;
   `components/thread-sidebar.tsx` is the barrel the rest of the app imports
   from. */
import * as React from "react"
import { ChevronRight, FolderIcon, Loader2, Pin, RefreshCwIcon, Search, Trash2, X } from "lucide-react"
import { useNavigate } from "react-router"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  useSidebar,
} from "@/components/ui/sidebar"
import { SidebarEnvContext, type SidebarEnv } from "./env"
import { deriveTiers } from "./tiers"
import { FoldableGroup, ProjectFolder } from "./groups"
import { GROUP, GROUP_LABEL, MENU, PROJECT_PAGE_SIZE, TIER } from "./scale"
import { ThreadList } from "./thread-list"
import type { ThreadStatus } from "./thread-row"
import { EmptyTrash } from "./trash"
import { markSeen } from "./activity"
import { useSidebarView, ViewMenu } from "./view"
import { useThreadStatuses } from "@/lib/thread/statuses"
import type { Actions } from "@/lib/actions"
import { projectPath, settingsPath, threadPath } from "@/lib/router"
import { openInNewTab } from "@/lib/workspace/open-threads"
import { usePins } from "@/lib/pins"
import { useActiveSpace, useProjects } from "@/lib/queries/catalog"
import { useActiveChat, useOpenThreads } from "@/lib/workspace/open-threads"
import { activityAt, isListed, type Project, type SessionMeta } from "@/lib/settings"
import { useStoreSelect } from "@/lib/store"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { useCoarsePointer } from "@/hooks/use-device"
import { useShortcut } from "@/hooks/use-hotkey"
import { describeError } from "@/lib/errors"
import { toast } from "@/lib/toast"

/** Starting a thread *in* a given project — the + on a project folder, and the
    project page's own button. The same front door ⌘N takes
    (`actions.startThreadIn`, which resolves the profile/agent/model from the
    remembered defaults); only the project is the caller's. A new thread, every
    time, opened as a tab of its own — the draft is invisible to every list
    until it is sent. */
export function useStartThreadIn(actions: Actions) {
  const navigate = useNavigate()
  const { isMobile, setOpenMobile } = useSidebar()
  return React.useCallback(
    (project: Project) => {
      if (isMobile) setOpenMobile(false)
      const id = actions.startThreadIn({ projectId: project.id })
      /* A thread started from a project is a tab of its own. */
      if (id && openInNewTab(threadPath(id))) return
      void navigate(id ? threadPath(id) : settingsPath("projects"))
    },
    [navigate, isMobile, setOpenMobile, actions]
  )
}

/* ── The list ── */
export function ThreadSidebar({ actions }: { actions: Actions }) {
  /* The session list and the project catalog — never `state.threads` itself,
     which is replaced on every streamed token of every thread. Projects come
     from the query cache, so only a projects refresh reaches this. */
  const sessions = useStoreSelect((state) => state.sessions)
  const projects = useProjects()
  const { id: activeSpaceId } = useActiveSpace()
  const pins = usePins()
  const view = useSidebarView()
  /* The threads with a tab open, in the dock's order — kept loaded below so a
     tab never goes missing from the list. Published by the dock
     (lib/workspace/open-threads), so a reload rebuilds it from the restored
     layout. */
  const openIds = useOpenThreads()
  const activeThreadId = useActiveChat()
  const navigate = useNavigate()
  const startIn = useStartThreadIn(actions)
  const coarse = useCoarsePointer()
  /* The in-sidebar filter: local to this mount, never stored — it answers "is
     it one of these?", and the palette is the deep search. Closing clears. */
  const [query, setQuery] = React.useState("")
  const [searching, setSearching] = React.useState(false)
  const searchRef = React.useRef<HTMLInputElement>(null)
  const { open: sidebarOpen, setOpen, isMobile, setOpenMobile } = useSidebar()
  const closeSearch = () => {
    setQuery("")
    setSearching(false)
  }
  useShortcut("sidebarFilter", () => {
    if (isMobile) setOpenMobile(true)
    else if (!sidebarOpen) setOpen(true)
    setSearching(true)
    // After the field mounts (and the collapsed sidebar has opened).
    requestAnimationFrame(() => searchRef.current?.focus())
  })
  const [refreshing, setRefreshing] = React.useState(false)
  const refreshSessions = React.useCallback(() => {
    if (refreshing) return
    setRefreshing(true)
    void actions
      .refreshSessions()
      .catch((error: unknown) => toast.error(describeError(error).title))
      .finally(() => setRefreshing(false))
  }, [actions, refreshing])

  const statuses = useThreadStatuses()
  const status = React.useCallback(
    (session: SessionMeta): ThreadStatus => statuses.get(session.id) ?? "idle",
    [statuses]
  )

  /* Which projects — and so which threads — belong to the space in front of
     you. A thread is filed under its project, so this is the whole of a
     thread's space. A thread whose project is gone is unattributable: it shows
     in every space (as "Other" below) rather than vanishing from the one space
     it was last worked in. */
  const spaceProjectIds = React.useMemo(
    () =>
      activeSpaceId
        ? new Set(projects.filter((project) => project.spaceId === activeSpaceId).map((project) => project.id))
        : null,
    [projects, activeSpaceId]
  )
  const knownProject = React.useMemo(() => new Set(projects.map((project) => project.id)), [projects])
  const inSpace = React.useCallback(
    (session: SessionMeta) =>
      !spaceProjectIds || spaceProjectIds.has(session.projectId) || !knownProject.has(session.projectId),
    [spaceProjectIds, knownProject]
  )
  // The folders this space draws. `projects` stays whole for orphan detection.
  const scopedProjects = React.useMemo(
    () => (spaceProjectIds ? projects.filter((project) => spaceProjectIds.has(project.id)) : projects),
    [projects, spaceProjectIds]
  )

  /* All the derived lists in one memo: none of them depend on anything a
     streamed token changes (statuses is identity-stable, see above), so a
     token costs this component a render but no re-sorting and — through the
     memoized rows — no row re-renders. */
  const projectNames = React.useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects]
  )
  const { live, trashed, pinned, filed } = React.useMemo(
    () =>
      deriveTiers({ sessions, inSpace, filter: view.filter, statuses, pins, query, projectNames }),
    [sessions, statuses, pins, view.filter, inSpace, query, projectNames]
  )

  /* The Sessions label's numbers come from the unfiltered
     statuses over the space's live threads, so a filter never counts itself away. */
  const counts = React.useMemo(() => {
    let running = 0
    let needsYou = 0
    for (const session of sessions) {
      if (!isListed(session) || session.deletedAt || !inSpace(session)) continue
      const state = statuses.get(session.id)
      if (state === "running") running++
      else if (state === "waiting" || state === "failed") needsYou++
    }
    return { running, needsYou }
  }, [sessions, statuses, inSpace])

  /* The thread in front of you is read: stamp it with the activity it showed,
     now and whenever a turn ends under your eyes. */
  const activeSession = sessions.find((session) => session.id === activeThreadId)
  const activeAt = activeSession ? activityAt(activeSession) : 0
  React.useEffect(() => {
    if (activeSession) markSeen(activeSession)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the stamp is the dependency, not the object
  }, [activeSession?.id, activeAt])

  const { byProject, orphans } = React.useMemo(() => {
    const byProject = new Map<string, SessionMeta[]>()
    for (const session of filed) {
      const list = byProject.get(session.projectId) ?? []
      list.push(session)
      byProject.set(session.projectId, list)
    }
    /* Every project gets a folder, threads or not: an empty folder still has
       its + — which is how a project you have not started on yet gets its first
       thread from here. Threads whose project is gone fall into "Other". */
    const orphans = [...byProject.keys()].filter((id) => !knownProject.has(id))
    return { byProject, orphans }
  }, [filed, knownProject])

  const pinSet = React.useMemo(() => new Set(pins), [pins])
  const env = React.useMemo<SidebarEnv>(
    () => ({ actions, status, pinSet, projectNames }),
    [actions, status, pinSet, projectNames]
  )

  /* ── Threads arrive a page at a time ──
     The store holds a window of the list, not the whole of it (the server
     pages it — `GET /api/sessions/page`), so two things keep the rows the
     sidebar needs in hand. Whatever the toolbar's pin, the tabs opened here and
     the thread in front of you name is loaded on sight, so a tab or a pin never
     goes missing; and the bottom of the panel is a sentinel that asks for the
     next page as you reach it. Loaded rows the in-panel filter hides are still
     loaded — nothing here re-fetches or drops a row to filter it. */
  const sessionWindow = useStoreSelect((state) => state.sessionWindow)
  React.useEffect(() => {
    const needed = [...openIds, activeThreadId].filter((id): id is string => !!id)
    if (needed.length === 0) return
    void actions.ensureSessionsLoaded(needed).catch(() => {
      /* Ambient: a thread that could not be looked up simply does not draw. */
    })
  }, [actions, openIds, activeThreadId])

  const [loadingMore, setLoadingMore] = React.useState(false)
  const sentinelRef = React.useRef<HTMLDivElement>(null)
  /* Handed to the effect below through a ref: the loader is async and has to
     read the window as it stands *after* a page lands, not as this render
     closed over it. */
  const windowRef = React.useRef(sessionWindow)
  windowRef.current = sessionWindow
  const busyRef = React.useRef(false)
  React.useEffect(() => {
    const node = sentinelRef.current
    if (!node) return
    const scroller = node.closest<HTMLElement>('[data-sidebar="content"]')
    let cancelled = false
    const load = async () => {
      if (cancelled || busyRef.current) return
      const seen = windowRef.current
      if (seen.ids.length >= seen.total) return
      /* Nothing is scrolled and nothing overflows: there is no long tail to
         reach, so loading one would grow a list nobody is looking at (a page's
         rows land in fold-shut folders). Wait for the panel to be tall enough
         to scroll at all. */
      if (scroller && scroller.scrollHeight <= scroller.clientHeight + 8) return
      const box = scroller?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight }
      // Only when the sentinel is at (or near) the foot of what is in front.
      if (node.getBoundingClientRect().top > box.bottom + 240) return
      const before = seen.ids.length
      busyRef.current = true
      setLoadingMore(true)
      try {
        await actions.loadMoreSessions()
      } catch {
        /* Quiet: the list simply stops growing, exactly as it would offline. */
      } finally {
        busyRef.current = false
        setLoadingMore(false)
      }
      /* Still in view and the page grew — the reader is at the bottom of a
         panel with room left, so fill it rather than making them jiggle the
         scrollbar. A page that did not grow ends the walk. */
      if (windowRef.current.ids.length > before) void load()
    }
    const target: HTMLElement | Window = scroller ?? window
    target.addEventListener("scroll", load, { passive: true })
    window.addEventListener("resize", load)
    void load()
    return () => {
      cancelled = true
      target.removeEventListener("scroll", load)
      window.removeEventListener("resize", load)
    }
  }, [actions, sessionWindow.total])

  const hasMore = sessionWindow.ids.length < sessionWindow.total
  const filtered = view.filter !== "all"
  const searched = query.trim() !== ""
  const nothingLive = live.length === 0

  return (
    <SidebarEnvContext.Provider value={env}>
      <SidebarGroup className={cn(TIER, GROUP)}>
        <SidebarGroupLabel className={cn(GROUP_LABEL, "group/label")}>
          <span className="truncate">Sessions</span>
          {counts.needsYou > 0 && (
            <span
              title={`${counts.needsYou} thread${counts.needsYou === 1 ? "" : "s"} need${counts.needsYou === 1 ? "s" : ""} you`}
              className="rounded-full bg-amber-500/15 px-1.5 text-[10px] font-medium text-amber-700 tabular-nums dark:text-amber-400"
            >
              {counts.needsYou}
            </span>
          )}
          <div className="ml-auto flex h-full items-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              title="Filter threads"
              aria-label="Filter threads"
              aria-pressed={searching}
              onClick={() => (searching ? closeSearch() : (setSearching(true), requestAnimationFrame(() => searchRef.current?.focus())))}
              className={cn(
                "rounded-sm text-muted-foreground hover:text-sidebar-foreground",
                coarse ? "size-10" : "size-6",
                (searching || query) && "text-primary"
              )}
            >
              <Search className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              title="Refresh threads"
              aria-label="Refresh threads"
              disabled={refreshing}
              onClick={refreshSessions}
              className={cn(
                "rounded-sm text-muted-foreground hover:text-sidebar-foreground",
                coarse ? "size-10" : "size-6"
              )}
            >
              <RefreshCwIcon className={cn("size-3.5", refreshing && "animate-spin")} />
            </Button>
            <ViewMenu view={view} />
          </div>
        </SidebarGroupLabel>
        {searching && (
          <div className="relative mb-1">
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation()
                  closeSearch()
                }
              }}
              placeholder="Filter by title, project or agent"
              aria-label="Filter threads by title, project or agent"
              className="h-8 w-full rounded-lg border border-sidebar-border bg-transparent px-2 pr-7 text-[13px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
            {query && (
              <button
                type="button"
                title="Clear filter"
                aria-label="Clear filter"
                onClick={() => {
                  setQuery("")
                  searchRef.current?.focus()
                }}
                className="absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-sm text-muted-foreground hover:text-sidebar-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        )}
      </SidebarGroup>

      {nothingLive && (
        <SidebarGroup className={GROUP}>
          <p className="px-2 py-2 text-xs text-muted-foreground">
            {query.trim()
              ? "No thread matches that."
              : filtered
              ? view.filter === "running"
                ? "Nothing is running right now."
                : "Nothing is waiting on you."
              : scopedProjects.length > 0
                ? "No threads yet — start one from a project below."
                : "No threads yet."}
          </p>
        </SidebarGroup>
      )}

      {pinned.length > 0 && (
        <FoldableGroup groupKey="__pinned" label="Pinned" icon={<Pin className="size-3 shrink-0" />}>
          <ThreadList sessions={pinned} />
        </FoldableGroup>
      )}

      {/* Flat: every live thread, newest activity first, under Today /
          Yesterday / … headings, each row naming its project. The thread in
          front of you is highlighted in place — it is always one of these. */}
      {view.sort === "recent" && filed.length > 0 && (
        <SidebarGroup className={GROUP}>
          <ThreadList sessions={filed} grouped showProject />
        </SidebarGroup>
      )}

      {/* Projects: one folder each. Not a foldable tier itself — the folders
          are the folds — but it hides under a status filter that matched
          nothing, where a column of empty folders would be noise. */}
      {view.sort === "project" && scopedProjects.length > 0 && !((filtered || searched) && nothingLive) && (
        <FoldableGroup groupKey="__projects" label="Projects" icon={<FolderIcon className="size-3 shrink-0" />}>
            <SidebarMenu className={MENU}>
              {scopedProjects
                .filter((project) => !searched || byProject.has(project.id))
                .map((project) => (
                <ProjectFolder
                  key={project.id}
                  id={project.id}
                  name={project.name}
                  logoUrl={project.logoUrl}
                  sessions={byProject.get(project.id) ?? []}
                  onNewThread={() => startIn(project)}
                  onOpenProject={() => void navigate(projectPath(project.id))}
                 
                />
              ))}
              {orphans.map((id) => (
                <ProjectFolder
                  key={id}
                  id={id}
                  name="Other"
                  sessions={byProject.get(id) ?? []}
                 
                />
              ))}
            </SidebarMenu>
        </FoldableGroup>
      )}

      {/* Trash folds, and folds shut by default: it is where things go, not
          where anyone works. */}
      {trashed.length > 0 && (
        <FoldableGroup
          groupKey="__trash"
          label="Trash"
          icon={<Trash2 className="size-3 shrink-0" />}
          count={trashed.length}
          defaultOpen={false}
        >
          <ThreadList sessions={trashed} trash limit={PROJECT_PAGE_SIZE} />
          <EmptyTrash sessions={trashed} actions={actions} />
        </FoldableGroup>
      )}

      {/* The end of the loaded window, and the sentinel the scroll watches for.
          A page trades the whole list for a window, so this is where the rest of
          the history arrives — as the reader reaches the foot of the panel, or
          when the button below is tapped (a phone, or a panel too short to
          scroll). It draws nothing once the window has caught up with the
          server's count. */}
      {(hasMore || loadingMore) && (
        <div ref={sentinelRef} className="px-2 pt-1 pb-4">
          <button
            type="button"
            disabled={loadingMore}
            onClick={() => {
              void actions.loadMoreSessions().catch(() => {
                /* Quiet: the window simply stops where it is. */
              })
            }}
            className="flex h-8 w-full items-center justify-center gap-2 rounded-lg text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 group-data-[collapsible=icon]:hidden"
          >
            {loadingMore ? (
              <Loader2 aria-hidden className="size-3.5 animate-spin" />
            ) : (
              <ChevronRight aria-hidden className="size-4" />
            )}
            <span>{loadingMore ? "Loading more\u2026" : "Load more threads"}</span>
          </button>
          <span className="sr-only">
            {sessionWindow.ids.length} of {sessionWindow.total} threads loaded
          </span>
        </div>
      )}
    </SidebarEnvContext.Provider>
  )
}
