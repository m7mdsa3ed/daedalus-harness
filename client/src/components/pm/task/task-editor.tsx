/* The task editor: one dialog, fields and body on the left, the task's own
   logs and children on the right.

   It reads the task out of the store (`pmTasks[boardId]`) rather than fetching
   one, so every optimistic move, patch and automation result the board already
   knows about shows up here without a round trip. What it does fetch — the
   comments and the activity journal — it fetches on open and forgets on close:
   those are paginated tables server-side and deliberately absent from the slim
   task the board list returns.

   Opening a subtask swaps the editor to that task and pushes the way back, so
   a tree can be walked without losing the parent. */
import * as React from "react"
import { toast } from "sonner"
import { Archive, ArrowLeft, MoreVertical, Trash2 } from "lucide-react"
import { reportError } from "@/lib/errors"
import { loadSettings, type ServerSettings } from "@/lib/settings"
import { useActions, type Actions } from "@/lib/actions"
import type { Board, Task } from "@/lib/pm/types"
import { useStore } from "@/lib/store"
import { useConfirm } from "@/components/confirm-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { EpicProgress } from "@/components/pm/epic-progress"
import { TaskFieldsForm } from "./task-fields-form"
import { SubtaskTree } from "./subtask-tree"
import { ChecklistEditor } from "./checklist-editor"
import { CommentsThread } from "./comments-thread"
import { ActivityList } from "./activity-list"
import { DependencyPicker } from "./dependency-picker"

/* The editor is opened from views that do not carry `actions` in their props
   (the PmViewProps contract is board/tasks/onOpenTask), so it can build its
   own from the active server the way App does. `useActions` is a useMemo over
   `settings`, and the settings object is read once per mount, so the identity
   stays stable. A caller that already has actions passes them and skips this. */
/** A stable empty array — a fresh `[]` per render would defeat EpicProgress's
    memo for every task that is not an epic. */
const EMPTY_TASKS: Task[] = []

function useOwnActions(provided?: Actions): Actions {
  const [settings] = React.useState(() => loadSettings())
  const own = useActions(settings as ServerSettings)
  return provided ?? own
}

export function TaskEditor({
  board,
  taskId,
  onClose,
  actions: provided,
}: {
  board: Board
  taskId: string
  onClose: () => void
  /** Optional: pm-page can hand its own down instead of minting a second set. */
  actions?: Actions
}) {
  const actions = useOwnActions(provided)
  const { state } = useStore()
  const confirm = useConfirm()

  /* `taskId` names the task the board opened; the stack is where the editor
     has walked to since (subtasks), so closing always returns the same id the
     caller gave. */
  const [stack, setStack] = React.useState<string[]>([])
  React.useEffect(() => setStack([]), [taskId])

  const currentId = stack.length > 0 ? stack[stack.length - 1] : taskId
  const tasks = state.pmTasks[board.id] ?? []
  const task = tasks.find((row) => row.id === currentId)

  const [tab, setTab] = React.useState("subtasks")

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-full gap-0 overflow-hidden p-0 sm:max-w-5xl">
        {task ? (
          <TaskBody
            board={board}
            task={task}
            tasks={tasks}
            actions={actions}
            tab={tab}
            onTab={setTab}
            canGoBack={stack.length > 0}
            onBack={() => setStack((current) => current.slice(0, -1))}
            onOpenTask={(id) => setStack((current) => [...current, id])}
            onClose={onClose}
            confirm={confirm}
          />
        ) : (
          <div className="p-10 text-center">
            <DialogTitle className="mb-2">Task not found</DialogTitle>
            <p className="text-sm text-muted-foreground">
              It was archived, trashed, or belongs to a board that isn't loaded.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function TaskBody({
  board,
  task,
  tasks,
  actions,
  tab,
  onTab,
  canGoBack,
  onBack,
  onOpenTask,
  onClose,
  confirm,
}: {
  board: Board
  task: Task
  /** The board's loaded tasks — the epic roll-up's children come from here,
      never from a fetch of its own. */
  tasks: Task[]
  actions: Actions
  tab: string
  onTab: (tab: string) => void
  canGoBack: boolean
  onBack: () => void
  onOpenTask: (id: string) => void
  onClose: () => void
  confirm: ReturnType<typeof useConfirm>
}) {
  const boardId = board.id

  const isEpic =
    task.typeId !== null &&
    board.issueTypes.some((type) => type.id === task.typeId && type.isEpic)
  const epicChildren = React.useMemo(
    () => (isEpic ? tasks.filter((row) => row.epicId === task.id) : EMPTY_TASKS),
    [isEpic, tasks, task.id]
  )

  const rename = (title: string) => {
    const next = title.trim()
    if (!next || next === task.title) return
    actions
      .patchTask(boardId, task.id, { title: next })
      .catch((error) => reportError(error, "Couldn't rename the task"))
  }

  const archive = () => {
    // Archiving drops the task from the loaded board, so the editor has
    // nothing left to show — leave, and offer the way back in the toast.
    onClose()
    actions
      .archiveTask(boardId, task.id)
      .then(() =>
        toast("Archived", {
          description: `${task.key} — ${task.title}`,
          action: {
            label: "Undo",
            onClick: () => {
              actions
                .unarchiveTask(boardId, task.id)
                .catch((error) => reportError(error, "Couldn't unarchive the task"))
            },
          },
        })
      )
      .catch((error) => reportError(error, "Couldn't archive the task"))
  }

  const trash = async () => {
    if (
      !(await confirm({
        title: `Delete ${task.key}?`,
        description: "The task moves to Trash, where it can be restored. Subtasks go with it.",
        confirmLabel: "Delete",
        destructive: true,
      }))
    )
      return
    onClose()
    actions
      .deleteTask(boardId, task.id)
      .then(() =>
        toast("Moved to Trash", {
          description: `${task.key} — ${task.title}`,
          action: {
            label: "Undo",
            onClick: () => {
              actions
                .restoreTask(boardId, task.id)
                .catch((error) => reportError(error, "Couldn't restore the task"))
            },
          },
        })
      )
      .catch((error) => reportError(error, "Couldn't delete the task"))
  }

  return (
    <div className="grid max-h-[85vh] grid-rows-[auto_minmax(0,1fr)]">
      <header className="flex items-center gap-2 border-b px-4 py-3 pr-14">
        {canGoBack && (
          <Button variant="ghost" size="icon-sm" onClick={onBack} title="Back to the parent task">
            <ArrowLeft />
          </Button>
        )}
        <Badge variant="outline" className="shrink-0 font-mono text-[11px]">
          {task.key}
        </Badge>
        <DialogTitle className="sr-only">{task.title}</DialogTitle>
        <Input
          key={`${task.id}:${task.title}`}
          defaultValue={task.title}
          aria-label="Task title"
          className="h-8 flex-1 border-0 bg-transparent px-2 text-sm font-medium shadow-none focus-visible:bg-input/30"
          onBlur={(event) => rename(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur()
          }}
        />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-sm" title="Task actions" />}
          >
            <MoreVertical />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={archive}>
              <Archive /> Archive
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => void trash()}>
              <Trash2 /> Move to Trash
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div className="grid min-h-0 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="min-h-0 space-y-4 overflow-y-auto p-4 md:border-r">
          <TaskFieldsForm board={board} task={task} actions={actions} />
          {/* Epics ARE tasks: this one has no progress of its own, only what
              points at it through `epicId`. Rendered from the board's loaded
              list, so it costs a filter, not a request. */}
          {isEpic && <EpicProgress board={board} epic={task} children={epicChildren} />}
        </div>

        <Tabs value={tab} onValueChange={(value) => onTab(String(value))} className="flex min-h-0 flex-col">
          <TabsList className="mx-3 mt-3 shrink-0">
            <TabsTrigger value="subtasks">Subtasks</TabsTrigger>
            <TabsTrigger value="checklists">Checklists</TabsTrigger>
            <TabsTrigger value="comments">Comments</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
            <TabsTrigger value="dependencies">Blockers</TabsTrigger>
          </TabsList>
          <TabsContent value="subtasks" className="min-h-0 flex-1 overflow-y-auto">
            <SubtaskTree board={board} task={task} actions={actions} onOpenTask={onOpenTask} />
          </TabsContent>
          <TabsContent value="checklists" className="min-h-0 flex-1 overflow-y-auto">
            <ChecklistEditor boardId={boardId} task={task} actions={actions} />
          </TabsContent>
          <TabsContent value="comments" className="flex min-h-0 flex-1 flex-col">
            <CommentsThread boardId={boardId} taskId={task.id} actions={actions} />
          </TabsContent>
          <TabsContent value="activity" className="min-h-0 flex-1 overflow-y-auto">
            <ActivityList board={board} taskId={task.id} actions={actions} />
          </TabsContent>
          {/* Dependencies are join rows, not a field on the task, so this tab
              reads the board's one dependency graph (lib/pm/dependencies)
              rather than anything in the slim task above. */}
          <TabsContent value="dependencies" className="min-h-0 flex-1 overflow-y-auto">
            <DependencyPicker
              board={board}
              task={task}
              tasks={tasks}
              actions={actions}
              onOpenTask={onOpenTask}
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
