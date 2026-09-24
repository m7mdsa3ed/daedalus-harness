/* ── The inspector's Changes tab ──
   A turn timeline: every measured turn that could have written a file
   (`changesTimeline`, the chip's own gate) as a card on a rail, newest first
   and open, each file's diff drawn inline under its row. Three other scopes
   read one flat card — the whole thread (first measured turn's start → now),
   what is uncommitted (HEAD → now) and the branch against its base — all read
   by git on the server (`turn-changes.ts`), never off the transcript.

   The bar on top says the scope's size, how much of it has been read (viewed
   marks, `lib/changes-marks.ts`), and holds the two messages this tab can
   send: "Ask to review" and "Fix flagged". Both — like "Send review" under
   the list — are ONE ordinary message through the thread's prompt door, so
   they queue behind a running turn and never steer.

   Its own module, loaded lazily by `thread-inspector.tsx`: the diff editor is
   a chunk a reader who never opens this tab never pays for. */
import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { MoreHorizontalIcon } from "lucide-react"

import { Empty } from "@/components/empty"
import { Notice } from "@/components/notice"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
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
import { FileList, Stat, type FileListContext } from "./changes/file-list"
import { CommentForm, ReviewDrafts } from "./changes/review-drafts"
import { totals, TurnCard } from "./changes/turn-card"
import type { TimelineTurn } from "./turn-footers"

const SCOPE_LABEL: Record<ChangesScope, string> = {
  turns: "By turn",
  thread: "Whole thread",
  uncommitted: "Uncommitted",
  branch: "Branch vs base",
}

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
        <ol className="ml-3 space-y-2 border-l border-border/60 py-2 pr-2 @panel-sm:ml-4">
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
    body = (
      <div className="m-2 rounded-lg border border-border/60 bg-card shadow-sm">
        <FileList ctx={ctx} files={flat.data?.files ?? []} scopeKey={scope} scope={scope} live />
      </div>
    )
  }

  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/60 px-2 py-1.5">
        <NativeSelect
          size="sm"
          value={scope}
          aria-label="What to show"
          className="w-36 shrink-0"
          onChange={(event) => setChangesScope(sessionId, event.target.value as ChangesScope)}
        >
          {(Object.keys(SCOPE_LABEL) as ChangesScope[]).map((value) => (
            <NativeSelectOption key={value} value={value}>
              {SCOPE_LABEL[value]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-[11px] text-muted-foreground">
          <Stat {...stats} />
          <span className="truncate">
            · {entries.length} {entries.length === 1 ? "file" : "files"} · Viewed {viewed}/{entries.length}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {flagged.length > 0 && (
            <Button size="xs" variant="outline" disabled={sending} onClick={fixFlagged}>
              Fix flagged ({flagged.length})
            </Button>
          )}
          <Button size="xs" variant="ghost" disabled={sending || reviewPaths.length === 0} onClick={askReview}>
            Ask to review
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon-xs" aria-label="More" title="More" />}
            >
              <MoreHorizontalIcon aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuItem disabled={entries.length === 0} onClick={() => markAll(true)}>
                Mark all viewed
              </DropdownMenuItem>
              <DropdownMenuItem disabled={viewed === 0} onClick={() => markAll(false)}>
                Clear viewed
              </DropdownMenuItem>
              {flagged.length > 0 && (
                <DropdownMenuItem onClick={() => setFlagged(sessionId, flagged, false)}>Clear flags</DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={() => void queryClient.invalidateQueries({ queryKey: sessionChangesKey(settings, sessionId) })}
              >
                Refresh
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
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
