/* ── Notifications inbox ──
   There is NO server notification feed, and nothing here invents one. The
   harness has a single bearer token and no accounts, so there is no "you" for
   a notification to be addressed to: no assignee identity exists anywhere in
   the client (`ServerSettings.name` is the server's name, not a person's), so
   there is deliberately no "assigned to me" section.

   What the inbox IS: the attention list this device can honestly derive from
   data it already holds — the tasks of the boards that have been LOADED this
   session (`state.pmTasks`, filled by `actions.loadBoardTasks` when a board is
   opened). Fetching every board's tasks to draw a badge would be exactly the
   load-all-then-filter the whole PM module was built to avoid, so a board that
   has not been opened contributes nothing and the inbox says so in place of
   pretending it is empty.

   Four item kinds, one per task, most severe first:
     overdue      — due date before today, not done
     blocked      — waiting on an unfinished dependency (lib/pm/dependencies,
                    which is the server's own `blockedTaskIds`, cached per board)
     due_today    — due today, not done
     due_tomorrow — due tomorrow, not done

   Read state is device-local, in the `ui.pm.inboxReadAt` key lib/pm/prefs.ts
   already owns — one timestamp, no new key. An item carries `since`: the
   moment it ENTERED the feed (the due date it passed, the start of the day its
   due-soon window opened, the last change to a blocked task), always in the
   past, so "mark all read" clears exactly what is on screen and only something
   newly wrong comes back unread. */
import * as React from "react"
import { useNavigate } from "react-router"
import {
  AlertTriangle,
  CalendarClock,
  CalendarDays,
  CheckCheck,
  Inbox as InboxIcon,
  Lock,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { BoardDot, usePmActions } from "@/components/pm/pm-sidebar-panels"
import { dependencyGraph, hasDependencyGraph, loadDependencyGraph } from "@/lib/pm/dependencies"
import { inboxReadAt, markInboxRead, usePmPrefs } from "@/lib/pm/prefs"
import type { Board, BoardSummary, Task } from "@/lib/pm/types"
import { boardPath } from "@/lib/router"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

export type InboxKind = "overdue" | "blocked" | "due_today" | "due_tomorrow"

export interface InboxItem {
  /** `<kind>:<taskId>` — stable across renders, unique per row. */
  id: string
  kind: InboxKind
  boardId: string
  boardName: string
  boardColor: string | null
  task: Task
  /** Epoch ms this item entered the feed; compared against `ui.pm.inboxReadAt`. */
  since: number
  unread: boolean
}

/** Severity order — a task appears once, under the worst thing true of it. */
const KIND_ORDER: InboxKind[] = ["overdue", "blocked", "due_today", "due_tomorrow"]

const KIND_META: Record<InboxKind, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  overdue: { label: "Overdue", icon: AlertTriangle },
  blocked: { label: "Blocked", icon: Lock },
  due_today: { label: "Due today", icon: CalendarClock },
  due_tomorrow: { label: "Due tomorrow", icon: CalendarDays },
}

const DAY = 86_400_000

function dayStart(at: number): number {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** The board's definition of done, with `completedAt` as the fallback for a
    task whose column is not in the given config — the same rule
    epic-progress.tsx and the dashboard use. */
function makeIsDone(board: Board | BoardSummary): (task: Task) => boolean {
  const columns = "columns" in board && Array.isArray(board.columns) ? board.columns : []
  const done = new Set(columns.filter((column) => column.category === "done").map((c) => c.id))
  const known = new Set(columns.map((column) => column.id))
  return (task) =>
    known.has(task.columnId) ? done.has(task.columnId) : task.completedAt !== null
}

export interface BuildInboxOptions {
  /** Epoch ms the inbox was last marked read; defaults to the stored pref. */
  readAt?: number
  /** "Now" — injected so the build is a pure function in tests. */
  now?: number
  /** Blocked task ids per board; defaults to whatever lib/pm/dependencies has
      already cached (a board whose graph has never been fetched contributes no
      blocked items rather than triggering a fetch from a pure function). */
  blockedByBoard?: (boardId: string) => ReadonlySet<string> | undefined
}

const cachedBlocked = (boardId: string): ReadonlySet<string> | undefined =>
  hasDependencyGraph(boardId) ? new Set(dependencyGraph(boardId).blockedTaskIds) : undefined

/**
 * Derive the feed. Pure given its options — no fetching, no storage writes.
 * `tasksByBoard` is the store's `pmTasks`: only the boards loaded this session
 * are in it, and only those are represented.
 */
export function buildInbox(
  boards: Array<Board | BoardSummary>,
  tasksByBoard: Record<string, Task[]>,
  options: BuildInboxOptions = {}
): InboxItem[] {
  const now = options.now ?? Date.now()
  const readAt = options.readAt ?? inboxReadAt()
  const blockedFor = options.blockedByBoard ?? cachedBlocked
  const today = dayStart(now)
  const tomorrow = today + DAY
  const dayAfter = tomorrow + DAY

  const items: InboxItem[] = []
  for (const board of boards) {
    const tasks = tasksByBoard[board.id]
    if (!tasks || tasks.length === 0) continue
    const isDone = makeIsDone(board)
    const blocked = blockedFor(board.id)

    for (const task of tasks) {
      if (task.archivedAt !== null || task.deletedAt !== null) continue
      if (isDone(task)) continue

      let kind: InboxKind | null = null
      let since = 0
      const due = task.dueDate

      if (due !== null && due < today) {
        kind = "overdue"
        // It became overdue when its due date passed — a stable moment in the
        // past, so marking read actually silences it.
        since = due
      } else if (blocked?.has(task.id)) {
        kind = "blocked"
        since = task.updatedAt
      } else if (due !== null && due >= today && due < tomorrow) {
        kind = "due_today"
        since = today
      } else if (due !== null && due >= tomorrow && due < dayAfter) {
        kind = "due_tomorrow"
        // The warning opened this morning, not tomorrow: `since` must never be
        // in the future or the row could not be marked read.
        since = today
      }
      if (kind === null) continue

      items.push({
        id: `${kind}:${task.id}`,
        kind,
        boardId: board.id,
        boardName: board.name,
        boardColor: board.color,
        task,
        since,
        unread: since > readAt,
      })
    }
  }

  items.sort((a, b) => {
    const order = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
    if (order !== 0) return order
    const aDue = a.task.dueDate ?? a.since
    const bDue = b.task.dueDate ?? b.since
    if (aDue !== bDue) return aDue - bDue
    return a.task.key.localeCompare(b.task.key)
  })
  return items
}

/**
 * The live feed for this device. Reads the loaded boards out of the store and
 * the read mark out of prefs, so it re-renders when either moves.
 *
 * `loadGraphs` asks lib/pm/dependencies for the graph of each LOADED board —
 * cached ones resolve without a request, and the set is bounded by the boards
 * opened this session. The sidebar badge passes false: a count must not spawn
 * fetches.
 */
export function useInboxItems(opts: { loadGraphs?: boolean } = {}): InboxItem[] {
  const { state } = useStore()
  const prefs = usePmPrefs()
  const actions = usePmActions()
  const [graphVersion, setGraphVersion] = React.useState(0)
  const loadGraphs = opts.loadGraphs === true

  const loadedBoardIds = React.useMemo(
    () => state.boards.filter((board) => state.pmTasks[board.id]).map((board) => board.id),
    [state.boards, state.pmTasks]
  )
  const graphKey = loadedBoardIds.join(",")

  React.useEffect(() => {
    if (!loadGraphs || graphKey === "") return
    let live = true
    Promise.all(
      graphKey.split(",").map((boardId) =>
        loadDependencyGraph(actions, boardId).catch(() => null)
      )
    ).then(() => {
      // A stale graph is a missing "blocked" row, not a broken page — a
      // failure here is silent by design.
      if (live) setGraphVersion((version) => version + 1)
    })
    return () => {
      live = false
    }
  }, [actions, graphKey, loadGraphs])

  return React.useMemo(
    () => {
      void graphVersion // recompute when a graph lands
      return buildInbox(state.boards, state.pmTasks, { readAt: prefs.inboxReadAt })
    },
    [state.boards, state.pmTasks, prefs.inboxReadAt, graphVersion]
  )
}

/** Unread item count — what the sidebar's Inbox row badges. Cached graphs
    only: drawing a badge must never spawn a request. */
export function useInboxCount(): number {
  const items = useInboxItems()
  return React.useMemo(() => items.filter((item) => item.unread).length, [items])
}

export interface PmInboxProps {
  /** Defaults to the store's live boards; pass a narrower list to scope it. */
  boards?: Array<Board | BoardSummary>
  /** Where a row goes. Absent, it navigates to the task's board. */
  onOpenTask?(boardId: string, taskId: string): void
  className?: string
}

export function PmInbox({ boards, onOpenTask, className }: PmInboxProps) {
  const { state } = useStore()
  const navigate = useNavigate()
  const all = useInboxItems({ loadGraphs: true })

  const items = React.useMemo(() => {
    if (!boards) return all
    const allowed = new Set(boards.map((board) => board.id))
    return all.filter((item) => allowed.has(item.boardId))
  }, [all, boards])

  const unread = items.filter((item) => item.unread).length
  const loadedCount = state.boards.filter((board) => state.pmTasks[board.id]).length

  const open = React.useCallback(
    (item: InboxItem) => {
      if (onOpenTask) {
        onOpenTask(item.boardId, item.task.id)
        return
      }
      // No `?task=` deep link exists on the board route yet — this opens the
      // board and carries the id so it can be honoured once one does.
      void navigate(`${boardPath(item.boardId)}?task=${encodeURIComponent(item.task.id)}`)
    },
    [navigate, onOpenTask]
  )

  return (
    <div className={cn("flex min-h-0 flex-col gap-3", className)}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
            Inbox
            {unread > 0 && (
              <Badge variant="secondary" className="tabular-nums">
                {unread}
              </Badge>
            )}
          </h2>
          <p className="text-sm text-muted-foreground">
            What needs attention on the boards open in this session — overdue, blocked and due
            next. Read state is this device's.
          </p>
        </div>
        {items.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            disabled={unread === 0}
            onClick={() => markInboxRead()}
          >
            <CheckCheck />
            Mark all read
          </Button>
        )}
      </div>

      {items.length === 0 ? (
        <Empty className="border border-dashed bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <InboxIcon />
            </EmptyMedia>
            <EmptyTitle>{loadedCount === 0 ? "Nothing loaded yet" : "Nothing needs you"}</EmptyTitle>
            <EmptyDescription>
              {loadedCount === 0
                ? "The inbox is derived from the boards you have opened — open one and anything overdue, blocked or due next lands here."
                : "No overdue, blocked or imminent tasks on the boards open in this session."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.map((item) => (
            <InboxRow key={item.id} item={item} onOpen={open} />
          ))}
        </ul>
      )}
    </div>
  )
}

const InboxRow = React.memo(function InboxRow({
  item,
  onOpen,
}: {
  item: InboxItem
  onOpen(item: InboxItem): void
}) {
  const meta = KIND_META[item.kind]
  const Icon = meta.icon
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(item)}
        className={cn(
          "flex w-full items-center gap-3 rounded-lg border bg-card px-3 py-2 text-left transition-colors hover:bg-muted/60",
          item.unread && "ring-1 ring-ring/40"
        )}
      >
        <Icon
          className={cn(
            "size-4 shrink-0",
            item.kind === "overdue" ? "text-destructive" : "text-muted-foreground"
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{item.task.title}</span>
            {item.unread && (
              <span aria-label="Unread" className="size-1.5 shrink-0 rounded-full bg-primary" />
            )}
          </span>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <BoardDot color={item.boardColor} className="size-2" />
            <span className="truncate">{item.boardName}</span>
            <span aria-hidden>·</span>
            <span className="font-mono">{item.task.key}</span>
          </span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{meta.label}</span>
      </button>
    </li>
  )
})

export default PmInbox
