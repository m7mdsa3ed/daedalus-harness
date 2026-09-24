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
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import type * as Monaco from "monaco-editor"

import { Notice } from "@/components/notice"
import { CopyButton } from "@/components/ui/copy-button"
import { DiffEditor, type DiffReview } from "@/components/workspace/diff-editor"
import { DiffRowsSkeleton } from "@/components/ui/skeletons"
import { PanelToolbar } from "@/components/workspace/primitives"
import { describeError } from "@/lib/errors"
import { useServer } from "@/lib/server-context"
import { isConflict, readFile, writeFile } from "@/lib/workspace/fs-api"
import { gitFileAt, gitWrite, scopeFileSide, type Comparison } from "@/lib/workspace/git-api"
import { hunkPatch, revertHunk, type LineChange } from "@/lib/workspace/hunks"
import { watchProject } from "@/lib/workspace/watch"

type MonacoDiff = Monaco.editor.IStandaloneDiffEditor

const SIDE_LABEL: Record<Comparison, string> = {
  head: "HEAD",
  staged: "Index",
  worktree: "Working tree",
}

/** A side read out of a thread's changes scope (`turn:<id>`, `thread`,
    `branch`, …) — a tree the server snapshotted, not a revision git names.
    `path` is thread-relative, which is what the scope's routes speak. */
export interface TreeSide {
  sessionId: string
  scope: string
  side: "before" | "after"
  path: string
}

export type DiffSide = Comparison | TreeSide

const sideLabel = (side: DiffSide) =>
  typeof side === "string" ? SIDE_LABEL[side] : side.side === "before" ? "Before" : "After"
const sideKey = (side: DiffSide | null) =>
  side === null || typeof side === "string" ? side : `${side.sessionId}\0${side.scope}\0${side.side}\0${side.path}`

/** One side of the comparison, whole. `generation` is how a caller says
    "read it again" — bumped by the watch stream and by Refresh. A null side
    reads nothing. */
function useSide(
  projectId: string,
  path: string,
  side: DiffSide | null,
  generation: number
): { text: string | null; error: string | null; version?: string } {
  const [text, setText] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  /* The worktree's version as read — what a hunk revert writes against. */
  const [version, setVersion] = React.useState<string | undefined>(undefined)

  React.useEffect(() => {
    const controller = new AbortController()
    const settle = (value: string, read?: string) => {
      if (controller.signal.aborted) return
      setText(value)
      setVersion(read)
      setError(null)
    }
    if (side === null) return
    if (side === "worktree") {
      void readFile(projectId, path, controller.signal)
        .then((file) => settle(file.content ?? "", file.version))
        /* Deleted on disk is a real answer, and an empty side is what it looks
           like. */
        .catch(() => settle(""))
    } else if (typeof side === "object") {
      void scopeFileSide(side.sessionId, side.scope, side.path, side.side)
        .then((result) => {
          /* A pruned snapshot is a sentence, said where the diff would be. */
          if (result.unavailable) throw new Error(result.unavailable)
          settle(result.missing ? "" : result.content)
        })
        .catch((err: unknown) => {
          if (!controller.signal.aborted) setError(describeError(err).title)
        })
    } else {
      void gitFileAt(projectId, path, side)
        .then((result) => settle(result.missing ? "" : result.content))
        .catch((err: unknown) => {
          if (!controller.signal.aborted) setError(describeError(err).title)
        })
    }
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the side's value, not its object
  }, [projectId, path, sideKey(side), generation])

  return { text, error, version }
}

export function DiffTab({
  projectId,
  path,
  left,
  right,
  active,
  repo,
  review,
  inline,
}: {
  projectId: string
  path: string
  left: DiffSide
  right: DiffSide
  /** The tab in front. Both sides keep being read either way — that is what
      makes a comparison current when you come back to it — but the diff editor
      is two models and the diff worker, so it exists only while it is being
      looked at. See `file-tab.tsx`. */
  active: boolean
  /** The repository the path is in (project-relative, "" for the project's
      own). Given on a comparison whose right side is the file on disk and
      whose left is the index or a scope's tree, it turns on the per-hunk
      Stage and Revert; without it there is no repository to stage into. */
  repo?: string
  /** Line comments — see `DiffEditor`. */
  review?: DiffReview
  /** One stacked diff with no toolbar, for a caller that already names the
      file (the inspector's inline rows). */
  inline?: boolean
}) {
  const [generation, setGeneration] = React.useState(0)
  const original = useSide(projectId, path, left, generation)
  const modified = useSide(projectId, path, right, generation)
  const [changes, setChanges] = React.useState<LineChange[]>([])
  const editorRef = React.useRef<MonacoDiff | null>(null)
  /* A scope's "after" tree that still reads as the disk does is the disk for
     the hunk verbs — the newest turn, reviewed before anything else wrote. */
  const afterTree = typeof right === "object" && right.side === "after"
  const disk = useSide(projectId, path, afterTree && repo !== undefined ? "worktree" : null, generation)
  const onDisk = right === "worktree" || (afterTree && disk.text !== null && disk.text === modified.text)
  const hunks = repo !== undefined && (left === "staged" || typeof left === "object") && onDisk

  /* Only worth listening for when one of the sides is the file on disk — two
     revisions do not move because someone saved. */
  const live = left === "worktree" || right === "worktree" || afterTree
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
      {!inline && <PanelToolbar>
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
          title={path}
        >
          {path}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {sideLabel(left)} ↔ {sideLabel(right)}
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
      </PanelToolbar>}
      {hunks && original.text !== null && modified.text !== null && changes.length > 0 && (
        <HunkBar
          projectId={projectId}
          path={path}
          repo={repo!}
          original={original.text}
          modified={modified.text}
          version={right === "worktree" ? modified.version : disk.version}
          changes={changes}
          editorRef={editorRef}
          onDone={() => setGeneration((current) => current + 1)}
        />
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        {original.text === null || modified.text === null ? (
          <DiffRowsSkeleton className="h-full overflow-y-auto" />
        ) : (
          active && (
            <DiffEditor
              original={original.text}
              modified={modified.text}
              filename={path}
              review={review}
              inline={inline}
              onLineChanges={hunks ? setChanges : undefined}
              editorRef={editorRef}
            />
          )
        )}
      </div>
    </div>
  )
}

/**
 * The unstaged hunks, one at a time: which one you are on, the way to the
 * next, and the two verbs (`lib/workspace/hunks.ts`). **Keep** is doing
 * nothing — or staging, which is the keep that sticks.
 *
 * Stage is `git apply --cached` of that hunk alone (the existing `apply`
 * route, which names `repo`); Revert writes the file with the hunk's lines put
 * back, through the file route, at the version the diff was read at — so an
 * agent that wrote the file since is a 409 said here, not an edit lost.
 */
function HunkBar({
  projectId,
  path,
  repo,
  original,
  modified,
  version,
  changes,
  editorRef,
  onDone,
}: {
  projectId: string
  path: string
  repo: string
  original: string
  modified: string
  version?: string
  changes: LineChange[]
  editorRef: React.RefObject<MonacoDiff | null>
  onDone: () => void
}) {
  const settings = useServer()
  const [index, setIndex] = React.useState(0)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const at = Math.min(index, changes.length - 1)
  const change = changes[at]!

  const reveal = (next: number) => {
    const target = changes[next]
    setIndex(next)
    const line = target?.modifiedStartLineNumber || 1
    const editor = editorRef.current?.getModifiedEditor()
    editor?.revealLineInCenter(line)
    editor?.setPosition({ lineNumber: line, column: 1 })
  }

  const act = async (verb: "stage" | "revert") => {
    setBusy(true)
    setError(null)
    try {
      if (verb === "stage") {
        /* The patch names the path relative to the repository's directory,
           which is where the server runs git. */
        const inRepo = repo && path.startsWith(`${repo}/`) ? path.slice(repo.length + 1) : path
        await gitWrite(settings, projectId, {
          action: "apply",
          patch: hunkPatch(inRepo, original, modified, change),
          cached: true,
          repo: repo || undefined,
        })
      } else {
        await writeFile(projectId, path, revertHunk(original, modified, change), { expectedVersion: version })
      }
      onDone()
    } catch (err) {
      setError(
        isConflict(err) && verb === "revert"
          ? "The file changed since this diff was read — refresh and try again."
          : describeError(err).title
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="shrink-0 border-b border-border/60">
      <div className="flex items-center gap-1 px-1.5 py-1 text-[11px]">
        <Button variant="ghost" size="icon-xs" aria-label="Previous change" title="Previous change" disabled={at === 0} onClick={() => reveal(at - 1)}>
          <ChevronLeftIcon aria-hidden />
        </Button>
        <span className="tabular-nums text-muted-foreground">
          Change {at + 1} of {changes.length}
        </span>
        <Button variant="ghost" size="icon-xs" aria-label="Next change" title="Next change" disabled={at >= changes.length - 1} onClick={() => reveal(at + 1)}>
          <ChevronRightIcon aria-hidden />
        </Button>
        <span className="flex-1" />
        <Button variant="ghost" size="xs" disabled={busy} onClick={() => void act("stage")} title="Stage this change only">
          Stage
        </Button>
        <Button variant="ghost" size="xs" disabled={busy} onClick={() => void act("revert")} title="Put this change's lines back as the left side has them">
          Revert
        </Button>
      </div>
      {error && (
        <Notice tone="error" className="mx-1.5 mb-1.5" action={<CopyButton text={error} size="icon-xs" />}>
          {error}
        </Notice>
      )}
    </div>
  )
}
