import * as React from "react"

import { COLOR_DOT, type BoardColor } from "@/lib/boards"
import type { TaskInput } from "@/lib/tasks-board"
import { groupTasks, type GroupBy } from "@/lib/tasks-view"
import { GroupSection, TaskRow } from "../task-card"
import { QuickAdd } from "../quick-add"
import type { ViewProps } from "../types"

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
 * quick-add that inherits the group's value.
 */
export function ListView({ statuses, sprints, tasks, allTasks, view, ctx, onOpen, onCreate }: ViewProps) {
  const groupBy: GroupBy = view.groupBy === "none" ? "status" : view.groupBy
  const groups = React.useMemo(
    () => groupTasks(tasks, groupBy, { statuses, sprints, all: allTasks }),
    [tasks, groupBy, statuses, sprints, allTasks],
  )
  const statusOf = (id: string) => statuses.find((s) => s.id === id) ?? null

  return (
    <div className="mx-auto flex w-full min-h-0 max-w-5xl flex-1 flex-col gap-3 overflow-y-auto p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
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
          >
            {group.tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                status={groupBy === "status" ? undefined : statusOf(task.statusId)}
                ctx={ctx}
                onClick={() => onOpen(task)}
              />
            ))}
            <div className="p-1">
              <QuickAdd
                compact
                onCreate={async (title) => {
                  await onCreate({ title, ...defaultsFor(groupBy, group.id) })
                }}
              />
            </div>
          </GroupSection>
        )
      })}
      {tasks.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground">No tasks match the current filters.</p>
      )}
    </div>
  )
}
