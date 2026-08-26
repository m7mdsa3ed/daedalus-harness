/* ── One board ──
   The route `/b/:boardId/:view?` renders this. It is the only thing in the PM
   module that fetches a board: the views under it are pure layout over the
   tasks it hands them (PmViewProps), and every one of them narrows the SAME
   loaded list through `applyFilters` here — switching Kanban→Table or typing in
   the filter bar is not a round trip.

   Ownership, so no view has to guess:
     - the board + its tasks (actions.loadBoard / loadBoardTasks)
     - the current view (URL segment wins, else this device's last choice)
     - the FilterSpec, and the memoized filtered list
     - which task is open in the editor, and the new-task dialog */
import * as React from "react"
import { useNavigate, useParams } from "react-router"
import { toast } from "sonner"
import {
  Archive,
  CalendarDays,
  ChartNoAxesColumn,
  ChevronDown,
  Copy,
  Flag,
  GanttChart,
  LayoutDashboard,
  ListOrdered,
  MoreHorizontal,
  Pencil,
  Plus,
  Settings2,
  SquareKanban,
  Table2,
  Rows3,
  Trash2,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { useConfirm } from "@/components/confirm-dialog"
import { FilterBar } from "@/components/pm/filter-bar"
import { NewTaskDialog } from "@/components/pm/new-task-dialog"
import { TaskEditor } from "@/components/pm/task/task-editor"
import { BoardDot, usePmActions } from "@/components/pm/pm-sidebar-panels"
import { BoardSettingsDialog } from "@/components/pm/settings/board-settings-dialog"
import { MilestoneDialog } from "@/components/pm/settings/milestone-editor"
import { SprintDialog } from "@/components/pm/settings/sprint-editor"
import { BoardTemplateDialog, saveBoardAsTemplate } from "@/components/pm/settings/template-flows"
import BurndownChart from "@/components/pm/charts/burndown-chart"
import VelocityChart from "@/components/pm/charts/velocity-chart"
import BacklogView from "@/components/pm/views/backlog-view"
import CalendarView from "@/components/pm/views/calendar-view"
import DashboardView from "@/components/pm/views/dashboard-view"
import KanbanView from "@/components/pm/views/kanban-view"
import ListView from "@/components/pm/views/list-view"
import TableView from "@/components/pm/views/table-view"
import TimelineView from "@/components/pm/views/timeline-view"
import { describeError, reportError } from "@/lib/errors"
import { useBlockedTaskIds, useDependencyGraph } from "@/lib/pm/dependencies"
import { applyFilters } from "@/lib/pm/filtering"
import { boardView, setBoardView } from "@/lib/pm/prefs"
import { VIEW_NAMES, type Board, type FilterSpec, type Sprint, type ViewName } from "@/lib/pm/types"
import { boardPath, pendingCreate, tasksPath } from "@/lib/router"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

/** Every name in `VIEW_NAMES` is built as of W5 — the placeholder below is
    kept for a board whose `defaultView` came from a newer server. */
const BUILT_VIEWS = [
  "kanban",
  "list",
  "table",
  "backlog",
  "calendar",
  "timeline",
  "dashboard",
] as const
type BuiltView = (typeof BUILT_VIEWS)[number]

const VIEW_TABS: Array<{ id: BuiltView; label: string; icon: React.ElementType }> = [
  { id: "kanban", label: "Kanban", icon: SquareKanban },
  { id: "list", label: "List", icon: Rows3 },
  { id: "table", label: "Table", icon: Table2 },
  { id: "backlog", label: "Backlog", icon: ListOrdered },
  { id: "calendar", label: "Calendar", icon: CalendarDays },
  { id: "timeline", label: "Timeline", icon: GanttChart },
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
]

/** The sprint selector's "everything" option. `FilterSpec.sprint` is absent for
    all sprints and the literal "none" for the backlog, so the empty string is
    only ever the <select>'s own value, never a filter. */
const ALL_SPRINTS = ""

const isViewName = (value: string | undefined): value is ViewName =>
  !!value && (VIEW_NAMES as readonly string[]).includes(value)

const isBuilt = (view: ViewName): view is BuiltView =>
  (BUILT_VIEWS as readonly string[]).includes(view)

/** Keystrokes are for the board, not for the field you are typing in. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable ||
    !!target.closest("[role=dialog]")
  )
}

export default function PmPage() {
  const params = useParams()
  const boardId = params.boardId ?? ""
  const navigate = useNavigate()
  const actions = usePmActions()
  const { state } = useStore()
  const confirm = useConfirm()

  const board = state.boards.find((entry) => entry.id === boardId)
  const tasks = state.pmTasks[boardId]

  const [status, setStatus] = React.useState<"loading" | "ready" | "missing" | "failed">("loading")
  const [filter, setFilter] = React.useState<FilterSpec>({})
  const [openTaskId, setOpenTaskId] = React.useState<string | null>(null)
  const [newTaskOpen, setNewTaskOpen] = React.useState(false)
  /** Set when the create was started from a lane — that lane is the default. */
  const [newTaskColumnId, setNewTaskColumnId] = React.useState<string | undefined>()
  /** Set when the create was started from a backlog lane: `null` is the
      backlog itself, `undefined` is "no opinion". */
  const [newTaskSprintId, setNewTaskSprintId] = React.useState<string | null | undefined>()
  const [renameOpen, setRenameOpen] = React.useState(false)
  /** `null` = closed, `{ sprint: null }` = create — the backlog view's idiom. */
  const [sprintDialog, setSprintDialog] = React.useState<{ sprint: Sprint | null } | null>(null)
  const [reportsOpen, setReportsOpen] = React.useState(false)
  const [milestonesOpen, setMilestonesOpen] = React.useState(false)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [templatesOpen, setTemplatesOpen] = React.useState(false)
  const filterInputRef = React.useRef<HTMLInputElement>(null)

  /* One board at a time: the filter and the open editor belong to the board
     they were opened on, so a route change resets them. */
  React.useEffect(() => {
    setFilter({})
    setOpenTaskId(null)
  }, [boardId])

  React.useEffect(() => {
    if (!boardId) return
    let cancelled = false
    setStatus("loading")
    Promise.all([actions.loadBoard(boardId), actions.loadBoardTasks(boardId)])
      .then(() => {
        if (!cancelled) setStatus("ready")
      })
      .catch((err) => {
        if (cancelled) return
        // A board that is gone is a page state, not a toast: the route is the
        // thing that is wrong and the way out is a link, not a dismissal.
        if (describeError(err).code === 404) return setStatus("missing")
        setStatus("failed")
        reportError(err, "Couldn't open the board")
      })
    return () => {
      cancelled = true
    }
  }, [boardId, actions])

  /* ⌘K and the sidebar ask for "new task" by navigating with ?new=task — the
     dialog lives here, so the param is consumed here and stripped. `?task=<id>`
     is the same idea for opening one: the palette's search hits, the inbox and
     the dashboard all address a task by URL, and the editor lives here. */
  React.useEffect(() => {
    const params = new URLSearchParams(location.search)
    const wanted = params.get("task")
    const create = pendingCreate(location.search) === "task"
    if (!wanted && !create) return
    if (create) {
      setNewTaskColumnId(undefined)
      setNewTaskSprintId(undefined)
      setNewTaskOpen(true)
    }
    if (wanted) setOpenTaskId(wanted)
    void navigate(location.pathname, { replace: true })
  }, [navigate])

  const urlView = isViewName(params.view) ? params.view : undefined
  const view: ViewName = urlView ?? boardView(boardId) ?? board?.defaultView ?? "kanban"

  // The URL is the stronger opinion — arriving on one is also choosing it.
  React.useEffect(() => {
    if (urlView && boardId) setBoardView(boardId, urlView)
  }, [urlView, boardId])

  const goToView = (next: ViewName) => {
    setBoardView(boardId, next)
    void navigate(boardPath(boardId, next))
  }

  const openTask = React.useCallback((id: string) => setOpenTaskId(id), [])

  const filtered = React.useMemo(() => applyFilters(tasks ?? [], filter), [tasks, filter])

  /* Dependencies are join rows the board fetch does not carry, and four
     surfaces want the same answer (the badges on cards and rows, the
     timeline's arrows, the editor's Blockers tab). Fetched ONCE per board here
     — never per card — and shared through lib/pm/dependencies. */
  const graph = useDependencyGraph(actions, boardId)
  const blockedTaskIds = useBlockedTaskIds(graph)

  /* The names actually in use on this board — the assignee picker has nothing
     else to offer, there being no accounts to enumerate. */
  const assigneeOptions = React.useMemo(() => {
    const names = new Set<string>()
    for (const task of tasks ?? []) for (const name of task.assignees) names.add(name)
    return [...names].sort((a, b) => a.localeCompare(b))
  }, [tasks])

  /* N = new task, / = the filter field. Bound on the page, not the window's
     lifetime — another route's N is not this one's. */
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isTypingTarget(event.target)) return
      if (event.key === "n" || event.key === "N") {
        event.preventDefault()
        setNewTaskColumnId(undefined)
        setNewTaskSprintId(undefined)
        setNewTaskOpen(true)
      } else if (event.key === "/") {
        event.preventDefault()
        filterInputRef.current?.focus()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  if (!boardId || status === "missing") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SquareKanban />
            </EmptyMedia>
            <EmptyTitle>No such board</EmptyTitle>
            <EmptyDescription>
              It was deleted, purged, or the link is from another harness.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" onClick={() => void navigate(tasksPath())}>
              All boards
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    )
  }

  if (!board || (status === "loading" && !tasks)) return <BoardSkeleton />

  /* Sprint scoping is a filter, not a second piece of state: "Sprint 4" in the
     header is `filter.sprint`, so every view — and the chips in the filter bar
     — already agree about it. `""` is the select's own "all", never a spec. */
  const activeSprint = board.sprints.find((sprint) => sprint.state === "active") ?? null
  const scopedSprintId =
    filter.sprint !== undefined && filter.sprint !== "none" ? filter.sprint : null
  const scopedSprint = board.sprints.find((sprint) => sprint.id === scopedSprintId) ?? null
  /* The charts report on the sprint being looked at, and on the one being run
     when nothing is scoped — a burndown of "all sprints" is not a thing. */
  const reportSprintId = scopedSprintId ?? activeSprint?.id ?? null
  const reportSprint = scopedSprint ?? activeSprint

  const setSprintScope = (value: string) => {
    setFilter((current) => {
      const next = { ...current }
      if (value === ALL_SPRINTS) delete next.sprint
      else next.sprint = value
      return next
    })
  }

  const archive = () => {
    actions
      .archiveBoard(board.id, true)
      .then(() => {
        void navigate(tasksPath())
        toast("Board archived", {
          description: board.name,
          action: {
            label: "Undo",
            onClick: () => {
              actions
                .archiveBoard(board.id, false)
                .catch((err) => reportError(err, "Couldn't restore the board"))
            },
          },
        })
      })
      .catch((err) => reportError(err, "Couldn't archive the board"))
  }

  const trash = async () => {
    if (
      !(await confirm({
        title: `Delete "${board.name}"?`,
        description:
          "The board and every task on it move to Trash, where they can be restored.",
        confirmLabel: "Delete",
        destructive: true,
      }))
    )
      return
    actions
      .deleteBoard(board.id)
      .then(() => {
        void navigate(tasksPath())
        toast("Moved to Trash", {
          description: board.name,
          action: {
            label: "Undo",
            onClick: () => {
              actions
                .restoreBoard(board.id)
                .catch((err) => reportError(err, "Couldn't restore the board"))
            },
          },
        })
      })
      .catch((err) => reportError(err, "Couldn't delete the board"))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 px-4 pb-3 sm:gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <BoardDot color={board.color} />
          <h2 className="truncate text-base font-semibold tracking-tight">{board.name}</h2>
          <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            {board.keyPrefix}
          </span>
        </div>

        <div
          role="tablist"
          aria-label="Board view"
          className="ml-auto inline-flex items-center gap-0.5 rounded-4xl bg-muted p-[3px]"
        >
          {VIEW_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={view === tab.id}
              onClick={() => goToView(tab.id)}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-4xl px-2.5 text-xs font-medium transition-colors",
                view === tab.id
                  ? "bg-background text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <tab.icon className="size-3.5" />
              <span className="hidden sm:inline">{tab.label}</span>
            </button>
          ))}
        </div>

        {/* Scope the whole page to one sprint. Only when the board has sprints
            — an empty selector is a promise the board cannot keep; the way to
            the first one is the Backlog tab's "New sprint". */}
        {board.sprints.length > 0 && (
          <div className="flex items-center gap-1">
            <NativeSelect
              size="sm"
              value={filter.sprint ?? ALL_SPRINTS}
              aria-label="Sprint"
              title="Scope this board to one sprint"
              onChange={(event) => setSprintScope(event.target.value)}
            >
              <NativeSelectOption value={ALL_SPRINTS}>All sprints</NativeSelectOption>
              <NativeSelectOption value="none">Backlog (no sprint)</NativeSelectOption>
              {board.sprints.map((sprint) => (
                <NativeSelectOption key={sprint.id} value={sprint.id}>
                  {sprint.name}
                  {sprint.state === "active" ? " · active" : ""}
                  {sprint.state === "completed" ? " · done" : ""}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Button
              variant="ghost"
              size="icon-sm"
              title={scopedSprint ? `Edit ${scopedSprint.name}` : "New sprint"}
              aria-label={scopedSprint ? `Edit ${scopedSprint.name}` : "New sprint"}
              onClick={() => setSprintDialog({ sprint: scopedSprint })}
            >
              {scopedSprint ? <Pencil /> : <Plus />}
            </Button>
          </div>
        )}

        <Button
          size="sm"
          onClick={() => {
            setNewTaskColumnId(undefined)
            setNewTaskSprintId(undefined)
            setNewTaskOpen(true)
          }}
        >
          <Plus />
          <span className="hidden sm:inline">New task</span>
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="icon-sm" title={`Actions for ${board.name}`}>
                <MoreHorizontal />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={() => setRenameOpen(true)}>
              <Pencil className="size-4" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setSettingsOpen(true)}>
              <Settings2 className="size-4" />
              Board settings
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setMilestonesOpen(true)}>
              <Flag className="size-4" />
              Milestones
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                void saveBoardAsTemplate(actions, board)
              }}
            >
              <Copy className="size-4" />
              Save as template
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setTemplatesOpen(true)}>
              <SquareKanban className="size-4" />
              New board from template…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={archive}>
              <Archive className="size-4" />
              Archive
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => void trash()}>
              <Trash2 className="size-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="px-4 pb-3">
        <FilterBar
          board={board}
          value={filter}
          onChange={(spec, savedView) => {
            setFilter(spec)
            // A saved view may carry the tab it was saved from; applying it is
            // then also a route change, exactly as if the tab had been clicked.
            if (savedView && savedView !== view) goToView(savedView)
          }}
          actions={actions}
          assigneeOptions={assigneeOptions}
          inputRef={filterInputRef}
        />
      </div>

      {/* ── Reports ──
          Burndown and velocity live on the Backlog tab, folded away: this is
          the planning surface, and the two questions the charts answer ("are we
          going to land this sprint" / "what does this board actually deliver")
          are asked while planning it. The standalone Reports dashboard is W5;
          until then this is the only place they are reachable, and it costs
          nothing until it is opened — the panel mounts the charts, and the
          charts are what fetch. */}
      {view === "backlog" && (
        <div className="px-4 pb-3">
          <Collapsible open={reportsOpen} onOpenChange={setReportsOpen}>
            <CollapsibleTrigger
              render={
                <Button variant="outline" size="sm" className="w-full justify-start sm:w-auto">
                  <ChartNoAxesColumn />
                  Reports
                  {reportSprint && (
                    <span className="text-muted-foreground">· {reportSprint.name}</span>
                  )}
                  <ChevronDown
                    className={cn("transition-transform", reportsOpen && "rotate-180")}
                  />
                </Button>
              }
            />
            <CollapsibleContent>
              <div className="grid gap-4 pt-3 lg:grid-cols-2">
                <section className="rounded-xl border bg-card/40 p-3">
                  <h3 className="mb-2 text-sm font-medium">
                    Burndown
                    {reportSprint && (
                      <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                        {reportSprint.name}
                      </span>
                    )}
                  </h3>
                  <BurndownChart boardId={board.id} sprintId={reportSprintId} actions={actions} />
                </section>
                <section className="rounded-xl border bg-card/40 p-3">
                  <h3 className="mb-2 text-sm font-medium">Velocity</h3>
                  <VelocityChart boardId={board.id} actions={actions} />
                </section>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        {isBuilt(view) ? (
          view === "kanban" ? (
            <KanbanView
              board={board}
              tasks={filtered}
              onOpenTask={openTask}
              actions={actions}
              blockedTaskIds={blockedTaskIds}
              onNewTask={(columnId) => {
                setNewTaskColumnId(columnId)
                setNewTaskSprintId(undefined)
                setNewTaskOpen(true)
              }}
            />
          ) : view === "list" ? (
            <ListView
              board={board}
              tasks={filtered}
              onOpenTask={openTask}
              blockedTaskIds={blockedTaskIds}
            />
          ) : view === "calendar" ? (
            <CalendarView
              board={board}
              tasks={filtered}
              onOpenTask={openTask}
              actions={actions}
            />
          ) : view === "timeline" ? (
            <TimelineView
              board={board}
              tasks={filtered}
              onOpenTask={openTask}
              actions={actions}
            />
          ) : view === "dashboard" ? (
            <DashboardView
              board={board}
              tasks={filtered}
              onOpenTask={openTask}
              actions={actions}
              sprintId={reportSprintId}
            />
          ) : view === "backlog" ? (
            <BacklogView
              board={board}
              tasks={filtered}
              onOpenTask={openTask}
              actions={actions}
              onNewTask={(sprintId) => {
                setNewTaskColumnId(undefined)
                setNewTaskSprintId(sprintId)
                setNewTaskOpen(true)
              }}
            />
          ) : (
            <TableView
              board={board}
              tasks={filtered}
              onOpenTask={openTask}
              actions={actions}
              blockedTaskIds={blockedTaskIds}
            />
          )
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6">
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Not built yet</EmptyTitle>
                <EmptyDescription>
                  This harness does not know the {view} view — it came from a newer server.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button variant="outline" onClick={() => goToView("kanban")}>
                  Open Kanban
                </Button>
              </EmptyContent>
            </Empty>
          </div>
        )}
      </div>

      {openTaskId && (
        <TaskEditor
          board={board}
          taskId={openTaskId}
          actions={actions}
          onClose={() => setOpenTaskId(null)}
        />
      )}
      {/* Created straight into the editor: the quick-create takes a title, and
          everything else about the task is one dialog further in. */}
      <NewTaskDialog
        board={board}
        open={newTaskOpen}
        onOpenChange={setNewTaskOpen}
        actions={actions}
        defaultColumnId={newTaskColumnId}
        defaultSprintId={newTaskSprintId}
        onCreated={(task) => setOpenTaskId(task.id)}
      />
      {/* Sprint management from the header: edit whatever the selector is
          scoped to, or create the next one. The backlog lanes open the same
          dialog — this is the entry point for the boards that never leave the
          kanban. */}
      {sprintDialog && (
        <SprintDialog
          board={board}
          open
          onOpenChange={(open) => !open && setSprintDialog(null)}
          sprint={sprintDialog.sprint}
          actions={actions}
          onDeleted={(sprintId) => {
            // The scope it named is gone; keeping it would filter to nothing.
            if (filter.sprint === sprintId) setSprintScope(ALL_SPRINTS)
          }}
        />
      )}
      {/* Milestones: dates the board is measured against. Reached from the
          board menu because they are board configuration, not a view — the
          calendar paints the markers they produce. */}
      <MilestoneDialog
        board={board}
        open={milestonesOpen}
        onOpenChange={setMilestonesOpen}
        actions={actions}
        tasks={tasks}
        onDeleted={(milestoneId) => {
          if (filter.milestoneId === milestoneId)
            setFilter((current) => {
              const next = { ...current }
              delete next.milestoneId
              return next
            })
        }}
      />
      {/* Everything a board is configured with, in one tabbed dialog: columns,
          labels, types, custom fields, sprints, milestones and automations. */}
      <BoardSettingsDialog
        board={board}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        actions={actions}
        tasks={tasks}
      />
      <BoardTemplateDialog
        open={templatesOpen}
        onOpenChange={setTemplatesOpen}
        board={board}
        actions={actions}
      />
      <RenameBoardDialog
        board={board}
        open={renameOpen}
        onOpenChange={setRenameOpen}
        onRename={(name) =>
          actions
            .updateBoard(board.id, { name })
            .then(() => setRenameOpen(false))
            .catch((err) => reportError(err, "Couldn't rename the board"))
        }
      />
    </div>
  )
}

function BoardSkeleton() {
  return (
    <div aria-busy="true" className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
      <div className="flex items-center gap-3">
        <Skeleton className="size-2.5 rounded-full" />
        <Skeleton className="h-5 w-40" />
        <Skeleton className="ml-auto h-7 w-40 rounded-4xl" />
        <Skeleton className="h-8 w-24 rounded-4xl" />
      </div>
      <Skeleton className="h-9 w-full rounded-4xl" />
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-3">
        <Skeleton className="min-h-40 rounded-xl" />
        <Skeleton className="min-h-40 rounded-xl" />
        <Skeleton className="min-h-40 rounded-xl" />
      </div>
    </div>
  )
}

function RenameBoardDialog({
  board,
  open,
  onOpenChange,
  onRename,
}: {
  board: Board
  open: boolean
  onOpenChange: (open: boolean) => void
  onRename: (name: string) => void
}) {
  const [name, setName] = React.useState(board.name)
  React.useEffect(() => {
    if (open) setName(board.name)
  }, [open, board.name])

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            const next = name.trim()
            if (next && next !== board.name) onRename(next)
            else onOpenChange(false)
          }}
        >
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>Rename board</ResponsiveDialogTitle>
          </ResponsiveDialogHeader>
          <Input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Board name"
          />
          <ResponsiveDialogFooter className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim()}>
              Save
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
