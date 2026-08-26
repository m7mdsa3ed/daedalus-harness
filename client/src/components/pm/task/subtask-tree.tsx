/* Subtasks are ordinary tasks with a `parentId` — they carry a key, a status
   and a whole editor of their own, which is why this is a tree of rows and not
   a checklist. The children come from the board's loaded task list in the
   store (nothing extra is fetched), so a child created here appears through
   the same `upsert-pm-task` every other view reads.

   Depth is real: a child can have children. `onOpenTask` hands the id back to
   the editor, which swaps to it and remembers the way back. */
import * as React from "react"
import { Plus } from "lucide-react"
import { reportError } from "@/lib/errors"
import type { Actions } from "@/lib/actions"
import type { Board, Task } from "@/lib/pm/types"
import { useStore } from "@/lib/store"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

/** Live children of `parentId`, in board order. Archived and trashed tasks are
    already absent from the cached list, but a stale optimistic row is not. */
function childrenOf(tasks: Task[], parentId: string): Task[] {
  return tasks
    .filter(
      (task) => task.parentId === parentId && task.deletedAt === null && task.archivedAt === null
    )
    .sort((a, b) => a.order - b.order)
}

function isDone(board: Board, task: Task): boolean {
  return board.columns.find((column) => column.id === task.columnId)?.category === "done"
}

const SubtaskRow = React.memo(function SubtaskRow({
  board,
  tasks,
  task,
  depth,
  actions,
  onOpenTask,
}: {
  board: Board
  tasks: Task[]
  task: Task
  depth: number
  actions: Actions
  onOpenTask: (id: string) => void
}) {
  const kids = childrenOf(tasks, task.id)
  const done = isDone(board, task)
  const column = board.columns.find((c) => c.id === task.columnId)

  return (
    <div>
      <button
        type="button"
        onClick={() => onOpenTask(task.id)}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        className="flex w-full items-center gap-2 rounded-lg py-1.5 pr-2 text-left hover:bg-muted"
      >
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            done ? "bg-primary" : "bg-muted-foreground/40"
          )}
        />
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{task.key}</span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[13px]",
            done && "text-muted-foreground line-through"
          )}
        >
          {task.title}
        </span>
        {column && (
          <span className="shrink-0 text-[11px] text-muted-foreground">{column.name}</span>
        )}
      </button>
      {kids.map((kid) => (
        <SubtaskRow
          key={kid.id}
          board={board}
          tasks={tasks}
          task={kid}
          depth={depth + 1}
          actions={actions}
          onOpenTask={onOpenTask}
        />
      ))}
    </div>
  )
})

export function SubtaskTree({
  board,
  task,
  actions,
  onOpenTask,
}: {
  board: Board
  task: Task
  actions: Actions
  onOpenTask: (id: string) => void
}) {
  const { state } = useStore()
  const tasks = state.pmTasks[board.id] ?? []
  const [title, setTitle] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  const kids = React.useMemo(() => childrenOf(tasks, task.id), [tasks, task.id])
  const done = kids.filter((kid) => isDone(board, kid)).length

  const add = async () => {
    const text = title.trim()
    if (!text || busy) return
    setBusy(true)
    try {
      // A subtask starts in the parent's column: it is the same piece of work,
      // one level down, and the board's first column would be a worse guess.
      await actions.createTask(board.id, {
        title: text,
        parentId: task.id,
        columnId: task.columnId,
        sprintId: task.sprintId,
        epicId: task.epicId,
      })
      setTitle("")
    } catch (error) {
      reportError(error, "Couldn't add the subtask")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2 p-4">
      {kids.length > 0 ? (
        <>
          <p className="px-1 text-[11px] text-muted-foreground">
            {done} of {kids.length} done
          </p>
          <div>
            {kids.map((kid) => (
              <SubtaskRow
                key={kid.id}
                board={board}
                tasks={tasks}
                task={kid}
                depth={0}
                actions={actions}
                onOpenTask={onOpenTask}
              />
            ))}
          </div>
        </>
      ) : (
        <p className="px-1 text-xs text-muted-foreground">No subtasks yet.</p>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              void add()
            }
          }}
          placeholder="Add a subtask…"
          className="h-8 text-[13px]"
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => void add()}
          disabled={busy || title.trim() === ""}
        >
          <Plus /> Add
        </Button>
      </div>
    </div>
  )
}
