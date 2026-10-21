/* ── One reading of a thread, for every list that draws one ──
   The sidebar, the dock tabs, the project page and the landing page all say the
   same word about the same thread, and they say it by calling the same
   function. That is not tidiness: the reading is composed from two independent
   things (whether we are attached, and whether a turn is running), and the last
   time two surfaces composed it separately a thread whose socket had died
   thirty seconds ago read "Idle" in every list on screen.

   `markFor` in ./phase.ts is the vocabulary. These two are how a list gets at
   it — the pure one for a single row, the hook for a whole list. */
import * as React from "react"

import type { SessionMeta } from "@/lib/settings"
import { useStoreSelect, type ThreadState } from "@/lib/store"
import { IDLE_PHASE, markFor, type ThreadActivity } from "@/lib/thread/phase"

/**
 * What one thread is doing, as far as this device can tell.
 *
 * The live thread is the truth about a running turn. `SessionMeta.promptActive`
 * is a server snapshot refetched only on bootstrap and on mutations, so on its
 * own it never lights up mid-turn — it is the fallback, and the only signal
 * there is for a thread this client has never connected to.
 *
 * "Waiting on you" (an open permission or elicitation) is exact for a thread
 * with a live connection; for any other it is the list's snapshot of the
 * server's bridge (`SessionMeta.waiting`), current as of the last refresh.
 */
export function threadStatus(
  session: SessionMeta,
  thread: ThreadState | undefined
): ThreadActivity {
  /* A live socket is the truth; without one the server's snapshot of its
     bridge (`SessionMeta.waiting`) is the only word there is. */
  const waiting =
    thread?.phase.kind === "live"
      ? thread.permissions.length > 0 || thread.elicitations.length > 0
      : (!!thread && (thread.permissions.length > 0 || thread.elicitations.length > 0)) || !!session.waiting
  return markFor(
    thread?.phase ?? IDLE_PHASE,
    thread?.turnActive ?? session.promptActive,
    waiting,
    !!session.lastTurnError,
    backgroundOf(session, thread)
  )
}

/* A native workflow (Claude Code's Workflow tool) is a background task that
   outlives the turn that launched it: the turn ends at "launched", and the run
   works on for minutes after. It reads as busy in every list, and ONLY here —
   `turnActive` stays the turn's, because it is what Stop, the queue and the
   turn footers mean by "running", and none of them apply to a task the agent
   is no longer waiting on.

   Three sources, in the order they can be believed:

   - a live socket's `background`, which is the server's own answer and moves
     on both ends of a run (`background` event, `caught_up`) — the only one
     that knows a run ended while this device was watching;
   - the row (`SessionMeta.backgroundActive`), read off the server's bridge for
     a list with no socket to the thread at all — a phone, or a desktop that
     has never opened it. That is the case this was missing: the transcript's
     own reading cannot help where there is no transcript;
   - and, on a server that predates the field, the transcript itself.

   Read from the server rather than only from the journal, because the journal
   keeps the run's own beats: an archive of a run that died mid-flight ends on
   its last `running` and would keep the thread busy for good. Which is also
   why there is no longer a "a respawn mid-run reads busy forever" bug: the new
   process reports no run, and its answer is the one believed. */
export function backgroundOf(session: SessionMeta, thread: ThreadState | undefined): boolean {
  if (session.backgroundActive !== undefined) {
    return thread?.phase.kind === "live" ? thread.background : session.backgroundActive
  }
  return thread ? backgroundRunning(thread.items) : false
}

/* The transcript's own reading of the same thing, kept for the one case the
   server cannot answer: a client newer than its server. Cached per items
   array, because `useThreadStatuses` asks this on every store write and the
   array only changes for the thread that wrote. */
const backgroundCache = new WeakMap<ThreadState["items"], boolean>()
export function backgroundRunning(items: ThreadState["items"]): boolean {
  let running = backgroundCache.get(items)
  if (running === undefined) {
    running = items.some((i) => i.kind === "async-task" && i.state === "running")
    backgroundCache.set(items, running)
  }
  return running
}

/** The agents dashboard's vocabulary: `threadStatus` folded down to what a
    person scanning every thread asks, plus the two things it does not say — a
    turn *held* at a failure (which `markFor` reads as running, because a held
    turn is still `turnActive`) and a thread with no agent process behind it. */
export type AgentState = "waiting" | "held" | "running" | "failed" | "idle" | "archived"

export function agentState(session: SessionMeta, thread: ThreadState | undefined): AgentState {
  const status = threadStatus(session, thread)
  if (status === "waiting") return "waiting"
  const held =
    thread?.phase.kind === "live" ? thread.paused && thread.pausedReason === "error" : !!session.held
  if (held) return "held"
  if (status === "running") return "running"
  if (status === "failed") return "failed"
  const live = thread?.phase.kind === "live"
  if (status === "stopped" || (!live && session.exited)) return "archived"
  return "idle"
}

/** How full the thread's context window is, 0–100, or null where no reading
    exists. The live thread's when a tab holds one, else the list's snapshot. */
export function contextPercent(session: SessionMeta, thread: ThreadState | undefined): number | null {
  const context = thread?.context ?? session.context
  if (!context || !context.size) return null
  return Math.min(100, Math.round((context.used / context.size) * 100))
}

/**
 * Every thread's reading at once, as a map that keeps its identity for as long
 * as the readings do.
 *
 * The derivation lives *inside* the selector on purpose: the store's own
 * `Object.is` on the returned map is then what decides whether the caller
 * re-renders at all. `state.threads` is replaced on every streamed token of
 * every thread, so a caller that selected it directly would re-render on each
 * one and merely skip the memos below it.
 *
 * The cached ref is safe because the selector is idempotent — the same state
 * yields the same map — and it is replaced only when a status word actually
 * differs.
 */
export function useThreadStatuses(): Map<string, ThreadActivity> {
  const prev = React.useRef<Map<string, ThreadActivity>>(new Map())
  return useStoreSelect((state) => {
    const next = new Map<string, ThreadActivity>()
    for (const session of state.sessions) {
      next.set(session.id, threadStatus(session, state.threads[session.id]))
    }
    let same = next.size === prev.current.size
    if (same) {
      for (const [id, value] of next) {
        if (prev.current.get(id) !== value) {
          same = false
          break
        }
      }
    }
    if (!same) prev.current = next
    return prev.current
  })
}
