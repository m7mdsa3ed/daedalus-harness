/* ── A file against git ──
   The comparison a source-control row or a transcript's "compare" chip opens.

   **Both sides are named**, and either can be a revision or the working file:
   HEAD ↔ worktree is "everything since the last commit", index ↔ worktree is
   "what is not staged", HEAD ↔ index is "what a commit would contain". Saying
   only which revision goes on the left forced the right to be the worktree, and
   a staged file then drew its unstaged edits as part of the commit.

   Both sides are read whole rather than as a patch, because Monaco computes and
   draws its own diff — handing it a unified patch would mean re-deriving the
   text it needs from the hunks the server chose.

   A side that does not exist is empty, not an error: a file added since HEAD has
   no left side, a deleted one no right.

   The **worktree** side follows the project's watch stream, because it changes
   under you while an agent works. A revision does not, so the two git sides are
   read once and moved on by the Refresh button — staging is the only thing that
   moves the index, and it happens in the panel next door. */
import * as React from "react"
import { RefreshIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { Empty } from "@/components/empty"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { DiffEditor } from "@/components/workspace/diff-editor"
import { DiffRowsSkeleton } from "@/components/ui/skeletons"
import { PanelToolbar } from "@/components/workspace/primitives"
import { describeError } from "@/lib/errors"
import { readFile } from "@/lib/workspace/fs-api"
import { gitFileAt, type Comparison } from "@/lib/workspace/git-api"
import { watchProject } from "@/lib/workspace/watch"

const SIDE_LABEL: Record<Comparison, string> = {
  head: "HEAD",
  staged: "Index",
  worktree: "Working tree",
}

/** One side of the comparison, whole. `generation` is how a caller says
    "read it again" — bumped by the watch stream and by Refresh. */
function useSide(
  projectId: string,
  path: string,
  side: Comparison,
  generation: number
): { text: string | null; error: string | null } {
  const [text, setText] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    const controller = new AbortController()
    const settle = (value: string) => {
      if (controller.signal.aborted) return
      setText(value)
      setError(null)
    }
    if (side === "worktree") {
      void readFile(projectId, path, controller.signal)
        .then((file) => settle(file.content ?? ""))
        /* Deleted on disk is a real answer, and an empty side is what it looks
           like. */
        .catch(() => settle(""))
    } else {
      void gitFileAt(projectId, path, side)
        .then((result) => settle(result.missing ? "" : result.content))
        .catch((err: unknown) => {
          if (!controller.signal.aborted) setError(describeError(err).title)
        })
    }
    return () => controller.abort()
  }, [projectId, path, side, generation])

  return { text, error }
}

export function DiffTab({
  projectId,
  path,
  left,
  right,
}: {
  projectId: string
  path: string
  left: Comparison
  right: Comparison
}) {
  const [generation, setGeneration] = React.useState(0)
  const original = useSide(projectId, path, left, generation)
  const modified = useSide(projectId, path, right, generation)

  /* Only worth listening for when one of the sides is the file on disk — two
     revisions do not move because someone saved. */
  const live = left === "worktree" || right === "worktree"
  React.useEffect(() => {
    if (!live) return
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
  }, [projectId, path, live])

  const error = original.error ?? modified.error
  if (error)
    return (
      <div className="p-2">
        <Empty>{error}</Empty>
      </div>
    )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar>
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
          title={path}
        >
          {path}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {SIDE_LABEL[left]} ↔ {SIDE_LABEL[right]}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                className="size-6 shrink-0"
                aria-label="Read both sides again"
                onClick={() => setGeneration((current) => current + 1)}
              >
                <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} className="size-3.5" />
              </Button>
            }
          />
          <TooltipContent>Read both sides again</TooltipContent>
        </Tooltip>
      </PanelToolbar>
      <div className="min-h-0 flex-1 overflow-hidden">
        {original.text === null || modified.text === null ? (
          <DiffRowsSkeleton className="h-full overflow-y-auto" />
        ) : (
          <DiffEditor original={original.text} modified={modified.text} filename={path} />
        )}
      </div>
    </div>
  )
}
