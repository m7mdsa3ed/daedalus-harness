import type { ThreadSocket } from "../thread-socket"
import type { Action, State, ThreadItem } from "../store"
import type { ConnEvent, ConnPhase } from "./phase"
import type { ReplaySink } from "./replay-buffer"

/**
 * The device-local facts a fold *writes* and the connection *reads*.
 *
 * One object, held by both and mutated in place — not four fields copied
 * across a seam. The fold is the only writer of every one of them and the
 * connection is the only reader that acts on them, so a copy would be a second
 * account of the same thing, disagreeing the moment either side moved.
 */
export interface FoldState {
  /**
   * The last journal cursor this device has folded, so a reconnect to an alive
   * process can ask for the delta instead of rebuilding a transcript it already
   * holds in memory. Reset to 0 whenever the thread is respawned, since a
   * respawn clears the server's journal and a stale cursor would point past its
   * end.
   */
  cursor: number
  /**
   * True between `restart: "started"` and the reattach that follows it.
   *
   * The server clears the journal and re-narrates the whole conversation into
   * it (`session/load`), and every one of those events is fanned out to the
   * socket this device is still holding. They are not news — they are the
   * transcript already on screen, said again — so while this is set the socket's
   * callbacks drop what they are handed. Cleared by the open that rebuilds.
   */
  restarting: boolean
  /** This open is replacing a transcript rather than drawing one, so the
      replay is committed once at the end — see `ConnectOpts.seamless`. */
  seamless: boolean
  /**
   * Whether the last read said a turn was running.
   *
   * The one thing that makes a view-open attach anyway: a turn's answer arrives
   * on a socket or nowhere, so a thread read while it is working is a thread
   * with something live to connect to. Written by the `caught_up` fold and read
   * by `start` immediately after it, which is the whole of its life.
   */
  promptActiveAtLoad: boolean
}

export function newFoldState(): FoldState {
  return { cursor: 0, restarting: false, seamless: false, promptActiveAtLoad: false }
}

/**
 * What the fold needs from the connection that owns it.
 *
 * The same bargain `ThreadDeps` makes one layer up: everything the callbacks
 * reach *outwards* for — the store, the phase, the ladder, the open chain —
 * enters through one bag, so the fold can be read without the class and the
 * class hands out no more of itself than the fold actually uses. The
 * connection's own fields stay private; what it exposes here is a set of
 * closures over them, built once in `ThreadConnection.callbacks`.
 */
export interface CallbackHost {
  readonly id: string
  dispatch: (action: Action) => void
  getState: () => State
  /** The four facts the fold writes — shared by reference, never copied. */
  state: FoldState
  /** The connection's phase, read at the moment it is needed: a fold runs long
      after the callbacks were built. */
  phaseNow: () => ConnPhase
  /** Whether this socket is still the one the connection is holding. A respawn
      or a reconnect installs a new socket for the same session id while the old
      one is still closing, and the old one must not speak for the live thread. */
  isCurrent: (socket: ThreadSocket) => boolean
  isDisposed: () => boolean
  /** The shared health probe, read at call time — the registry assigns it after
      the connection is constructed. */
  probe: () => (() => Promise<boolean>) | undefined
  apply: (event: ConnEvent) => void
  clearRecovery: () => void
  scheduleReconnect: (error: unknown, probe?: () => Promise<boolean>, opts?: { restarting?: boolean }) => void
  markReviving: (because: "revive" | "config") => void
  holdForRestart: () => void
  endRestartHold: () => void
  forgetJournal: () => void
  /** `ThreadConnection.openFromStore` — the shape of `ConnectOpts`, spelled
      structurally so this stays a leaf module. */
  openFromStore: (opts: { revive?: boolean; seamless?: boolean }) => Promise<void>
  detach: () => void
  /** The thread's title, for a notification about it. */
  titleOf: () => string
}

/**
 * One socket's fold: the host, the buffer it commits through, and the two
 * facts an attach carries from its start to its end.
 *
 * Built per `ThreadSocket` in `makeThreadCallbacks`, which is what makes the
 * two mutable fields below safe: they belong to one attach, and a replacement
 * socket gets a context of its own.
 */
export interface FoldContext {
  host: CallbackHost
  sink: ReplaySink
  /**
   * `owner` resolves to the socket these callbacks belong to. A function rather
   * than the socket itself because the callbacks are built *while* constructing
   * it — see the guard in `onStatus`, which is what stops a closing socket from
   * speaking for the one that replaced it.
   */
  owner: () => ThreadSocket
  /** Rows this device owns that no journal can produce, held across an attach
      that replaces the transcript. Captured at `attached` and put back at
      `caught_up` — see lib/thread/carry.ts for which rows and why. */
  carried: ThreadItem[]
  /** Whether this attach is serving the journal alone. Read from `attached`,
      where the server states it, and NOT from `ThreadSocket.isArchived`: that
      field is assigned after the whole document has been folded, so at
      `caught_up` — which is where it is needed — it still reads false, and an
      archived thread would sit on `attaching` forever waiting for a socket
      that is never going to be opened. */
  attachedArchived: boolean
}
