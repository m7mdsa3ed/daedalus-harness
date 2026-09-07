/* ── What source control is being asked about ──
   A narrowing of the IDE's source-control view to a named set of paths, held
   per project in a module store — the same shape and for the same reasons as
   `editors.ts`: the panel unmounts when its tab is closed or the layout is
   rearranged, and the question you asked must outlive that.

   It exists because a turn's "7 files changed" is a question about the working
   set, not a second view of it. The files are already in source control, where
   they can be read as a diff and *acted on* — staged, discarded, committed —
   so the review is that view with everything else hidden, and the alternative
   (a list of the same paths in a surface that could do none of it) was the
   changes tab this replaces.

   **Not persisted, deliberately.** It is a question asked once, about a turn
   that has just happened; a filter restored from localStorage a day later is a
   panel that looks broken. `idePrefs` is for the reader's standing choices,
   which this is not.

   **Paths are repository-relative**, as everything in source control is
   (`projectPath` is the join back out). A turn is measured in the project's own
   repository, so in a project holding several the filter is matched against all
   of them — a path that collides across two repositories shows one extra row,
   which is a better failure than hiding the file you asked about. */
import * as React from "react"

export interface ScmFilter {
  /** What the banner says this is: "7 files from this turn". */
  label: string
  paths: ReadonlySet<string>
  /** Bumped per request, so asking twice for the same set is two answers —
      what makes a second chip click re-open the side view you just closed. */
  nonce: number
}

const filters = new Map<string, ScmFilter>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of [...listeners]) listener()
}

export function scmFilterOf(projectId: string): ScmFilter | null {
  return filters.get(projectId) ?? null
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useScmFilter(projectId: string): ScmFilter | null {
  return React.useSyncExternalStore(
    subscribe,
    () => scmFilterOf(projectId),
    () => null
  )
}

/** Narrow this project's source control, or (with no paths) stop narrowing. */
export function setScmFilter(projectId: string, filter: { label: string; paths: string[] } | null): void {
  if (!filter || filter.paths.length === 0) {
    if (!filters.delete(projectId)) return
    emit()
    return
  }
  const nonce = (filters.get(projectId)?.nonce ?? 0) + 1
  filters.set(projectId, { label: filter.label, paths: new Set(filter.paths), nonce })
  emit()
}

/** A project that is gone takes its question with it. */
export function forgetScmFilter(projectId: string): void {
  if (!filters.delete(projectId)) return
  emit()
}
