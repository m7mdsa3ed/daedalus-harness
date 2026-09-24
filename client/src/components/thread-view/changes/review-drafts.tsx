/* ── Review drafts ──
   The comment box a gutter "+" opens and the pending comments with the one
   button that sends them. A review is ONE user message through the thread's
   prompt door (`actions.send`), so it queues behind a running turn and never
   steers; the drafts are cleared only once the send resolves. */
import * as React from "react"
import { PencilIcon, Trash2Icon } from "lucide-react"

import { Notice } from "@/components/notice"
import { Shortcut } from "@/components/shortcut"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import { Textarea } from "@/components/ui/textarea"
import type { ReviewAnchor } from "@/components/workspace/diff-editor"
import { useShortcut } from "@/hooks/use-hotkey"
import { describeError } from "@/lib/errors"
import {
  clearReviewComments,
  composeReview,
  removeReviewComment,
  updateReviewComment,
  type ReviewComment,
} from "@/lib/review-comments"

const lineLabel = (c: Pick<ReviewComment, "line" | "endLine">) =>
  c.line === c.endLine ? `${c.line}` : `${c.line}–${c.endLine}`

/** Writing one comment, anchored where the "+" was clicked. ⌘/Ctrl+Enter
    saves (the textarea's own, and it says so to the review's shortcut by
    living inside `data-review-form`); Escape drops it. */
export function CommentForm({
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
export function ReviewDrafts({
  sessionId,
  comments,
  strip,
  onSend,
}: {
  sessionId: string
  comments: ReviewComment[]
  strip?: string
  onSend: (text: string) => Promise<void>
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
              <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground" title={c.path}>
                {c.path}:{lineLabel(c)}
              </span>
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
