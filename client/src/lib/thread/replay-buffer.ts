import * as React from "react"

import type { Action } from "../store"

/**
 * The one sink every folded event goes into, buffered across a replay.
 *
 * The replay is a few thousand events, and dispatching each one commits a
 * render of a transcript nobody has looked at yet — which is what made a
 * long thread visibly rebuild itself line by line. So between `attached` and
 * `caught_up` the actions go into a list instead.
 *
 * Held back until the end, though, it overshot: the screen stayed empty for
 * the *whole* replay. So the buffer is committed per `replay` frame
 * (`commit`) and only closed at the end (`flush`) — the frame is the
 * server's own cut, a handful of them carry a window, and the transcript
 * paints from the first one while the rest are still arriving.
 *
 * Two rules keep it honest. Everything thread-scoped goes through `send`,
 * never `dispatch` — a stray direct dispatch would jump the queue and land
 * before the `thread-reset` that is still sitting in the buffer. And any
 * exit from the replay flushes: `caught_up` is the ordinary one, a socket
 * that dies mid-replay is the other, and without the second the history
 * would be dropped on the floor along with the close status.
 */
export interface ReplaySink {
  send: (action: Action) => void
  /** The one hot dispatch: an agent streams text as dozens of chunks a second,
      and each one is a full state update. Marking it a transition lets React
      treat it as interruptible — a burst of chunks coalesces into the frames
      the display can actually show instead of one render per token. */
  sendStream: (action: Action) => void
  /** Open a buffer: from here nothing reaches the reducer until a `commit` or
      the closing `flush`. Raised by the two things that bracket a fold —
      `attached` and the `load_earlier` re-fold. */
  open: () => void
  /** Commit what has been folded so far and close the buffer. */
  flush: () => void
  /** Commit what has been folded so far and keep buffering. */
  commit: () => void
}

/**
 * `isDeaf` is the restart gate, read per action rather than captured: while a
 * restart that cleared the journal runs, what this socket is being told is the
 * transcript already on screen said again — see `FoldState.restarting`.
 */
export function makeReplaySink(
  dispatch: (action: Action) => void,
  isDeaf: () => boolean
): ReplaySink {
  let buffer: Action[] | null = null
  const send = (action: Action) => {
    /* Dropped rather than buffered: this socket is watching a journal being
       cleared and refilled under it, and none of what it is being told is
       news (see `restarting`). The rebuild that follows is what puts the
       transcript back, from 0. */
    if (isDeaf()) return
    if (buffer) buffer.push(action)
    else dispatch(action)
  }
  /* The one hot dispatch: an agent streams text as dozens of chunks a second,
     and each one is a full state update. Marking it a transition lets React
     treat it as interruptible — a burst of chunks coalesces into the frames
     the display can actually show instead of one render per token. */
  const sendStream = (action: Action) => {
    if (isDeaf()) return
    if (buffer) buffer.push(action)
    else React.startTransition(() => dispatch(action))
  }
  const flush = () => {
    const pending = buffer
    buffer = null
    if (pending?.length) dispatch({ type: "batch", actions: pending })
  }
  /* Commit what has been folded so far and keep buffering. The array is
     replaced rather than emptied in place, because the actions in it are about
     to be handed to the reducer and a buffer that kept collecting into the
     same array would be mutating a batch already dispatched. */
  const commit = () => {
    const pending = buffer
    if (!pending?.length) return
    buffer = []
    dispatch({ type: "batch", actions: pending })
  }
  return {
    send,
    sendStream,
    open: () => {
      buffer = []
    },
    flush,
    commit,
  }
}
