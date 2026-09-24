/* ── Review comments ──
   Line comments made on a thread's diff (the inspector's Changes tab), held as
   drafts until "Send review" turns them into ONE ordinary user message.

   Device-local and per thread, like a composer draft (`lib/drafts.ts`): they
   are words not yet sent, so they are the typist's, and they survive a reload
   the way a half-typed message does. Nothing about them reaches the server
   until the send — which goes through `actions.send`, the one prompt door, so
   a review typed into a running turn queues like any other message. */
import { createLocalStore } from "@/lib/local-store"
import { uuid } from "@/lib/uuid"

export interface ReviewComment {
  id: string
  /** Project-relative, the path the diff was opened on. */
  path: string
  /** 1-based, inclusive. */
  line: number
  endLine: number
  /** Which side of the diff the lines are on: the old text or the new. */
  side: "original" | "modified"
  /** The lines as they read when the comment was made — quoted in the
      message, because the agent reads a review after the file has moved. */
  code: string
  text: string
}

type Drafts = Record<string, ReviewComment[]>

const isComment = (value: unknown): value is ReviewComment => {
  const c = value as Partial<ReviewComment> | null
  return (
    !!c &&
    typeof c.id === "string" &&
    typeof c.path === "string" &&
    typeof c.line === "number" &&
    typeof c.endLine === "number" &&
    (c.side === "original" || c.side === "modified") &&
    typeof c.code === "string" &&
    typeof c.text === "string"
  )
}

export const reviewDrafts = createLocalStore<Drafts>(
  "daedalus.review-comments.v1",
  (raw) => {
    if (!raw || typeof raw !== "object") return {}
    const out: Drafts = {}
    for (const [id, list] of Object.entries(raw as Record<string, unknown>)) {
      const kept = Array.isArray(list) ? list.filter(isComment) : []
      if (kept.length > 0) out[id] = kept
    }
    return out
  },
  {}
)

const EMPTY: ReviewComment[] = []

export function useReviewComments(sessionId: string): ReviewComment[] {
  return reviewDrafts.use()[sessionId] ?? EMPTY
}

function write(sessionId: string, list: ReviewComment[]): void {
  const next = { ...reviewDrafts.get() }
  if (list.length > 0) next[sessionId] = list
  else delete next[sessionId]
  reviewDrafts.set(next)
}

export function addReviewComment(sessionId: string, comment: Omit<ReviewComment, "id">): void {
  write(sessionId, [...(reviewDrafts.get()[sessionId] ?? []), { ...comment, id: uuid() }])
}

export function updateReviewComment(sessionId: string, id: string, text: string): void {
  write(
    sessionId,
    (reviewDrafts.get()[sessionId] ?? []).map((c) => (c.id === id ? { ...c, text } : c))
  )
}

export function removeReviewComment(sessionId: string, id: string): void {
  write(
    sessionId,
    (reviewDrafts.get()[sessionId] ?? []).filter((c) => c.id !== id)
  )
}

export function clearReviewComments(sessionId: string): void {
  write(sessionId, [])
}

/**
 * The one message a review becomes: a short header, then each comment as
 * `@path (line N)`, the quoted code and the words. The `@path` is a mention,
 * so the server adds the `resource_link` for it like any typed one
 * (`server/src/mentions.ts`) — the line is written after a space, outside the
 * token it resolves.
 *
 * `strip` is the prefix to take off a project-relative path so the mention
 * resolves against the thread's own cwd — a worktree thread's.
 */
export function composeReview(comments: ReviewComment[], strip = ""): string {
  const prefix = strip ? `${strip}/` : ""
  const parts = [
    `Review comments (${comments.length}) on your changes — please address each:`,
  ]
  for (const c of comments) {
    const path = prefix && c.path.startsWith(prefix) ? c.path.slice(prefix.length) : c.path
    const lines = c.line === c.endLine ? `line ${c.line}` : `lines ${c.line}-${c.endLine}`
    const where = c.side === "original" ? `${lines}, before the change` : lines
    const fence = c.code.includes("```") ? "~~~" : "```"
    parts.push(
      [`@${path} (${where})`, fence, c.code.replace(/\n$/, ""), fence, c.text.trim()].join("\n")
    )
  }
  return parts.join("\n\n")
}
