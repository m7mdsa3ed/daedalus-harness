/* ── The main sidebar ──
   Laid out the way the Codex and Claude desktop apps lay theirs out, because
   that is the shape people arrive already knowing:

     ┌ brand row · Search
     │ New thread · Build · Tasks · …                  fixed nav, icon + label, always there
      ├ Pinned                             the ones you said matter
      │ Recents                            the newest few, flat — a shortcut,
      │                                    running turns first
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

   The pieces live under `components/sidebar/` — the spacing scale, the
   memoized row/list and the folder/group primitives — with this file as the
   layout that stacks them (and the stable import path for the scale). */
import * as React from "react"
import {
  CalendarClock,
  ExternalLink,
  Clock,
  FolderIcon,
  ListFilter,
  Pin,
  SquareKanban,
  SquarePen,
  Trash2,
  Zap,
} from "lucide-react"
import { useLocation, useNavigate } from "react-router"
import { reportError } from "@/lib/errors"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { useConfirm } from "@/components/confirm-dialog"
import { Badge } from "@/components/ui/badge"
import { FoldableGroup, ProjectFolder } from "@/components/sidebar/groups"
import { GROUP, GROUP_LABEL, MENU, PROJECT_PAGE_SIZE, ROW, TIER } from "@/components/sidebar/scale"
import { ThreadList } from "@/components/sidebar/thread-list"
import { ItemContextMenu } from "@/components/item-context-menu"
import { useChord } from "@/lib/keybindings"
import { formatChord, type ShortcutId } from "@/lib/shortcuts"
import { Shortcut } from "@/components/shortcut"
import type { ThreadStatus } from "@/components/sidebar/thread-row"
import { IDLE_PHASE, markFor } from "@/lib/thread/phase"
import type { Actions } from "@/lib/actions"
import {
  boardPath,
  projectPath,
  routinesPath,
  schedulesPath,
  settingsPath,
  threadPath,
} from "@/lib/router"
import { usePins } from "@/lib/pins"
import { useProfiles, useProjects } from "@/lib/queries/catalog"
import { useRoutines, useScheduled } from "@/lib/queries/routines"
import { activityAt, isTopLevel, type Project, type SessionMeta } from "@/lib/settings"
import { defaultsForProfile, loadThreadDefaults, resolveThreadStart } from "@/lib/thread-defaults"
import { useStoreSelect, type ThreadState as LiveThreadState } from "@/lib/store"
import { cn } from "@/lib/utils"

/* The scale keeps its historical import path: everything outside the sidebar
   (the settings nav included) reads it from here. */
export { GROUP, GROUP_LABEL, MENU, ROW, TIER } from "@/components/sidebar/scale"

/** Rows Recents shows before folding the rest into the project folders. */
const RECENT_COUNT = 8

/* ── Fixed nav ──
   The rows every screen of the app is one click from, above the list rather
   than in it. New thread is the first menu row; Search is the icon button
   beside the brand in the header (`app-shell.tsx`).

   Deliberately only the rows that start something. Plan usage used to sit here
   too, as a peak-percentage badge that polled `GET /api/quota` every ten
   minutes; it lives in Settings › Usage alone now. It was the one row that
   worked rather than navigated — it made the sidebar ask the server a question
   nobody had posed, on a timer, for a number that is only ever acted on by
   going to the page that shows it properly. */
export function SidebarNav({
  onNewThread,
  onNewThreadInTab,
}: {
  onNewThread?: () => void
  onNewThreadInTab?: () => void
} = {}) {
  const location = useLocation()
  const navigate = useNavigate()
  const inBoard = location.pathname.startsWith("/board")
  const inRoutines = location.pathname.startsWith("/routines")
  const inSchedules = location.pathname.startsWith("/schedules")
  // Both lists are loaded at boot (the palette and the pages read the same
  // queries), so the rows can say how much is armed without asking again.
  const routineCount = useRoutines().data?.length ?? 0
  const scheduledCount = useScheduled().data?.length ?? 0
  const newThreadChord = useChord("newThread") ?? ""
  return (
    <SidebarGroup className={GROUP}>
      <SidebarGroupContent>
        <SidebarMenu className={MENU}>
          {onNewThread && (
            <SidebarMenuItem>
              <ItemContextMenu
                items={
                  onNewThreadInTab
                    ? [{ label: "New thread in new tab", icon: <ExternalLink />, onClick: onNewThreadInTab }]
                    : []
                }
              >
                <SidebarMenuButton
                  size="sm"
                  tooltip={newThreadChord ? `New thread (${formatChord(newThreadChord)})` : "New thread"}
                  onClick={(event) => {
                    if ((event.metaKey || event.ctrlKey) && onNewThreadInTab) {
                      onNewThreadInTab()
                    } else {
                      onNewThread()
                    }
                  }}
                  className={ROW}
                >
                  <SquarePen />
                  <span>New thread</span>
                  <Kbd id="newThread" />
                </SidebarMenuButton>
              </ItemContextMenu>
            </SidebarMenuItem>
          )}
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              tooltip="Tasks board"
              isActive={inBoard}
              onClick={() => void navigate(boardPath())}
              className={ROW}
            >
              <SquareKanban />
              <span>Tasks</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {/* Two pages for what happens with nobody watching. The labels are
              the feature: a routine starts a NEW thread on its own (a clock, a
              webhook, a commit) and answers the agent's questions itself; a
              scheduled message speaks into a thread that ALREADY EXISTS. They
              sit together because "routine" and "scheduled" are not words
              that tell themselves apart, and the count on each is how much is
              armed — the number you are asking about before you open it. */}
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              tooltip="Routines — threads that start on their own"
              isActive={inRoutines}
              onClick={() => void navigate(routinesPath())}
              className={ROW}
            >
              <Zap />
              <span>Routines</span>
              <NavCount count={routineCount} />
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              tooltip="Scheduled — messages sent into a thread later"
              isActive={inSchedules}
              onClick={() => void navigate(schedulesPath())}
              className={ROW}
            >
              <CalendarClock />
              <span>Scheduled</span>
              <NavCount count={scheduledCount} />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

/** The quiet count a nav row carries when its page has something in it —
    hidden at zero (an empty page needs no number in front of it) and in the
    icon rail, where the icon is the whole row. */
function NavCount({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <span className="ml-auto text-[10px] tabular-nums text-muted-foreground group-data-[collapsible=icon]:hidden">
      {count}
    </span>
  )
}

/** The chord, at the row's trailing edge, only while the row is hovered — a
    hint, not a label. Hidden in the icon rail, where the tooltip carries it. */
function Kbd({ id }: { id: ShortcutId }) {
  return (
    <Shortcut
      id={id}
      className="ml-auto hidden opacity-0 transition-opacity group-hover/menu-button:opacity-100 sm:inline-flex group-data-[collapsible=icon]:hidden"
      keyClassName="h-4 min-w-4 bg-transparent px-0.5 text-[10px] text-muted-foreground/70"
    />
  )
}

/* ── Sort / filter, remembered on this device ── */
type SidebarSort = "recent" | "project"
type SidebarFilter = "all" | "running" | "waiting"
interface SidebarView {
  sort: SidebarSort
  filter: SidebarFilter
}
const VIEW_KEY = "ui.sidebarView"
const VIEW_DEFAULT: SidebarView = { sort: "recent", filter: "all" }
const viewListeners = new Set<() => void>()
let viewCache: SidebarView | null = null

function readView(): SidebarView {
  if (viewCache) return viewCache
  try {
    const raw = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "null") as Partial<SidebarView> | null
    viewCache = {
      sort: raw?.sort === "project" ? "project" : "recent",
      filter: raw?.filter === "running" || raw?.filter === "waiting" ? raw.filter : "all",
    }
  } catch {
    viewCache = VIEW_DEFAULT
  }
  return viewCache
}

function writeView(patch: Partial<SidebarView>) {
  viewCache = { ...readView(), ...patch }
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(viewCache))
  } catch {
    // A forgotten preference is not worth throwing out of a click handler.
  }
  viewListeners.forEach((fn) => fn())
}

function useSidebarView(): SidebarView {
  return React.useSyncExternalStore(
    (fn) => {
      viewListeners.add(fn)
      return () => viewListeners.delete(fn)
    },
    readView,
    readView
  )
}

/** Starting a thread *in* a given project — the + on a project folder. The
    profile/agent/model come from the same remembered defaults ⌘N uses; only
    the project is the caller's. With no usable profile there is nothing to
    start, so it lands on the projects settings page like the empty state does. */
export function useStartThreadIn(actions: Actions) {
  const profiles = useProfiles()
  const navigate = useNavigate()
  const { isMobile, setOpenMobile } = useSidebar()
  return React.useCallback(
    (project: Project) => {
      const defaults = loadThreadDefaults()
      const start = resolveThreadStart(defaults, profiles)
      if (!start) return void navigate(settingsPath("projects"))
      const id = actions.newDraftThread({
        project,
        ...start,
        ...defaultsForProfile(defaults, start.profile.id),
      })
      if (isMobile) setOpenMobile(false)
      void navigate(threadPath(id))
    },
    [actions, profiles, navigate, isMobile, setOpenMobile]
  )
}

/* ── Per-thread status, with a stable identity ──
   The statuses the sidebar sorts, filters and groups by almost never change
   with the stream that produces them, so the map is rebuilt on each notify
   (cheap — one pass, no parsing) and *reused by identity* when its contents
   are unchanged.

   That identity is now the subscription itself: the derivation lives inside
   the selector, so the store's own `Object.is` on the returned map is what
   decides whether the sidebar renders at all. It used to sit in the render
   body under `useStore()`, which meant the whole sidebar re-rendered on every
   streamed token of every thread and merely skipped the memos below it. The
   selector must be idempotent for this to be safe, and it is: the same state
   yields the same map and the ref is replaced only when a status word
   actually differs.

   The live thread is the truth about a running turn: SessionMeta.promptActive
   is a server snapshot refetched only on bootstrap and on mutations, so on
   its own it never lights up mid-turn. Fall back to it for threads this
   client has not connected yet — for those it is the only signal there is.
   Waiting on you: the agent raised a question (elicitation) or an approval
   (permission) that is still open. Only known for threads this client has
   connected, so best-effort — and correct whenever a tab has it open. */
function useThreadStatuses(): Map<string, ThreadStatus> {
  const prev = React.useRef<Map<string, ThreadStatus>>(new Map())
  return useStoreSelect((state) => {
    const next = new Map<string, ThreadStatus>()
    for (const session of state.sessions) {
      const thread = state.threads[session.id] as LiveThreadState | undefined
      const waiting = !!thread && (!!thread.permission || !!thread.elicitation)
      const running = thread?.turnActive ?? session.promptActive
      /* A thread this client has never connected has no phase of its own, and
         `idle` is the honest reading for it — the server's `promptActive` is
         the only signal there is, and it says nothing about a connection that
         does not exist. */
      /* The row's own record of how its last turn went — the server's, so it
         is known for every thread in the list and not only for the ones this
         device has open. */
      next.set(
        session.id,
        markFor(thread?.phase ?? IDLE_PHASE, running, waiting, !!session.lastTurnError)
      )
    }
    let same = next.size === prev.current.size
    if (same) {
      for (const [id, value] of next) {
        if (prev.current.get(id) !== value) {
          same = false
          break
        }
      }
    }
    if (!same) prev.current = next
    return prev.current
  })
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
  const { live, trashed, pinned, recent, filed } = React.useMemo(() => {
    // Deleting is reversible, so a deleted thread leaves the tiers above but
    // not the sidebar: it drops into Trash until it is restored or purged.
    const live = sessions
      .filter(isTopLevel)
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
      .filter(isTopLevel)
      .filter((session) => !!session.deletedAt)
      .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))

    /* By last activity, not by creation: a thread is recent because something
       was said in it, so picking up an old one brings it back to the top
       instead of leaving it wherever it was started. */
    const newestFirst = [...live].sort((a, b) => activityAt(b) - activityAt(a))
    const pinSet = new Set(pins)
    // Pinned keeps the order pins were added in, not the order threads were
    // created: the group you built by hand should stay where you put it.
    const pinned = pins
      .map((id) => newestFirst.find((session) => session.id === id))
      .filter((session): session is SessionMeta => !!session)
    const rest = newestFirst.filter((session) => !pinSet.has(session.id))
    /* Recent first: a flat Recents list of the newest few — and the folders
       still hold *every* thread, this one included. Recents is a shortcut, not
       a place a thread moves to: a folder that dropped whatever was recent was
       an incomplete index of its own project, so the newest thread — the one
       most likely to be looked for — was the one missing from where it lives.
       By project: no Recents at all, which is the view for someone who thinks
       in projects rather than in time. */
    /* Running first, always. A turn in progress is the one thing in this list
       that is happening *now*, and by-activity order buried it under whatever
       was typed most recently. Every running thread is in the list whatever its
       age, and the rest fill the remaining slots. */
    const isRunning = (session: SessionMeta) => statuses.get(session.id) === "running"
    const running = rest.filter(isRunning)
    const idle = rest.filter((session) => !isRunning(session))
    const recent =
      view.sort === "recent"
        ? [...running, ...idle.slice(0, Math.max(RECENT_COUNT - running.length, 0))]
        : []
    return { live, trashed, pinned, recent, filed: newestFirst }
  }, [sessions, statuses, pins, view.filter, view.sort])

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

      {recent.length > 0 && (
        <FoldableGroup groupKey="__recent" label="Recents" icon={<Clock className="size-3 shrink-0" />}>
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

/** Sort and filter, in one small menu on the Threads label — the controls
    Claude Code desktop puts at the top of its session list. The trigger
    lights up while a filter is on so a short list is never mistaken for an
    empty install. */
function ViewMenu({ view }: { view: SidebarView }) {
  const filtered = view.filter !== "all"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            title="Sort and filter"
            className={cn(
              "ml-auto grid size-5 place-items-center rounded-sm transition-colors hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-popup-open:text-sidebar-foreground",
              filtered ? "text-primary hover:text-primary" : "text-muted-foreground"
            )}
          />
        }
      >
        <ListFilter className="size-3.5" />
        <span className="sr-only">Sort and filter threads</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start" className="w-44">
        {/* The label is Base UI's Menu.GroupLabel: it reads its group from
            context and throws outside one, so it sits inside the radio group
            it names rather than loose in the content. */}
        <DropdownMenuRadioGroup
          value={view.sort}
          onValueChange={(value) => writeView({ sort: value as SidebarSort })}
        >
          <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Sort
          </DropdownMenuLabel>
          <DropdownMenuRadioItem value="recent">Recent first</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="project">By project</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={view.filter}
          onValueChange={(value) => writeView({ filter: value as SidebarFilter })}
        >
          <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Show
          </DropdownMenuLabel>
          <DropdownMenuRadioItem value="all">All threads</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="running">Running</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="waiting">Needs you</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The one action that belongs to the Trash rather than to a thread in it.
    At the foot of the list, not on the label: the label is a disclosure
    trigger, and a destructive button inside a trigger is a click away from
    being hit by someone who only meant to fold the group. */
function EmptyTrash({ sessions, actions }: { sessions: SessionMeta[]; actions: Actions }) {
  const confirm = useConfirm()
  const [busy, setBusy] = React.useState(false)

  const empty = async () => {
    if (
      !(await confirm({
        title: sessions.length === 1 ? "Empty the Trash?" : `Delete ${sessions.length} threads forever?`,
        description:
          "The harness forgets them. Only each agent's own transcript file would still have the conversation.",
        confirmLabel: "Delete forever",
        destructive: true,
      }))
    )
      return
    setBusy(true)
    /* One at a time: purgeThread refreshes the session list after each, and a
       parallel burst would have several refreshes racing. There are never many. */
    try {
      for (const session of sessions) await actions.purgeThread(session.id)
    } catch (err) {
      reportError(err, "Couldn't empty the Trash")
    } finally {
      setBusy(false)
    }
  }

  return (
    <SidebarMenu className={MENU}>
      <SidebarMenuItem>
        <SidebarMenuButton
          size="sm"
          onClick={empty}
          disabled={busy}
          tooltip="Delete every thread in the Trash"
          className={cn(ROW, "text-muted-foreground hover:bg-destructive/10 hover:text-destructive")}
        >
          <Trash2 />
          <span className="truncate">{busy ? "Emptying…" : "Empty Trash"}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
