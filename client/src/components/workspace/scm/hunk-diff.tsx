/* ── A file's diff, drawn as hunks you can act on ──
   Sublime Merge's centre: the diff is not a picture of a change but a list of
   them, each with its own verb. A hunk stages whole from its header; clicking
   changed lines picks them and the verb narrows to "Stage 3 lines". The patches
   are cut by `lib/workspace/diff-patch.ts` out of git's own diff and go back
   through the one `apply` door. Without `onApply` (a commit's file) it only
   reads. */
import * as React from "react"
import { ExternalLinkIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { DiffRowsSkeleton } from "@/components/ui/skeletons"
import { Empty } from "@/components/empty"
import { Notice } from "@/components/notice"
import { PanelToolbar } from "@/components/workspace/primitives"
import { describeError } from "@/lib/errors"
import { useServer } from "@/lib/server-context"
import { cn } from "@/lib/utils"
import { gitDiff } from "@/lib/workspace/git-api"
import { isChange, parsePatch, patchFor, type FilePatch } from "@/lib/workspace/diff-patch"

export type DiffSource = "unstaged" | "staged" | { rev: string }
export type HunkVerb = "stage" | "unstage" | "discard"

export function HunkDiff({
  projectId,
  repo,
  path,
  from,
  untracked,
  source,
  version,
  busy,
  onApply,
  onOpenFull,
}: {
  projectId: string
  repo: string
  path: string
  from?: string
  untracked?: boolean
  source: DiffSource
  /** Changes when the thing the diff was read from may have - re-reads it. */
  version: number
  busy?: boolean
  onApply?: (patch: string, verb: HunkVerb) => Promise<boolean>
  onOpenFull?: () => void
}) {
  const settings = useServer()
  const [file, setFile] = React.useState<FilePatch | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [picked, setPicked] = React.useState<ReadonlyMap<number, ReadonlySet<number>>>(new Map())
  const key = `${path}\0${typeof source === "string" ? source : source.rev}`
  const shown = React.useRef(key)

  React.useEffect(() => {
    /* A different file or side is not a refresh: its hunks must not stay under
       buttons that would apply them. */
    if (shown.current !== key) {
      shown.current = key
      setFile(null)
    }
    const controller = new AbortController()
    gitDiff(
      settings,
      projectId,
      {
        path,
        from,
        untracked,
        repo: repo || undefined,
        comparison: source === "unstaged" ? "worktree" : source === "staged" ? "staged" : source,
      },
      controller.signal
    )
      .then(({ patch }) => {
        setFile(parsePatch(patch))
        setError(null)
        setPicked(new Map())
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(describeError(err).title)
      })
    return () => controller.abort()
    // `source` is folded into `key`; the object form would re-run on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, projectId, repo, path, from, untracked, key, version])

  const toggle = (hunk: number, line: number) =>
    setPicked((current) => {
      const next = new Map(current)
      const set = new Set(next.get(hunk))
      if (set.has(line)) set.delete(line)
      else set.add(line)
      if (set.size === 0) next.delete(hunk)
      else next.set(hunk, set)
      return next
    })

  const act = async (hunkIndex: number, verb: HunkVerb) => {
    if (!file || !onApply) return
    const lines = picked.get(hunkIndex)
    const patch = patchFor(file, file.hunks[hunkIndex]!, lines, verb !== "stage")
    if (patch) await onApply(patch, verb)
  }

  const editable = !!onApply && !busy
  const staged = source === "staged"

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <PanelToolbar className="sticky top-0 z-20 gap-2 bg-background px-3">
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={from ? `${from} -> ${path}` : path}>{path}</span>
        {onOpenFull && (
          <Button variant="ghost" size="xs" onClick={onOpenFull} title="Open the whole file as a side-by-side diff">
            <ExternalLinkIcon data-icon="inline-start" /> Full diff
          </Button>
        )}
      </PanelToolbar>
      {error ? (
        <Notice tone="error" className="m-3" copy={error}>{error}</Notice>
      ) : !file ? (
        <DiffRowsSkeleton hunks={1} />
      ) : file.hunks.length === 0 ? (
        file.binary ? (
          <Empty className="m-3">Binary file - no text to show.</Empty>
        ) : file.head.length === 0 ? (
          <Empty className="m-3">No changes.</Empty>
        ) : (
          <pre className="px-3 py-4 font-mono text-xs whitespace-pre-wrap text-muted-foreground">{file.head.join("\n")}</pre>
        )
      ) : (
        file.hunks.map((hunk, h) => {
          const count = picked.get(h)?.size ?? 0
          const what = count > 0 ? `${count} ${count === 1 ? "line" : "lines"}` : "hunk"
          let oldNo = hunk.oldStart
          let newNo = hunk.newStart
          return (
            <section key={hunk.header} className="border-b">
              <div className="sticky top-8 z-10 flex min-h-7 items-center gap-2 border-y bg-muted px-3 text-xs text-muted-foreground">
                <span className="min-w-0 flex-1 truncate font-mono">{hunk.header}</span>
                {onApply && (
                  <>
                    {!staged && !untracked && (
                      <Button variant="destructive" size="xs" disabled={!editable} onClick={() => void act(h, "discard")}>
                        Discard {what}
                      </Button>
                    )}
                    <Button variant="outline" size="xs" disabled={!editable} onClick={() => void act(h, staged ? "unstage" : "stage")}>
                      {staged ? "Unstage" : "Stage"} {what}
                    </Button>
                  </>
                )}
              </div>
              <div className="font-mono text-xs leading-5">
                {hunk.lines.map((line, i) => {
                  const o = line.kind === "+" ? "" : oldNo
                  const n = line.kind === "-" ? "" : newNo
                  if (line.kind !== "+") oldNo += 1
                  if (line.kind !== "-") newNo += 1
                  const on = picked.get(h)?.has(i) ?? false
                  const pickable = !!onApply && isChange(line)
                  return (
                    <div
                      key={i}
                      onClick={pickable ? () => toggle(h, i) : undefined}
                      className={cn(
                        "flex",
                        line.kind === "+" && "bg-success/10",
                        line.kind === "-" && "bg-destructive/10",
                        on && "bg-primary/15",
                        pickable && "cursor-pointer hover:bg-muted"
                      )}
                    >
                      <span className="w-9 shrink-0 select-none bg-muted/50 pr-1 text-right text-muted-foreground">{o}</span>
                      <span className="w-9 shrink-0 select-none border-r bg-muted/50 pr-1 text-right text-muted-foreground">{n}</span>
                      <span className={cn("w-4 shrink-0 select-none text-center", line.kind === "+" && "text-success", line.kind === "-" && "text-destructive")}>
                        {on ? "✓" : line.kind === " " ? "" : line.kind}
                      </span>
                      <span className="min-w-0 flex-1 whitespace-pre pr-3">{line.text}</span>
                    </div>
                  )
                })}
              </div>
            </section>
          )
        })
      )}
    </div>
  )
}
