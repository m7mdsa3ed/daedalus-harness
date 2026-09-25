import type { TaskInput } from "./tasks-board"

const key = (serverId: string, boardId: string) => `ui.tasks.draft.${serverId}.${boardId}`

export function loadNewTaskDraft(serverId: string, boardId: string): TaskInput | null {
  try {
    const raw = localStorage.getItem(key(serverId, boardId))
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const draft = value as Record<string, unknown>
    const nullableString = (field: string) => draft[field] === null || typeof draft[field] === "string"
    const nullableNumber = (field: string) => draft[field] === null || typeof draft[field] === "number"
    if (typeof draft.title !== "string" || typeof draft.description !== "string") return null
    if (typeof draft.statusId !== "string" || !["task", "bug", "story", "epic"].includes(String(draft.type))) return null
    if (!["lowest", "low", "medium", "high", "urgent"].includes(String(draft.priority))) return null
    if (!Array.isArray(draft.labels) || !draft.labels.every((label) => typeof label === "string")) return null
    if (!nullableString("assignee") || !nullableString("parentId") || !nullableString("sprintId")) return null
    if (!nullableNumber("estimate") || !nullableNumber("startAt") || !nullableNumber("dueAt")) return null
    return {
      title: draft.title,
      description: draft.description,
      statusId: draft.statusId,
      type: draft.type as TaskInput["type"],
      priority: draft.priority as TaskInput["priority"],
      labels: draft.labels,
      assignee: draft.assignee as string | null,
      parentId: draft.parentId as string | null,
      sprintId: draft.sprintId as string | null,
      estimate: draft.estimate as number | null,
      startAt: draft.startAt as number | null,
      dueAt: draft.dueAt as number | null,
    }
  } catch {
    return null
  }
}

export function saveNewTaskDraft(serverId: string, boardId: string, draft: TaskInput): void {
  try {
    localStorage.setItem(key(serverId, boardId), JSON.stringify(draft))
  } catch {
    // A full or blocked storage costs the draft, never task creation.
  }
}

export function clearNewTaskDraft(serverId: string, boardId: string): void {
  try {
    localStorage.removeItem(key(serverId, boardId))
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}
