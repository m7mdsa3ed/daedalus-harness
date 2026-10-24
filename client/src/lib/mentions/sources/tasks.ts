/* `@KEY-12` — a task from the board. Picking one inserts `@KEY-12`, which the
   send expands into the task and how to work it (`lib/task-mentions.ts`) — only
   for a thread that carries the Harness MCP, so only such a thread is offered one. */
import * as React from "react"
import { SquareCheck, SquareCheckIcon } from "lucide-react"
import { useBoardsEnabled, useTasksQuery } from "@/lib/queries/boards"
import { taskKey } from "@/lib/tasks-board"
import { TASK_KEY } from "@/lib/task-mentions"
import type { MentionSource } from "../types"

export interface TaskMatch {
  type: "task"
  key: string
  title: string
  status?: string
}

const LIMIT = 8

/* Tasks only where the agent can work them: the expansion tells it to call
   the Harness MCP, so without it there is nothing to mention. Asked for once
   the menu is open, never by a composer that is merely mounted. */
export const tasksSource: MentionSource<TaskMatch, TaskMatch[]> = {
  id: "task",
  useData(ctx, query) {
    const offer = ctx.harness && query !== null && !query.includes("/")
    const tasksQuery = useTasksQuery(offer)
    const { boards, statuses } = useBoardsEnabled(offer)
    return React.useMemo((): TaskMatch[] => {
      if (!offer) return []
      const keyOf = new Map(boards.map((b) => [b.id, b.key]))
      const statusOf = new Map(statuses.map((s) => [s.id, s.name]))
      return (tasksQuery.data ?? [])
        .filter((task) => !task.archived && keyOf.has(task.boardId))
        .map((task) => ({
          type: "task" as const,
          key: taskKey(task, keyOf.get(task.boardId)!),
          title: task.title,
          status: statusOf.get(task.statusId),
        }))
    }, [offer, boards, statuses, tasksQuery.data])
  },
  available: (ctx) => ctx.harness,
  search(query, _ctx, tasks) {
    if (query.includes("/")) return []
    const q = query.toLowerCase()
    return tasks.filter((task) => `${task.key} ${task.title}`.toLowerCase().includes(q)).slice(0, LIMIT)
  },
  key: (task) => task.key,
  insert: (task) => ({ type: "text", text: `@${task.key}`, open: false }),
  face: (ref) => (TASK_KEY.test(ref) ? { icon: SquareCheckIcon, label: ref } : null),
  row: (task) => ({
    icon: SquareCheck,
    label: task.key,
    description: task.title,
    aside: task.status,
    badge: "task",
  }),
}
