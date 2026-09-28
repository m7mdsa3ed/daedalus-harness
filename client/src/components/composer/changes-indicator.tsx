/* ── What the last turn that wrote anything did to the worktree ──
   The count in the footer's cluster, the file list its popover holds, and the
   way back into source control narrowed to those paths. */
import { useState } from "react"
import { GitCompareIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  READING_MARK,
  READING_TRIGGER,
  ReadingBubble,
  ReadingFace,
  OpenInInspector,
} from "@/components/composer/indicator"
import { shortPath } from "@/lib/tools"
import type { ChangedFile, TurnChanges } from "@/lib/workspace/git-api"
import { cn } from "@/lib/utils"

/* Git's own letter for a changed file, and the tone the app already gives that
   outcome elsewhere. A letter rather than four icons: A/M/D/R is the shortest
   thing that is unambiguous, and this list is read at 12px beside a path. */
const FILE_STATUS: Record<ChangedFile["status"], { letter: string; tone: string }> = {
  added: { letter: "A", tone: "text-emerald-600 dark:text-emerald-400" },
  modified: { letter: "M", tone: "text-amber-600 dark:text-amber-400" },
  deleted: { letter: "D", tone: "text-destructive" },
  renamed: { letter: "R", tone: "text-sky-600 dark:text-sky-400" },
}

/** The two figures, in the one place they are spelled. */
function DiffCount({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="shrink-0 font-mono text-[11px] tabular-nums">
      <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>{" "}
      <span className="text-destructive">−{removed}</span>
    </span>
  )
}

/**
 * What the last turn that wrote anything did to the worktree, beside the
 * checklist, the workers and the context ring.
 *
 * It was a chip in the transcript, under the turn that earned it — which put
 * the same reading in a different place every turn and scrolled it out of view
 * the moment the next answer arrived. It is the same *kind* of answer as the
 * three beside it: one number that is true of the thread right now, glanced at
 * constantly and read in full rarely. So it is the same shape (a 24px trigger
 * over a popover) in the same cluster, and the file list — which is what a
 * chip could never show without a second surface — is what the popover holds.
 *
 * `changes` is already gated by the caller (`withTurnChanges` +
 * `turnCouldTouchFiles` in thread-view): git measures a *window*, not an
 * author, so a turn that only read or searched is never handed one. Nothing
 * about that bargain moved here.
 */
export function ChangesIndicator({
  changes,
}: {
  changes?: TurnChanges
}) {
  const [open, setOpen] = useState(false)
  if (!changes || changes.files.length === 0) return null

  const count = changes.files.length
  const added = changes.files.reduce((n, f) => n + f.additions, 0)
  const removed = changes.files.reduce((n, f) => n + f.deletions, 0)
  const label = `${count} ${count === 1 ? "file" : "files"} changed`

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(READING_TRIGGER, "text-muted-foreground hover:text-foreground")}
            title={`${label} — +${added} −${removed}`}
            aria-label={label}
          >
            {/* The subagent count's bargain: the mark rides inside the pill where
                the panel has room for words, and stands bare with the bubble on
                it where it does not — one count, two dresses, never both, both
                shared with the four beside it. */}
            <ReadingFace
              icon={<GitCompareIcon className={READING_MARK} />}
              label={label}
              after={<ReadingBubble>{count > 9 ? "9+" : count}</ReadingBubble>}
            />
          </Button>
        }
      />
      <PopoverContent align="end" side="top" className="w-80 gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <p className="font-medium">{label}</p>
          <DiffCount added={added} removed={removed} />
        </div>
        <p className="text-xs text-muted-foreground">
          What the last turn that wrote anything did to the worktree — git's count, not the
          transcript's, so a shell command that edited a file is in it.
        </p>
        <ul className="-mx-1 max-h-[min(50svh,20rem)] space-y-0.5 overflow-y-auto overscroll-contain px-1">
          {changes.files.map((file) => (
            <li key={file.path} className="flex items-baseline gap-2 text-xs">
              <span
                className={cn("w-3 shrink-0 text-center font-mono font-semibold", FILE_STATUS[file.status].tone)}
                title={file.status}
              >
                {FILE_STATUS[file.status].letter}
              </span>
              {/* shortPath, not truncate: a path clipped at the end loses the
                  filename, which is the only part being scanned for. */}
              <span
                className="min-w-0 flex-1 truncate font-mono text-foreground"
                title={file.from ? `${file.from} → ${file.path}` : file.path}
              >
                {shortPath(file.path, 40)}
              </span>
              {file.binary ? (
                <span className="shrink-0 text-[11px] text-muted-foreground">binary</span>
              ) : (
                <DiffCount added={file.additions} removed={file.deletions} />
              )}
            </li>
          ))}
        </ul>
        <OpenInInspector tab="changes" onOpen={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}
