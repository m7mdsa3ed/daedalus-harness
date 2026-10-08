import { ThreadSocket, type ThreadCallbacks } from "../thread-socket"
import { api, ApiError, type Project, type ServerSettings, type SessionMeta } from "../settings"
import type { Action, State } from "../store"
import { makeThreadCallbacks } from "./callbacks"
import { newFoldState, type FoldState } from "./fold-context"
import { makeReconnectLadder, type ReconnectLadder } from "./ladder"
import { describeError } from "../errors"
import { recordThreadError } from "./record-error"
import {
  IDLE_PHASE,
  describePhase,
  isOpening,
  reduceConn,
  samePhase,
  type ConnEvent,
  type ConnPhase,
} from "./phase"

/** How many steps `ready` will take to make a thread sendable. Four covers the
    longest honest chain — open, find it archived, revive, attach — with one to
    spare; past that something is refusing rather than taking time, and the loop
    stops on no-progress before it ever gets here anyway. */
const READY_ROUNDS = 4
/** The longest a kept restart may hold the open chain before it is let go
    anyway — see `holdForRestart`. A spawn plus a `session/load` of a long
    conversation is seconds; this is the socket-died-in-between floor, not a
    budget anything is expected to reach. */
const RESTART_HOLD_MS = 60_000

/** `revive: true` means "this thread needs a running agent, and a socket to it"
    — spawn one rather than serving its journal read-only, and attach rather
    than stopping at the document. Opening a thread does not set it;
    reconnecting, reviving and sending all do. That is the whole of the rule
    that a connection is opened by an outgoing message and by nothing else. */
export interface ConnectOpts {
  revive?: boolean
  /**
   * Hold the rebuilt transcript back until it is whole, instead of painting it
   * a frame at a time.
   *
   * The frame-by-frame commit is right for an *open*: there is nothing on
   * screen, and a thread that paints from its first frame beats one that stays
   * blank until its last. It is wrong for a **replacement** — a restart, where
   * the transcript already on screen is a correct rendering of this very
   * conversation and the only thing the reader gains from watching it be
   * cleared and redrawn is the knowledge that something happened, which the
   * phase already says. So the reset and every frame land in one commit, and
   * the swap is invisible.
   */
  seamless?: boolean
  /**
   * This device created the thread a moment ago, so there is nothing on the
   * server it has not just been told — skip the HTTP read and attach. The read
   * exists so a view-open paints without a socket; a create is already asking
   * for one, and reading first cost the first message a round trip and a
   * `read` → `live` hop.
   */
  fresh?: boolean
}

/**
 * What a connection needs from the world outside it.
 *
 * A bag rather than a set of imports, so everything impure — fetch, dispatch,
 * the store, the session list — enters through one seam. `refreshSessions` is
 * the one that has to be handed in rather than done here: it is also what
 * prunes the device-local stores and sweeps this registry, which is
 * `lib/actions.ts`'s job and not a connection's.
 *
 * Held by reference and mutated in place rather than copied per connection: the
 * bag is rebuilt whenever `useActions` re-memoizes, and a connection that had
 * captured the old one would keep dispatching into a store handle nobody reads.
 * See `ThreadRegistry.repoint`.
 */
export interface ThreadDeps {
  settings: ServerSettings
  dispatch: (action: Action) => void
  getState: () => State
  /** The project catalog, read out of the query cache the same way
      `getState` reads the reducer: inside a callback, last-committed. It
      lives there rather than in the store, so a connection that needs to know
      whether its project still exists has to be handed a reader. */
  projects: () => Project[]
  /** The same list, or `undefined` while the first read is still in flight. */
  projectsLoaded: () => Project[] | undefined
  refreshSessions: () => Promise<void>
  /** Told when this thread stops being reachable at all, so the registry can
      forget it. The connection cannot remove itself from a map it does not
      own. */
  onGone: (sessionId: string) => void
  /** Told when this thread parks, so the shared health poll can start and the
      network watcher knows there is something to un-park. */
  onParked: () => void
}

/**
 * One thread's connection to its agent, and everything device-local that hangs
 * off it: the socket, the journal cursor, the open chain, and the reconnect
 * ladder's attempt count and timer.
 *
 * All four of those used to be module-level `Map`s in `lib/actions.ts`, keyed
 * by session id and swept by hand. Nothing owned a thread, so nothing could
 * answer "what is happening to this one" — and the sweeps disagreed:
 * `dropThreadRuntime` cleared six of the seven maps, while `deleteThread` and
 * `purgeThread` cleared only the socket and leaked the rest. Here there is one
 * object per thread and one way to end it, which is what `destroy()` is.
 */
export class ThreadConnection {
  readonly id: string
  private deps: ThreadDeps
  /** The socket, once one exists. Null before anything has needed one — which
      is every open that is only a read — and after a close. Note that an
      archived (and now a `read`) thread still holds a `ThreadSocket` object
      with no WebSocket under it: that is what answers `load_earlier` and the
      queue edits over HTTP. */
  private socket: ThreadSocket | null = null
  /**
   * The journal cursor, the restart gate, the seamless flag and the last
   * read's `promptActive`: the four facts the fold writes and this object
   * reads, shared with the callbacks by reference rather than copied across
   * the seam. What each one is for is in lib/thread/fold-context.ts.
   */
  private state: FoldState = newFoldState()
  /**
   * Opens in flight — every open for this thread runs after the one before it
   * has settled.
   *
   * Opening is not a single synchronous `new WebSocket`: it is an awaited HTTP
   * read of the transcript and only then a socket. That await is a window in
   * which "is this connected" is false for a thread that is very much being
   * opened, so a second call landing in it built a second socket on the same
   * session — two peers on the server, both folding every event into the same
   * store, and the origin-peer exclusion covering only one of them. Serialising
   * rather than widening the guard means the guards inside run against a
   * settled world, which is the only state in which they can answer.
   */
  private chain: Promise<unknown> = Promise.resolve()
  /**
   * Ends the chain link a *kept* restart holds — see `onRestart`.
   *
   * A restart that keeps the journal never opens anything: the socket stays
   * attached and the phase goes straight back to `live`. That is the point of
   * it, and it is also what took `reviving` off the chain. `ready()`'s default
   * case waits for a phase it did not start by awaiting `settled()`, on the
   * documented grounds that every such phase is raised inside `openNow` and so
   * "the chain really does own it" — which stopped being true the moment
   * `markReviving("config")` started being raised from a socket callback.
   * `settled()` then resolved in the same tick, the loop saw no progress and
   * every send during a config restart threw "stuck waiting for the agent to
   * restart on the new settings".
   *
   * So the restart takes a link of its own. `ready()` needs no change, and
   * neither does anything else that waits on `settled()`.
   */
  private restartDone: (() => void) | null = null
  /** The attempt count, the backoff timer and the parked flag — see
      lib/thread/ladder.ts. Built in the constructor, because every rung of it
      is one of this object's own methods. */
  private ladder: ReconnectLadder
  private disposed = false
  /** The shared health probe, handed down by the registry so a ladder booked
      from inside `onStatus` gates on it exactly as an explicit reconnect does.
      One question between every thread, rather than one per thread per rung. */
  probe?: () => Promise<boolean>
  /** What this connection is doing, and the only copy of it. The store's is a
      mirror this object writes; nothing else may. */
  private phase: ConnPhase = IDLE_PHASE
  /** Why the last open failed. `openFromStore` records failures in the
      transcript and returns — which is right for a React effect that has
      nowhere to put an exception, and wrong for `ready`, whose caller is a
      person who just pressed send and is owed the actual reason. */
  private lastOpenError: unknown = null
  /** Aborts the respawn request while it is in flight — see `cancelWait`. */
  private waitAbort: AbortController | null = null

  constructor(id: string, deps: ThreadDeps) {
    this.id = id
    this.deps = deps
    this.ladder = makeReconnectLadder({
      apply: (event) => this.apply(event),
      attempt: (probe) => void this.attemptReconnect(probe),
      isDisposed: () => this.disposed,
      onParked: () => this.deps.onParked(),
    })
  }

  /**
   * Move the phase, and tell the store when it actually moved.
   *
   * The single writer. Every transition goes through `reduceConn`, which is
   * total and ignores what it has no rule for — so an event from a socket that
   * has been superseded, or a close landing after the ladder has already booked
   * a rung, cannot overwrite a state that has moved on. That argument used to be
   * settled by dispatch order between two writers, and the reconnect ladder lost
   * it every time.
   *
   * `samePhase` rather than identity: `reduceConn` builds a fresh object per
   * transition, so a re-attach that lands on the state it was already in would
   * otherwise re-render every surface reading it to tell them nothing.
   */
  private apply(event: ConnEvent): void {
    const next = reduceConn(this.phase, event)
    if (samePhase(next, this.phase)) return
    this.phase = next
    this.deps.dispatch({ type: "thread-phase", id: this.id, phase: next })
  }

  /** For the paths that draw the phase before a socket exists — a create or a
      respawn POST, which are the seconds-long part of starting a thread. */
  markStarting(): void {
    this.apply({ type: "create-begin" })
  }

  /**
   * A process is being put back under this thread, so the rebuild reads as a
   * restart rather than a plain read.
   *
   * `because` is what the wait *says*, and the two callers mean different
   * things by it: a revive is a thread whose agent had stopped and is coming
   * back, and a config restart is a setting the user just picked that could
   * not be applied to the running process. Told apart because one sentence was
   * being used for both — see `ConnPhase`.
   */
  markReviving(because: "revive" | "config" = "revive"): void {
    this.apply({ type: "revive-begin", because })
  }

  /** Give up on a revive's wait. Only the respawn request can be abandoned
      (it is the long part: the server spawns, handshakes and reloads the
      conversation inside it), and the server finishes what it started — the
      next send finds the agent up or asks again. ponytail: no server-side
      cancel; add one if abandoned spawns ever pile up. */
  cancelWait(): void {
    this.waitAbort?.abort()
  }

  /** The create never happened — put the thread back to "never opened", which
      is what a draft whose first message failed actually is. */
  markIdle(): void {
    this.apply({ type: "detached" })
  }

  // ---- what other code asks about a thread ----

  /** The socket, or null. Callers that need one must go through `requireLive`. */
  get live(): ThreadSocket | null {
    return this.socket
  }

  /** Read from the journal with no agent process behind it. */
  get isArchived(): boolean {
    return this.socket?.isArchived ?? false
  }

  get isParked(): boolean {
    return this.ladder.parked
  }

  /** Whether a reconnect is booked or waiting — what `retryNow` acts on. */
  get isRecovering(): boolean {
    return this.ladder.recovering
  }

  /**
   * The socket a command goes down.
   *
   * Still a refusal rather than a wait: the words are recorded, not lost. The
   * outbox is what turns this into "become sendable" for prompts; queue edits
   * and mode changes stay refusals because they are about a thread the user is
   * already looking at, and inventing a wait for them would hide a dead
   * connection rather than report it.
   */
  requireLive(): ThreadSocket {
    if (!this.socket) {
      throw new Error(
        "This thread has no live connection to its agent — revive it and send again."
      )
    }
    return this.socket
  }

  /**
   * A socket that can take a command, whatever state this thread is in.
   *
   * This is the old "This thread has no live connection to its agent — revive it
   * and send again" refusal, turned inside out. Every reason that sentence could
   * be true is a thing this method knows how to wait for or bring about: an open
   * that has not been asked for yet, one that is half way through, a thread whose
   * process was retired, a ladder mid-backoff, a thread parked waiting for a
   * server that has not come back. The refusal was a statement about this
   * device's bookkeeping dressed up as a statement about the thread, and the
   * user's answer to it — press the button, then send again — is something the
   * client can do on their behalf.
   *
   * What is left throws, and what is left has a real reason: the thread is in
   * Trash, its project is gone, or the server refused to spawn.
   *
   * Bounded at two rounds, so a server that keeps answering `archived` cannot
   * spin here — the second failure is reported rather than retried forever.
   */
  async ready(): Promise<ThreadSocket> {
    /* Each pass does ONE thing and then re-asks, because healing is genuinely
       multi-step: a thread this device has not opened yet goes `idle` → open →
       `archived` (an exited thread with a journal opens read-only, by design) →
       revive → `live`. That is three passes for the most ordinary case there is
       — open an old thread from the sidebar, type, send — and a budget of two
       turned it into "This thread could not be brought back online", which is a
       sentence about this loop rather than about the thread. */
    for (let round = 0; round < READY_ROUNDS; round += 1) {
      // Checked first, so arriving costs no budget at all.
      if (this.phase.kind === "live" && this.socket?.connected) return this.socket
      if (this.phase.kind === "live") {
        /* Attached, according to the phase, to a socket that cannot carry a
           command. Say so rather than handing it back: `prompt` would throw
           "not connected" from inside the send, which is the failure this whole
           method exists to stop. `detached` puts the phase back to `idle`, and
           the next pass opens. */
        this.apply({ type: "detached" })
        continue
      }
      const before = this.phase
      switch (this.phase.kind) {
        case "deleted":
          throw new Error("This thread is in Trash — restore it before sending.")
        case "failed":
          if (this.phase.recover === "none") throw new Error(this.phase.reason)
          await this.revive(this.probe)
          break
        case "read":
          /* The transcript was read over HTTP and nothing was connected,
             because nothing needed to be. This is the moment that stops being
             true: open again, asking for the socket this time. */
          await this.openFromStore({ revive: true })
          break
        case "archived":
          /* Reading it needed no process, and this is the moment that stops
             being true. Revive rather than refuse: the user typed into a thread
             that looked open, and "revive it and send again" is a step the
             client can take for them. */
          await this.revive(this.probe)
          break
        case "parked":
        case "reconnecting":
          /* Do not merely wait. A parked thread is waiting on a poll that may be
             twenty seconds away, and a thread between rungs is waiting on a
             timer — in both cases the user has just asked for the thing the
             ladder is trying to do, so ask for it now instead.

             And put the ladder back if that fails. `revive` clears the attempt
             count and the timer before it tries, so an attempt made on the
             user's behalf that does not land would otherwise leave the thread
             with nothing watching it — a send would have *stopped* the recovery
             it was trying to shortcut. */
          try {
            await this.revive(this.probe)
          } catch (error) {
            this.scheduleReconnect(error, this.probe)
            throw error
          }
          break
        case "idle":
          /* `revive: true` from here, always. A view-open deliberately brings
             up no socket (and respawns nothing), which is the right reading of
             "somebody is looking at this thread" and the wrong one of
             "somebody is sending to it" — the caller of `ready` is the second.
             Opening without it cost this loop a whole round per send on a
             thread the device had not opened yet, to land in `read` and ask
             again. */
          await this.openFromStore({ revive: true })
          break
        default:
          /* Already on its way (`starting`, `reviving`, `loading`, `replaying`,
             `attaching`). Wait for it to land rather than starting a second one
             — that race is what put two peers on one session and drew every
             message twice. */
          await this.settled()
          /* `reviving` with nothing in flight and no restart held is owned by
             nobody (a respawn that died before it could say so): recover. */
          if (this.phase.kind === "reviving" && !this.state.restarting) {
            await this.revive(this.probe)
            break
          }
          /* Except that `starting` is not on the chain at all. Every other phase
             here is one an open moved through, so waiting for the chain is
             waiting for the thing that will end it — but `starting` is set by
             hand around `POST /api/sessions` (`markStarting`), which no open
             owns, so `settled()` has nothing to wait for and returns in the same
             tick. The loop then saw no progress, broke, and reported the thread
             as "stuck waiting for the agent to spawn" — about an agent that was
             already up. That was every draft's first message: `createSession`
             marks `starting`, POSTs, and hands straight to `ready`, whose only
             other way out of this phase was an open that a React effect had not
             run yet. Opening is what the effect would have done, and doing it
             here makes the send's own hand-off deterministic rather than a race
             with React's commit. (`reviving` is deliberately not included: the
             chain really does own it — raised inside `openNow` for a revive,
             and held by `holdForRestart` for the config restart that opens
             nothing at all. That second half is what the kept-journal restart
             had to add: without it this phase was owned by nobody and every
             send during a settings change reported the thread as stuck.) */
          if (this.phase.kind === "starting") await this.openFromStore({ revive: true })
          break
      }
      /* Nothing moved: another pass would do exactly the same nothing. Not
         conditioned on there being no socket — an archived thread has one, and
         requiring it to be null is how a thread that kept landing back on the
         same phase spent the whole budget instead of stopping at the first
         round that achieved nothing. Report the reason the open actually
         failed, which `openFromStore` has already put in the transcript, rather
         than the loop's own exhaustion. */
      if (samePhase(this.phase, before)) break
    }
    if (this.phase.kind === "live" && this.socket) return this.socket
    /* Naming the phase is not decoration: this is the message somebody reports,
       and "could not be brought back online" on its own says only that this loop
       gave up, which is the least useful half of what happened. */
    throw (
      this.lastOpenError ??
      new Error(
        `This thread could not be brought back online — it is stuck ${describePhase(this.phase)}. Try reviving it.`
      )
    )
  }

  // ---- opening ----

  /**
   * Open (or reattach to) this thread, behind whatever open is already running.
   *
   * The chain is per connection and each link re-asks the guards, so a second
   * caller reads a settled world rather than racing the first caller's answers.
   * Failures reach this caller; the chain itself is kept swallowed, so one
   * failed open does not reject the next.
   */
  open(meta: SessionMeta, opts: ConnectOpts = {}): Promise<void> {
    return this.run(async () => {
      try {
        await this.openNow(meta, opts)
      } catch (error) {
        /* A throw while `reviving` (the respawn POST, or the open behind it)
           would leave a phase with no banner and a Send that throws "stuck".
           Say it as a failure with the Revive button instead. */
        if (this.phase.kind === "reviving" && !this.disposed) {
          const info = describeError(error)
          if (info.kind === "cancelled") {
            /* The wait was given up on (`cancelWait`): back to what it was
               before — a thread with no process, sendable, whose send starts
               the agent again. Not a failure, so no card and no row. */
            this.apply({ type: "caught-up", archived: true })
          } else {
            /* Said as WHICH thing failed — the title used to be the error's
               own, so a failed revive read as "The request failed (500)" —
               with the cause one fold down, where Copy takes it. */
            this.apply({
              type: "failed",
              title: "Couldn't revive the agent",
              reason: info.title,
              detail: [
                info.notInstalled?.install && `Install it with: ${info.notInstalled.install}`,
                info.detail,
              ]
                .filter(Boolean)
                .join("\n\n") || undefined,
              recover: "revive",
            })
          }
        }
        throw error
      }
    })
  }

  /**
   * Open from whatever the store currently says about this thread.
   *
   * The row is read *here*, inside the chain, rather than being handed in by a
   * React effect — which is the whole point. The panel's effect used to take the
   * row as a dependency, and `refreshSessions` replaces every row object, so a
   * list refresh re-fired an open; an open landing inside another open is two
   * peers on one session. Now the panel names an id and the connection looks up
   * the row at the moment it needs it, which is also the only moment the answer
   * is current.
   *
   * A row this device has never heard of is not an error: the route can resolve
   * before the list has landed. The caller re-asks when it does.
   *
   * A failure *is* one, and it is recorded here rather than thrown at a React
   * effect that has nowhere to put it — in the thread, which is the surface the
   * caller is already showing, and `settle: false` because a connection that
   * failed says nothing about whether the agent's turn is over.
   */
  openFromStore(opts: ConnectOpts = {}): Promise<void> {
    return this.run(async () => {
      const meta = this.deps.getState().sessions.find((s) => s.id === this.id)
      if (!meta) {
        /* Not an error for a panel that opened before the list landed — the key
           it watches changes when it does, and this runs again. It *is* an error
           for `ready`, whose caller cannot wait for a row that may never come. */
        this.lastOpenError = new Error("This thread is not on this server any more.")
        return
      }
      try {
        await this.openNow(meta, opts)
        this.lastOpenError = null
      } catch (error) {
        this.lastOpenError = error
        recordThreadError(this.deps.dispatch, this.id, error, "Couldn't connect to this thread", {
          settle: false,
        })
        /* And put the phase back, or the failure is invisible in every surface
           that reads one: an opening phase locks the composer (`composerLock`)
           and draws no banner (`bannerFor` has nothing for a wait), so a thread
           whose open threw sat on "Starting the agent…" with the send button out
           of service and no way to ask again. `idle` is what it actually is —
           nothing in flight, nothing attached — and it is the phase the next
           open starts from. The socket goes with it: `connect` rejected, so
           whatever is left is not carrying this thread. */
        if (isOpening(this.phase)) this.detach()
      }
    })
  }

  /**
   * Resolve once whatever open is in flight has finished — without starting one.
   *
   * `send` is deliberately not on the open chain (a prompt is not an open), but
   * the socket it is about to use is whatever the chain last installed, and
   * reading that mid-open gets a connection with no socket in it yet: the
   * transcript is still being read over HTTP. The chain never rejects, so this
   * only ever waits.
   */
  settled(): Promise<void> {
    return this.chain.then(
      () => {},
      () => {}
    )
  }

  /**
   * Hold the open chain until a kept restart says it is over.
   *
   * The timeout is not a policy, it is a floor: the server states `ready` or
   * `failed` for every restart it starts, but a socket that dies in between
   * states neither — and a chain link nobody resolves is a thread that can
   * never be opened again. Generous, because a respawn is a spawn plus a
   * `session/load` of the whole conversation.
   */
  private holdForRestart(): void {
    this.endRestartHold()
    /* The gate is built HERE, not inside a `run` callback. `run` would not
       construct it until whatever is already on the chain had finished — so a
       restart arriving during an open would leave `restartDone` unset when
       `ready` came, nothing would resolve it, and the chain would sit on the
       timeout instead of being let go. Built synchronously, the resolver exists
       from this line on and the chain merely waits for a promise that may
       already be settled by the time it gets there. */
    const gate = new Promise<void>((resolve) => {
      this.restartDone = resolve
      setTimeout(resolve, RESTART_HOLD_MS)
    })
    this.chain = this.chain.then(
      () => gate,
      () => gate
    )
  }

  /** Let the chain go, however the restart ended — including not at all. */
  private endRestartHold(): void {
    const done = this.restartDone
    this.restartDone = null
    done?.()
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn)
    this.chain = next.then(
      () => {},
      () => {}
    )
    return next
  }

  private async openNow(meta: SessionMeta, opts: ConnectOpts = {}): Promise<void> {
    if (this.disposed) return
    /* The rebuild this gate was raised for. From here every event is the new
       process's, folded normally. */
    this.state.restarting = false
    this.state.seamless = opts.seamless ?? false
    // A draft has no server session and no agent process — there is nothing to
    // connect to until the first message brings it into existence.
    if (meta.draft) return
    if (this.socket?.connected) return
    /* A thread that has been read holds no socket by design, so `connected`
       cannot answer for it — and what is in the store is already the whole of
       it. Navigating back to the route, or a row that flipped to `exited` under
       it, must not re-fetch the transcript. A revive is the exception: it is
       asking for the process and the peer this thread deliberately does not
       have. */
    if (
      !opts.revive &&
      this.socket &&
      !this.socket.isDisposed &&
      (this.socket.isArchived || this.phase.kind === "read")
    )
      return
    /* A thread whose project was deleted can never open. Saying nothing left
       it stuck on the connecting skeleton forever — but a list that has not
       been read yet is not an empty one, so this waits for the answer rather
       than failing every thread on a cold boot. */
    const known = this.deps.projectsLoaded()
    if (known && !known.some((p) => p.id === meta.projectId)) {
      throw new Error(
        "This thread's project no longer exists, so there is no working directory to run the agent in."
      )
    }
    /* A deleted thread is exited with no way back through the revive path —
       restore is what brings it around. Throwing here also stops the reconnect
       backoff from re-POSTing a respawn the server must refuse, which is where
       the old "session deleted" retry loop came from. */
    if (meta.deletedAt) {
      throw new Error(
        "This thread is in Trash — restore it from the thread list to open it again."
      )
    }

    /* No live process (idle-retired, or the server restarted). Two ways back,
       and which one is right depends on what the user is about to do.

       If the server still holds this thread's journal (`cursor > 0`), opening it
       is a *read*, and a read does not need an agent: attach, replay the
       archive, and show it read-only. Spawning a process and making it
       re-narrate the whole conversation through `session/load` — several seconds
       and a child process — to look at yesterday's work was the cost this
       avoids. Sending a message is what needs the agent, and `send` revives on
       its own when that happens.

       With no journal (pruned by retention, or a thread from before the archive
       existed) there is nothing to read, so the revive happens here exactly as
       it always did. */
    if (meta.exited && meta.cursor > 0 && !opts.revive) {
      await this.start(0, false)
      return
    }
    if (meta.exited) {
      await this.reviveProcess(meta)
      if (this.disposed) return
    }

    /* Already read, and the only thing missing is the peer. The document is on
       screen and this device's cursor names its end, so the socket resumes from
       there — re-reading a transcript to attach to it would make the first send
       into a thread pay for the read a second time. */
    if (
      this.phase.kind === "read" &&
      this.socket &&
      !this.socket.isDisposed &&
      !this.socket.connected
    ) {
      await this.socket.connect({ cursor: this.state.cursor })
      return
    }
    const live = opts.revive ?? false
    const archived = await this.start(this.resumeCursor(meta), live, opts.fresh ?? false)
    /* The row said this thread's process was up, and the server's own answer —
       the authority, because the row is a list read a moment ago and a process
       can die in between — says there is none. Trust the server: put one back
       rather than hand the caller a thread that will refuse every command. This
       gap is what surfaced as "stuck reading from the archive with no agent
       running", a sentence about this loop rather than about the thread, and it
       came with advice the client could take itself. Asked for only on a
       `revive` open, so an automatic rung still never respawns behind the
       reader's back (`attemptReconnect` asks with `revive: false`). */
    if (live && archived && !this.disposed) {
      await this.reviveProcess(meta)
      if (this.disposed) return
      /* One retry, then a real error. A second `archived` answer means the
         server took the spawn and still has no process behind the thread —
         something a third request cannot fix, and a state that deserves to be
         said rather than retried in a circle. */
      if (await this.start(0, true)) {
        throw new Error(
          "The agent did not come back up, so this thread is still reading from its archive."
        )
      }
    }
  }

  /** Where a reattach picks up. 0 when this device has never folded this
      thread's journal (a fresh connect or a page reload), or when the agent is
      about to be respawned. A value > 0 is the delta: "I already have this
      much; give me the rest." */
  private resumeCursor(meta: SessionMeta): number {
    return meta.exited ? 0 : this.state.cursor
  }

  /**
   * Put a process back under this thread — the revive half of `openNow`, and
   * the only door that spawns one outside a create.
   *
   * `meta` is the row the server last answered with: the profile and the
   * model/effort it names are what the spawn runs on, and the server takes
   * whatever change is staged on top of them.
   *
   * Announced as `reviving` first, because putting a process back is the
   * seconds-long part — without it the thread reads "Reading this
   * conversation…" through a wait that is not a read at all, and a failure
   * would land with no phase for `open`'s catch to turn into a failure card.
   */
  private async reviveProcess(meta: SessionMeta): Promise<void> {
    this.apply({ type: "revive-begin", because: "revive" })
    const abort = (this.waitAbort = new AbortController())
    try {
      await api(this.deps.settings, `/api/sessions/${this.id}/respawn`, {
        method: "POST",
        signal: abort.signal,
        body: JSON.stringify({
          profileId: meta.profileId,
          model: meta.model || undefined,
          effort: meta.effort || undefined,
        }),
      })
    } finally {
      if (this.waitAbort === abort) this.waitAbort = null
    }
    await this.deps.refreshSessions()
    /* Respawn cleared the server's journal; a saved cursor now points past its
       end. Dropping it makes the attach that follows a clean `from: 0` rebuild
       rather than leaning on the server's clamp. */
    this.state.cursor = 0
  }

  /**
   * Read the thread over HTTP, and connect a socket only if this open asked for
   * one.
   *
   * The read comes first because opening a thread *is* a read, and it used to be
   * paid for as a connection — a WebSocket handshake, an attach and a paced
   * stream of replay frames before the first line of the transcript could be
   * drawn. `ThreadSocket.load` folds the same bracket out of one HTTP response
   * (same events, same callbacks, same parser), so the transcript paints off a
   * request the browser makes on a connection it already holds, and the socket
   * that follows resumes from where that document ended — a delta, usually an
   * empty one, rather than the whole thread again.
   *
   * `live` is the rest of it. Reading a thread is not attaching to it: a peer
   * that never sends is a socket held open for the duration of somebody's
   * reading, on every thread the dock has open, on a server that counts peers
   * to decide what to retire. So a view-open stops at the document, and the
   * socket is brought up by the first thing that actually needs one — a
   * message, a queue edit, a reconnect the user asked for — through `ready()`.
   * The archived case was always this shape (a thread with no agent process has
   * nothing to say on a socket, and paging back and queue edits both have an
   * HTTP answer); this makes it the rule rather than the exception.
   *
   * One exception, and it is the server's to state: a thread whose turn is
   * running *is* something live to connect to, and its answer arrives on a
   * socket or not at all. `caught_up` says so (`promptActive`), so a read that
   * lands mid-turn attaches on the strength of it.
   *
   * Returns whether the thread was left **archived** — the server's own answer
   * that there is no process behind it. That is not something this device's row
   * is allowed to override: a `live` open that comes back archived was asked to
   * revive a thread the row believed was up, and `openNow` is the caller that
   * puts the process back rather than handing a caller a document it cannot
   * send to.
   */
  private async start(cursor: number, live: boolean, fresh = false): Promise<boolean> {
    /* The HTTP read starts here. `open-begin` deliberately leaves a ladder's
       phase alone (see `reduceConn`): a reconnect attempt *is* an open, and
       while one runs the thread is still recovering rather than merely loading
       — which is what the banner says and what decides whether the composer
       holds the words already typed into it. */
    this.apply({ type: "open-begin" })
    this.state.promptActiveAtLoad = false
    /* Whatever was on this thread before is not this socket, and two sockets on
       one session are two peers folding every event into the same store — which
       is what a duplicated transcript is. */
    this.socket?.close()
    const socket = new ThreadSocket(this.id, this.deps.settings, this.callbacks(() => socket))
    this.socket = socket
    let archived = false
    let read = false
    try {
      if (!fresh) {
        ;({ archived } = await socket.load({ cursor }))
        read = true
      }
    } catch (error) {
      /* The thread is genuinely unreadable this way (deleted, or no archive to
         read), or the server predates the route. Either way the socket is the
         authority and its own refusal is the better message, so this is not
         reported here. */
      console.warn(`Reading thread ${this.id} over HTTP failed; falling back to the socket`, error)
    }
    /* Reading the transcript is an await, and in it another path can have
       replaced this thread's socket (a respawn, a revive, a second open). The
       replacement owns the session now — the callbacks already drop anything
       this object says once it is not the registered one — so connecting here
       would put a second peer on the same session. */
    if (this.socket !== socket) return false
    if (read && !live && !this.state.promptActiveAtLoad) {
      /* Read, and nothing asked for a peer. `read` rather than a dressed-up
         "connected": the composer takes words exactly as it does on an archived
         thread, and sending is what opens the socket.

         Only when the document actually landed. A read that *failed* is a
         thread with nothing on screen, and calling that "read, up to date"
         would be a lie the composer takes words against — so it falls through
         to the socket, which is the fallback the catch above was written for
         (an older server has no replay route) and the only thing left that can
         either serve the thread or say why it cannot. */
      if (!archived) this.apply({ type: "read" })
      return archived
    }
    if (archived) {
      /* Nothing to connect to, and nothing coming — `onCaughtUp` has already
         moved the phase to `archived`, which is a state of its own rather than
         a dressed-up "connected". Sending is what revives it.

         Reported rather than merely stopped at, because "sending revives it" is
         true of an *open* and not of a revive: a caller that came here with
         `live` asked for the process already, and returning silently is how
         `openNow` handed `ready` a thread it could not bring up. */
      return true
    }
    /* Where the socket picks up: the end of the document, so a turn journaled
       while it was streaming arrives as the delta it is. Read from the cursor
       the fold itself moved rather than from the argument, because it is also
       the right answer when the read failed *part way* — those events are on
       screen, and resuming from before them would fold them a second time. */
    await socket.connect({ cursor: Math.max(cursor, this.state.cursor) })
    return false
  }

  // ---- recovery ----

  /**
   * Reattach, reviving the agent if it is gone.
   *
   * `silent` is the automatic-backoff path: a failed attempt is not worth a
   * transcript row of its own — the ladder reports once, at give-up.
   */
  async reconnect(
    silent = false,
    probe?: () => Promise<boolean>,
    opts: { revive?: boolean } = {}
  ): Promise<void> {
    const revive = opts.revive ?? true
    /* An automatic attempt asks the cheap unauthenticated question first. Every
       rung of every thread's ladder otherwise costs a full
       `/api/sessions?deleted=1` — the whole list, deleted rows included, once
       per open transcript per round — to discover what one shared health probe
       already knows. A user-initiated reconnect skips the gate: it was asked
       for, and it should fail against the real route rather than against a
       probe. */
    if (silent && probe && !(await probe())) {
      throw new ApiError({
        status: 0,
        path: "/api/health",
        serverMessage: "the server did not answer a health check",
      })
    }
    /* Drop any half-open socket so the `connected` short-circuit in `openNow`
       cannot skip the reconnect — and *detach*, not merely close.
       `close()` alone left `this.socket` pointing at the socket it had just
       killed, and the `close` event is asynchronous: it landed in the middle of
       the round trip below, still passed the ownership guard (the field and the
       callback's owner were the same object), and was read as a connection that
       had died on us. So a revive marked the thread `failed` on its way to
       reviving it — and a `ready()` that started from there spent its whole
       budget failing itself in a circle. Detaching nulls the field first, so the
       stray close belongs to nobody and is dropped where every other superseded
       socket's is. */
    this.detach()
    const sessions = await api<SessionMeta[]>(this.deps.settings, "/api/sessions?deleted=1")
    this.deps.dispatch({ type: "sessions", sessions })
    const meta = sessions.find((s) => s.id === this.id)
    if (!meta) throw new Error("This thread no longer exists on the server.")
    /* Deleted mid-connection (another tab, another device): reconnecting is not
       a thing that can succeed, so stop the ladder and say what happened once,
       instead of retrying a revive the server must refuse. */
    if (meta.deletedAt) {
      this.apply({ type: "deleted" })
      this.deps.onGone(this.id)
      this.deps.dispatch({
        type: "error",
        id: this.id,
        title: "This thread was deleted",
        reason: "It moved to Trash on this server — restore it to reopen it.",
      })
      return
    }
    /* `revive` on every path the *user* asked for. Opening a thread from the UI
       may serve its archive read-only, but a reconnect the user pressed never
       should: the socket closed because the process died (or was taken over),
       and the thread they are looking at was live a moment ago. Attaching to
       the journal instead would turn a crash into a silently read-only thread.

       An automatic rung is the opposite reading, and deliberately: nobody asked
       for anything, so it asks for the thread as it is. A live process gets its
       socket back; a retired one is read from its journal and stays read, until
       a send revives it. */
    if (!revive && meta.exited && meta.cursor === 0) {
      /* Retired with no journal to read and nothing this attempt may spawn.
         Not a rung to keep climbing — the ladder is for a path that is coming
         back, and this thread is answering. Say it once, with the button that
         does what only a person can ask for. */
      this.clearRecovery()
      this.apply({
        type: "failed",
        title: "This thread is no longer running",
        reason: "The conversation is restored when the agent is revived.",
        recover: "revive",
      })
      return
    }
    await this.open(meta, { revive })
    /* The attempt landed. A socket that came up has already cleared the ladder
       from `onStatus`, but the other honest outcome — reattached to a thread
       whose agent has been retired, read from its journal — never raises
       `connected`, and leaving the counters set would let the next close start
       halfway up a ladder that had in fact succeeded. */
    this.clearRecovery()
  }

  /** Put an agent process back under a thread that has none — the ladder's
      counters cleared first, because this was asked for. */
  async revive(probe?: () => Promise<boolean>): Promise<void> {
    this.clearRecovery()
    await this.reconnect(false, probe)
  }

  private clearRecovery(): void {
    this.ladder.clear()
  }

  /** Book the next rung, or park — the counter, the backoff and the parked
      flag are lib/thread/ladder.ts's. Public because `ready` re-books here
      when an attempt it made on the user's behalf did not land, and because
      the socket's own `onStatus` books one for a close that says nothing
      about the thread. */
  scheduleReconnect(lastError: unknown, probe?: () => Promise<boolean>): void {
    this.ladder.schedule(lastError, probe)
  }

  /** One rung. It asks for the thread AS IT IS (`revive: false`), which is
      the whole of "a dropped socket reattaches on its own, and never
      respawns": a live agent gets its socket back, a retired one is read from
      its journal and left `read`, and putting a process back stays something
      only a send or the button asks for. */
  private attemptReconnect(probe?: () => Promise<boolean>): Promise<void> {
    return this.reconnect(true, probe, { revive: false }).catch((error) => {
      console.warn(`Reconnecting thread ${this.id} failed`, error)
      this.scheduleReconnect(error, probe)
    })
  }

  /** The network, or the user's attention, came back: reset the counter and try
      once now. A failure re-enters the ladder at rung one. */
  retryNow(probe?: () => Promise<boolean>): void {
    this.ladder.retryNow(probe)
  }

  // ---- teardown ----

  /** Drop the socket but keep what this device knows (the cursor above all), so
      re-opening is a delta rather than a rebuild. */
  detach(): void {
    /* A restart is reported on the socket, so a socket that is going away is
       one that will never say `ready` or `failed`. Holding the chain past that
       would stall every later open behind `holdForRestart`'s timeout — which
       exists as a floor, not as something anything should routinely wait out. */
    this.endRestartHold()
    this.socket?.close()
    this.socket = null
    this.apply({ type: "detached" })
  }

  /**
   * Drop the socket *and* the cursor: the server's log for this thread has been
   * cleared, so the position saved in it names nothing.
   *
   * The one caller is a respawn — the only moment a log is replaced rather than
   * extended. Keeping the cursor would make the next attach ask for a delta
   * from a position past the end of a log that has just started again, which
   * the server clamps back to 0 anyway; saying so here means the rebuild is
   * intended rather than repaired.
   */
  forgetJournal(): void {
    this.detach()
    this.state.cursor = 0
  }

  /** The thread is gone, or this whole connection is. Everything device-local
      goes with it — which is the entire point of the object: there is one place
      to forget a thread, and it cannot disagree with itself. */
  destroy(): void {
    this.disposed = true
    this.clearRecovery()
    // …which releases any restart hold: a chain link nobody resolves would
    // outlive the object holding it.
    this.detach()
    this.state.cursor = 0
  }

  /** Tell the server this peer's page has stopped running. */
  setBackground(background: boolean): void {
    this.socket?.setBackground(background)
  }

  // ---- the socket's callbacks ----

  /** The thread's title, for a notification about it. */
  private titleOf(): string {
    return this.deps.getState().sessions.find((s) => s.id === this.id)?.title || "Untitled thread"
  }

  /**
   * What this connection hands the socket to fold into.
   *
   * One object, built once per socket, and the only sink under
   * `ThreadSocket`'s one `handle` switch — so an HTTP replay and a live
   * connection are the same code path, with no second parser. The bodies are
   * lib/thread/callbacks.ts's; what they are allowed to reach back into is the
   * bag below, which is this object's privates behind closures rather than the
   * object itself.
   */
  private callbacks(owner: () => ThreadSocket): ThreadCallbacks {
    return makeThreadCallbacks(
      {
        id: this.id,
        dispatch: this.deps.dispatch,
        getState: this.deps.getState,
        state: this.state,
        phaseNow: () => this.phase,
        isCurrent: (socket) => this.socket === socket,
        isDisposed: () => this.disposed,
        probe: () => this.probe,
        apply: (event) => this.apply(event),
        clearRecovery: () => this.clearRecovery(),
        scheduleReconnect: (error, probe) => this.scheduleReconnect(error, probe),
        markReviving: (because) => this.markReviving(because),
        holdForRestart: () => this.holdForRestart(),
        endRestartHold: () => this.endRestartHold(),
        forgetJournal: () => this.forgetJournal(),
        openFromStore: (opts) => this.openFromStore(opts),
        detach: () => this.detach(),
        titleOf: () => this.titleOf(),
      },
      owner
    )
  }
}
