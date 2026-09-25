/* ── The inspector's Changes tab ──
   Drawn as VS Code's source control view: a toolbar, then collapsible
   sections of dense file rows. "Turns" is a section per measured turn that
   could have written a file (`changesTimeline`, the chip's own gate), newest
   first and the newest open, each file's diff drawn inline under its row.
   Three other scopes read one section — the whole thread (first measured
   turn's start → now), what is uncommitted (HEAD → now) and the branch
   against its base — all read by git on the server (`turn-changes.ts`),
   never off the transcript.

   The bar on top says the scope's size, how much of it has been read (viewed
   marks, `lib/changes-marks.ts`), and holds the two messages this tab can
   send: "Ask to review" and "Fix flagged". Both — like "Send review" under
   the list — are ONE ordinary message through the thread's prompt door, so
   they queue behind a running turn and never steer.

   Its own module, loaded lazily by `thread-inspector.tsx`: the diff editor is
   a chunk a reader who never opens this tab never pays for. */
import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { CheckCheckIcon, ChevronDownIcon, FlagIcon, MoreHorizontalIcon, RefreshCwIcon, SparklesIcon } from "lucide-react"

import { Empty } from "@/components/empty"
import { Notice } from "@/components/notice"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { PanelRowsSkeleton } from "@/components/ui/skeletons"
import type { ReviewAnchor } from "@/components/workspace/diff-editor"
import {
  isViewed,
  setChangesScope,
  setFlagged,
  setViewed,
  useChangesMarks,
  type ChangesScope,
} from "@/lib/changes-marks"
import { describeError } from "@/lib/errors"
import { sessionChangesKey } from "@/lib/queries/keys"
import {
  addReviewComment,
  composeAskReview,
  composeFixFlagged,
  removeReviewComment,
  threadRelative,
  useReviewComments,
} from "@/lib/review-comments"
import { useServer } from "@/lib/server-context"
import { scopeFiles, type ChangedFile } from "@/lib/workspace/git-api"
import { CountBadge, FileList, RowAction, Stat, type FileListContext } from "./changes/file-list"
import { CommentForm, ReviewDrafts } from "./changes/review-drafts"
import { SectionHeader, totals, TurnCard } from "./changes/turn-card"
import type { TimelineTurn } from "./turn-footers"

/* The label is the toolbar's, the title the menu row's and the flat
   scope's section header. */
const SCOPES: { value: ChangesScope; label: string; title: string }[] = [
  { value: "turns", label: "Turns", title: "Each turn's changes, newest first" },
  { value: "thread", label: "Thread", title: "Everything this thread changed" },
  { value: "uncommitted", label: "Uncommitted", title: "The working tree against HEAD" },
  { value: "branch", label: "Branch", title: "This branch against its base" },
]

/** What "Ask to review" calls the scope, in the message. */
const SCOPE_ASK: Record<ChangesScope, string> = {
  turns: "the changes from your last turn",
  thread: "all the changes you made in this thread",
  uncommitted: "the uncommitted changes in the working tree",
  branch: "this branch's changes against its base branch",
}

export default function InspectorChanges({
  projectId,
  sessionId,
  turns,
  turnActive,
  repo,
  onSend,
}: {
  projectId: string
  sessionId: string
  /** `changesTimeline`, newest first. */
  turns: TimelineTurn[]
  turnActive: boolean
  /** The thread's own checkout when it is not the project's — a worktree
      thread's (project-relative). Diff paths are joined onto it, and the
      messages' mentions are written relative to it. */
  repo?: string
  /** The thread's prompt door (`actions.send`). */
  onSend: (text: string) => Promise<void>
}) {
  const settings = useServer()
  const queryClient = useQueryClient()
  const marks = useChangesMarks(sessionId)
  const scope = marks.scope ?? "turns"
  const comments = useReviewComments(sessionId)
  const [anchor, setAnchor] = React.useState<(ReviewAnchor & { path: string }) | null>(null)
  const ctx = React.useMemo<FileListContext>(
    () => ({ projectId, sessionId, repo: repo ?? "", comments, onComment: setAnchor }),
    [projectId, sessionId, repo, comments]
  )

  /* The running turn's row carries no files until it ends, so it is read
     live; everything else in "By turn" is the rows the socket already sent. */
  const running = turns.find((turn) => !turn.changes.ended && !turn.changes.unavailable)
  const liveScope = running ? `turn:${running.changes.turnId}` : ""
  const live = useQuery({
    queryKey: sessionChangesKey(settings, sessionId, liveScope),
    queryFn: ({ signal }) => scopeFiles(settings, sessionId, liveScope, signal),
    enabled: scope === "turns" && !!running,
    refetchInterval: 4000,
  })
  const flat = useQuery({
    queryKey: sessionChangesKey(settings, sessionId, scope),
    queryFn: ({ signal }) => scopeFiles(settings, sessionId, scope, signal),
    enabled: scope !== "turns",
    refetchInterval: turnActive ? 5000 : false,
  })

  const filesOf = React.useCallback(
    (turn: TimelineTurn): ChangedFile[] => (turn === running ? (live.data?.files ?? []) : turn.changes.files),
    [running, live.data]
  )
  const entries = React.useMemo(
    () =>
      scope === "turns"
        ? turns.flatMap((turn) => filesOf(turn).map((file) => ({ scopeKey: `turn:${turn.changes.turnId}`, file })))
        : (flat.data?.files ?? []).map((file) => ({ scopeKey: scope, file })),
    [scope, turns, filesOf, flat.data]
  )
  const stats = totals(entries.map((entry) => entry.file))
  const viewed = entries.filter((entry) => isViewed(marks, entry.scopeKey, entry.file)).length
  const flagged = marks.flagged ?? []

  const [openTurns, setOpenTurns] = React.useState<Record<string, boolean>>({})
  const [flatOpen, setFlatOpen] = React.useState(true)
  const [sending, setSending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const send = async (text: string, after?: () => void) => {
    setSending(true)
    setError(null)
    try {
      await onSend(text)
      after?.()
    } catch (err) {
      setError(describeError(err).title)
    } finally {
      setSending(false)
    }
  }

  const reviewPaths = scope === "turns" ? (turns[0] ? filesOf(turns[0]) : []) : (flat.data?.files ?? [])
  const askReview = () => void send(composeAskReview(SCOPE_ASK[scope], reviewPaths.map((file) => file.path)))
  const fixFlagged = () => {
    const onFlagged = comments.filter((c) => flagged.includes(threadRelative(c.path, repo)))
    void send(composeFixFlagged(flagged, onFlagged, repo), () => {
      for (const c of onFlagged) removeReviewComment(sessionId, c.id)
      setFlagged(sessionId, flagged, false)
    })
  }
  const markAll = (value: boolean) => {
    const byScope = new Map<string, ChangedFile[]>()
    for (const entry of entries) byScope.set(entry.scopeKey, [...(byScope.get(entry.scopeKey) ?? []), entry.file])
    for (const [key, files] of byScope) setViewed(sessionId, key, files, value)
  }

  let body: React.ReactNode
  if (scope === "turns") {
    body =
      turns.length === 0 ? (
        <div className="p-3">
          <Empty>No turn has written to the worktree yet.</Empty>
        </div>
      ) : (
        <ol className="py-0.5">
          {turns.map((turn, index) => {
            const id = turn.changes.turnId
            return (
              <TurnCard
                key={id}
                ctx={ctx}
                turn={turn}
                files={filesOf(turn)}
                unavailable={turn === running ? live.data?.unavailable : undefined}
                open={openTurns[id] ?? index === 0}
                onToggle={() => setOpenTurns((current) => ({ ...current, [id]: !(current[id] ?? index === 0) }))}
              />
            )
          })}
        </ol>
      )
  } else if (flat.isPending) {
    body = <PanelRowsSkeleton rows={5} className="py-1" />
  } else if (flat.error) {
    const message = describeError(flat.error).title
    body = (
      <Notice tone="error" className="m-2" action={<CopyButton text={message} size="icon-xs" />}>
        {message}
      </Notice>
    )
  } else if (flat.data?.unavailable) {
    body = (
      <div className="p-3">
        <Empty>{flat.data.unavailable}</Empty>
      </div>
    )
  } else {
    const files = flat.data?.files ?? []
    body = (
      <div className="py-0.5">
        <SectionHeader
          open={flatOpen}
          onToggle={() => setFlatOpen((value) => !value)}
          title={SCOPES.find((item) => item.value === scope)?.title}
        >
          <CountBadge>{files.length}</CountBadge>
        </SectionHeader>
        {flatOpen && <FileList ctx={ctx} files={files} scopeKey={scope} scope={scope} live />}
      </div>
    )
  }

  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      {/* VS Code's view toolbar: what is shown on the left, icon actions on
          the right, and the viewed progress as a hairline along its foot. */}
      <header className="relative flex h-8 shrink-0 items-center gap-1 border-b border-border/60 pr-1.5 pl-1">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                className="min-w-0 gap-1 px-1.5 text-[11px] font-semibold tracking-wide uppercase"
                title="What to show"
              />
            }
          >
            <span className="truncate">{SCOPES.find((item) => item.value === scope)?.label}</span>
            <ChevronDownIcon aria-hidden className="size-3 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-52">
            <DropdownMenuRadioGroup value={scope} onValueChange={(next) => setChangesScope(sessionId, next as ChangesScope)}>
              {SCOPES.map((item) => (
                <DropdownMenuRadioItem key={item.value} value={item.value}>
                  {item.title}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="hidden min-w-0 truncate text-[10px] text-muted-foreground @panel-sm:inline">
          <Stat {...stats} />
        </span>
        <span className="flex-1" />
        {flagged.length > 0 && (
          <Button
            size="xs"
            variant="ghost"
            className="gap-1 px-1.5 text-destructive hover:text-destructive"
            disabled={sending}
            onClick={fixFlagged}
            title={`Ask the agent to fix ${flagged.length} flagged ${flagged.length === 1 ? "file" : "files"}`}
          >
            <FlagIcon aria-hidden className="size-3.5 fill-current" />
            <span className="font-mono text-[10px] tabular-nums">{flagged.length}</span>
          </Button>
        )}
        <RowAction
          icon={SparklesIcon}
          label="Ask the agent to review"
          disabled={sending || reviewPaths.length === 0}
          onClick={askReview}
        />
        <RowAction
          icon={CheckCheckIcon}
          label="Mark all viewed"
          disabled={entries.length === 0 || viewed === entries.length}
          onClick={() => markAll(true)}
        />
        <RowAction
          icon={RefreshCwIcon}
          label="Refresh"
          onClick={() => void queryClient.invalidateQueries({ queryKey: sessionChangesKey(settings, sessionId) })}
        />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<button type="button" aria-label="More" title="More" className="grid size-5 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground" />}
          >
            <MoreHorizontalIcon aria-hidden className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuItem disabled={viewed === 0} onClick={() => markAll(false)}>
              Clear viewed
            </DropdownMenuItem>
            <DropdownMenuItem disabled={flagged.length === 0} onClick={() => setFlagged(sessionId, flagged, false)}>
              Clear flags
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {entries.length > 0 && (
          <div
            className="absolute inset-x-0 -bottom-px h-0.5"
            role="progressbar"
            aria-label="Files viewed"
            aria-valuenow={viewed}
            aria-valuemin={0}
            aria-valuemax={entries.length}
            title={`${viewed}/${entries.length} viewed`}
          >
            <div className="h-full bg-primary/70 transition-[width]" style={{ width: `${(viewed / entries.length) * 100}%` }} />
          </div>
        )}
      </header>
      {error && (
        <Notice tone="error" className="mx-2 mt-1.5" action={<CopyButton text={error} size="icon-xs" />}>
          {error}
        </Notice>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
      {anchor && (
        <CommentForm
          anchor={anchor}
          onCancel={() => setAnchor(null)}
          onSave={(text) => {
            addReviewComment(sessionId, { ...anchor, text })
            setAnchor(null)
          }}
        />
      )}
      {comments.length > 0 && (
        <ReviewDrafts
          sessionId={sessionId}
          comments={comments}
          strip={repo}
          onSend={onSend}
        />
      )}
    </div>
  )
}
