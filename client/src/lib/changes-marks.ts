/* ── What a reader has done in a thread's Changes tab ──
   The scope they read it in, the files they marked viewed and the files they
   flagged for the agent to fix. Device-local and per thread, like the review
   drafts beside them (`lib/review-comments.ts`): a reading position, not a
   fact about the conversation.

   **A viewed mark is keyed on the file's content, not only its path**: it
   stores a fingerprint (`fileFingerprint` — the status and the +/− counts, the
   one reading of the content every scope already carries) and counts only
   while the fingerprint matches, so a file that changed after you read it
   comes back unread without anything having to clear it. */
import { createLocalStore } from "@/lib/local-store"
import type { ChangedFile } from "@/lib/workspace/git-api"

export type ChangesScope = "turns" | "thread" | "uncommitted" | "branch"
export const CHANGES_SCOPES: readonly ChangesScope[] = ["turns", "thread", "uncommitted", "branch"]

interface ThreadMarks {
  scope?: ChangesScope
  /** `${scopeKey}\0${path}` → fingerprint when marked. */
  viewed?: Record<string, string>
  /** Thread-relative paths. */
  flagged?: string[]
}

type Marks = Record<string, ThreadMarks>

const store = createLocalStore<Marks>(
  "daedalus.changes-marks.v1",
  (raw) => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Marks) : {}),
  {}
)

const EMPTY: ThreadMarks = {}

export function useChangesMarks(sessionId: string): ThreadMarks {
  return store.use()[sessionId] ?? EMPTY
}

function write(sessionId: string, patch: (current: ThreadMarks) => ThreadMarks): void {
  const all = store.get()
  store.set({ ...all, [sessionId]: patch(all[sessionId] ?? EMPTY) })
}

/* ponytail: a close enough reading of "the content moved" — an edit that keeps
   both counts (one line swapped for another) keeps the mark. A blob id on
   `ChangedFile` is the upgrade if that ever matters. */
export const fileFingerprint = (file: ChangedFile) => `${file.status}:${file.additions}:${file.deletions}`

const viewKey = (scopeKey: string, path: string) => `${scopeKey}\0${path}`

export function isViewed(marks: ThreadMarks, scopeKey: string, file: ChangedFile): boolean {
  return marks.viewed?.[viewKey(scopeKey, file.path)] === fileFingerprint(file)
}

export function setViewed(sessionId: string, scopeKey: string, files: ChangedFile[], viewed: boolean): void {
  write(sessionId, (current) => {
    const next = { ...current.viewed }
    for (const file of files) {
      if (viewed) next[viewKey(scopeKey, file.path)] = fileFingerprint(file)
      else delete next[viewKey(scopeKey, file.path)]
    }
    return { ...current, viewed: next }
  })
}

export function setFlagged(sessionId: string, paths: string[], flagged: boolean): void {
  write(sessionId, (current) => {
    const next = new Set(current.flagged)
    for (const path of paths) {
      if (flagged) next.add(path)
      else next.delete(path)
    }
    return { ...current, flagged: [...next] }
  })
}

export function setChangesScope(sessionId: string, scope: ChangesScope): void {
  write(sessionId, (current) => ({ ...current, scope }))
}
