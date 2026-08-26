/* Comments are their own table and their own request: the board fetch stays
   slim and appending one writes one row. The editor holds the page it fetched
   in local state — nothing here enters the store, so closing the dialog frees
   it.

   The server returns comments oldest-first with limit/offset, so "the latest
   page" is the tail: ask for the first page to learn `total`, then jump the
   offset to the end. "Show earlier" walks backwards a page at a time. */
import * as React from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Trash2 } from "lucide-react"
import { reportError } from "@/lib/errors"
import { shortAge } from "@/lib/time"
import type { Actions } from "@/lib/actions"
import type { Comment } from "@/lib/pm/types"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Skeleton } from "@/components/ui/skeleton"

const PAGE = 20

/** Single bearer token, no accounts — the author is a free-form name, and the
    one this client writes is "you" (assignees work the same way). */
const AUTHOR = "you"

export function CommentsThread({
  boardId,
  taskId,
  actions,
}: {
  boardId: string
  taskId: string
  actions: Actions
}) {
  const [comments, setComments] = React.useState<Comment[] | null>(null)
  const [total, setTotal] = React.useState(0)
  const [offset, setOffset] = React.useState(0)
  const [body, setBody] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    let live = true
    setComments(null)
    setBody("")
    ;(async () => {
      const first = await actions.listComments(boardId, taskId, { limit: PAGE, offset: 0 })
      if (!live) return
      const tail = Math.max(0, first.total - PAGE)
      const page =
        tail === 0 ? first : await actions.listComments(boardId, taskId, { limit: PAGE, offset: tail })
      if (!live) return
      setTotal(page.total)
      setOffset(tail)
      setComments(page.comments)
    })().catch((error) => {
      if (!live) return
      setComments([])
      reportError(error, "Couldn't load the comments")
    })
    return () => {
      live = false
    }
  }, [actions, boardId, taskId])

  const showEarlier = async () => {
    const next = Math.max(0, offset - PAGE)
    try {
      const page = await actions.listComments(boardId, taskId, { limit: offset - next, offset: next })
      setOffset(next)
      setTotal(page.total)
      setComments((current) => [...page.comments, ...(current ?? [])])
    } catch (error) {
      reportError(error, "Couldn't load earlier comments")
    }
  }

  const submit = async () => {
    const text = body.trim()
    if (!text || busy) return
    setBusy(true)
    try {
      const comment = await actions.addComment(boardId, taskId, { author: AUTHOR, bodyMd: text })
      setComments((current) => [...(current ?? []), comment])
      setTotal((n) => n + 1)
      setBody("")
    } catch (error) {
      reportError(error, "Couldn't post the comment")
    } finally {
      setBusy(false)
    }
  }

  /* Single-user harness: there is nobody else's comment to protect, so delete
     is offered on every row. */
  const remove = async (comment: Comment) => {
    const before = comments
    setComments((current) => (current ?? []).filter((c) => c.id !== comment.id))
    try {
      await actions.deleteComment(boardId, taskId, comment.id)
      setTotal((n) => Math.max(0, n - 1))
    } catch (error) {
      setComments(before)
      reportError(error, "Couldn't delete the comment")
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {comments === null ? (
          <>
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-2/3" />
          </>
        ) : (
          <>
            {offset > 0 && (
              <Button variant="outline" size="xs" onClick={showEarlier} className="w-full">
                Show earlier ({offset})
              </Button>
            )}
            {comments.length === 0 && (
              <p className="text-xs text-muted-foreground">No comments yet.</p>
            )}
            {comments.map((comment) => (
              <article key={comment.id} className="group/comment rounded-xl bg-muted/40 p-3">
                <header className="mb-1 flex items-center gap-2 text-xs">
                  <span className="font-medium">{comment.author}</span>
                  <span
                    className="text-muted-foreground/60"
                    title={new Date(comment.createdAt).toLocaleString()}
                  >
                    {shortAge(comment.createdAt)}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="ml-auto opacity-0 group-hover/comment:opacity-100"
                    title="Delete comment"
                    onClick={() => void remove(comment)}
                  >
                    <Trash2 />
                  </Button>
                </header>
                <div className="prose prose-sm max-w-none text-[13px]">
                  <Markdown remarkPlugins={[remarkGfm]}>{comment.bodyMd}</Markdown>
                </div>
              </article>
            ))}
          </>
        )}
      </div>
      <div className="border-t p-3">
        <Textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Write a comment… (⌘⏎ to send)"
          rows={3}
          className="resize-none text-[13px]"
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void submit()
            }
          }}
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">
            {total} comment{total === 1 ? "" : "s"}
          </span>
          <Button size="sm" disabled={busy || body.trim() === ""} onClick={() => void submit()}>
            Comment
          </Button>
        </div>
      </div>
    </div>
  )
}
