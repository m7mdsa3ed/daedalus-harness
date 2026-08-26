/* Checklists are a json column on the task — small, always read whole, and
   referenced by nothing — so every edit here is one `patchTask` carrying the
   whole `checklists` array. That is the deliberate trade the schema makes: no
   join table to keep honest, at the cost of rewriting a short array. */
import * as React from "react"
import { Plus, Trash2 } from "lucide-react"
import { reportError } from "@/lib/errors"
import type { Actions } from "@/lib/actions"
import type { Checklist, ChecklistItem, Task } from "@/lib/pm/types"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"

function countDone(lists: Checklist[]): { done: number; total: number } {
  let done = 0
  let total = 0
  for (const list of lists)
    for (const item of list.items) {
      total += 1
      if (item.done) done += 1
    }
  return { done, total }
}

export function ChecklistEditor({
  boardId,
  task,
  actions,
}: {
  boardId: string
  task: Task
  actions: Actions
}) {
  const lists = task.checklists ?? []
  const [newList, setNewList] = React.useState("")
  const [drafts, setDrafts] = React.useState<Record<string, string>>({})

  const write = (next: Checklist[]) => {
    actions
      .patchTask(boardId, task.id, { checklists: next })
      .catch((error) => reportError(error, "Couldn't save the checklist"))
  }

  const mapList = (listId: string, fn: (list: Checklist) => Checklist) =>
    write(lists.map((list) => (list.id === listId ? fn(list) : list)))

  const addList = () => {
    const name = newList.trim()
    if (!name) return
    setNewList("")
    write([...lists, { id: crypto.randomUUID(), name, items: [] }])
  }

  const addItem = (listId: string) => {
    const text = (drafts[listId] ?? "").trim()
    if (!text) return
    setDrafts((current) => ({ ...current, [listId]: "" }))
    const item: ChecklistItem = { id: crypto.randomUUID(), text, done: false }
    mapList(listId, (list) => ({ ...list, items: [...list.items, item] }))
  }

  const { done, total } = countDone(lists)

  return (
    <div className="space-y-4 p-4">
      {total > 0 && (
        <div className="flex items-center gap-3">
          <Progress
            value={(done / total) * 100}
            className="flex-1 [&_[data-slot=progress-track]]:h-1.5"
          />
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {done}/{total}
          </span>
        </div>
      )}

      {lists.map((list) => (
        <section key={list.id} className="space-y-1.5 rounded-xl border p-3">
          <header className="flex items-center gap-2">
            <Input
              defaultValue={list.name}
              key={`${list.id}:${list.name}`}
              className="h-7 border-0 bg-transparent px-1 text-sm font-medium shadow-none focus-visible:bg-input/30"
              onBlur={(event) => {
                const name = event.target.value.trim()
                if (name && name !== list.name) mapList(list.id, (l) => ({ ...l, name }))
              }}
            />
            <Button
              variant="ghost"
              size="icon-xs"
              title="Delete checklist"
              onClick={() => write(lists.filter((l) => l.id !== list.id))}
            >
              <Trash2 />
            </Button>
          </header>

          {list.items.map((item) => (
            <div key={item.id} className="group/item flex items-center gap-2 py-0.5">
              <Checkbox
                checked={item.done}
                onCheckedChange={(checked) =>
                  mapList(list.id, (l) => ({
                    ...l,
                    items: l.items.map((it) =>
                      it.id === item.id ? { ...it, done: checked === true } : it
                    ),
                  }))
                }
              />
              <span
                className={
                  item.done
                    ? "flex-1 text-[13px] text-muted-foreground line-through"
                    : "flex-1 text-[13px]"
                }
              >
                {item.text}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                className="opacity-0 group-hover/item:opacity-100"
                title="Delete item"
                onClick={() =>
                  mapList(list.id, (l) => ({
                    ...l,
                    items: l.items.filter((it) => it.id !== item.id),
                  }))
                }
              >
                <Trash2 />
              </Button>
            </div>
          ))}

          <Input
            value={drafts[list.id] ?? ""}
            onChange={(event) =>
              setDrafts((current) => ({ ...current, [list.id]: event.target.value }))
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                addItem(list.id)
              }
            }}
            onBlur={() => addItem(list.id)}
            placeholder="Add an item…"
            className="h-7 text-[13px]"
          />
        </section>
      ))}

      <div className="flex items-center gap-2">
        <Input
          value={newList}
          onChange={(event) => setNewList(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              addList()
            }
          }}
          placeholder="New checklist…"
          className="h-8 text-[13px]"
        />
        <Button variant="outline" size="sm" onClick={addList} disabled={newList.trim() === ""}>
          <Plus /> Add
        </Button>
      </div>
    </div>
  )
}
