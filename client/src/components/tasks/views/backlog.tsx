import * as React from "react"
import { CircleCheck, MoreHorizontal, Pencil, Play, Plus, Rocket, Trash2 } from "lucide-react"

import { cn } from "@/lib/utils"
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
import { GroupSection, TaskRow } from "../task-card"
import { QuickAdd } from "../quick-add"
import { SprintPicker } from "../fields"
import type { ViewProps } from "../types"

const fmt = (ms: number | null) =>
  ms == null ? "—" : new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" })

export interface SprintOps {
  onCreate: () => void
  onEdit: (sprint: Sprint) => void
  onStart: (sprint: Sprint) => void
  onComplete: (sprint: Sprint) => void
  onDelete: (sprint: Sprint) => void
}

function SprintHeader({ sprint, tasks, statuses, ops }: { sprint: Sprint; tasks: Task[]; statuses: ViewProps["statuses"]; ops: SprintOps }) {
  const p = sprintProgress(tasks, sprint.id, statuses)
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0
  const daysLeft = sprint.endAt != null ? Math.ceil((sprint.endAt - Date.now()) / 86_400_000) : null
  return (
    <div className="flex items-center gap-2">
      <span className="hidden items-center gap-2 text-[10px] normal-case text-muted-foreground sm:inline-flex">
        {sprint.state === "active" && <span className="rounded-pill bg-emerald-500/15 px-1.5 py-0.5 font-semibold text-emerald-600">Active</span>}
        {sprint.state === "closed" && <span className="rounded-pill bg-muted px-1.5 py-0.5 font-semibold">Closed</span>}
        <span className="tabular-nums">
          {fmt(sprint.startAt)} → {fmt(sprint.endAt)}
        </span>
        {sprint.state === "active" && daysLeft != null && (
          <span className={cn("tabular-nums", daysLeft < 0 && "text-destructive")}>{daysLeft < 0 ? `${-daysLeft}d over` : `${daysLeft}d left`}</span>
        )}
        {p.total > 0 && (
          <span className="inline-flex items-center gap-1.5 tabular-nums" title={`${p.done}/${p.total} done · ${p.donePoints}/${p.points} pts`}>
            <span className="h-1.5 w-16 overflow-hidden rounded-pill bg-muted">
              <span className="block h-full rounded-pill bg-emerald-500" style={{ width: `${pct}%` }} />
            </span>
            {pct}%
          </span>
        )}
      </span>
      {sprint.state === "planned" && (
        <button type="button" onClick={() => ops.onStart(sprint)} className="inline-flex h-7 items-center gap-1 rounded-pill bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:bg-primary/90">
          <Play className="size-3" /> Start
        </button>
      )}
      {sprint.state === "active" && (
        <button type="button" onClick={() => ops.onComplete(sprint)} className="inline-flex h-7 items-center gap-1 rounded-pill border px-2.5 text-xs font-medium hover:bg-accent">
          <CircleCheck className="size-3" /> Complete
        </button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button type="button" aria-label={`${sprint.name} options`} className="grid size-7 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground">
              <MoreHorizontal className="size-4" />
            </button>
          }
        />
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onClick={() => ops.onEdit(sprint)}>
            <Pencil className="size-4" /> Edit sprint…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => ops.onDelete(sprint)} className="text-destructive">
            <Trash2 className="size-4" /> Delete sprint
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
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

  const row = (task: Task) => (
    <div key={task.id} className="flex items-center">
      <div className="min-w-0 flex-1">
        <TaskRow task={task} status={statusOf(task.statusId)} ctx={ctx} onClick={() => onOpen(task)} />
      </div>
      <div className="shrink-0 border-b pr-1">
        <SprintPicker
          value={task.sprintId}
          sprints={sprints}
          onChange={(sprintId) => void onUpdate(task.id, { sprintId })}
          trigger={
            <button type="button" aria-label="Move to sprint" className="grid size-7 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground">
              <Rocket className="size-3.5" />
            </button>
          }
        />
      </div>
    </div>
  )

  const section = (sprint: Sprint, defaultOpen = true) => {
    const list = inSprint(sprint.id)
    return (
      <GroupSection
        key={sprint.id}
        title={sprint.name}
        count={list.length}
        points={list.reduce((n, t) => n + (t.estimate ?? 0), 0)}
        defaultOpen={defaultOpen}
        action={<SprintHeader sprint={sprint} tasks={allTasks} statuses={statuses} ops={sprintOps} />}
      >
        {sprint.goal && <p className="border-b px-3 py-1.5 text-xs text-muted-foreground">{sprint.goal}</p>}
        {list.map(row)}
        {list.length === 0 && <p className="px-3 py-3 text-xs text-muted-foreground">Nothing planned yet — move tasks here from the backlog.</p>}
        {sprint.state !== "closed" && (
          <div className="p-1">
            <QuickAdd compact onCreate={async (title) => void (await onCreate({ title, sprintId: sprint.id }))} />
          </div>
        )}
      </GroupSection>
    )
  }

  return (
    <div className="mx-auto flex w-full min-h-0 max-w-5xl flex-1 flex-col gap-3 overflow-y-auto p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      {active.map((s) => section(s))}
      {planned.map((s) => section(s))}
      <button
        type="button"
        onClick={sprintOps.onCreate}
        className="flex items-center gap-2 self-start rounded-pill border border-dashed px-3 py-1.5 text-xs font-medium text-muted-foreground hover:border-primary/40 hover:text-foreground"
      >
        <Plus className="size-3.5" /> New sprint
      </button>
      <GroupSection title="Backlog" count={backlog.length} points={backlog.reduce((n, t) => n + (t.estimate ?? 0), 0)}>
        {backlog.map(row)}
        {backlog.length === 0 && <p className="px-3 py-3 text-xs text-muted-foreground">The backlog is empty.</p>}
        <div className="p-1">
          <QuickAdd compact onCreate={async (title) => void (await onCreate({ title }))} />
        </div>
      </GroupSection>
      {closed.length > 0 && (
        <div className="mt-2 flex flex-col gap-3">
          <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Closed sprints</h3>
          {closed.map((s) => section(s, false))}
        </div>
      )}
    </div>
  )
}
