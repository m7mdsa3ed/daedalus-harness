/* ── One turn on the Changes list ──
   A collapsible section, the way source control draws "Staged Changes": a
   header row of chevron, the turn's message, when it ran and a count badge,
   with its actions revealed on hover — and, open, its files with their diffs
   inline. A finished turn reads its two recorded trees; the running one reads
   its start tree against the disk, live. A turn that was never measured (or
   whose snapshot git pruned) says so in a sentence: it is a fact about the
   repository, not a failure.

   **Revert turn** puts exactly this turn's paths back as its start tree had
   them, in the working tree only (`POST …/turn-changes/:turnId/revert`). The
   server refuses when one of them changed since the turn ended and names
   them; "Revert anyway" is the same call with `force`. */
import * as React from "react"
import { useQueries, useQueryClient } from "@tanstack/react-query"
import { ChevronRightIcon, Undo2Icon } from "lucide-react"

import { useConfirm } from "@/components/confirm-dialog"
import { Notice } from "@/components/notice"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import { useCoarsePointer } from "@/hooks/use-device"
import { describeError } from "@/lib/errors"
import { sessionChangesKey } from "@/lib/queries/keys"
import { useServer } from "@/lib/server-context"
import { shortAge } from "@/lib/time"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"
import { editsExplain } from "@/lib/tools/edits"
import { revertConflicts, revertTurn, scopeFileSide, type ChangedFile } from "@/lib/workspace/git-api"
import type { TimelineTurn } from "../turn-footers"
import { CountBadge, FileList, HoverActions, RowAction, type FileListContext } from "./file-list"

export const totals = (files: ChangedFile[]) =>
  files.reduce(
    (sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
    { additions: 0, deletions: 0 }
  )

/** A section header — chevron, title, what sits at its end. The flat scopes'
    one "Changes" section wears it too. */
export function SectionHeader({
  open,
  onToggle,
  title,
  titleHint,
  actions,
  children,
}: {
  open: boolean
  onToggle: () => void
  title: React.ReactNode
  titleHint?: string
  /** Revealed on hover. */
  actions?: React.ReactNode
  /** Always drawn, after the actions: a time, a badge. */
  children?: React.ReactNode
}) {
  const coarse = useCoarsePointer()
  return (
    <div
      className={cn(
        "group/section flex items-center gap-1 pr-1.5 pl-1 text-[11px] hover:bg-accent/40",
        coarse ? "min-h-11" : "min-h-6"
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex min-w-0 flex-1 items-center gap-1 self-stretch text-left font-semibold focus-visible:outline-none"
        title={titleHint}
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
        />
        <span className="min-w-0 truncate">{title}</span>
      </button>
      {actions && <HoverActions group="section">{actions}</HoverActions>}
      {children}
    </div>
  )
}

export function TurnCard({
  ctx,
  turn,
  files: measured,
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
  const files = useOwnFiles(ctx.sessionId, turn, measured)
  const title =
    turn.prompt?.split("\n").find((line) => line.trim())?.trim() || (changes.sessionId ? "A step it started" : "An earlier turn")
  const sentence = changes.unavailable
    ? "Not measured — the project was not a git repository when this turn ran."
    : unavailable
  /* A file still `shared` after `useOwnFiles` has a peer's lines in it: revert
     only what this thread's edits wrote there. */
  const partial = React.useMemo(() => {
    const out: Record<string, { oldText: string; newText: string }[]> = {}
    for (const file of files) {
      const ours = turn.edits.filter((e) => e.path && (e.path === file.path || e.path.endsWith(`/${file.path}`)))
      if (file.shared && file.status === "modified" && ours.length > 0) out[file.path] = ours
    }
    return out
  }, [files, turn.edits])
  const revert = useRevertTurn(ctx, changes.turnId, files.length, partial)

  return (
    <li>
      <SectionHeader
        open={open}
        onToggle={onToggle}
        titleHint={turn.prompt}
        title={
          <>
            {changes.sessionId && <span className="mr-1 font-normal text-muted-foreground">Subagent ·</span>}
            {title}
          </>
        }
        actions={
          !running && !sentence && files.length > 0 ? (
            <RowAction
              icon={Undo2Icon}
              label="Revert this turn's files"
              disabled={revert.busy}
              className="hover:text-destructive"
              onClick={() => void revert.ask()}
            />
          ) : undefined
        }
      >
        {running ? (
          <span className="flex shrink-0 items-center gap-1 text-[10px] font-medium text-primary">
            <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-primary" />
            Live
          </span>
        ) : (
          <span
            className="shrink-0 text-[10px] text-muted-foreground tabular-nums"
            title={new Date(changes.startedAt).toLocaleString()}
          >
            {shortAge(changes.startedAt)}
          </span>
        )}
        {!sentence && <CountBadge title={`${files.length} changed`}>{files.length}</CountBadge>}
      </SectionHeader>
      {open &&
        (sentence ? (
          <p className="py-1 pr-2 pl-7 text-[11px] text-muted-foreground">{sentence}</p>
        ) : (
          <>
            {revert.panel}
            <FileList
              ctx={ctx}
              files={files}
              scopeKey={`turn:${changes.turnId}`}
              scope={`turn:${changes.turnId}`}
              live={running}
            />
          </>
        ))}
    </li>
  )
}

/** The revert's confirm, and what it has to say when the server refuses —
    the header holds the button, the section holds the answer. */
function useRevertTurn(
  ctx: FileListContext,
  turnId: string,
  count: number,
  partial: Record<string, { oldText: string; newText: string }[]>
) {
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
      const { reverted } = await revertTurn(settings, ctx.sessionId, turnId, force, partial)
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

  const panel =
    conflicts || error ? (
      <div className="space-y-1.5 py-1 pr-2 pl-7">
        {conflicts && (
          <Notice
            tone="warn"
            title="Changed since this turn ended"
            action={<CopyButton text={conflicts.join("\n")} size="icon-xs" />}
          >
            <p>Reverting would also undo other edits to:</p>
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
    ) : null

  return { busy, ask, panel }
}

/**
 * Break the server's `shared` tie with content, not names. A shared file is
 * one written while another thread's turn ran in the repository, so git's diff
 * of it holds every writer's lines. Replay this thread's own edits over the
 * turn's start text: if they alone reproduce the end text, the file is ours
 * and loses the flag; otherwise a hunk is someone else's (or a shell's, which
 * names nothing) and it stays `shared`. Read only once a turn has ended.
 */
function useOwnFiles(sessionId: string, turn: TimelineTurn, files: ChangedFile[]): ChangedFile[] {
  const { changes, edits } = turn
  const shared = changes.ended ? files.filter((file) => file.shared && file.status === "modified") : []
  const verdicts = useQueries({
    queries: shared.map((file) => ({
      queryKey: ["own-file", sessionId, changes.turnId, file.path, file.additions, file.deletions],
      staleTime: Infinity,
      queryFn: async () => {
        const scope = `turn:${changes.turnId}`
        const [before, after] = await Promise.all([
          scopeFileSide(sessionId, scope, file.path, "before"),
          scopeFileSide(sessionId, scope, file.path, "after"),
        ])
        const ours = edits.filter((e) => e.path && (e.path === file.path || e.path.endsWith(`/${file.path}`)))
        return ours.length > 0 && editsExplain(before.content, after.content, ours)
      },
    })),
  })
  const own = new Set(shared.filter((_, i) => verdicts[i]?.data === true).map((file) => file.path))
  if (own.size === 0) return files
  return files.map((file) => (own.has(file.path) ? { ...file, shared: undefined } : file))
}
