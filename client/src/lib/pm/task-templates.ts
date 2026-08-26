import { useSyncExternalStore } from "react"
import type { Board, Checklist, CustomFieldValues, Task, TaskCreateInput } from "./types"

/* ── Task templates ──
   A shape a board's tasks keep taking — "Release checklist", "Bug report" —
   saved so the next one starts filled in. Deliberately device-local, in
   localStorage next to pins and prefs: the server has no task-template table
   (W1's schema stops at board templates, which ARE server-side — see
   components/pm/settings/template-flows), and inventing one on the client's
   behalf would put a private habit on everyone else's board.

   Same shape as lib/pins.ts and lib/pm/prefs.ts: one module-level cache, a
   listener set, a `storage` listener so a second tab's save lands here too.
   Keys are per board — `ui.pm.taskTemplates.<boardId>` — because every id a
   template carries (column, type, labels, custom fields) belongs to one board.

   What a template stores is a *partial* TaskCreateInput. Two omissions are on
   purpose: absolute dates (a due date is the one thing that is never reusable)
   and `parentId` (a subtask's parent is the context it was created in, not the
   shape of the work). */

const STORAGE_KEY = "ui.pm.taskTemplates"

const boardKey = (boardId: string) => `${STORAGE_KEY}.${boardId}`

/** The reusable half of a task, under a name the picker shows. */
export interface TaskTemplate {
  id: string
  name: string
  createdAt: number
  /** A TaskCreateInput minus title/dates — see the module note. */
  input: Partial<TaskCreateInput>
}

/** boardId -> its templates, newest save last (the order the picker shows). */
type Templates = Record<string, TaskTemplate[]>

function parse(raw: string | null): TaskTemplate[] {
  try {
    const value = JSON.parse(raw ?? "[]") as unknown
    if (!Array.isArray(value)) return []
    return value.filter(
      (entry): entry is TaskTemplate =>
        !!entry &&
        typeof entry === "object" &&
        typeof (entry as TaskTemplate).id === "string" &&
        typeof (entry as TaskTemplate).name === "string" &&
        !!(entry as TaskTemplate).input &&
        typeof (entry as TaskTemplate).input === "object"
    )
  } catch {
    return []
  }
}

function readAll(): Templates {
  const templates: Templates = {}
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith(`${STORAGE_KEY}.`)) continue
      templates[key.slice(STORAGE_KEY.length + 1)] = parse(localStorage.getItem(key))
    }
  } catch {
    // Corrupt or unavailable storage reads as "no templates".
  }
  return templates
}

let cache = readAll()
const listeners = new Set<() => void>()

function notify() {
  for (const listener of listeners) listener()
}

function write(boardId: string, next: TaskTemplate[]) {
  try {
    if (next.length === 0) localStorage.removeItem(boardKey(boardId))
    else localStorage.setItem(boardKey(boardId), JSON.stringify(next))
  } catch {
    // Losing a template is survivable; throwing out of a click handler is not.
  }
  cache = readAll()
  notify()
}

export const taskTemplatesSnapshot = (): Templates => cache

export function subscribeTaskTemplates(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const EMPTY: TaskTemplate[] = []

/** One board's templates, oldest first. Stable empty array — the reference is
    what a memo'd picker depends on. */
export const taskTemplates = (boardId: string): TaskTemplate[] => cache[boardId] ?? EMPTY

function newId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `tpl-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  }
}

/** Save a payload under a name. A repeat of an existing name replaces it —
    "Save as template" twice is an update, not a second identical row. */
export function saveTaskTemplate(
  boardId: string,
  name: string,
  input: Partial<TaskCreateInput>
): TaskTemplate {
  const trimmed = name.trim() || "Untitled template"
  const existing = taskTemplates(boardId)
  const previous = existing.find((t) => t.name.toLowerCase() === trimmed.toLowerCase())
  const template: TaskTemplate = {
    id: previous?.id ?? newId(),
    name: trimmed,
    createdAt: Date.now(),
    input,
  }
  write(
    boardId,
    previous
      ? existing.map((t) => (t.id === previous.id ? template : t))
      : [...existing, template]
  )
  return template
}

export function removeTaskTemplate(boardId: string, templateId: string): void {
  const next = taskTemplates(boardId).filter((t) => t.id !== templateId)
  if (next.length !== taskTemplates(boardId).length) write(boardId, next)
}

export function renameTaskTemplate(boardId: string, templateId: string, name: string): void {
  const trimmed = name.trim()
  if (!trimmed) return
  write(
    boardId,
    taskTemplates(boardId).map((t) => (t.id === templateId ? { ...t, name: trimmed } : t))
  )
}

/** Drop templates for boards the server no longer lists — same contract as
    `prunePins` / `prunePmPrefs`: opinions outlive a refresh, not a deletion. */
export function pruneTaskTemplates(boardIds: Iterable<string>): void {
  const live = new Set(boardIds)
  const dead = Object.keys(cache).filter((id) => !live.has(id))
  if (dead.length === 0) return
  try {
    for (const id of dead) localStorage.removeItem(boardKey(id))
  } catch {
    // See write().
  }
  cache = readAll()
  notify()
}

/* Another tab's save is this device's save too. */
window.addEventListener("storage", (event) => {
  if (event.key !== null && !event.key.startsWith(STORAGE_KEY)) return
  cache = readAll()
  notify()
})

/** One board's templates, live. */
export function useTaskTemplates(boardId: string): TaskTemplate[] {
  return useSyncExternalStore(
    subscribeTaskTemplates,
    () => taskTemplates(boardId),
    () => taskTemplates(boardId)
  )
}

// ---------------------------------------------------------------------------
// Pure payload helpers

/** The reusable half of an existing task. Dates and `parentId` are dropped on
    purpose (see the module note); checklists come back with every tick reset,
    which is what a template of a checklist means. */
export function templateFromTask(task: Task): Partial<TaskCreateInput> {
  return {
    title: task.title,
    descriptionMd: task.descriptionMd,
    columnId: task.columnId,
    typeId: task.typeId,
    priority: task.priority,
    assignees: [...task.assignees],
    storyPoints: task.storyPoints,
    estimateMinutes: task.estimateMinutes,
    epicId: task.epicId,
    sprintId: task.sprintId,
    milestoneId: task.milestoneId,
    labelIds: [...task.labelIds],
    recurrence: task.recurrence,
    customFieldValues: { ...task.customFieldValues },
    checklists: resetChecklists(task.checklists),
  }
}

function resetChecklists(checklists: Checklist[]): Checklist[] {
  return checklists.map((list) => ({
    ...list,
    id: newId(),
    items: list.items.map((item) => ({ ...item, id: newId(), done: false })),
  }))
}

/**
 * A template is stored ids and all, and a board's ids move: a column can be
 * deleted, a label removed, a custom field dropped. The server answers an
 * unknown custom-field id with a 400 and an unknown column with a 404, so a
 * stale template must be trimmed against the board before it is used rather
 * than failing the create it was supposed to make easy.
 */
export function sanitizeTemplateInput(
  board: Board,
  input: Partial<TaskCreateInput>
): Partial<TaskCreateInput> {
  const has = (list: { id: string }[], id: string | null | undefined) =>
    typeof id === "string" && list.some((row) => row.id === id)

  const fields = new Map(board.customFields.map((field) => [field.id, field]))
  const values: CustomFieldValues = {}
  for (const [fieldId, value] of Object.entries(input.customFieldValues ?? {})) {
    if (fields.has(fieldId)) values[fieldId] = value
  }

  return {
    ...input,
    columnId: has(board.columns, input.columnId) ? input.columnId : undefined,
    typeId: has(board.issueTypes, input.typeId) ? input.typeId : null,
    sprintId: has(board.sprints, input.sprintId) ? input.sprintId : null,
    milestoneId: has(board.milestones, input.milestoneId) ? input.milestoneId : null,
    labelIds: (input.labelIds ?? []).filter((id) => has(board.labels, id)),
    // The epic is a task, not board config — it cannot be checked here, and a
    // stale one only costs the create a 404, so it rides along unverified.
    customFieldValues: values,
    checklists: resetChecklists(input.checklists ?? []),
  }
}
