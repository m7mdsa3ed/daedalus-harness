/* ── The main sidebar ──
   Laid out the way the Codex and Claude desktop apps lay theirs out, because
   that is the shape people arrive already knowing:

     ┌ brand row · Search
     │ New thread · Build · Tasks · …                  fixed nav, icon + label, always there
      ├ Pinned                             the ones you said matter
      │ Opened                             the threads with a tab open, in
      │                                    dock order — Recents leaves these out
      │ Recents                            the newest few, flat — a shortcut,
      │                                    running turns always among them
     │ Projects                           one folder per project, ALL its
     │   ▸ harness              + ·       threads, by period; + starts one *in* it
     │   ▸ website
     │ Routines · Scheduled             …two more fixed rows: each is a page
     │ Trash                              folded shut
     └ <server> / Settings                the "account" row

   Two ideas are borrowed on purpose. From Codex: the fixed nav rows at the top
   and projects as expandable folders with their threads under them — a new
   thread started from a folder lands *in* that folder. From Claude Code
   desktop: the list is a working set, so it carries a status per row (a
   running turn, a thread waiting on you), and the controls at the top of the
   list filter by that status and switch between "recent first" and "group by
   project". Rows are one line and carry the title alone, like both apps: a
   running turn shimmers the title and a thread waiting on you gets an amber
   dot at the trailing edge — that is the whole ornament. Everything else about
   a thread — agent, profile, model, project, when it started, and the row's
   actions — is in the `ThreadInfoCard`, one popover that opens on hover (and,
   on a phone, on long press) and carries the actions beside the reading, so
   one hover reaches both a thread's what and its what-to-do.

   Pins, fold state and the sort/filter are device-local (the harness's session
   list is shared, and one person's sidebar must not reorder another's).

   Routines and scheduled messages are not listed here at all. Each is a page
   of its own (`/routines`, `/schedules`) with the whole list, its counts and
   the controls, so the sidebar carries one nav row per page rather than a
   second, smaller copy of the list with fewer controls on it.

   This folder is the sidebar: the spacing scale (`scale.ts`), the fixed nav
   (`nav.tsx`), the sort/filter store and its menu (`view.tsx`), the
   folder/group primitives (`groups.tsx`), the memoized row and list
   (`thread-row.tsx`, `thread-list.tsx`) and the Trash's own action
   (`trash.tsx`). This file is the layout that stacks them;
   `components/thread-sidebar.tsx` is the barrel the rest of the app imports
   from. */
import * as React from "react"
import { FolderIcon, History as HistoryIcon, Layers, Pin, Trash2 } from "lucide-react"
import { useNavigate } from "react-router"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  useSidebar,
} from "@/components/ui/sidebar"
import { FoldableGroup, ProjectFolder } from "./groups"
import { GROUP, GROUP_LABEL, MENU, PROJECT_PAGE_SIZE, TIER } from "./scale"
import { ThreadList } from "./thread-list"
import type { ThreadStatus } from "./thread-row"
import { EmptyTrash } from "./trash"
import { useSidebarView, ViewMenu } from "./view"
import { useThreadStatuses } from "@/lib/thread/statuses"
import type { Actions } from "@/lib/actions"
import { projectPath, settingsPath, threadPath } from "@/lib/router"
import { usePins } from "@/lib/pins"
import { useProjects } from "@/lib/queries/catalog"
import { useOpenThreads } from "@/lib/workspace/open-threads"
import { activityAt, isListed, type Project, type SessionMeta } from "@/lib/settings"
import { useStoreSelect } from "@/lib/store"
import { cn } from "@/lib/utils"

/** Rows Recents shows before folding the rest into the project folders. */
const RECENT_COUNT = 8

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
  const pins = usePins()
  const view = useSidebarView()
  /* The threads with a tab open, in the dock's order — the "Opened" tier, and
     what Recents leaves out. Published by the dock (lib/workspace/open-threads),
     so a reload rebuilds it from the restored layout. */
  const openIds = useOpenThreads()
  const navigate = useNavigate()
  const startIn = useStartThreadIn(actions)
  /* The icon rail is 3rem wide: a thread row there is a title clipped to
     nothing, and a group label is already hidden by the primitive — so the
     rail would be a column of blank rows and stray fold chevrons. Collapsed,
     the list is not shown at all; the rail carries the fixed nav (New thread,
     Search, Tasks) and nothing else. Mobile is unaffected — there the sidebar
     is a sheet, always full width, whatever `open` says. */
  const { state: sidebarState, isMobile } = useSidebar()
  const railed = sidebarState === "collapsed" && !isMobile

  const statuses = useThreadStatuses()
  const status = React.useCallback(
    (session: SessionMeta): ThreadStatus => statuses.get(session.id) ?? "idle",
    [statuses]
  )

  /* All the derived lists in one memo: none of them depend on anything a
     streamed token changes (statuses is identity-stable, see above), so a
     token costs this component a render but no re-sorting and — through the
     memoized rows — no row re-renders. */
  const { live, trashed, pinned, recent, opened, filed } = React.useMemo(() => {
    // Deleting is reversible, so a deleted thread leaves the tiers above but
    // not the sidebar: it drops into Trash until it is restored or purged.
    const live = sessions
      .filter(isListed)
      .filter((session) => !session.deletedAt)
      .filter((session) => {
        if (view.filter === "running") return statuses.get(session.id) === "running"
        /* "Needs you" is both readings that are addressed to the reader: a
           question the agent is blocked on, and a turn that ended badly and
           has been sitting there since. */
        if (view.filter === "waiting") {
          const status = statuses.get(session.id)
          return status === "waiting" || status === "failed"
        }
        return true
      })
    const trashed = sessions
      .filter(isListed)
      .filter((session) => !!session.deletedAt)
      .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))

    /* By last activity, not by creation: a thread is recent because something
       was said in it, so picking up an old one brings it back to the top
       instead of leaving it wherever it was started. */
    const newestFirst = [...live].sort((a, b) => activityAt(b) - activityAt(a))
    // Pinned keeps the order pins were added in, not the order threads were
    // created: the group you built by hand should stay where you put it.
    const pinned = pins
      .map((id) => newestFirst.find((session) => session.id === id))
      .filter((session): session is SessionMeta => !!session)
    /* Recent first: a flat Recents list of the newest few — and the folders
       still hold *every* thread, this one included. Recents is a shortcut, not
       a place a thread moves to: a folder that dropped whatever was recent was
       an incomplete index of its own project, so the newest thread — the one
       most likely to be looked for — was the one missing from where it lives.
       By project: no Recents at all, which is the view for someone who thinks
       in projects rather than in time. */
    /* Newest first, by creation date — and running is a reason to be *in*
       Recents, never a reason to be at the top of it. A thread's status is only
       truly known once this client has connected to it (`useThreadStatuses`
       falls back to the server's `promptActive`, a snapshot refetched on
       bootstrap and mutations), so a running block at the top re-sorted the
       list the moment you clicked a row and the connection corrected a stale
       reading — the one list position you were reading from moved under the
       click that opened it. Membership can still change on that correction; the
       order of what is drawn cannot. */
    const isRunning = (session: SessionMeta) => statuses.get(session.id) === "running"
    const rest = [...live].sort((a, b) => b.createdAt - a.createdAt)

    /* ── Opened, and Recents without it ──
       A thread with a tab open is already one click away, so it is not also a
       shortcut in Recents: the tier below lists what is open, Recents lists what
       is not. Closing a tab takes its id out of the open set, which is all it
       takes for the thread to fall back into Recents if it belongs there — both
       are derived, so the two can never disagree. Mapped through `live`, so the
       status filter narrows this tier with every other, and a draft (which no
       list draws) stays out of it. */
    const openSet = new Set(openIds)
    const byId = new Map(live.map((session) => [session.id, session]))
    const opened = openIds.flatMap((id) => {
      const session = byId.get(id)
      return session ? [session] : []
    })
    const closed = rest.filter((session) => !openSet.has(session.id))

    const running = closed.filter(isRunning)
    /* Every running thread keeps its place, whatever its age — that is what
       Recents replaced the old Running tier with, and burying the turn that is
       happening now is the thing the tier existed to prevent. The rest fill
       what is left, so the count is what it always was. */
    const shown = new Set(running.map((session) => session.id))
    for (const session of closed) {
      if (shown.size >= Math.max(RECENT_COUNT, running.length)) break
      shown.add(session.id)
    }
    const recent = view.sort === "recent" ? closed.filter((session) => shown.has(session.id)) : []
    return { live, trashed, pinned, recent, opened, filed: newestFirst }
  }, [sessions, statuses, pins, view.filter, view.sort, openIds])

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
    const orphans = [...byProject.keys()].filter(
      (id) => !projects.some((project) => project.id === id)
    )
    return { byProject, orphans }
  }, [filed, projects])

  const listProps = { actions, status }
  const filtered = view.filter !== "all"
  const nothingLive = live.length === 0

  // After the hooks, never before: the lists above are all hook state.
  if (railed) return null

  return (
    <>
      <SidebarGroup className={cn(TIER, GROUP)}>
        <SidebarGroupLabel className={cn(GROUP_LABEL, "group/label")}>
          <span className="truncate">Threads</span>
          <ViewMenu view={view} />
        </SidebarGroupLabel>
      </SidebarGroup>

      {nothingLive && (
        <SidebarGroup className={GROUP}>
          <p className="px-2 py-2 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
            {filtered
              ? view.filter === "running"
                ? "Nothing is running right now."
                : "Nothing is waiting on you."
              : projects.length > 0
                ? "No threads yet — start one from a project below."
                : "No threads yet."}
          </p>
        </SidebarGroup>
      )}

      {pinned.length > 0 && (
        <FoldableGroup groupKey="__pinned" label="Pinned" icon={<Pin className="size-3 shrink-0" />}>
          <ThreadList sessions={pinned} {...listProps} />
        </FoldableGroup>
      )}

      {/* The threads with a tab open, in the dock's order. The active one is
          the row the dock just focused — highlighted here exactly as it is in
          every other tier, so the transcript in front of you always has a row
          that says so. Recents leaves these out; closing a tab returns it. */}
      {opened.length > 0 && (
        <FoldableGroup groupKey="__opened" label="Opened" icon={<Layers className="size-3 shrink-0" />}>
          <ThreadList sessions={opened} {...listProps} />
        </FoldableGroup>
      )}

      {recent.length > 0 && (
        /* A clock read as "scheduled" next to a Scheduled nav row; Recents is
           what happened, so it wears a history mark. */
        <FoldableGroup groupKey="__recent" label="Recents" icon={<HistoryIcon className="size-3 shrink-0" />}>
          <ThreadList sessions={recent} {...listProps} />
        </FoldableGroup>
      )}

      {/* Projects: one folder each. Not a foldable tier itself — the folders
          are the folds — but it hides under a status filter that matched
          nothing, where a column of empty folders would be noise. */}
      {projects.length > 0 && !(filtered && nothingLive) && (
        <FoldableGroup groupKey="__projects" label="Projects" icon={<FolderIcon className="size-3 shrink-0" />}>
            <SidebarMenu className={MENU}>
              {projects.map((project) => (
                <ProjectFolder
                  key={project.id}
                  id={project.id}
                  name={project.name}
                  logoUrl={project.logoUrl}
                  sessions={byProject.get(project.id) ?? []}
                  onNewThread={() => startIn(project)}
                  onOpenProject={() => void navigate(projectPath(project.id))}
                  {...listProps}
                />
              ))}
              {orphans.map((id) => (
                <ProjectFolder
                  key={id}
                  id={id}
                  name="Other"
                  sessions={byProject.get(id) ?? []}
                  {...listProps}
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
          <ThreadList sessions={trashed} trash limit={PROJECT_PAGE_SIZE} {...listProps} />
          <EmptyTrash sessions={trashed} actions={actions} />
        </FoldableGroup>
      )}
    </>
  )
}
