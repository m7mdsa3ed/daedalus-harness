/* ── The one thing a thread says about itself, as data ──
   The foot of a transcript used to be five scroller items (connection,
   archived, starting, working, held) whose JSX gates kept exactly one from
   speaking. This is that ladder in one pure function, in the same order, so a
   surface draws one slot and cannot say two things. */
import { retryWhy, workingMessage } from "@/components/composer/activity-line"
import { describeError } from "@/lib/errors"
import { useStoreSelect, type ThreadState } from "@/lib/store"
import { holdOf } from "@/lib/thread/hold"
import { bannerFor, slowLine, startingLine } from "@/lib/thread/phase"
import * as React from "react"

export type StatusActionKind =
  | "revive" | "reconnect" | "restore" | "cancel"
  | "continue" | "retry" | "retryAsPaths" | "dismiss" | "settings"

export interface ThreadStatus {
  kind:
    | "starting" | "reviving" | "loading" | "replaying" | "attaching"
    | "reconnecting" | "parked" | "failed"
    | "retrying" | "held" | "sending" | "working" | "waiting"
    | "archived" | "trashed" | "turn-failed"
  tone: "progress" | "info" | "warn" | "error"
  headline: string
  /** Position in the startup sequence; only the opening phases have one. */
  step?: { n: number; of: number }
  detail?: string
  /** The cause or stack, folded under a disclosure. */
  more?: string
  /** A fix that can be copied (a missing agent's install line). */
  install?: string
  /** "Retry (text only)" when the turn carried attachments. */
  retryLabel?: string
  /** `turn-failed`: the transcript row this status stands in for. */
  itemId?: string
  /** Startup: a number behind the wait, and the sentence added once it runs long. */
  bar?: { done: number; total: number }
  slow?: string
  /** `reconnecting`: when the next attempt is made. */
  nextAt?: number
  actions?: { label: string; busyLabel?: string; kind: StatusActionKind }[]
  /** When the state began, where state already holds it (`parked`). */
  since?: number
}

const STEPS = { starting: 1, reviving: 1, loading: 2, replaying: 3, attaching: 4 } as const

/**
 * `waitShown` is `useWaitShown(phase)`: the one time-dependent input (a config
 * restart is held back 450ms), so it stays the caller's and this stays pure.
 * Order is the JSX's: connection, archived, the wait, then the turn.
 */
export function statusFor(thread: ThreadState, waitShown = true): ThreadStatus | null {
  const phase = thread.phase
  const banner = bannerFor(phase)
  if (banner) {
    return {
      kind: phase.kind === "deleted" ? "trashed" : (phase.kind as "reconnecting" | "parked" | "failed"),
      tone: banner.tone,
      headline: banner.title,
      detail: banner.message,
      more: banner.detail,
      nextAt: phase.kind === "reconnecting" ? phase.nextAt : undefined,
      actions: banner.action ? [banner.action] : undefined,
      since: phase.kind === "parked" ? phase.since : undefined,
    }
  }
  if (phase.kind === "archived") {
    return {
      kind: "archived",
      tone: "info",
      headline: "Agent stopped",
      detail: "Send a message to restart the agent and continue this conversation.",
    }
  }
  const line = startingLine(phase)
  if (line && waitShown) {
    const kind = phase.kind as "starting" | "reviving" | "loading" | "replaying" | "attaching"
    const sending = thread.items.some((item) => item.kind === "user" && item.local && item.sending)
    return {
      kind,
      tone: "progress",
      headline: sending ? `Sending your message — ${line.text}` : line.text,
      step: { n: STEPS[kind], of: 4 },
      detail: sending
        ? `Your message is safe and will be delivered as soon as the agent is ready. ${line.detail}`
        : line.detail,
      bar: line.bar,
      slow: slowLine(phase) ?? undefined,
      // Only the waits whose request can be abandoned; a settings restart is the server's.
      actions:
        phase.kind === "starting" || (phase.kind === "reviving" && phase.because === "revive")
          ? [{ label: "Cancel", kind: "cancel" }]
          : undefined,
    }
  }
  const hold = holdOf(thread)
  // A turn held on a failure is the held card's (model picker, Continue), not a line.
  if (hold.byError) return null
  if (line) return null
  if (!thread.turnActive) return failureStatus(thread)
  if (thread.retry) {
    const { attempt, of, error } = thread.retry
    return {
      kind: "retrying",
      tone: "warn",
      headline: "Retrying request",
      detail: `${of ? `${attempt} of ${of} attempts` : `Attempt ${attempt}`}${error ? ` — ${retryWhy(error)}` : ""}`,
      more: error ? [describeError(error).title, describeError(error).detail].filter(Boolean).join("\n\n") : undefined,
    }
  }
  if (hold.paused) return { kind: "held", tone: "info", headline: hold.message }
  const waiting = thread.permissions.length > 0 || thread.elicitations.length > 0
  const sending = thread.items.some((item) => item.kind === "user" && item.local && item.sending)
  if (sending) {
    return {
      kind: "sending",
      tone: "progress",
      headline: "Sending your message…",
      detail: "Waiting for the server to accept this message.",
    }
  }
  return { kind: waiting ? "waiting" : "working", tone: "progress", headline: workingMessage(thread) }
}

/** The newest failure, while it is the last thing that happened: the turn is
    over and nothing has been said since. The same rule `thread-view` used to
    give the row its Continue (`last.stopped`) and Retry (`retryText`). */
function failureStatus(thread: ThreadState): ThreadStatus | null {
  const item = thread.items[thread.items.length - 1]
  if (item?.kind !== "error") return null
  const missing = item.notInstalled
  const carried = (item.retryAttachments?.length ?? 0) > 0
  const actions: NonNullable<ThreadStatus["actions"]> = [
    ...(missing ? [{ label: "Open Agents settings", kind: "settings" as const }] : []),
    ...(item.stopped ? [{ label: "Continue", kind: "continue" as const }] : []),
    ...(item.retryText ? [{ label: carried ? "Retry (text only)" : "Retry", kind: "retry" as const }] : []),
    ...(carried ? [{ label: "Retry as file paths", kind: "retryAsPaths" as const }] : []),
    { label: "Dismiss", kind: "dismiss" },
  ]
  return {
    kind: "turn-failed",
    tone: missing || item.severity === "warning" ? "warn" : item.severity === "info" ? "info" : "error",
    headline: item.title,
    detail: item.reason,
    more: item.detail,
    install: missing?.install,
    retryLabel: carried ? "Retry (text only)" : undefined,
    itemId: item.id,
    actions,
  }
}

const same = (a: ThreadStatus | null, b: ThreadStatus | null) => JSON.stringify(a) === JSON.stringify(b)

/**
 * `statusFor` over the store, referentially stable while the derived value is
 * unchanged (the pattern of `useLiveTurnActive`): a streamed token that leaves
 * the line as it was does not re-render the foot.
 */
export function useThreadStatus(sessionId: string, waitShown: boolean): ThreadStatus | null {
  const prev = React.useRef<ThreadStatus | null>(null)
  return useStoreSelect((state) => {
    const thread = state.threads[sessionId]
    const next = thread ? statusFor(thread, waitShown) : null
    if (!same(prev.current, next)) prev.current = next
    return prev.current
  })
}
