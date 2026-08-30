/* ── The main sidebar ──
   Laid out the way the Codex and Claude desktop apps lay theirs out, because
   that is the shape people arrive already knowing:

     ┌ brand row
     │ New thread · Search · Tasks        fixed nav, icon + label, always there
     ├ Pinned                             the ones you said matter
     │ Recents                            the newest few, flat, "Show more"
     │ Projects                           one folder per project, its threads
     │   ▸ harness              + ·       inside, + starts a thread *in* it
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
   list is shared, and one person's sidebar must not reorder another's). */
import * as React from "react"
import {
  CalendarClock,
  ChevronRight,
  Clock,
  ExternalLink,
  FolderIcon,
  Link as LinkIcon,
  ListFilter,
  MoreVertical,
  Pin,
  PinOff,
  Plus,
  SearchIcon,
  SquareKanban,
  SquarePen,
  Trash2,
  Undo2,
} from "lucide-react"
import { toast } from "sonner"
import { useLocation, useNavigate } from "react-router"
import { reportError } from "@/lib/errors"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { AgentIcon, ProjectIcon } from "@/components/entity-icon"
import { useConfirm } from "@/components/confirm-dialog"
import {
  ItemContextMenu,
  renderMenuItems,
  type MenuItemSpec,
} from "@/components/item-context-menu"
import type { Actions } from "@/lib/actions"
import { boardPath, currentThreadId, schedulePath, settingsPath, threadPath } from "@/lib/router"
import { markNewTab } from "@/lib/session-tabs"
import { togglePin, usePins } from "@/lib/pins"
import { formatChord, KEYS } from "@/lib/shortcuts"
import { type Project, type SessionMeta } from "@/lib/settings"
import { defaultsForProfile, loadThreadDefaults, resolveThreadStart } from "@/lib/thread-defaults"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

/* Group titles, not rows. A label used to be the same size, weight and colour
   as the threads under it, so "Recent" scanned as a thread called Recent.
   Smaller, uppercase, tracked out, and darker than the rows beneath — /80 over
   the sidebar surface keeps it legible while the rows stay full-strength.
   Shared by every sidebar group (the settings nav too) so the whole panel has
   one title voice. */
export const GROUP_LABEL =
  "flex h-7 gap-1.5 px-2 text-[11px] font-bold tracking-[0.06em] uppercase text-sidebar-foreground/80"

/* ── One spacing scale for the whole sidebar ──
   Every row, label and group in this panel draws from these, so nothing is
   a pixel off its neighbour:

     GROUP   the horizontal inset of a tier (`px-2`), no vertical padding of
             its own — TIER is the gap between tiers.
     LABEL   h-7 at the same `px-2` as a row, so label text and row icons
             share a left edge (GROUP_LABEL above).
     ROW     h-8, `px-2`, 13px text, `gap-2` between icon and title (from the
             menu-button base), every svg `size-4`. The one exception is the
             footer's two-line server row, which is h-11 on purpose.
     MENU    `gap-0.5` between rows — the base primitive's `gap-1` reads as
             a list of buttons, not an index.
     ACTION  a row's hover control (⋯, +) at `top-1.5 right-1`: centred in an
             h-8 row (the primitive's `top-1` for size=sm is for its h-7 rows).
             A folder row reserves `pr-8` for its + (the primitive's default);
             a thread row does NOT (`FLOAT_ROW`) — the title runs to the edge
             and the ⋯ floats over it on hover, painted in the row's own hover
             colour with a short fade on its leading edge (`FLOAT_ACTION`), so
             the text it covers ends softly instead of stopping 32px early on
             every row for a control that is only there when the pointer is.
     NEST    a folder's threads, indented so a child's icon sits under the
             folder's own — the border is the folder chevron's centre line. */
export const ROW = "h-8 px-2 text-[13px]"
export const MENU = "gap-0.5"
export const GROUP = "px-2 py-0"
export const TIER = "mt-3"
const ACTION = "top-1.5! right-1"
/* The thread row: no reserved gutter — see ACTION. The ⋯ then sits over the
   title, so it carries an opaque ground: `bg-sidebar-accent` is what the row
   itself is painted while hovered or active, the two states the button is
   visible in, so it reads as part of the row rather than a chip on it. The
   `before:` pseudo is the fade (the `after:` one is the primitive's touch
   target). */
const FLOAT_ROW = "pr-2!"
const FLOAT_ACTION = cn(
  ACTION,
  "bg-sidebar-accent hover:bg-sidebar-border",
  "before:pointer-events-none before:absolute before:top-0 before:right-full before:h-full before:w-5 before:bg-linear-to-l before:from-sidebar-accent before:to-transparent"
)
const NEST = "ml-4 border-l border-sidebar-border pl-2 py-0.5"

/** Rows Recents shows before folding the rest into the project folders. */
const RECENT_COUNT = 8

/** Rows a long-tail list (a project folder, Trash) shows before "Show more". */
const PROJECT_PAGE_SIZE = 6

/* ── Fixed nav ──
   The rows every screen of the app is one click from, above the list rather
   than in it: New thread and Search used to be two icon buttons beside the
   brand, which vanished in the collapsed rail — the one place a create
   affordance is needed most. As menu rows they collapse to icons with
   tooltips like everything else. */
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
    <kbd className="ml-auto hidden shrink-0 font-sans text-[10px] tracking-wide text-muted-foreground/70 opacity-0 transition-opacity group-hover/menu-button:opacity-100 sm:inline group-data-[collapsible=icon]:hidden">
      {formatChord(chord)}
    </kbd>
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
function useStartThreadIn(actions: Actions) {
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

/* ── The list ── */
export function ThreadSidebar({ actions }: { actions: Actions }) {
  const { state } = useStore()
  const pins = usePins()
  const view = useSidebarView()
  const startIn = useStartThreadIn(actions)

  /* The live thread is the truth about a running turn: SessionMeta.promptActive
     is a server snapshot refetched only on bootstrap and on mutations, so on
     its own it never lights up mid-turn. Fall back to it for threads this
     client has not connected yet — for those it is the only signal there is. */
  const running = (session: SessionMeta) =>
    state.threads[session.id]?.turnActive ?? session.promptActive
  /* Waiting on you: the agent raised a question (elicitation) or an approval
     (permission) that is still open. Only known for threads this client has
     connected, so best-effort — and correct whenever a tab has it open. */
  const waiting = (session: SessionMeta) => {
    const thread = state.threads[session.id]
    return !!thread && (!!thread.permission || !!thread.elicitation)
  }
  const status = (session: SessionMeta): ThreadStatus =>
    waiting(session) ? "waiting" : running(session) ? "running" : "idle"

  // Deleting is reversible, so a deleted thread leaves the tiers above but not
  // the sidebar: it drops into Trash until it is restored or purged.
  const live = state.sessions
    .filter((session) => !session.deletedAt)
    .filter((session) => {
      if (view.filter === "running") return status(session) === "running"
      if (view.filter === "waiting") return status(session) === "waiting"
      return true
    })
  const trashed = state.sessions
    .filter((session) => !!session.deletedAt)
    .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))

  const newestFirst = [...live].sort((a, b) => b.createdAt - a.createdAt)
  // Pinned keeps the order pins were added in, not the order threads were
  // created: the group you built by hand should stay where you put it.
  const pinned = pins
    .map((id) => newestFirst.find((session) => session.id === id))
    .filter((session): session is SessionMeta => !!session)
  const rest = newestFirst.filter((session) => !pins.includes(session.id))
  /* Recent first: a flat Recents list, and the folders hold what is older.
     By project: no Recents — every thread lives under its folder, which is
     the view for someone who thinks in projects rather than in time. */
  const recent = view.sort === "recent" ? rest.slice(0, RECENT_COUNT) : []
  const older = view.sort === "recent" ? rest.slice(RECENT_COUNT) : rest

  const byProject = new Map<string, SessionMeta[]>()
  for (const session of older) {
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

  const listProps = { actions, status }
  const filtered = view.filter !== "all"
  const nothingLive = live.length === 0

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
        <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Sort
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={view.sort}
          onValueChange={(value) => writeView({ sort: value as SidebarSort })}
        >
          <DropdownMenuRadioItem value="recent">Recent first</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="project">By project</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Show
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={view.filter}
          onValueChange={(value) => writeView({ filter: value as SidebarFilter })}
        >
          <DropdownMenuRadioItem value="all">All threads</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="running">Running</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="waiting">Needs you</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A project as a folder row: chevron, name, thread count; its threads
    indented under it when open, and a + on hover that starts a thread in it.
    Fold state is remembered under the project's id — the same key the older
    project groups used, so nothing anyone folded comes back open. */
function ProjectFolder({
  id,
  name,
  logoUrl,
  sessions,
  onNewThread,
  actions,
  status,
}: {
  id: string
  name: string
  logoUrl?: string
  sessions: SessionMeta[]
  /** Absent for "Other" — a project that no longer exists cannot host one. */
  onNewThread?: () => void
  actions: Actions
  status: (session: SessionMeta) => ThreadStatus
}) {
  const [open, setOpen] = React.useState(() => !collapsedGroups().includes(id))
  const toggle = (next: boolean) => {
    setOpen(next)
    rememberFold(id, next, true)
  }
  const location = useLocation()
  const activeThreadId = currentThreadId(location.pathname, location.search)
  const holdsActive = sessions.some((session) => session.id === activeThreadId)

  return (
    <SidebarMenuItem>
      <Collapsible open={open} onOpenChange={toggle}>
        <CollapsibleTrigger
          render={
            <SidebarMenuButton
              size="sm"
              tooltip={name}
              /* The folder takes the active tint only while closed over the
                 routed thread — a pointer to where you are that the row
                 itself, being hidden, cannot give. */
              isActive={!open && holdsActive}
              className={cn(ROW, "text-sidebar-foreground/90")}
            />
          }
        >
          {/* Chevron leads, as in a file tree: it is the fold control, and
              leading keeps the trailing corner free for the count and the
              hover +. In the icon rail only the folder survives. */}
          <ChevronRight
            aria-hidden
            className={cn(
              "text-muted-foreground transition-transform duration-200 group-data-[collapsible=icon]:hidden",
              open && "rotate-90"
            )}
          />
          {/* The project's mark — the same one the pickers and the settings
              list draw, so a project is recognisable by its picture wherever
              it is named. "Other" has no project to draw. */}
          {onNewThread ? (
            <ProjectIcon project={{ name, logoUrl }} className="size-4" />
          ) : (
            <FolderIcon className="text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate">{name}</span>
          {sessions.length > 0 && (
            <span className="shrink-0 text-[11px] text-muted-foreground/70 tabular-nums transition-opacity group-hover/menu-item:opacity-0 group-data-[collapsible=icon]:hidden">
              {sessions.length}
            </span>
          )}
        </CollapsibleTrigger>
        {onNewThread && (
          <SidebarMenuAction
            showOnHover
            title={`New thread in ${name}`}
            onClick={onNewThread}
            className={ACTION}
          >
            <Plus />
            <span className="sr-only">New thread in {name}</span>
          </SidebarMenuAction>
        )}
        <CollapsibleContent className="harness-collapse group-data-[collapsible=icon]:hidden">
          <div className={NEST}>
            {sessions.length === 0 ? (
              <p className="flex h-8 items-center px-2 text-[11px] text-muted-foreground">
                {onNewThread ? "No threads yet" : "Empty"}
              </p>
            ) : (
              <ThreadList
                sessions={sessions}
                actions={actions}
                status={status}
                limit={PROJECT_PAGE_SIZE}
              />
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </SidebarMenuItem>
  )
}

/** "In 3 days" / "every day" style line for a schedule. */
function scheduleWhen(nextAt: number, everyMs: number | null): string {
  const when = new Date(nextAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
  if (everyMs === null) return when
  const every =
    everyMs >= 7 * 24 * 60 * 60_000
      ? `${Math.round(everyMs / (7 * 24 * 60 * 60_000))} week(s)`
      : everyMs >= 24 * 60 * 60_000
        ? `${Math.round(everyMs / (24 * 60 * 60_000))} day(s)`
        : everyMs >= 60 * 60_000
          ? `${Math.round(everyMs / (60 * 60_000))} hour(s)`
          : `${Math.round(everyMs / 60_000)} min`
  return `${when} · every ${every}`
}

/** Upcoming prompts the server will deliver even with no browser open — the
    sidebar's "Automations". It names the thread it will land in, so its row
    opens that thread. Shown even when empty, because a section that hides
    itself is also the one place nobody can find to create the first item;
    the + on the label reuses the schedule page and its picker, which is why
    it needs a live thread to exist at all. */
function ScheduledGroup({ actions }: { actions: Actions }) {
  const { state } = useStore()
  const navigate = useNavigate()
  const location = useLocation()
  const { isMobile, setOpenMobile } = useSidebar()
  const confirm = useConfirm()

  const live = state.sessions.filter((s) => !s.draft && !s.deletedAt)

  const cancel = async (id: string) => {
    if (
      !(await confirm({
        title: "Cancel this scheduled message?",
        destructive: true,
        confirmLabel: "Cancel schedule",
      }))
    )
      return
    actions.cancelSchedule(id).catch((err) => reportError(err, "Couldn't cancel the schedule"))
  }

  const open = (sessionId: string) => {
    if (isMobile) setOpenMobile(false)
    void navigate(threadPath(sessionId))
  }

  const titleOf = (sessionId: string) =>
    state.sessions.find((s) => s.id === sessionId)?.title ?? "Unknown thread"

  return (
    <FoldableGroup
      groupKey="__scheduled"
      label="Scheduled"
      icon={<CalendarClock className="size-3 shrink-0" />}
      count={state.scheduled.length > 0 ? state.scheduled.length : undefined}
      action={
        live.length > 0 && (
          <button
            type="button"
            title="New schedule"
            onClick={() =>
              void navigate(schedulePath(live[0].id), {
                state: { returnTo: location.pathname + location.search },
              })
            }
            className="grid size-4 place-items-center rounded-sm text-muted-foreground transition-colors hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus className="size-3.5" />
            <span className="sr-only">New schedule</span>
          </button>
        )
      }
    >
      {state.scheduled.length === 0 ? (
        <p className="px-2 py-2 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
          {live.length > 0
            ? "Nothing scheduled. + adds a prompt the server sends later."
            : "Nothing scheduled — open a thread first."}
        </p>
      ) : (
        <SidebarMenu className={MENU}>
          {state.scheduled.map((item) => (
            <SidebarMenuItem key={item.id}>
              <SidebarMenuButton
                tooltip={`${titleOf(item.sessionId)} — ${scheduleWhen(item.nextAt, item.everyMs)}`}
                onClick={() => open(item.sessionId)}
                className="h-auto min-h-8 px-2 py-1 text-[13px]"
              >
                {/* Two lines, because the message is the schedule's payload:
                    a row that showed only the thread could not tell two
                    schedules apart. */}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] leading-tight">
                    {titleOf(item.sessionId)}
                  </span>
                  <span className="block truncate text-[10px] leading-tight text-muted-foreground">
                    {item.text} · {scheduleWhen(item.nextAt, item.everyMs)}
                  </span>
                </span>
              </SidebarMenuButton>
              <SidebarMenuAction
                showOnHover
                title="Cancel schedule"
                onClick={() => void cancel(item.id)}
                className={ACTION}
              >
                <Trash2 />
                <span className="sr-only">Cancel schedule</span>
              </SidebarMenuAction>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      )}
    </FoldableGroup>
  )
}

/* Which groups are folded, on this device. One list for every foldable thing —
   a project folder is keyed by its id, Trash by a name no project can have —
   so the sidebar has one fold memory rather than one per kind of group. */
const COLLAPSED_KEY = "ui.collapsedProjects"

function collapsedGroups(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as unknown
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : []
  } catch {
    return []
  }
}

function rememberFold(key: string, open: boolean, defaultOpen: boolean) {
  /* Only the *departure* from the default is stored, so a group that defaults
     closed (Trash) does not need a row in the list to stay closed — and one
     that defaults open does not need one to stay open. */
  const collapsed = collapsedGroups().filter((id) => id !== key)
  if (open !== defaultOpen) collapsed.push(key)
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed))
  } catch {
    // A forgotten fold is not worth throwing out of a click handler.
  }
}

/** A foldable sidebar tier. Open/closed is remembered per key. */
function FoldableGroup({
  groupKey,
  label,
  icon,
  count,
  defaultOpen = true,
  action,
  children,
}: {
  groupKey: string
  label: string
  icon?: React.ReactNode
  /** Printed next to the label when the number is something you act on. */
  count?: number
  defaultOpen?: boolean
  /** A control that belongs to the group itself, not to a row in it — the
      Scheduled group's "+ new". Rendered only on hover, in the slot just
      before the chevron (where the count sits, which yields to it exactly as
      a project folder's count yields to its hover +), so the chevron itself
      stays put and behaves like every other group's. It cannot live inside
      the label, because the label is the fold trigger and a button in a
      button folds and fires at once. */
  action?: React.ReactNode
  children: React.ReactNode
}) {
  const [open, setOpen] = React.useState(
    () => collapsedGroups().includes(groupKey) !== defaultOpen
  )

  const toggle = (next: boolean) => {
    setOpen(next)
    rememberFold(groupKey, next, defaultOpen)
  }

  return (
    <Collapsible open={open} onOpenChange={toggle}>
      <SidebarGroup className={cn(TIER, GROUP)}>
        {/* The header row is the hover group, not the label: the action is
            the label's sibling (see above), and a `group-hover` on the label
            alone never reached it. */}
        <div className="group/label relative">
          {action && (
            /* right = label px-2 + chevron size-4 + label gap-1.5. */
            <div className="absolute top-1.5 right-[30px] z-10 flex opacity-0 transition-opacity duration-150 group-hover/label:opacity-100 focus-within:opacity-100 group-data-[collapsible=icon]:hidden">
              {action}
            </div>
          )}
          <CollapsibleTrigger
            render={
              <SidebarGroupLabel
                className={cn(GROUP_LABEL, "hover:text-sidebar-foreground/70")}
              />
            }
          >
            {icon}
            <span className="truncate">{label}</span>
            {count != null && (
              <span
                className={cn(
                  "ml-auto tabular-nums opacity-70 transition-opacity duration-150",
                  action && "group-hover/label:opacity-0 group-focus-within/label:opacity-0"
                )}
              >
                {count}
              </span>
            )}
            <ChevronRight
              aria-hidden
              className={cn(
                "shrink-0 transition-transform duration-200",
                count == null && "ml-auto",
                open && "rotate-90"
              )}
            />
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent className="harness-collapse">
          <SidebarGroupContent>{children}</SidebarGroupContent>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
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

type ThreadStatus = "idle" | "running" | "waiting"

function ThreadList({
  sessions,
  actions,
  status,
  trash = false,
  limit,
}: {
  sessions: SessionMeta[]
  actions: Actions
  status: (session: SessionMeta) => ThreadStatus
  /** Rendering the Trash: these threads are deleted, so the row restores
      instead of opening and the menu offers the two ways back out. */
  trash?: boolean
  /** Show this many rows and a "Show more" toggle under them. For the long
      tail — a folder with last winter's threads in it — not for Pinned or
      Recents, which are short by construction. */
  limit?: number
}) {
  /* Expansion is deliberately not persisted: the reveal answers "is what I am
     looking for down there?" and the answer resets the next visit. */
  const [expanded, setExpanded] = React.useState(false)
  const visible = limit && !expanded ? sessions.slice(0, limit) : sessions
  const hidden = sessions.length - visible.length
  const location = useLocation()
  const navigate = useNavigate()
  const activeThreadId = currentThreadId(location.pathname, location.search)
  const confirm = useConfirm()
  const pins = usePins()
  const { isMobile, setOpenMobile } = useSidebar()

  /* Delete stops the agent and moves the thread to Trash. Recoverable, but not
     free — the process dies and a running turn dies with it — so it asks, and
     the toast still offers the one-click way back. */
  const remove = async (session: SessionMeta) => {
    /* A draft was never started: no process to stop, no server row, and nothing
       for Trash to hold. Discarding it is the whole operation. */
    if (session.draft) {
      if (
        !(await confirm({
          title: "Discard this thread?",
          description:
            "It was never started, so there is no agent to stop and nothing to restore afterwards.",
          confirmLabel: "Discard",
          destructive: true,
        }))
      )
        return
      if (activeThreadId === session.id) void navigate("/")
      void actions.deleteThread(session.id)
      return
    }
    if (
      !(await confirm({
        title: `Delete "${session.title}"?`,
        description:
          "The agent process is stopped and the thread moves to Trash, where it can be restored.",
        confirmLabel: "Delete",
        destructive: true,
      }))
    )
      return
    // Leave the route first: a deleted thread has no page to show.
    if (activeThreadId === session.id) void navigate("/")
    actions
      .deleteThread(session.id)
      .then(() =>
        toast("Moved to Trash", {
          description: session.title,
          action: {
            label: "Undo",
            onClick: () => {
              actions
                .restoreThread(session.id)
                .catch((err) => reportError(err, "Couldn't restore the thread"))
            },
          },
        })
      )
      .catch((err) => reportError(err, "Couldn't delete the thread"))
  }

  const restore = (session: SessionMeta) => {
    actions.restoreThread(session.id).catch((err) => reportError(err, "Couldn't restore the thread"))
  }

  const purge = async (session: SessionMeta) => {
    if (
      !(await confirm({
        title: `Delete "${session.title}" forever?`,
        description:
          "The harness forgets this thread. Only the agent's own transcript file would still have the conversation.",
        confirmLabel: "Delete forever",
        destructive: true,
      }))
    )
      return
    actions.purgeThread(session.id).catch((err) => reportError(err, "Couldn't delete the thread"))
  }

  const open = (session: SessionMeta, newTab = false) => {
    if (isMobile) setOpenMobile(false)
    if (newTab) markNewTab()
    void navigate(threadPath(session.id))
  }

  return (
    <SidebarMenu className={MENU}>
      {visible.map((session) => {
        const pinned = pins.includes(session.id)
        const state = trash ? "idle" : status(session)
        /* One list feeds both the hover dropdown and the right-click menu. */
        const items = trash
          ? trashMenuItems(session, restore, purge)
          : threadMenuItems(session, pinned, {
              openInNewTab: () => open(session, true),
              onDelete: remove,
            })
        return (
          <ThreadRow
            key={session.id}
            session={session}
            items={items}
            state={state}
            trash={trash}
            active={activeThreadId === session.id}
            onOpen={(newTab) => open(session, newTab)}
          />
        )
      })}
      {/* One toggle row, styled as a quieter thread row rather than a button —
          it expands the index you are already scanning. */}
      {hidden > 0 && (
        <SidebarMenuItem>
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-data-[collapsible=icon]:hidden"
          >
            <ChevronRight
              aria-hidden
              className={cn("size-4 shrink-0 transition-transform duration-200", expanded && "rotate-90")}
            />
            <span>{expanded ? "Show less" : `Show ${hidden} more`}</span>
          </button>
        </SidebarMenuItem>
      )}
    </SidebarMenu>
  )
}

/** How long a finger has to rest on a row before it is a press, not a tap. */
const LONG_PRESS_MS = 450

/** Hover has to rest this long before the card opens — a pointer crossing
    the list on its way somewhere else must not flash six cards. */
const HOVER_DELAY_MS = 500

/** One thread, one line. The title and — when there is one — a status dot;
    nothing else on the row. The info card is one popover: on desktop it opens
    on hover (Base UI's `openOnHover`, so it also closes when the pointer
    leaves both row and card); on a phone a long press opens it, with the
    row's actions under the card standing in for the right-click menu. */
function ThreadRow({
  session,
  items,
  state,
  trash,
  active,
  onOpen,
}: {
  session: SessionMeta
  items: MenuItemSpec[]
  state: ThreadStatus
  trash: boolean
  active: boolean
  onOpen: (newTab: boolean) => void
}) {
  const { isMobile } = useSidebar()
  const [infoOpen, setInfoOpen] = React.useState(false)
  /* The press in flight: its timer, and whether it fired. `fired` outlives
     the timer because the click that ends a long press arrives *after*
     pointerup, and that click must open the card's row nowhere. */
  const press = React.useRef<{ timer: number; fired: boolean } | null>(null)

  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current.timer)
  }
  const startPress = (event: React.PointerEvent) => {
    if (event.pointerType === "mouse") return
    cancelPress()
    const current = { fired: false, timer: 0 }
    current.timer = window.setTimeout(() => {
      current.fired = true
      setInfoOpen(true)
    }, LONG_PRESS_MS)
    press.current = current
  }
  const click = (event: React.MouseEvent) => {
    if (press.current?.fired) {
      press.current.fired = false
      event.preventDefault()
      return
    }
    onOpen(event.metaKey || event.ctrlKey)
  }

  const row = (
    <>
      {/* A running turn is the title itself shimmering — the pale band that
          the working line and a live thought already use — rather than a dot
          beside it: the row *is* the thing in motion. A thread waiting on you
          keeps the amber dot at the trailing edge — the floating ⋯ covers it
          while the pointer is on the row, which is fine: it is the one row
          you must act on, and a still mark is what says "stopped, for you". */}
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          (session.exited || trash) && "text-muted-foreground",
          trash && "line-through",
          state === "running" && "harness-shimmer"
        )}
      >
        {session.title}
      </span>
      {state === "waiting" && (
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-amber-500" />
      )}
    </>
  )
  const button = (
    <SidebarMenuButton
      size="sm"
      isActive={active}
      onClick={click}
      onPointerDown={startPress}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onPointerLeave={cancelPress}
      /* A finger resting on the row must not also raise the browser's own
         callout or the native context menu — the popover is the long press. */
      onContextMenu={(event) => {
        if (isMobile) event.preventDefault()
      }}
      className={cn(ROW, FLOAT_ROW, isMobile && "select-none [-webkit-touch-callout:none]")}
    />
  )
  const card = <ThreadInfoCard session={session} state={state} trash={trash} />

  return (
    <SidebarMenuItem>
      <Popover
        open={infoOpen}
        onOpenChange={(open, details) => {
          /* A tap or click on the row is navigation, never a toggle — the
             popover's own press handling is ignored. Hover opens are Base
             UI's (desktop); a long press sets the state itself (mobile). */
          if (open && details.reason === "trigger-press") return
          setInfoOpen(open)
        }}
      >
        {isMobile ? (
          <PopoverTrigger render={button}>{row}</PopoverTrigger>
        ) : (
          <ItemContextMenu items={items}>
            <PopoverTrigger render={button} openOnHover delay={HOVER_DELAY_MS}>
              {row}
            </PopoverTrigger>
          </ItemContextMenu>
        )}
        <PopoverContent
          side={isMobile ? "bottom" : "right"}
          align="start"
          sideOffset={8}
          className="w-72 gap-3 p-3"
        >
          {card}
          {isMobile && (
            <div className="flex flex-col gap-0.5 border-t border-border/60 pt-2">
              {items.map((item, index) =>
                item.type === "separator" ? null : (
                  <button
                    key={index}
                    type="button"
                    disabled={item.disabled}
                    onClick={() => {
                      setInfoOpen(false)
                      item.onClick()
                    }}
                    className={cn(
                      "flex h-8 items-center gap-2 rounded-lg px-2 text-[13px] hover:bg-accent disabled:opacity-50 [&>svg]:size-4 [&>svg]:shrink-0",
                      item.destructive && "text-destructive"
                    )}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </button>
                )
              )}
            </div>
          )}
        </PopoverContent>
      </Popover>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <SidebarMenuAction showOnHover title={`Actions for ${session.title}`} className={FLOAT_ACTION}>
              <MoreVertical />
            </SidebarMenuAction>
          }
        />
        <DropdownMenuContent side="right" align="start" className="w-44">
          {renderMenuItems(items, { Item: DropdownMenuItem, Separator: DropdownMenuSeparator })}
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  )
}

/** What the row no longer says: the thread's status, who runs it and where,
    and when it began. */
function ThreadInfoCard({
  session,
  state,
  trash,
}: {
  session: SessionMeta
  state: ThreadStatus
  trash: boolean
}) {
  const { state: store } = useStore()
  const project = store.projects.find((p) => p.id === session.projectId)
  const profile = store.profiles.find((p) => p.id === session.profileId)?.name
  const agent = store.agents.find((a) => a.id === session.agentId)?.name ?? session.agentId
  const when = (ts: number) =>
    new Date(ts).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
  const status = trash
    ? "In Trash"
    : state === "waiting"
      ? "Needs you"
      : state === "running"
        ? "Running"
        : session.exited
          ? "Stopped"
          : session.draft
            ? "Not started"
            : "Idle"
  const rows: [string, React.ReactNode][] = [
    ["Status", status],
    [
      "Agent",
      <span key="agent" className="flex items-center gap-1.5">
        <AgentIcon agentId={session.agentId} className="size-3.5" />
        {agent}
      </span>,
    ],
    ["Profile", profile ?? "—"],
    ["Model", [session.model, session.effort].filter(Boolean).join(" · ") || "Agent's own"],
    [
      "Project",
      <span key="project" className="flex items-center gap-1.5">
        {project && <ProjectIcon project={project} className="size-3.5" />}
        {project?.name ?? "Other"}
      </span>,
    ],
    ["Started", when(session.createdAt)],
  ]
  if (trash && session.deletedAt) rows.push(["Deleted", when(session.deletedAt)])
  return (
    <div className="flex flex-col gap-2 text-left text-xs">
      <p className="text-[13px] font-medium leading-snug">{session.title}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {rows.map(([label, value]) => (
          <React.Fragment key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 truncate">{value}</dd>
          </React.Fragment>
        ))}
      </dl>
    </div>
  )
}

/** The row menu for a live thread — Trash rows get their own two items. */
function threadMenuItems(
  session: SessionMeta,
  pinned: boolean,
  handlers: {
    openInNewTab: () => void
    onDelete: (session: SessionMeta) => void
  }
): MenuItemSpec[] {
  return [
    {
      label: pinned ? "Unpin" : "Pin to top",
      icon: pinned ? <PinOff /> : <Pin />,
      onClick: () => togglePin(session.id),
    },
    { label: "Open in new tab", icon: <ExternalLink />, onClick: handlers.openInNewTab },
    {
      label: "Copy link",
      icon: <LinkIcon />,
      onClick: () => {
        navigator.clipboard
          .writeText(new URL(threadPath(session.id), window.location.origin).toString())
          .then(() => toast.success("Link copied"))
          .catch((err) => reportError(err, "Couldn't copy the link"))
      },
    },
    { type: "separator" },
    {
      label: "Delete",
      icon: <Trash2 />,
      destructive: true,
      onClick: () => handlers.onDelete(session),
    },
  ]
}

function trashMenuItems(
  session: SessionMeta,
  restore: (session: SessionMeta) => void,
  purge: (session: SessionMeta) => void
): MenuItemSpec[] {
  return [
    { label: "Restore", icon: <Undo2 />, onClick: () => restore(session) },
    { type: "separator" },
    {
      label: "Delete forever",
      icon: <Trash2 />,
      destructive: true,
      onClick: () => purge(session),
    },
  ]
}
