import * as React from "react"
import { useDroppable } from "@dnd-kit/core"
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { ChevronsLeftRightIcon, ChevronsRightLeftIcon, PlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { SortableTaskCard } from "@/components/pm/views/task-card"
import type { Column, Label as PmLabel, Task } from "@/lib/pm/types"
import { cn } from "@/lib/utils"

/* ── One kanban lane ──
   A droppable that wraps a SortableContext, so a card can be dropped on
   another card (sortable) or anywhere in the lane including an empty one (the
   droppable). Collapse state is the device's opinion and comes from
   lib/pm/prefs through the view. */

export interface KanbanColumnProps {
  column: Column
  /** Already filtered and rank-sorted by the view. */
  tasks: Task[]
  labels: Record<string, PmLabel>
  subtaskCounts: Record<string, { done: number; total: number }>
  /** Epic roll-ups keyed by epic task id — only epics have an entry. */
  epicCounts: Record<string, { done: number; total: number }>
  /** The board's blocked set, fetched once by pm-page (lib/pm/dependencies). */
  blockedTaskIds?: ReadonlySet<string>
  collapsed: boolean
  onToggleCollapsed(columnId: string): void
  onOpenTask(id: string): void
  onNewTask?(columnId: string): void
}

function WipBadge({ count, limit }: { count: number; limit: number }) {
  const over = count > limit
  return (
    <span
      title={over ? `Over the WIP limit of ${limit}` : `WIP limit ${limit}`}
      className={cn(
        "rounded-4xl border px-1.5 py-px text-[10px] leading-4",
        over
          ? "border-destructive/40 bg-destructive/10 font-medium text-destructive"
          : "border-border bg-muted text-muted-foreground"
      )}
    >
      {count}/{limit}
    </span>
  )
}

function KanbanColumnImpl({
  column,
  tasks,
  labels,
  subtaskCounts,
  epicCounts,
  blockedTaskIds,
  collapsed,
  onToggleCollapsed,
  onOpenTask,
  onNewTask,
}: KanbanColumnProps) {
  // The lane itself is the drop target, which is what makes an empty column
  // (no sortable items to hit) accept a card at all.
  const { setNodeRef, isOver } = useDroppable({
    id: column.id,
    data: { type: "column", columnId: column.id },
  })
  const ids = React.useMemo(() => tasks.map((task) => task.id), [tasks])
  const overLimit = column.wipLimit !== null && tasks.length > column.wipLimit

  if (collapsed) {
    return (
      <div
        ref={setNodeRef}
        className={cn(
          "flex w-11 shrink-0 flex-col items-center gap-2 rounded-xl border bg-card/40 py-2",
          overLimit && "border-destructive/40",
          isOver && "border-ring/60 bg-muted/60"
        )}
      >
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Expand ${column.name}`}
          onClick={() => onToggleCollapsed(column.id)}
        >
          <ChevronsLeftRightIcon />
        </Button>
        <span className="text-[10px] text-muted-foreground">{tasks.length}</span>
        <span
          className="mt-1 text-xs font-medium whitespace-nowrap text-muted-foreground"
          style={{ writingMode: "vertical-rl" }}
        >
          {column.name}
        </span>
      </div>
    )
  }

  return (
    <div
      className={cn(
        "flex w-72 shrink-0 flex-col rounded-xl border bg-card/40",
        overLimit && "border-destructive/40"
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: column.color ?? "var(--muted-foreground)" }}
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {column.name}
        </span>
        {column.wipLimit === null ? (
          <span className="text-[11px] text-muted-foreground">{tasks.length}</span>
        ) : (
          <WipBadge count={tasks.length} limit={column.wipLimit} />
        )}
        {onNewTask && (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`New task in ${column.name}`}
            onClick={() => onNewTask(column.id)}
          >
            <PlusIcon />
          </Button>
        )}
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Collapse ${column.name}`}
          onClick={() => onToggleCollapsed(column.id)}
        >
          <ChevronsRightLeftIcon />
        </Button>
      </div>

      <div
        ref={setNodeRef}
        className={cn(
          "flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto rounded-b-xl px-2 pt-1 pb-2",
          isOver && "bg-muted/50"
        )}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {tasks.map((task) => (
            <SortableTaskCard
              key={task.id}
              task={task}
              columnId={column.id}
              labels={labels}
              subtasks={subtaskCounts[task.id]}
              epic={epicCounts[task.id]}
              blocked={blockedTaskIds?.has(task.id)}
              onOpen={onOpenTask}
            />
          ))}
        </SortableContext>
        {tasks.length === 0 && (
          <p className="px-1 py-6 text-center text-xs text-muted-foreground">Nothing here</p>
        )}
      </div>
    </div>
  )
}

export const KanbanColumn = React.memo(KanbanColumnImpl)
