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
import { Spinner } from "@/components/ui/spinner"
import { Notice } from "@/components/notice"
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
      <div className="sticky top-0 z-20 flex h-8 items-center gap-2 border-b border-border/60 bg-background px-3">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={from ? `${from} -> ${path}` : path}>{path}</span>
        {onOpenFull && (
          <Button variant="ghost" size="xs" className="gap-1" onClick={onOpenFull} title="Open the whole file as a side-by-side diff">
            <ExternalLinkIcon className="size-3" /> Full diff
          </Button>
        )}
      </div>
      {error ? (
        <div className="p-3"><Notice tone="error">{error}</Notice></div>
      ) : !file ? (
        <div className="grid h-24 place-items-center"><Spinner /></div>
      ) : file.hunks.length === 0 ? (
        <p className="px-3 py-4 text-center text-xs text-muted-foreground">
          {file.binary ? "Binary file - no text to show." : file.head.length === 0 ? "No changes." : null}
          {!file.binary && file.head.length > 0 && <pre className="text-left font-mono text-[11px] whitespace-pre-wrap">{file.head.join("\n")}</pre>}
        </p>
      ) : (
        file.hunks.map((hunk, h) => {
          const count = picked.get(h)?.size ?? 0
          const what = count > 0 ? `${count} ${count === 1 ? "line" : "lines"}` : "hunk"
          let oldNo = hunk.oldStart
          let newNo = hunk.newStart
          return (
            <section key={hunk.header} className="border-b border-border/40">
              <div className="sticky top-8 z-10 flex min-h-7 items-center gap-2 border-y border-border/50 bg-muted px-3 text-[10px] text-muted-foreground">
                <span className="min-w-0 flex-1 truncate font-mono">{hunk.header}</span>
                {onApply && (
                  <>
                    {!staged && !untracked && (
                      <Button variant="ghost" size="xs" disabled={!editable} className="h-5 px-1.5 text-[10px] text-destructive" onClick={() => void act(h, "discard")}>
                        Discard {what}
                      </Button>
                    )}
                    <Button variant="outline" size="xs" disabled={!editable} className="h-5 px-1.5 text-[10px]" onClick={() => void act(h, staged ? "unstage" : "stage")}>
                      {staged ? "Unstage" : "Stage"} {what}
                    </Button>
                  </>
                )}
              </div>
              <div className="font-mono text-[11px] leading-5">
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
                        line.kind === "+" && "bg-emerald-500/20",
                        line.kind === "-" && "bg-red-500/20",
                        on && "bg-sky-500/25",
                        pickable && "cursor-pointer hover:brightness-95"
                      )}
                    >
                      <span className="w-9 shrink-0 select-none bg-muted/60 pr-1 text-right text-muted-foreground">{o}</span>
                      <span className="w-9 shrink-0 select-none border-r border-border/50 bg-muted/60 pr-1 text-right text-muted-foreground">{n}</span>
                      <span className={cn("w-4 shrink-0 select-none text-center", line.kind === "+" && "text-emerald-600 dark:text-emerald-400", line.kind === "-" && "text-red-600 dark:text-red-400")}>
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
