/* ── One turn on the Changes timeline ──
   A card on the rail: the turn's message, when it ran, what it changed, and —
   open — its files with their diffs inline. A finished turn reads its two
   recorded trees; the running one reads its start tree against the disk, live.
   A turn that was never measured (or whose snapshot git pruned) says so in a
   sentence: it is a fact about the repository, not a failure.

   **Revert turn** puts exactly this turn's paths back as its start tree had
   them, in the working tree only (`POST …/turn-changes/:turnId/revert`). The
   server refuses when one of them changed since the turn ended and names
   them; "Revert anyway" is the same call with `force`. */
import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Undo2Icon } from "lucide-react"

import { useConfirm } from "@/components/confirm-dialog"
import { Notice } from "@/components/notice"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import { describeError } from "@/lib/errors"
import { sessionChangesKey } from "@/lib/queries/keys"
import { useServer } from "@/lib/server-context"
import { shortAge } from "@/lib/time"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"
import { revertConflicts, revertTurn, type ChangedFile } from "@/lib/workspace/git-api"
import type { TimelineTurn } from "../turn-footers"
import { FileList, Stat, type FileListContext } from "./file-list"

export const totals = (files: ChangedFile[]) =>
  files.reduce(
    (sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
    { additions: 0, deletions: 0 }
  )

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1)

export function TurnCard({
  ctx,
  turn,
  files,
  unavailable,
  open,
  onToggle,
}: {
  ctx: FileListContext
  turn: TimelineTurn
  files: ChangedFile[]
  unavailable?: string
  open: boolean
  onToggle: () => void
}) {
  const { changes } = turn
  const running = !changes.ended
  const stats = totals(files)
  const title = turn.prompt?.split("\n").find((line) => line.trim())?.trim() || "An earlier turn"
  const sentence = changes.unavailable
    ? "Not measured — the project was not a git repository when this turn ran."
    : unavailable

  return (
    <li className="relative pl-4 @panel-sm:pl-6">
      {/* The rail's dot; the line itself is the list's border. */}
      <span
        aria-hidden
        className={cn(
          "absolute top-3 left-[-4.5px] size-2 rounded-full border border-background",
          running ? "animate-pulse bg-primary" : "bg-muted-foreground/50"
        )}
      />
      <div className="rounded-lg border border-border/60 bg-card shadow-sm">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex w-full min-w-0 flex-col gap-1 px-2.5 py-2 text-left"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-xs font-medium" title={turn.prompt}>
              {title}
            </span>
            {running ? (
              <span className="shrink-0 rounded-full bg-primary/15 px-1.5 text-[10px] font-medium text-primary">Live</span>
            ) : (
              <span className="shrink-0 text-[10px] text-muted-foreground" title={new Date(changes.startedAt).toLocaleString()}>
                {shortAge(changes.startedAt)}
              </span>
            )}
          </span>
          {sentence ? (
            <span className="text-[11px] text-muted-foreground">{sentence}</span>
          ) : (
            <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[10px] text-muted-foreground">
              <Stat {...stats} />
              <span>
                {files.length} {files.length === 1 ? "file" : "files"}
              </span>
              {!open &&
                files.slice(0, 6).map((file) => (
                  <span key={file.path} className="max-w-32 truncate rounded bg-muted px-1 font-mono" title={file.path}>
                    {basename(file.path)}
                  </span>
                ))}
              {!open && files.length > 6 && <span>+{files.length - 6}</span>}
            </span>
          )}
        </button>
        {open && !sentence && (
          <div className="border-t border-border/60">
            <FileList
              ctx={ctx}
              files={files}
              scopeKey={`turn:${changes.turnId}`}
              scope={`turn:${changes.turnId}`}
              live={running}
            />
            {!running && files.length > 0 && <RevertTurn ctx={ctx} turnId={changes.turnId} count={files.length} />}
          </div>
        )}
      </div>
    </li>
  )
}

function RevertTurn({ ctx, turnId, count }: { ctx: FileListContext; turnId: string; count: number }) {
  const settings = useServer()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const [busy, setBusy] = React.useState(false)
  const [conflicts, setConflicts] = React.useState<string[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const run = async (force: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const { reverted } = await revertTurn(settings, ctx.sessionId, turnId, force)
      setConflicts(null)
      void queryClient.invalidateQueries({ queryKey: sessionChangesKey(settings, ctx.sessionId) })
      toast.success(`Reverted ${reverted.length} ${reverted.length === 1 ? "file" : "files"} from this turn`)
    } catch (err) {
      const paths = revertConflicts(err)
      if (paths) setConflicts(paths)
      else setError(describeError(err).title)
    } finally {
      setBusy(false)
    }
  }

  const ask = async () => {
    const ok = await confirm({
      title: `Revert this turn's ${count} ${count === 1 ? "file" : "files"}?`,
      description:
        "Each file goes back to how it was before this turn — files it created are deleted, files it deleted come back. Only the working tree changes; nothing is staged or committed.",
      confirmLabel: "Revert",
      destructive: true,
    })
    if (ok) await run(false)
  }

  return (
    <div className="space-y-1.5 border-t border-border/60 px-2 py-1.5">
      <div className="flex justify-end">
        <Button variant="ghost" size="xs" disabled={busy} onClick={() => void ask()}>
          <Undo2Icon data-icon="inline-start" />
          Revert turn
        </Button>
      </div>
      {conflicts && (
        <Notice
          tone="warn"
          title="Changed since this turn ended"
          action={<CopyButton text={conflicts.join("\n")} size="icon-xs" />}
        >
          <p>Reverting would also undo later edits to:</p>
          <ul className="mt-1 font-mono text-[10px]">
            {conflicts.slice(0, 12).map((path) => (
              <li key={path} className="truncate">
                {path}
              </li>
            ))}
            {conflicts.length > 12 && <li>…and {conflicts.length - 12} more</li>}
          </ul>
          <div className="mt-1.5 flex gap-1">
            <Button size="xs" variant="destructive" disabled={busy} onClick={() => void run(true)}>
              Revert anyway
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setConflicts(null)}>
              Cancel
            </Button>
          </div>
        </Notice>
      )}
      {error && (
        <Notice tone="error" action={<CopyButton text={error} size="icon-xs" />}>
          {error}
        </Notice>
      )}
    </div>
  )
}
