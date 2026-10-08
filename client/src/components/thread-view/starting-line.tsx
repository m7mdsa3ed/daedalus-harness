/* ── The wait at the foot of the transcript ── the one line a starting,
   restarting or replaying thread is allowed to say, and the gate that decides
   whether it is on screen at all. Its own file because the surface only ever
   asks it one thing — `useWaitShown(phase)`; `ThreadStatus` draws the line — and
   the reasoning behind it is long enough to bury the transcript. */
import * as React from "react"
import { startingLine, waitDelayMs, type ConnPhase } from "@/lib/thread/phase"

/** The one line a starting thread is allowed to say, staged through the phases
    the client can actually tell apart: while the draft flag holds, the POST that
    spawns the agent and runs the handshake is in flight; once the server's row
    has replaced it, the socket is opening; and once `attached` has landed, the
    journal is replaying toward `caught_up`.

    The last of those is the one that used to be missing, and its absence made
    the line say something it had no evidence for. Before `attached` this client
    knows nothing about the thread's *size* — the wait is the network, the
    socket, or a server busy with someone else's turn — yet the slow line blamed
    "a long conversation" either way, sending the reader to look at a length that
    was frequently not the problem. So the two waits are told apart, and only the
    second one is allowed to talk about the conversation: it is the one with a
    number behind it.

    That number is why there is a bar rather than a longer apology. `attached`
    states where the replay ends, so the wait is a quantity from the first frame
    and the reader can see it moving. The rule is the service worker's, which had
    the same problem in a harder form (see `sw.ts`): no bar until the total is
    known, because a spinner is how "not known yet" is said and a bar drawn
    against nothing is a lie that jumps. A *short* replay draws none either — it
    is over in a blink, and a bar that appears and vanishes is noise about work
    nobody waited for. */
/**
 * Whether this phase's wait should be on screen at all.
 *
 * Two answers folded into one: is there a wait to draw (`startingLine`), and
 * has it lasted long enough to be worth drawing (`waitDelayMs`). The caller
 * needs both as one boolean because a `MessageScrollerItem` that renders
 * nothing still reserves its intrinsic size — so the gate has to be outside
 * the item, not inside `ThreadStatus`.
 *
 * The delay is zero for every phase but a config restart, so this is a
 * `useState` that never changes and a `setTimeout` that is never set on the
 * paths that used to render immediately.
 */
export function useWaitShown(phase: ConnPhase): boolean {
  const delay = startingLine(phase) ? waitDelayMs(phase) : 0
  const [elapsed, setElapsed] = React.useState(delay === 0)
  React.useEffect(() => {
    if (delay === 0) {
      setElapsed(true)
      return
    }
    setElapsed(false)
    const timer = setTimeout(() => setElapsed(true), delay)
    return () => clearTimeout(timer)
  }, [delay])
  return elapsed && startingLine(phase) !== null
}
