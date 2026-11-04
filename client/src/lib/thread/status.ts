/* ── The one thing a thread says about itself, as data ──
   The foot of a transcript used to be five scroller items (connection,
   archived, starting, working, held) whose JSX gates kept exactly one from
   speaking. This is that ladder in one pure function, in the same order, so a
   surface draws one slot and cannot say two things. */
import { retryWhy, shownRetry, workingMessage } from "@/components/composer/activity-line"
import { runningAgents } from "@/components/composer/agents-indicator"
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
    | "background"
    | "archived" | "trashed" | "turn-failed"
  tone: "progress" | "info" | "warn" | "error"
  headline: string
  /** The transcript is opening — a wait, never a position in a sequence. This
      used to carry `{n, of}` and draw "Step 1 of 4", which was a lie twice
      over: an open is not a fixed four steps (a new thread never leaves the
      spawn, and a revive is one wait, not a rung) and the phases that would
      advance it are deliberately held while a create is in flight. So it is a
      flag; the only progress with a number behind it is the replay `bar`. */
  opening?: true
  detail?: string
  /** The backoff in progress (`retrying`): which retry of how many, and its wait. */
  retry?: { attempt: number; of?: number; delayMs?: number }
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
  /** An open turn's clock: when it began, and the wall time of the thread's
      settled turns before it, so the line can tick this turn and the total. */
  ran?: { since: number; before: number }
}

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
      opening: true,
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
  /* Nothing in flight, no hold, no failure left to report — except, sometimes,
     work the agent launched that outlived the turn. That is neither an ending
     nor a wait: it is the thread still going with no turn open. */
  if (!thread.turnActive) return failureStatus(thread) ?? backgroundStatus(thread)
  const ran = runtimeOf(thread)
  const retry = shownRetry(thread)
  if (retry) {
    const { attempt, of, delayMs, error } = retry
    return {
      ran,
      kind: "retrying",
      tone: "warn",
      headline: "Request failed, trying again",
      detail: error ? retryWhy(error) : undefined,
      retry: { attempt, of, delayMs },
      more: error ? [describeError(error).title, describeError(error).detail].filter(Boolean).join("\n\n") : undefined,
    }
  }
  if (hold.paused) return { ran, kind: "held", tone: "info", headline: hold.message }
  const waiting = thread.permissions.length > 0 || thread.elicitations.length > 0
  const sending = thread.items.some((item) => item.kind === "user" && item.local && item.sending)
  if (sending) {
    return {
      ran,
      kind: "sending",
      tone: "progress",
      headline: "Sending your message…",
      detail: "Waiting for the server to accept this message.",
    }
  }
  return { ran, kind: waiting ? "waiting" : "working", tone: "progress", headline: workingMessage(thread) }
}

/** The open turn began at its message: the newest of the thread's own bubbles.
    `turnDuration` holds only settled turns (`turn_ended`), and only the ones
    this window replayed, so the total is what this device has read. */
function runtimeOf(thread: ThreadState): ThreadStatus["ran"] {
  for (let i = thread.items.length - 1; i >= 0; i--) {
    const item = thread.items[i]
    if (item.kind !== "user" || item.parentId) continue
    if (item.at === undefined) return undefined
    const before = Object.values(thread.turnDuration).reduce((sum, ms) => sum + ms, 0)
    return { since: item.at, before }
  }
  return undefined
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

/**
 * The thread's own line while its agent still has background work going and no
 * turn is open: a Claude Code workflow, which answers its prompt at "launched"
 * and works on afterwards. Without this the transcript simply fell silent at
 * the turn's end and the thread read as done while its run was mid-flight —
 * the one reading a person watching the thread has.
 *
 * Its own kind rather than `working`, because `working` is the turn's: it is
 * what a Stop button, the queue and the composer are about, and none of them
 * apply to work the agent is no longer waiting on. Named off the run for the
 * same reason `workingMessage` names a step: at least one agent's `name` here is
 * the workflow's own, since a native run's steps carry it (`nativeWorkflowRun`).
 * A run whose per-agent beats never arrived (an unpatched adapter) still has the
 * totals, so it falls back to the plain sentence rather than saying nothing.
 */
function backgroundStatus(thread: ThreadState): ThreadStatus | null {
  if (!thread.background) return null
  const agents = runningAgents(thread)
  const run = agents.find((agent) => agent.name)?.name
  /* A one-step run's child is no workflow: name it by its pair, and say "agent". */
  const head = agents.length === 1 ? thread.items.find((item) => item.id === agents[0].id) : undefined
  const ask = head?.kind === "subagent" ? head.ask : undefined
  const asked = ask ? ask.agent ?? "The asked agent" : undefined
  return {
    kind: "background",
    tone: "progress",
    headline:
      agents.length > 1
        ? `${agents.length} agents still running`
        : asked
          ? `${asked} is still working`
          : `${run ?? "A workflow"} is still running`,
    detail: asked
      ? "This turn is over; the agent it asked is not. Its work is in the transcript above, and its answer comes back as a new turn."
      : "This turn is over; the workflow it launched is not. Its steps are in the transcript above, and this line goes when the run ends.",
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
