import { describeError, markReported, type ErrorInfo } from "../errors"
import type { Action } from "../store"

/**
 * Put a failure in the thread it belongs to.
 *
 * Failures that belong to a thread are recorded IN that thread, not in a toast:
 * the transcript is where the user is looking, it survives the four seconds a
 * toast lives, and it is the only place that can offer the one useful next step
 * (send that prompt again).
 *
 * A free function taking its sink, rather than a method on anything, because it
 * has two of them. Everything outside a replay wants the row committed now;
 * the replay wants it in the same fold as the transcript it belongs to, or the
 * error lands in a thread that is about to be reset out from under it.
 */
export function recordThreadError(
  emit: (action: Action) => void,
  sessionId: string,
  err: unknown,
  context: string,
  opts: {
    retryText?: string
    /** False when the failure is this device's connection rather than the
        agent's answer: a reconnect is coming and it re-folds the transcript,
        so nothing in flight is over. */
    settle?: boolean
  } = {}
): ErrorInfo {
  const info = describeError(err)
  console.error(`[${context}]`, err)
  // It has a home in the transcript now; the global net must not re-toast it
  // if a caller lets the rethrow escape.
  markReported(err)
  if (info.kind === "cancelled") return info
  emit({
    type: "error",
    id: sessionId,
    title: context,
    reason: info.title,
    detail: info.detail,
    retryText: opts.retryText,
    settle: opts.settle ?? true,
    /* This client's own account of a failure. Nothing on the server will ever
       replay it, which is what makes it a row an attach has to carry rather
       than destroy — see lib/thread/carry.ts. */
    local: true,
  })
  return info
}
