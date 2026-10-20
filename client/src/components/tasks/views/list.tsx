import * as React from "react"
import { Plus } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { COLOR_DOT, type BoardColor } from "@/lib/boards"
import type { TaskInput } from "@/lib/tasks-board"
import { groupTasks, type GroupBy } from "@/lib/tasks-view"
import { GroupSection, TaskRow, TaskRows } from "../task-card"
import { QuickAdd } from "../quick-add"
import { ICON_BTN } from "../fields"
import { INSET_X } from "../modes"
import type { ViewProps } from "../types"

/** The scroll content: one column, centred, its end padded past the floating
    bulk bar (`--tasks-foot`, set by the shell). Every row-shaped view repeats it. */
const CONTENT = cn(
  "mx-auto grid w-full max-w-6xl gap-6 py-3 pb-[calc(var(--tasks-foot,0px)+0.75rem)]",
  INSET_X,
)

/** What a task created inside a group inherits from it. */
function defaultsFor(groupBy: GroupBy, groupId: string): Partial<TaskInput> {
  switch (groupBy) {
    case "status":
      return { statusId: groupId }
    case "priority":
      return { priority: groupId as TaskInput["priority"] }
    case "type":
      return { type: groupId as TaskInput["type"] }
    case "assignee":
      return groupId ? { assignee: groupId } : {}
    case "label":
      return groupId ? { labels: [groupId] } : {}
    case "sprint":
      return groupId ? { sprintId: groupId } : {}
    case "epic":
      return groupId ? { parentId: groupId } : {}
    default:
      return {}
  }
}

/**
 * The list: the board read down instead of across. Grouped by whatever the
 * toolbar says (status by default), each group collapsible with its own
 * quick-add that inherits the group's value — opened from the group's +.
 */
export function ListView({ statuses, sprints, tasks, allTasks, view, ctx, onOpen, onCreate }: ViewProps) {
  const groupBy: GroupBy = view.groupBy === "none" ? "status" : view.groupBy
  const groups = React.useMemo(
    () => groupTasks(tasks, groupBy, { statuses, sprints, all: allTasks }),
    [tasks, groupBy, statuses, sprints, allTasks],
  )
  const statusOf = (id: string) => statuses.find((s) => s.id === id) ?? null
  /** The group whose quick-add is open — one at a time. */
  const [adding, setAdding] = React.useState<string | null>(null)

  return (
    <div className="h-full overflow-y-auto">
      <div className={CONTENT}>
        {groups.map((group) => {
          if (group.tasks.length === 0 && groupBy !== "status") return null
          const points = group.tasks.reduce((n, t) => n + (t.estimate ?? 0), 0)
          return (
            <GroupSection
              key={group.id}
              title={group.label}
              count={group.tasks.length}
              points={points}
              color={group.color ? COLOR_DOT[group.color as BoardColor] : null}
              action={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className={cn(ICON_BTN, "text-muted-foreground")}
                  title={`Add task to ${group.label}`}
                  onClick={() => setAdding(group.id)}
                >
                  <Plus />
                </Button>
              }
            >
              <TaskRows tasks={group.tasks}>
                {(task) => (
                  <TaskRow
                    task={task}
                    status={groupBy === "status" ? undefined : statusOf(task.statusId)}
                    ctx={ctx}
                    onClick={() => onOpen(task)}
                  />
                )}
              </TaskRows>
              <div className="p-1.5">
                <QuickAdd
                  open={adding === group.id}
                  onOpenChange={(open) => setAdding(open ? group.id : null)}
                  onCreate={async (title) => {
                    await onCreate({ title, ...defaultsFor(groupBy, group.id) })
                  }}
                />
              </div>
            </GroupSection>
          )
        })}
      </div>
    </div>
  )
}
