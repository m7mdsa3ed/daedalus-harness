/* ── The tab strip ──
   The desktop's open threads and pages, in the header row. A tab is a route: the
   address bar says which one is in front (`tabKeyFor`), a click navigates, and
   closing the one in front moves to its neighbour. Nothing here arranges
   anything — there is no dock — so the strip is a list: click, close, drag to
   reorder, and a + for a new thread.

   A thread's status is its title's colour (amber waiting on you, red failed)
   and a shimmer while a turn runs, the same words the sidebar row uses.

   The header is a drag region and a `pointer-events-none` overlay; the strip
   turns events back on for the tabs and leaves the empty run after them as the
   window's title bar. */
import * as React from "react"
import {
  BellIcon,
  CalendarClockIcon,
  FileTextIcon,
  FolderIcon,
  PlusIcon,
  RepeatIcon,
  RouteIcon,
  SettingsIcon,
  SquareKanbanIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react"
import { useLocation, useNavigate } from "react-router"

import { AgentIcon } from "@/components/entity-icon"
import { useChord } from "@/lib/keybindings"
import { formatChord } from "@/lib/shortcuts"
import { useSessionMeta, useStoreSelect } from "@/lib/store"
import { useThreadStatuses } from "@/lib/thread/statuses"
import type { ThreadActivity } from "@/lib/thread/phase"
import { cn } from "@/lib/utils"
import {
  closeTab,
  moveTab,
  pageKey,
  tabKeyFor,
  useTabs,
  type Tab,
} from "@/lib/workspace/tabs"

const PAGE_ICONS: Record<string, LucideIcon> = {
  settings: SettingsIcon,
  board: SquareKanbanIcon,
  routines: RepeatIcon,
  schedules: CalendarClockIcon,
  notifications: BellIcon,
  projects: FolderIcon,
}

function pageIcon(path: string): LucideIcon {
  const key = pageKey(path)
  if (key.endsWith("/trace")) return RouteIcon
  return PAGE_ICONS[key.split("/")[0]] ?? FileTextIcon
}

function Title({
  children,
  state,
}: {
  children: React.ReactNode
  state?: ThreadActivity
}) {
  return (
    <span
      className={cn(
        "min-w-0 flex-1 truncate text-left",
        state === "waiting" && "text-amber-700 dark:text-amber-400",
        state === "failed" && "text-destructive",
        state === "running" && "harness-shimmer [animation-duration:3.2s]!"
      )}
    >
      {children}
    </span>
  )
}

function TabItem({
  tab,
  active,
  state,
  title,
  onOpen,
  onClose,
  onDragStart,
  onDropOn,
}: {
  tab: Tab
  active: boolean
  state?: ThreadActivity
  title: string
  onOpen: () => void
  onClose: () => void
  onDragStart: () => void
  onDropOn: () => void
}) {
  const meta = useSessionMeta(tab.sessionId ?? "")
  const Icon = tab.sessionId ? null : pageIcon(tab.path)
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [active])
  return (
    <div
      ref={ref}
      role="tab"
      aria-selected={active}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move"
        onDragStart()
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault()
        onDropOn()
      }}
      // Middle click closes, as a browser's does.
      onAuxClick={(event) => {
        if (event.button === 1) {
          event.preventDefault()
          onClose()
        }
      }}
      className={cn(
        "group/tab pointer-events-auto relative flex h-[var(--dock-chip-h)] w-44 max-w-[14rem] min-w-24 shrink items-center gap-1.5 rounded-lg pr-1 pl-2.5 text-xs transition-colors [-webkit-app-region:no-drag]",
        active
          ? "bg-accent text-accent-foreground shadow-xs"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        title={title}
        className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch focus-visible:outline-none"
      >
        <span aria-hidden className="grid size-4 shrink-0 place-items-center">
          {tab.sessionId ? (
            <AgentIcon agentId={meta?.agentId} className="size-3.5" />
          ) : Icon ? (
            <Icon className="size-3.5" />
          ) : null}
        </span>
        <Title state={state}>{title}</Title>
      </button>
      <button
        type="button"
        tabIndex={-1}
        onClick={onClose}
        aria-label={`Close ${title}`}
        title={`Close ${title}`}
        className={cn(
          "grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 group-hover/tab:opacity-100",
          active && "opacity-60"
        )}
      >
        <XIcon className="size-3" />
      </button>
    </div>
  )
}

export function TabStrip({
  headingFor,
  onNewThread,
}: {
  headingFor: (path: string) => { crumb?: string; title: string } | null
  onNewThread: () => void
}) {
  const tabs = useTabs()
  const location = useLocation()
  const navigate = useNavigate()
  const statuses = useThreadStatuses()
  const titles = useThreadTitles()
  const newChord = useChord("newThread") ?? ""
  const activeKey = tabKeyFor(location.pathname, location.search)
  const dragging = React.useRef<string | null>(null)

  const close = (key: string) => {
    const next = closeTab(key, activeKey)
    if (next) void navigate(next)
  }

  return (
    <div role="tablist" aria-label="Open tabs" className="flex min-w-0 flex-1 items-center gap-0.5">
      <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
        {tabs.map((tab, index) => (
          <TabItem
            key={tab.key}
            tab={tab}
            active={tab.key === activeKey}
            state={tab.sessionId ? statuses.get(tab.sessionId) : undefined}
            title={
              tab.sessionId
                ? (titles(tab.sessionId) ?? "Thread")
                : (headingFor(tab.path)?.title ?? "Page")
            }
            onOpen={() => void navigate(tab.path)}
            onClose={() => close(tab.key)}
            onDragStart={() => {
              dragging.current = tab.key
            }}
            onDropOn={() => {
              if (dragging.current && dragging.current !== tab.key) moveTab(dragging.current, index)
              dragging.current = null
            }}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={onNewThread}
        title={`New thread${newChord ? ` (${formatChord(newChord)})` : ""}`}
        aria-label="New thread"
        className="pointer-events-auto grid size-[var(--dock-chip-h)] shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground [-webkit-app-region:no-drag]"
      >
        <PlusIcon className="size-4" />
      </button>
    </div>
  )
}

/** Titles for the strip, without subscribing it to every row's every change. */
function useThreadTitles(): (sessionId: string) => string | undefined {
  const sessions = useSessionsTitles()
  return React.useCallback((id: string) => sessions.get(id), [sessions])
}

function useSessionsTitles(): Map<string, string> {
  const sessions = useStoreSelect((state) => state.sessions)
  return React.useMemo(() => new Map(sessions.map((session) => [session.id, session.title])), [sessions])
}
