/* The per-task journal, read the way the server writes it: one row per changed
   field per mutation, `seq` monotonic. It is fetched when the tab opens and
   forgotten when the editor closes — activity never enters the store (the
   journal rule: a long history costs no RAM and pages as a range scan).

   Phrasing lives here and nowhere else. The server journals raw column names
   and raw values (`columnId`, epoch ms, id arrays); a human reads "moved to In
   progress", so the board's config tables are what turns one into the other. */
import * as React from "react"
import { reportError } from "@/lib/errors"
import { shortAge } from "@/lib/time"
import type { Actions } from "@/lib/actions"
import type { ActivityEntry, Board } from "@/lib/pm/types"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

const PRIORITIES = ["None", "Low", "Medium", "High", "Urgent"]

/** Field names the server journals, in the voice a person would use. */
const FIELD_LABELS: Record<string, string> = {
  title: "title",
  descriptionMd: "description",
  columnId: "status",
  typeId: "type",
  priority: "priority",
  assignees: "assignees",
  startDate: "start date",
  dueDate: "due date",
  storyPoints: "story points",
  estimateMinutes: "estimate",
  epicId: "epic",
  parentId: "parent",
  sprintId: "sprint",
  milestoneId: "milestone",
  milestone: "milestone",
  recurrence: "recurrence",
  customFieldValues: "custom fields",
  checklists: "checklists",
  labels: "labels",
  archivedAt: "archive",
  deletedAt: "trash",
  completedAt: "completion",
}

function names(board: Board, field: string, value: unknown): string | null {
  if (value === null || value === undefined) return null
  const lookup = (list: Array<{ id: string; name: string }>, id: unknown) =>
    list.find((entry) => entry.id === id)?.name ?? String(id)
  switch (field) {
    case "columnId":
      return lookup(board.columns, value)
    case "typeId":
      return lookup(board.issueTypes, value)
    case "sprintId":
      return lookup(board.sprints, value)
    case "milestoneId":
      return lookup(board.milestones, value)
    case "priority":
      return PRIORITIES[Number(value)] ?? String(value)
    case "startDate":
    case "dueDate":
    case "completedAt":
    case "archivedAt":
    case "deletedAt":
      return new Date(Number(value)).toLocaleDateString()
    case "labels":
      return Array.isArray(value)
        ? value.map((id) => lookup(board.labels, id)).join(", ") || "none"
        : String(value)
    case "assignees":
      return Array.isArray(value) ? value.join(", ") || "nobody" : String(value)
    case "estimateMinutes":
      return `${value}m`
    case "descriptionMd":
    case "checklists":
    case "customFieldValues":
    case "recurrence":
      return null // Bodies are too long to quote — "edited the description".
    default:
      return typeof value === "object" ? null : String(value)
  }
}

/** One journal row as a sentence. Returns the phrase after the actor. */
function phrase(board: Board, entry: ActivityEntry): string {
  const label = FIELD_LABELS[entry.field] ?? entry.field
  if (entry.field === "created") {
    const to = entry.to as { key?: string; title?: string } | null
    return `created ${to?.key ?? "the task"}${to?.title ? ` — ${to.title}` : ""}`
  }
  if (entry.field === "columnId") {
    const to = names(board, entry.field, entry.to)
    return to ? `moved to ${to}` : "moved"
  }
  if (entry.field === "archivedAt") return entry.to ? "archived" : "unarchived"
  if (entry.field === "deletedAt") return entry.to ? "moved to Trash" : "restored"
  if (entry.field === "completedAt") return entry.to ? "completed" : "reopened"

  const from = names(board, entry.field, entry.from)
  const to = names(board, entry.field, entry.to)
  if (to === null && from === null) return `edited the ${label}`
  if (entry.to === null || entry.to === undefined) return `cleared the ${label}`
  if (from === null) return `set ${label} to ${to}`
  return `${label} ${from} → ${to}`
}

export function ActivityList({
  board,
  taskId,
  actions,
}: {
  board: Board
  taskId: string
  actions: Actions
}) {
  const [entries, setEntries] = React.useState<ActivityEntry[] | null>(null)

  const load = React.useCallback(() => {
    let live = true
    setEntries(null)
    actions
      .listActivity(board.id, taskId)
      .then((rows) => live && setEntries(rows))
      .catch((error) => {
        if (!live) return
        setEntries([])
        reportError(error, "Couldn't load the activity")
      })
    return () => {
      live = false
    }
  }, [actions, board.id, taskId])

  React.useEffect(load, [load])

  if (entries === null) {
    return (
      <div className="space-y-2 p-4">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    )
  }

  if (entries.length === 0) {
    return <p className="p-4 text-xs text-muted-foreground">Nothing has happened yet.</p>
  }

  return (
    <div className="space-y-3 p-4">
      {entries
        .slice()
        .reverse()
        .map((entry) => (
          <div key={entry.seq} className="flex gap-2 text-xs">
            <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
            <div className="min-w-0 flex-1">
              <span className="font-medium text-foreground">{entry.actor}</span>{" "}
              <span className="text-muted-foreground">{phrase(board, entry)}</span>
            </div>
            <span
              className="shrink-0 tabular-nums text-muted-foreground/60"
              title={new Date(entry.at).toLocaleString()}
            >
              {shortAge(entry.at)}
            </span>
          </div>
        ))}
      <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={load}>
        Refresh
      </Button>
    </div>
  )
}
