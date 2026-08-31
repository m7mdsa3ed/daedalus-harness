/* ── The main sidebar ──
   Laid out the way the Codex and Claude desktop apps lay theirs out, because
   that is the shape people arrive already knowing:

     ┌ brand row
     │ New thread · Search · Tasks        fixed nav, icon + label, always there
     ├ Pinned                             the ones you said matter
     │ Recents                            the newest few, flat — a shortcut
     │ Projects                           one folder per project, ALL its
     │   ▸ harness              + ·       threads, by period; + starts one *in* it
     │   ▸ website
     │ Scheduled                          what the server will send later
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
   a thread — agent, profile, model, project, when it started — is in the
   `ThreadInfoCard`, one popover that opens on hover and, on a phone, on long
   press (where it also carries the row's actions, since it replaces the
   right-click menu a finger cannot open).

   Pins, fold state and the sort/filter are device-local (the harness's session
   list is shared, and one person's sidebar must not reorder another's).

   The pieces live under `components/sidebar/` — the spacing scale, the
   memoized row/list, the folder/group primitives and the Scheduled tier —
   with this file as the layout that stacks them (and the stable import path
   for the scale). */
import * as React from "react"
import {
  Clock,
  FolderIcon,
  ListFilter,
  Pin,
  SearchIcon,
  SquareKanban,
  SquarePen,
  Trash2,
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
import { FoldableGroup, ProjectFolder } from "@/components/sidebar/groups"
import { GROUP, GROUP_LABEL, MENU, PROJECT_PAGE_SIZE, ROW, TIER } from "@/components/sidebar/scale"
import { ScheduledGroup } from "@/components/sidebar/scheduled"
import { ThreadList } from "@/components/sidebar/thread-list"
import type { ThreadStatus } from "@/components/sidebar/thread-row"
import type { Actions } from "@/lib/actions"
import { boardPath, projectPath, settingsPath, threadPath } from "@/lib/router"
import { usePins } from "@/lib/pins"
import { formatChord, KEYS } from "@/lib/shortcuts"
import { Shortcut } from "@/components/shortcut"
import { activityAt, isTopLevel, type Project, type SessionMeta } from "@/lib/settings"
import { defaultsForProfile, loadThreadDefaults, resolveThreadStart } from "@/lib/thread-defaults"
import { useStore, type ThreadState as LiveThreadState } from "@/lib/store"
import { cn } from "@/lib/utils"

/* The scale keeps its historical import path: everything outside the sidebar
   (the settings nav included) reads it from here. */
export { GROUP, GROUP_LABEL, MENU, ROW, TIER } from "@/components/sidebar/scale"

/** Rows Recents shows before folding the rest into the project folders. */
const RECENT_COUNT = 8

/* ── Fixed nav ──
   The rows every screen of the app is one click from, above the list rather
   than in it: New thread and Search used to be two icon buttons beside the
   brand, which vanished in the collapsed rail — the one place a create
   affordance is needed most. As menu rows they collapse to icons with
   tooltips like everything else.

   Deliberately only the rows that start something. Plan usage used to sit here
   too, as a peak-percentage badge that polled `GET /api/quota` every ten
   minutes; it lives in Settings › Usage alone now. It was the one row that
   worked rather than navigated — it made the sidebar ask the server a question
   nobody had posed, on a timer, for a number that is only ever acted on by
   going to the page that shows it properly. */
export function SidebarNav({
  onNewThread,
  onSearch,
}: {
  onNewThread: () => void
  onSearch: () => void
}) {
  const location = useLocation()
  const navigate = useNavigate()
  const inBoard = location.pathname.startsWith("/board")
  return (
    <SidebarGroup className={GROUP}>
      <SidebarGroupContent>
        <SidebarMenu className={MENU}>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              tooltip={`New thread (${formatChord(KEYS.newThread)})`}
              onClick={onNewThread}
              className={ROW}
            >
              <SquarePen />
              <span>New thread</span>
              <Kbd chord={KEYS.newThread} />
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              tooltip={`Search threads and commands (${formatChord(KEYS.palette)})`}
              onClick={onSearch}
              className={ROW}
            >
              <SearchIcon />
              <span>Search</span>
              <Kbd chord={KEYS.palette} />
            </SidebarMenuButton>
          </SidebarMenuItem>
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
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

/** The chord, at the row's trailing edge, only while the row is hovered — a
    hint, not a label. Hidden in the icon rail, where the tooltip carries it. */
function Kbd({ chord }: { chord: string }) {
  return (
    <Shortcut
      chord={chord}
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
  const { state } = useStore()
  const navigate = useNavigate()
  const { isMobile, setOpenMobile } = useSidebar()
  return React.useCallback(
    (project: Project) => {
      const defaults = loadThreadDefaults()
      const start = resolveThreadStart(defaults, state.profiles)
      if (!start) return void navigate(settingsPath("projects"))
      const id = actions.newDraftThread({
        project,
        ...start,
        ...defaultsForProfile(defaults, start.profile.id),
      })
      if (isMobile) setOpenMobile(false)
      void navigate(threadPath(id))
    },
    [actions, state.profiles, navigate, isMobile, setOpenMobile]
  )
}

/* ── Per-thread status, with a stable identity ──
   The sidebar re-renders on every streamed token (`state.threads` changes),
   but the statuses it derives its sorting/filtering/grouping from almost
   never change with it. So the map is rebuilt per render (cheap — one pass,
   no parsing) and *reused by identity* when its contents are unchanged, which
   is what lets every derived-list memo and every memoized row below actually
   skip.

   The live thread is the truth about a running turn: SessionMeta.promptActive
   is a server snapshot refetched only on bootstrap and on mutations, so on
   its own it never lights up mid-turn. Fall back to it for threads this
   client has not connected yet — for those it is the only signal there is.
   Waiting on you: the agent raised a question (elicitation) or an approval
   (permission) that is still open. Only known for threads this client has
   connected, so best-effort — and correct whenever a tab has it open. */
function useThreadStatuses(
  sessions: SessionMeta[],
  threads: Record<string, LiveThreadState>
): Map<string, ThreadStatus> {
  const prev = React.useRef<Map<string, ThreadStatus>>(new Map())
  const next = new Map<string, ThreadStatus>()
  for (const session of sessions) {
    const thread = threads[session.id] as LiveThreadState | undefined
    const waiting = !!thread && (!!thread.permission || !!thread.elicitation)
    const running = thread?.turnActive ?? session.promptActive
    next.set(session.id, waiting ? "waiting" : running ? "running" : "idle")
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
}

/* ── The list ── */
export function ThreadSidebar({ actions }: { actions: Actions }) {
  const { state } = useStore()
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

  const statuses = useThreadStatuses(state.sessions, state.threads)
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
    const live = state.sessions
      .filter(isTopLevel)
      .filter((session) => !session.deletedAt)
      .filter((session) => {
        if (view.filter === "running") return statuses.get(session.id) === "running"
        if (view.filter === "waiting") return statuses.get(session.id) === "waiting"
        return true
      })
    const trashed = state.sessions
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
    const recent = view.sort === "recent" ? rest.slice(0, RECENT_COUNT) : []
    return { live, trashed, pinned, recent, filed: newestFirst }
  }, [state.sessions, statuses, pins, view.filter, view.sort])

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
      (id) => !state.projects.some((project) => project.id === id)
    )
    return { byProject, orphans }
  }, [filed, state.projects])

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
              : state.projects.length > 0
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
      {state.projects.length > 0 && !(filtered && nothingLive) && (
        <SidebarGroup className={cn(TIER, GROUP)}>
          <SidebarGroupLabel className={GROUP_LABEL}>
            <FolderIcon className="size-3 shrink-0" />
            <span className="truncate">Projects</span>
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className={MENU}>
              {state.projects.map((project) => (
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
          </SidebarGroupContent>
        </SidebarGroup>
      )}

      <ScheduledGroup actions={actions} />

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
