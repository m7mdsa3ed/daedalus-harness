/* ── Unsaved edits, held outside the component that is showing them ──
   The Preview panel draws one file at a time, so an editor that kept its text in
   itself would lose it on every tab switch and every re-open. A draft lives here
   instead, keyed by project and path, for as long as the page does.

   `base` is the text the file had when it was last read or saved and `version`
   is the server's token for it (the write sends it back, so a file an agent
   rewrote in the meantime is a 409 and not an edit that silently wins). A draft
   is **dirty** when its text is not its base — an opened-and-untouched editor
   holds a clean draft, which is why opening a file to look at it never raises
   a "discard changes?" question.

   Deliberately not persisted: a draft that survived a reload would be applied
   to a file that may have moved on since, which is the thing the version
   exists to catch. */
import * as React from "react"

export interface Draft {
  text: string
  base: string
  version: string
}

const drafts = new Map<string, Draft>()
const listeners = new Set<() => void>()
let rev = 0

const SEP = "\u0000"
const keyOf = (projectId: string, path: string) => `${projectId}${SEP}${path}`
const emit = () => {
  rev++
  for (const listener of [...listeners]) listener()
}

export const isDirty = (draft: Draft | undefined): boolean => !!draft && draft.text !== draft.base

export function getDraft(projectId: string, path: string): Draft | undefined {
  return drafts.get(keyOf(projectId, path))
}

export function setDraft(projectId: string, path: string, draft: Draft): void {
  drafts.set(keyOf(projectId, path), draft)
  emit()
}

export function clearDraft(projectId: string, path: string): void {
  if (drafts.delete(keyOf(projectId, path))) emit()
}

/** The paths of one project with unsaved changes, sorted. */
export function dirtyPaths(projectId: string): string[] {
  const prefix = `${projectId}${SEP}`
  const out: string[] = []
  for (const [key, draft] of drafts) if (key.startsWith(prefix) && isDirty(draft)) out.push(key.slice(prefix.length))
  return out.sort()
}

const under = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`)

/** A rename: the drafts of `from` (or of everything under it) follow to `to`. */
export function moveDrafts(projectId: string, from: string, to: string): void {
  const prefix = `${projectId}${SEP}`
  const moved: [string, Draft][] = []
  for (const [key, draft] of drafts) {
    if (!key.startsWith(prefix)) continue
    const path = key.slice(prefix.length)
    if (!under(path, from)) continue
    drafts.delete(key)
    moved.push([keyOf(projectId, to + path.slice(from.length)), draft])
  }
  if (moved.length === 0) return
  for (const [key, draft] of moved) drafts.set(key, draft)
  emit()
}

/** A delete: the drafts of `path` and of everything under it are gone. */
export function dropDrafts(projectId: string, path: string): void {
  const prefix = `${projectId}${SEP}`
  let changed = false
  for (const key of [...drafts.keys()]) {
    if (key.startsWith(prefix) && under(key.slice(prefix.length), path)) {
      drafts.delete(key)
      changed = true
    }
  }
  if (changed) emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** One file's draft, re-read when any draft changes. */
export function useDraft(projectId: string, path: string): Draft | undefined {
  React.useSyncExternalStore(subscribe, () => rev)
  return getDraft(projectId, path)
}

/** A project's dirty paths; the same array while nothing changed. */
export function useDirtyPaths(projectId: string): string[] {
  const current = React.useSyncExternalStore(subscribe, () => rev)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `current` is the store's revision
  return React.useMemo(() => dirtyPaths(projectId), [projectId, current])
}
