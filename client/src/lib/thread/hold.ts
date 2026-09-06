import { describeError } from "@/lib/errors"
import type { ThreadState } from "@/lib/store"
import type { WireError } from "@daedalus/protocol"

/**
 * The hold, read once. Four components used to re-derive "is this the turn
 * that failed?" from `pausedReason === "error"` and spell the rule and its
 * wording separately; this is the one place both live, so a change to what a
 * hold means is one edit.
 *
 * Two things hold a turn and they are one wait (see `AcpBridge.setHold`). A
 * `byUser` hold is the composer's toggle: the turn may still be mid-stream
 * and lifts at its next step. A `byError` hold is a turn that **failed and did
 * not end** — stopped at its last finished step with every tool call intact,
 * waiting for a model change and a Continue — and it is drawn as an open turn
 * in a stopped state, never as an error row.
 */
export interface Hold {
  /** Anything is holding the turn. */
  paused: boolean
  byError: boolean
  byUser: boolean
  /** The failure a `byError` hold is waiting on; null otherwise. */
  error: WireError | null
  /** What the hold says about itself, for the status line and the card. */
  message: string
  /** What sending does while held. Held either way, the words are *steered*:
      they join the turn at the boundary it is waiting at, so they land the
      moment it goes on. Queued, they would sit behind a turn that never ends
      on its own. */
  sendHint: string
}

const NONE: Hold = {
  paused: false,
  byError: false,
  byUser: false,
  error: null,
  message: "",
  sendHint: "",
}

export function holdOf(thread: Pick<ThreadState, "paused" | "pausedReason" | "pausedError">): Hold {
  if (!thread.paused) return NONE
  if (thread.pausedReason === "error") {
    const reason = thread.pausedError ? describeError(thread.pausedError).title : ""
    return {
      paused: true,
      byError: true,
      byUser: false,
      error: thread.pausedError ?? null,
      message: reason ? `Held — ${reason}` : "Held — the model provider returned an error",
      sendHint: "Add to the held turn — it lands when you continue",
    }
  }
  return {
    paused: true,
    byError: false,
    byUser: true,
    error: null,
    message: "Paused",
    sendHint: "Add to the paused turn — it lands when you resume",
  }
}
