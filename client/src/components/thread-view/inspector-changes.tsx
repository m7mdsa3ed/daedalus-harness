/* ── The inspector's Changes tab ──
   The newest gated turn's files, drawn by source control narrowed to them —
   never a list of its own (a second list of the same files that could not
   stage, discard or commit is the changes tab this app already removed). A
   file opens in the Monaco diff surface over the list, with a way back.

   The diff is also where a review is written: a "+" in the gutter anchors a
   line comment, the comments collect as drafts (`lib/review-comments.ts`,
   device-local, per thread) listed under the view, and "Send review" makes
   them ONE user message through the thread's one prompt door — so it queues
   behind a running turn and never steers.

   Its own module, loaded lazily by `thread-inspector.tsx`: source control and
   the diff editor are a chunk a reader who never opens this tab never pays
   for. */
import * as React from "react"
import { ArrowLeftIcon, MessageSquarePlusIcon, PencilIcon, Trash2Icon } from "lucide-react"

import { Empty } from "@/components/empty"
import { Notice } from "@/components/notice"
import { Shortcut } from "@/components/shortcut"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import { Textarea } from "@/components/ui/textarea"
import type { ReviewAnchor } from "@/components/workspace/diff-editor"
import { DiffTab } from "@/components/workspace/diff-tab"
import { ScmView } from "@/components/workspace/scm-view"
import { useShortcut } from "@/hooks/use-hotkey"
import { describeError } from "@/lib/errors"
import type { ScmFilter } from "@/lib/ide/scm-filter"
import {
  addReviewComment,
  clearReviewComments,
  composeReview,
  removeReviewComment,
  updateReviewComment,
  useReviewComments,
  type ReviewComment,
} from "@/lib/review-comments"
import type { Comparison, TurnChanges } from "@/lib/workspace/git-api"

export default function InspectorChanges({
  projectId,
  sessionId,
  changes,
  repo,
  onSend,
}: {
  projectId: string
  sessionId: string
  changes?: TurnChanges
  /** The thread's own repository, when it is not the project's — a worktree
      thread's (project-relative). Source control is pinned to it, and the
      review's mentions are written relative to it. */
  repo?: string
  /** The thread's prompt door (`actions.send`). */
  onSend: (text: string) => Promise<void>
}) {
  /* A fresh filter per turn, keyed on the turn: the view reads `paths` and the
     label, and a new object per render would re-derive its rows for nothing. */
  const filter = React.useMemo<ScmFilter | null>(
    () =>
      changes && changes.files.length > 0
        ? {
            label: `${changes.files.length} ${changes.files.length === 1 ? "file" : "files"} from the last turn`,
            paths: new Set(changes.files.map((file) => file.path)),
            nonce: 0,
          }
        : null,
    [changes]
  )
  const [diff, setDiff] = React.useState<{
    path: string
    left: Comparison
    right: Comparison
    repo?: string
  } | null>(null)
  const comments = useReviewComments(sessionId)
  const [anchor, setAnchor] = React.useState<(ReviewAnchor & { path: string }) | null>(null)

  const marks = React.useMemo(
    () =>
      diff
        ? comments
            .filter((c) => c.path === diff.path)
            .map((c) => ({ side: c.side, line: c.line, endLine: c.endLine }))
        : [],
    [comments, diff]
  )
  const review = React.useMemo(
    () =>
      diff
        ? { marks, onComment: (next: ReviewAnchor) => setAnchor({ ...next, path: diff.path }) }
        : undefined,
    [diff, marks]
  )

  const body = diff ? (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center border-b border-border/60 px-1 py-0.5">
        <Button variant="ghost" size="xs" onClick={() => setDiff(null)}>
          <ArrowLeftIcon data-icon="inline-start" />
          Changes
        </Button>
        <span className="ml-auto truncate pr-1.5 text-[10px] text-muted-foreground">
          <MessageSquarePlusIcon aria-hidden className="mr-1 inline size-3" />
          Click + beside a line to comment
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <DiffTab
          projectId={projectId}
          path={diff.path}
          left={diff.left}
          right={diff.right}
          repo={diff.repo}
          review={review}
          active
        />
      </div>
    </div>
  ) : filter || repo !== undefined ? (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScmView
        projectId={projectId}
        filter={filter}
        pinnedRepo={repo}
        onOpenDiff={(path, left, right, inRepo) => setDiff({ path, left, right, repo: inRepo })}
        /* A file with nothing to compare (untracked) is still a diff: empty on
           the left, the file on the right. */
        onOpenFile={(path) => setDiff({ path, left: "head", right: "worktree" })}
      />
    </div>
  ) : (
    <div className="p-3">
      <Empty>No turn has written to the worktree yet.</Empty>
    </div>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {body}
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
          onOpen={(c) => setDiff((current) => (current?.path === c.path ? current : { path: c.path, left: "head", right: "worktree" }))}
        />
      )}
    </div>
  )
}

const lineLabel = (c: Pick<ReviewComment, "line" | "endLine">) =>
  c.line === c.endLine ? `${c.line}` : `${c.line}–${c.endLine}`

/** Writing one comment, anchored where the "+" was clicked. ⌘/Ctrl+Enter
    saves (the textarea's own, and it says so to the review's shortcut by
    living inside `data-review-form`); Escape drops it. */
function CommentForm({
  anchor,
  onCancel,
  onSave,
}: {
  anchor: ReviewAnchor & { path: string }
  onCancel: () => void
  onSave: (text: string) => void
}) {
  const [text, setText] = React.useState("")
  const save = () => {
    if (text.trim()) onSave(text.trim())
  }
  return (
    <div data-review-form className="shrink-0 space-y-1.5 border-t border-border/60 bg-muted/30 p-2">
      <p className="truncate font-mono text-[10px] text-muted-foreground" title={anchor.path}>
        {anchor.path}:{lineLabel(anchor)}
        {anchor.side === "original" ? " (before)" : ""}
      </p>
      <Textarea
        autoFocus
        rows={3}
        value={text}
        placeholder="What should change here?"
        className="min-h-16 text-xs"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            save()
          } else if (event.key === "Escape") {
            event.preventDefault()
            onCancel()
          }
        }}
      />
      <div className="flex justify-end gap-1">
        <Button variant="ghost" size="xs" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" disabled={!text.trim()} onClick={save}>
          Add comment
        </Button>
      </div>
    </div>
  )
}

/** The pending comments and the one button that sends them. */
function ReviewDrafts({
  sessionId,
  comments,
  strip,
  onSend,
  onOpen,
}: {
  sessionId: string
  comments: ReviewComment[]
  strip?: string
  onSend: (text: string) => Promise<void>
  onOpen: (comment: ReviewComment) => void
}) {
  const [editing, setEditing] = React.useState<string | null>(null)
  const [sending, setSending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const root = React.useRef<HTMLElement>(null)

  const send = async () => {
    if (sending || comments.length === 0) return
    setSending(true)
    setError(null)
    try {
      await onSend(composeReview(comments, strip))
      clearReviewComments(sessionId)
    } catch (err) {
      /* The send path records a failure in the transcript too; this is the
         surface the reader is looking at, and the drafts are still here. */
      setError(describeError(err).title)
    } finally {
      setSending(false)
    }
  }

  /* Only with the focus in this tab, and never from the comment box, whose
     own ⌘↵ saves the comment — the composer keeps its ⌘↵. */
  useShortcut("sendReview", (event) => {
    const target = (event.target as Element | null) ?? document.activeElement
    const inside = root.current?.parentElement?.contains(document.activeElement ?? null)
    if (!inside || target?.closest?.("[data-review-form]")) return false
    void send()
  })

  return (
    <section
      ref={root}
      aria-label="Pending review comments"
      className="flex max-h-[45%] shrink-0 flex-col border-t border-border/60"
    >
      <header className="flex items-center gap-1.5 px-2 py-1.5">
        <span className="text-[11px] font-medium">
          Review · {comments.length} {comments.length === 1 ? "comment" : "comments"}
        </span>
        <span className="flex-1" />
        <Button variant="ghost" size="xs" onClick={() => clearReviewComments(sessionId)}>
          Discard
        </Button>
        <Button size="xs" disabled={sending} onClick={() => void send()}>
          Send review
          <Shortcut id="sendReview" className="ml-1" />
        </Button>
      </header>
      {error && (
        <Notice tone="error" className="mx-2 mb-1.5" action={<CopyButton text={error} size="icon-xs" />}>
          {error}
        </Notice>
      )}
      <ul className="min-h-0 flex-1 divide-y divide-border/40 overflow-y-auto px-2 pb-1.5">
        {comments.map((c) => (
          <li key={c.id} className="py-1.5">
            <div className="flex min-w-0 items-center gap-1">
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left font-mono text-[10px] text-muted-foreground hover:text-foreground"
                title={`Open ${c.path}`}
                onClick={() => onOpen(c)}
              >
                {c.path}:{lineLabel(c)}
              </button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Edit comment"
                title="Edit comment"
                onClick={() => setEditing(editing === c.id ? null : c.id)}
              >
                <PencilIcon aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Delete comment"
                title="Delete comment"
                onClick={() => removeReviewComment(sessionId, c.id)}
              >
                <Trash2Icon aria-hidden />
              </Button>
            </div>
            {editing === c.id ? (
              <div data-review-form>
                <Textarea
                  autoFocus
                  rows={2}
                  defaultValue={c.text}
                  className="mt-1 min-h-12 text-xs"
                  onBlur={(event) => {
                    const text = event.target.value.trim()
                    if (text) updateReviewComment(sessionId, c.id, text)
                    setEditing(null)
                  }}
                  onKeyDown={(event) => {
                    if ((event.key === "Enter" && (event.metaKey || event.ctrlKey)) || event.key === "Escape") {
                      event.preventDefault()
                      event.currentTarget.blur()
                    }
                  }}
                />
              </div>
            ) : (
              <p className="mt-0.5 line-clamp-3 text-xs whitespace-pre-wrap">{c.text}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
