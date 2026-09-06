/* ── What happens to the answer ──
   A run produces prose (and, when the routine declared an output schema, a
   verdict). `onFinish` is where that goes, and every option here is something
   the harness already does for other reasons — a push notification, a knowledge
   entry, a card on a board, another routine. Nothing new is built for a routine
   to have somewhere to put its answer.

   Plural and optional, and a failure is recorded on the run rather than failing
   it: the work already happened by the time these run, and losing a night's
   review because a board column was renamed would be the wrong trade. */
import * as React from "react"
import { BellIcon, BookTextIcon, KanbanIcon, PlusIcon, RepeatIcon, Trash2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { statusesOf } from "@/lib/boards"
import { useBoardsEnabled } from "@/lib/queries/boards"
import type { OnFinishAction, Routine } from "@/lib/settings"

const KIND_META: Record<OnFinishAction["kind"], { label: string; icon: typeof BellIcon; blurb: string }> = {
  push: {
    label: "Send a notification",
    icon: BellIcon,
    blurb: "A push to every registered device, naming the routine.",
  },
  knowledge: {
    label: "Save to the knowledge base",
    icon: BookTextIcon,
    blurb: "The run's answer as an entry on this routine's project.",
  },
  task: { label: "Create a task card", icon: KanbanIcon, blurb: "A card on a board, with the answer as its note." },
  routine: { label: "Fire another routine", icon: RepeatIcon, blurb: "Chained — the next run's payload is this answer." },
}

/** Sentinel for "let the server choose": the first board and its first column.
    Not the literal `"default"` board id, because the server resolves the first
    *column* by order rather than by name, and a hardcoded `"todo"` here would
    be exactly the per-install knowledge this indirection avoids. */
const SERVER_DEFAULT = "__default__"

export function OnFinishEditor({
  value,
  onChange,
  /** Every other routine, for the chaining action. This routine is excluded by
      the caller: a routine that fires itself is an obvious loop, and the server
      would be the only thing left to stop it. */
  routines,
}: {
  value: OnFinishAction[]
  onChange: (next: OnFinishAction[]) => void
  routines: Routine[]
}) {
  /* Only when a task action is actually on screen does the query run: a board
     list is a request, and most routines never add one. */
  const wantsBoards = value.some((a) => a.kind === "task")
  const boards = useBoardsEnabled(wantsBoards)

  const patch = (index: number, next: OnFinishAction) =>
    onChange(value.map((action, i) => (i === index ? next : action)))
  const remove = (index: number) => onChange(value.filter((_, i) => i !== index))

  const add = (kind: OnFinishAction["kind"]) => {
    const blank: Record<OnFinishAction["kind"], OnFinishAction> = {
      push: { kind: "push" },
      knowledge: { kind: "knowledge" },
      task: { kind: "task" },
      routine: { kind: "routine", routineId: routines[0]?.id ?? "" },
    }
    onChange([...value, blank[kind]])
  }

  return (
    <div className="space-y-3">
      {value.map((action, index) => {
        const meta = KIND_META[action.kind]
        const Icon = meta?.icon ?? BellIcon
        return (
          <div key={index} className="rounded-xl border p-3">
            <div className="flex items-center gap-2.5">
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{meta?.label ?? action.kind}</div>
                <p className="text-xs text-muted-foreground">{meta?.blurb}</p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => remove(index)}
              >
                <Trash2Icon />
                <span className="sr-only">Remove this action</span>
              </Button>
            </div>

            {action.kind === "knowledge" && (
              <Input
                className="mt-3"
                placeholder="Entry title — blank uses the routine's name and the date"
                value={action.title ?? ""}
                onChange={(e) => patch(index, { ...action, title: e.target.value || undefined })}
              />
            )}

            {action.kind === "task" && (
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                <Input
                  placeholder="Card title — blank uses the routine's name"
                  value={action.title ?? ""}
                  onChange={(e) => patch(index, { ...action, title: e.target.value || undefined })}
                />
                <Select
                  value={action.boardId ?? SERVER_DEFAULT}
                  onValueChange={(v) =>
                    v &&
                    patch(index, {
                      ...action,
                      boardId: v === SERVER_DEFAULT ? undefined : v,
                      // A column belongs to a board; keeping one across a board
                      // change would name a column the new board does not have.
                      statusId: undefined,
                    })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue>
                      {boards.boards.find((b) => b.id === action.boardId)?.name ?? "Default board"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={SERVER_DEFAULT}>Default board</SelectItem>
                    {boards.boards.map((board) => (
                      <SelectItem key={board.id} value={board.id}>
                        {board.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={action.statusId ?? SERVER_DEFAULT}
                  onValueChange={(v) =>
                    v && patch(index, { ...action, statusId: v === SERVER_DEFAULT ? undefined : v })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue>
                      {boards.statuses.find((s) => s.id === action.statusId)?.name ?? "First column"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={SERVER_DEFAULT}>First column</SelectItem>
                    {statusesOf(boards.statuses, action.boardId ?? "").map((status) => (
                      <SelectItem key={status.id} value={status.id}>
                        {status.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {action.kind === "routine" &&
              (routines.length === 0 ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  There is no other routine to fire yet.
                </p>
              ) : (
                <Select
                  value={action.routineId}
                  onValueChange={(v) => v && patch(index, { ...action, routineId: v })}
                >
                  <SelectTrigger className="mt-3 w-full">
                    <SelectValue>
                      {routines.find((r) => r.id === action.routineId)?.name ?? "Pick a routine"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {routines.map((routine) => (
                      <SelectItem key={routine.id} value={routine.id}>
                        {routine.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ))}
          </div>
        )
      })}

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button type="button" size="sm" variant="outline">
              <PlusIcon data-icon="inline-start" />
              Add an action
            </Button>
          }
        />
        <DropdownMenuContent align="start" className="w-64">
          {(Object.keys(KIND_META) as OnFinishAction["kind"][]).map((kind) => {
            const meta = KIND_META[kind]
            const Icon = meta.icon
            return (
              <DropdownMenuItem key={kind} onClick={() => add(kind)}>
                <Icon className="size-4 text-muted-foreground" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{meta.label}</span>
                  <span className="truncate text-[10px] text-muted-foreground">{meta.blurb}</span>
                </span>
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
