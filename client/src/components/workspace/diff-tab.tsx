/* ── A file against git ──
   The comparison a source-control row or a transcript's "compare" chip opens:
   HEAD (or the index) on the left, what is on disk on the right.

   Both sides are read whole rather than as a patch, because Monaco computes and
   draws its own diff — handing it a unified patch would mean re-deriving the
   text it needs from the hunks the server chose. The left side is a revision,
   so it is read once; the right side follows the worktree, so it re-reads when
   the project's files move.

   A side that does not exist is empty, not an error: a file added since HEAD has
   no left side, a deleted one no right. */
import * as React from "react"

import { DiffEditor } from "@/components/workspace/diff-editor"
import { PanelEmptyState, PanelToolbar } from "@/components/workspace/primitives"
import { describeError } from "@/lib/errors"
import { readFile } from "@/lib/workspace/fs-api"
import { gitFileAt, type Comparison } from "@/lib/workspace/git-api"
import { watchProject } from "@/lib/workspace/watch"

export function DiffTab({
  projectId,
  path,
  comparison,
}: {
  projectId: string
  path: string
  comparison: Exclude<Comparison, "worktree">
}) {
  const [original, setOriginal] = React.useState<string | null>(null)
  const [modified, setModified] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [generation, setGeneration] = React.useState(0)

  React.useEffect(() => {
    let cancelled = false
    void gitFileAt(projectId, path, comparison)
      .then((result) => {
        if (!cancelled) setOriginal(result.missing ? "" : result.content)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err).title)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, path, comparison])

  React.useEffect(() => {
    const controller = new AbortController()
    void readFile(projectId, path, controller.signal)
      .then((file) => {
        if (!controller.signal.aborted) setModified(file.content ?? "")
      })
      .catch(() => {
        /* Deleted on disk is a real answer, and the empty right-hand side is
           what it looks like. */
        if (!controller.signal.aborted) setModified("")
      })
    return () => controller.abort()
  }, [projectId, path, generation])

  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const stop = watchProject(projectId, (batch) => {
      if (!batch.overflow && !batch.events.some((event) => event.path === path)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setGeneration((current) => current + 1), 300)
    })
    return () => {
      if (timer) clearTimeout(timer)
      stop()
    }
  }, [projectId, path])

  if (error) return <PanelEmptyState>{error}</PanelEmptyState>
  if (original === null || modified === null) return <PanelEmptyState>Reading both sides…</PanelEmptyState>

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={path}>
          {path}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {comparison === "head" ? "HEAD ↔ working tree" : "Index ↔ working tree"}
        </span>
      </PanelToolbar>
      <div className="min-h-0 flex-1 overflow-hidden">
        <DiffEditor original={original} modified={modified} filename={path} />
      </div>
    </div>
  )
}
