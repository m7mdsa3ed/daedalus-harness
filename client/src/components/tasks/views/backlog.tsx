import { MENU_WIDTH } from "@/components/menu-row"
import { CircleCheck, MoreHorizontal, Pencil, Play, Plus, Rocket, Trash2 } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Empty } from "@/components/empty"
import { useConfirm } from "@/components/confirm-dialog"
import { SectionHead, StatusBadge } from "@/components/settings/primitives"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { Sprint } from "@/lib/boards"
import type { Task } from "@/lib/tasks-board"
import { sprintProgress } from "@/lib/tasks-view"
import { GroupSection, TaskRow, TaskRows } from "../task-card"
import { QuickAdd } from "../quick-add"
import { ICON_BTN, SprintPicker } from "../fields"
import { INSET_X } from "../modes"
import type { ViewProps } from "../types"

const CONTENT = cn(
  "mx-auto grid w-full max-w-6xl gap-6 py-3 pb-[calc(var(--tasks-foot,0px)+0.75rem)]",
  INSET_X,
)

const fmt = (ms: number | null) =>
  ms == null ? "—" : new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" })

export interface SprintOps {
  onCreate: () => void
  onEdit: (sprint: Sprint) => void
  onStart: (sprint: Sprint) => void
  onComplete: (sprint: Sprint) => void
  onDelete: (sprint: Sprint) => void
}

const STATE_BADGE = {
  active: <StatusBadge tone="ok">Active</StatusBadge>,
  planned: <StatusBadge tone="neutral">Planned</StatusBadge>,
  closed: <StatusBadge tone="info">Closed</StatusBadge>,
} as const

/** The header's end: the sprint's one next step, and its menu. */
function SprintActions({ sprint, ops }: { sprint: Sprint; ops: SprintOps }) {
  const confirm = useConfirm()
  return (
    <span className="flex items-center gap-1">
      {sprint.state === "planned" && (
        <Button type="button" size="sm" variant="outline" className="pointer-coarse:h-11" onClick={() => ops.onStart(sprint)}>
          <Play /> Start
        </Button>
      )}
      {sprint.state === "active" && (
        <Button type="button" size="sm" variant="outline" className="pointer-coarse:h-11" onClick={() => ops.onComplete(sprint)}>
          <CircleCheck /> Complete
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button type="button" variant="ghost" size="icon-sm" title={`${sprint.name} options`} className={cn(ICON_BTN, "text-muted-foreground")}>
              <MoreHorizontal />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className={MENU_WIDTH}>
          <DropdownMenuItem onClick={() => ops.onEdit(sprint)}>
            <Pencil className="size-4" /> Edit sprint…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={async () => {
              const ok = await confirm({
                title: `Delete ${sprint.name}?`,
                description: "Its tasks return to the backlog.",
                confirmLabel: "Delete sprint",
                destructive: true,
              })
              if (ok) ops.onDelete(sprint)
            }}
          >
            <Trash2 className="size-4" /> Delete sprint…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}

/** The sprint's second line, at every width: dates, time left, progress,
    then its goal. Counted over every task on the board, not the filtered ones. */
function SprintFacts({ sprint, tasks, statuses }: { sprint: Sprint; tasks: Task[]; statuses: ViewProps["statuses"] }) {
  const p = sprintProgress(tasks, sprint.id, statuses)
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0
  const daysLeft = sprint.endAt != null ? Math.ceil((sprint.endAt - Date.now()) / 86_400_000) : null
  return (
    <div className="grid gap-1 px-3 py-2 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 tabular-nums">
        <span>
          {fmt(sprint.startAt)} → {fmt(sprint.endAt)}
        </span>
        {sprint.state === "active" && daysLeft != null && (
          <span className={cn(daysLeft < 0 && "text-destructive")}>{daysLeft < 0 ? `${-daysLeft}d over` : `${daysLeft}d left`}</span>
        )}
        <span>
          {p.done}/{p.total} done · {p.donePoints}/{p.points} pts
        </span>
        {p.total > 0 && (
          <span className="inline-flex items-center gap-2">
            <Progress value={pct} aria-label="Sprint progress" className="w-24 [&_[data-slot=progress-track]]:h-1.5" />
            {pct}%
          </span>
        )}
      </div>
      {sprint.goal && <p className="line-clamp-2 text-pretty">{sprint.goal}</p>}
    </div>
  )
}

/**
 * Sprints and the backlog. The active sprint first, then planned ones, then
 * the backlog; a task is moved between them with the sprint picker on its
 * row. Closed sprints fold away underneath as the record of what shipped.
 */
export function BacklogView({ statuses, sprints, tasks, allTasks, ctx, onOpen, onCreate, onUpdate, sprintOps }: ViewProps & { sprintOps: SprintOps }) {
  const statusOf = (id: string) => statuses.find((s) => s.id === id) ?? null
  const active = sprints.filter((s) => s.state === "active")
  const planned = sprints.filter((s) => s.state === "planned")
  const closed = sprints.filter((s) => s.state === "closed")
  const inSprint = (id: string) => tasks.filter((t) => t.sprintId === id)
  const backlog = tasks.filter((t) => t.sprintId == null)
  const pointsOf = (list: Task[]) => list.reduce((n, t) => n + (t.estimate ?? 0), 0)

  const row = (task: Task) => (
    <TaskRow
      task={task}
      status={statusOf(task.statusId)}
      ctx={ctx}
      onClick={() => onOpen(task)}
      trailing={
        <SprintPicker
          value={task.sprintId}
          sprints={sprints}
          onChange={(sprintId) => void onUpdate(task.id, { sprintId })}
          trigger={
            <Button type="button" variant="ghost" size="icon-sm" title="Move to sprint" className={cn(ICON_BTN, "text-muted-foreground")}>
              <Rocket />
            </Button>
          }
        />
      }
    />
  )

  const newSprint = (
    <Button type="button" variant="outline" size="sm" className="pointer-coarse:h-11" onClick={sprintOps.onCreate}>
      <Plus /> New sprint
    </Button>
  )

  const section = (sprint: Sprint, defaultOpen = true) => {
    const list = inSprint(sprint.id)
    return (
      <GroupSection
        key={sprint.id}
        title={sprint.name}
        count={list.length}
        points={pointsOf(list)}
        defaultOpen={defaultOpen}
        meta={STATE_BADGE[sprint.state]}
        action={<SprintActions sprint={sprint} ops={sprintOps} />}
      >
        <SprintFacts sprint={sprint} tasks={allTasks} statuses={statuses} />
        <TaskRows tasks={list}>{row}</TaskRows>
        {list.length === 0 && <Empty className="m-2">Nothing planned yet — move tasks here from the backlog.</Empty>}
        {sprint.state !== "closed" && (
          <div className="p-1.5">
            <QuickAdd onCreate={async (title) => void (await onCreate({ title, sprintId: sprint.id }))} />
          </div>
        )}
      </GroupSection>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className={CONTENT}>
        <div>
          <SectionHead label="Sprints" action={newSprint} />
          {sprints.length === 0 && (
            <Empty action={newSprint}>No sprints yet — plan one to pull work out of the backlog.</Empty>
          )}
        </div>
        {active.map((s) => section(s))}
        {planned.map((s) => section(s))}
        <GroupSection title="Backlog" count={backlog.length} points={pointsOf(backlog)}>
          <TaskRows tasks={backlog}>{row}</TaskRows>
          {backlog.length === 0 && <Empty className="m-2">The backlog is empty.</Empty>}
          <div className="p-1.5">
            <QuickAdd onCreate={async (title) => void (await onCreate({ title }))} />
          </div>
        </GroupSection>
        {closed.map((s) => section(s, false))}
      </div>
    </div>
  )
}
