import { describeError } from "../errors"
import { RECONNECT_MAX_ATTEMPTS, RECONNECT_MAX_ATTEMPTS_RESTARTING, type ConnEvent } from "./phase"

const RECONNECT_BASE_DELAY_MS = 500
const RECONNECT_MAX_DELAY_MS = 8000

/**
 * The reattach ladder: an attempt count, a timer, and the parked flag.
 *
 * A closure rather than a class, because it is three fields and the connection
 * is the only thing that can act on them. What it does NOT own is what an
 * attempt *is*: `attempt` is the connection's own `attemptReconnect`, which
 * asks for the thread as it is (`revive: false`) and never puts a process
 * back. The ladder decides only *when*.
 */
export interface ReconnectLadder {
  /** Parked until the network (or the user, or the health poll) comes back: the
      ladder gave up, or `navigator.onLine` said an attempt could not succeed. */
  readonly parked: boolean
  /** A reconnect is booked or waiting. */
  readonly recovering: boolean
  clear: () => void
  /** Book the next rung, or park. */
  schedule: (
    lastError: unknown,
    probe?: () => Promise<boolean>,
    /** `restarting`: the close was the server announcing its own restart. Sticky for
        the rest of the outage, so the rungs that follow keep the longer budget. */
    opts?: { restarting?: boolean },
  ) => void
  /** The network, or the user's attention, came back: reset the counter and try
      once now. A failure re-enters the ladder at rung one. */
  retryNow: (probe?: () => Promise<boolean>) => void
}

export function makeReconnectLadder(opts: {
  apply: (event: ConnEvent) => void
  /** One rung: the connection's own reattach, which re-enters `schedule` when
      it fails. */
  attempt: (probe?: () => Promise<boolean>) => void
  isDisposed: () => boolean
  /** Something parked: the shared health poll starts, and the network watcher
      knows there is something to un-park. */
  onParked: () => void
}): ReconnectLadder {
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let parked = false
  let restarting = false

  const clear = (): void => {
    attempt = 0
    parked = false
    restarting = false
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const park = (reason?: string): void => {
    parked = true
    opts.apply({ type: "parked", reason, at: Date.now() })
    opts.onParked()
  }

  /**
   * Book the next rung, or park.
   *
   * No longer booked by a close: a socket that drops is left dropped, because a
   * socket is what a *message* needs and nothing is sending. The ladder is the
   * continuation of an attempt the user asked for — a send that had to bring the
   * connection back and did not land, which `ready` re-books here so the thread
   * is not left with nothing watching it — and each failed attempt re-enters it.
   */
  const schedule = (lastError: unknown, probe?: () => Promise<boolean>, hint?: { restarting?: boolean }): void => {
    if (timer || opts.isDisposed()) return
    if (hint?.restarting) restarting = true
    /* Offline, every attempt is a guaranteed failure that burns the budget
       against a network that cannot answer. Park the thread instead — the
       `online` listener retries it the moment there is a network to try. */
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      park("There is no network connection.")
      return
    }
    const next = attempt + 1
    const max = restarting ? RECONNECT_MAX_ATTEMPTS_RESTARTING : RECONNECT_MAX_ATTEMPTS
    if (next > max) {
      /* Parked, not abandoned: coming back online, refocusing the tab or the
         shared health poll resets the counter and tries again without waiting
         for the user. The ladder is a fast detector, not the whole budget —
         five rungs cover about 16 seconds, and a deploy takes longer than that,
         so giving up before the server is back is the ORDINARY outcome. */
      /* Said as a *state*, not as a transcript row. Giving up used to append an
         error to the conversation, and giving up is precisely the thing that
         ends on its own — the health poll un-parks it a few seconds later, and
         the row stayed there forever, one per outage, in the middle of the
         thread. The banner `bannerFor` draws from this phase says the same
         sentence and then stops saying it. */
      const info = lastError ? describeError(lastError) : undefined
      park(info?.title ?? "The server or the agent process is not reachable.")
      return
    }

    attempt = next
    const backoff = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (next - 1), RECONNECT_MAX_DELAY_MS)
    /* Jitter, so every thread a server restart dropped does not knock again in
       the same instant on every device. */
    const delayMs = backoff + Math.random() * backoff * 0.5
    opts.apply({
      type: "retry-scheduled",
      attempt: next,
      max,
      restarting: restarting || undefined,
      nextAt: Date.now() + delayMs,
      reason: lastError ? describeError(lastError).title : undefined,
    })
    timer = setTimeout(() => {
      timer = null
      opts.attempt(probe)
    }, delayMs)
  }

  return {
    get parked() {
      return parked
    },
    get recovering() {
      return parked || timer !== null
    },
    clear,
    schedule,
    retryNow: (probe) => {
      clear()
      opts.attempt(probe)
    },
  }
}
