/* ── The wait at the foot of the transcript ── the one line a starting,
   restarting or replaying thread is allowed to say, and the gate that decides
   whether it is on screen at all. Its own file because the surface only ever
   asks it two things — `useWaitShown(phase)` and `<StartingLine phase>` — and
   the reasoning behind both is long enough to bury the transcript. */
import * as React from "react"
import { Progress } from "@/components/ui/progress"
import { Button } from "@/components/ui/button"
import { PhaseLine } from "@/components/composer-status"
import { formatElapsed } from "@/components/step-row"
import { slowLine, startingLine, waitDelayMs, type ConnPhase } from "@/lib/thread/phase"

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
const SLOW_MS = 6_000

/** When a spawn or a restart has gone on long enough to say how long, and to
    offer the way out. The same rule as the delay above it: nothing is drawn
    until the wait lasts — a handshake that beats this never shows a clock. */
const CLOCK_MS = 10_000

/** Replays smaller than this fold imperceptibly; below it the progress is true
    but not worth drawing. */
const LONG_REPLAY_EVENTS = 400

/**
 * Whether this phase's wait should be on screen at all.
 *
 * Two answers folded into one: is there a wait to draw (`startingLine`), and
 * has it lasted long enough to be worth drawing (`waitDelayMs`). The caller
 * needs both as one boolean because a `MessageScrollerItem` that renders
 * nothing still reserves its intrinsic size — so the gate has to be outside
 * the item, not inside `StartingLine`.
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

export function StartingLine({ phase, onCancel }: { phase: ConnPhase; onCancel?: () => void }) {
  const [slow, setSlow] = React.useState(false)
  React.useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_MS)
    return () => clearTimeout(timer)
  }, [])
  /* Only the waits that can be given up on tick: a clock re-rendering a replay
     once a second would be motion with nothing behind it. */
  const cancellable = !!onCancel
  const [waited, setWaited] = React.useState(0)
  React.useEffect(() => {
    if (!cancellable) return
    const since = Date.now()
    const timer = setInterval(() => setWaited(Date.now() - since), 1000)
    return () => clearInterval(timer)
  }, [cancellable])
  const line = startingLine(phase)
  if (!line) return null
  /* A bar only when there is a number behind the wait AND the wait is long
     enough to be felt. Below the threshold the fold is imperceptible and a bar
     that appears and vanishes is noise about work nobody waited for. */
  const bar = line.bar && line.bar.total >= LONG_REPLAY_EVENTS ? line.bar : null
  const slowText = slow ? slowLine(phase) : null
  return (
    <div className="py-2">
      {/* Literally the working line now, not merely "the same shape as" it:
          spawning, restarting and connecting are the thread being worked on,
          and the reader should not have to learn a second shape for the wait.
          Sharing the component is also what makes the swap between these six
          sentences a transition instead of a cut — see `PhaseLine`. */}
      <PhaseLine text={line.text} label="Opening this thread" />
      {bar && (
        <div className="flex max-w-xs items-center gap-2 pl-6 pt-1.5">
          <Progress
            value={bar.done}
            max={bar.total}
            className="flex-1 [&_[data-slot=progress-track]]:h-1"
          />
          <span className="text-xs text-muted-foreground tabular-nums">
            {Math.min(99, Math.floor((bar.done / bar.total) * 100))}%
          </span>
        </div>
      )}
      {/* Always said, not only once the wait is slow. Every headline above is a
          word this codebase means something precise by and the reader does not
          — "Restarting the agent…" is the whole of what a person had to work
          out for themselves — so the sentence under it is the answer to "what
          is this, and did I lose anything". When the wait runs long, `slowLine`
          answers the question that replaces it — whether this will end at all —
          as a sentence *added*, never one taken over: the detail is the only
          thing that says nothing was lost, and dropping it at exactly the
          moment the reader starts to worry is backwards. */}
      <div className="max-w-prose pl-6 pt-1 text-xs leading-relaxed text-muted-foreground">
        {line.detail}
        {slowText && <span className="mt-1 block">{slowText}</span>}
      </div>
      {/* The way out of a wait that has stopped looking like one. Cancel gives
          up the *wait*, never the words: the message goes back in the box. */}
      {onCancel && waited >= CLOCK_MS && (
        <div className="flex items-center gap-2 pl-6 pt-1.5 text-xs text-muted-foreground">
          <span className="tabular-nums">Waiting {formatElapsed(waited)}</span>
          <Button variant="outline" size="xs" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  )
}
