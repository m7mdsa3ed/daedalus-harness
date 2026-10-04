import type { AttachmentRef } from "@daedalus/protocol"

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
    /** What the failed prompt carried — see `ErrorItem.retryAttachments`. Not
        what Retry sends; what lets the row say what Retry will and will not
        do, and what the "as file paths" variant re-sends. */
    retryAttachments?: AttachmentRef[]
    /** False when the failure is this device's connection rather than the
        agent's answer: a reconnect is coming and it re-folds the transcript,
        so nothing in flight is over. */
    settle?: boolean
    /** A headline-sized reason of the caller's own, for a failure whose
        normalized title says less than the caller knows. The normalized
        title moves into the folded detail rather than being lost. */
    reason?: string
    /** Softer than a failure: a thing to know, said in the amber. */
    severity?: "warning"
    /** The agent's process ended under this turn — the row offers Continue. */
    stopped?: boolean
    /** Extra lines for the folded detail, ahead of the error's own. */
    detail?: string
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
    reason: opts.reason ?? info.title,
    detail: [opts.detail, opts.reason ? info.title : undefined, info.detail].filter(Boolean).join("\n\n") || undefined,
    notInstalled: info.notInstalled,
    severity: opts.severity,
    stopped: opts.stopped,
    retryText: opts.retryText,
    retryAttachments: opts.retryAttachments,
    settle: opts.settle ?? true,
    /* This client's own account of a failure. Nothing on the server will ever
       replay it, which is what makes it a row an attach has to carry rather
       than destroy — see lib/thread/carry.ts. */
    local: true,
  })
  return info
}
