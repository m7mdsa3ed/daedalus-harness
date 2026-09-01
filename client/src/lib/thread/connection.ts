import * as React from "react"
import { AgentError, ThreadSocket, type ThreadCallbacks } from "../thread-socket"
import { api, ApiError, type Project, type ServerSettings, type SessionMeta } from "../settings"
import { optionKey, saveAgentOptions } from "../agent-options"
import { appendTaskEvent } from "../task-events"
import { notifyThreadEvent } from "../notifications"
import { describeError } from "../errors"
import { emptyThread, type Action, type State, type ThreadItem } from "../store"
import { carryOf } from "./carry"
import { recordThreadError } from "./record-error"
import {
  IDLE_PHASE,
  RECONNECT_MAX_ATTEMPTS,
  describePhase,
  isOpening,
  reduceConn,
  samePhase,
  type ConnEvent,
  type ConnPhase,
} from "./phase"

const RECONNECT_BASE_DELAY_MS = 500
const RECONNECT_MAX_DELAY_MS = 8000
/** Codes that mean the thread is not coming back on its own: killed, taken
    over, unknown. Everything else — an agent that exited, a socket that went
    quiet (4100), a bare 1006 — is worth a ladder. */
const NON_RECONNECTABLE_CLOSE_CODES = new Set([4000, 4002, 4004])

/** How many steps `ready` will take to make a thread sendable. Four covers the
    longest honest chain — open, find it archived, revive, attach — with one to
    spare; past that something is refusing rather than taking time, and the loop
    stops on no-progress before it ever gets here anyway. */
const READY_ROUNDS = 4

/** `revive: true` means "this thread needs a running agent" — spawn one rather
    than serving its journal read-only. Opening a thread does not set it;
    reconnecting, reviving and sending all do. */
export interface ConnectOpts {
  revive?: boolean
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
  /** The socket, once one exists. Null while the transcript is being read over
      HTTP, on an archived thread (which deliberately opens none), and after a
      close. */
  private socket: ThreadSocket | null = null
  /**
   * The last journal cursor this device has folded, so a reconnect to an alive
   * process can ask for the delta instead of rebuilding a transcript it already
   * holds in memory. Reset to 0 whenever the thread is respawned, since a
   * respawn clears the server's journal and a stale cursor would point past its
   * end.
   */
  private cursor = 0
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
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Parked until the network (or the user, or the health poll) comes back: the
      ladder gave up, or `navigator.onLine` said an attempt could not succeed. */
  private parked = false
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

  constructor(id: string, deps: ThreadDeps) {
    this.id = id
    this.deps = deps
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
    return this.parked
  }

  /** Whether a reconnect is booked or waiting — what `retryNow` acts on. */
  get isRecovering(): boolean {
    return this.parked || this.timer !== null
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
          await this.openFromStore()
          break
        default:
          /* Already on its way (`starting`, `reviving`, `loading`, `replaying`,
             `attaching`). Wait for it to land rather than starting a second one
             — that race is what put two peers on one session and drew every
             message twice. */
          await this.settled()
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
             with React's commit. (`reviving` is deliberately not included: it is
             raised inside `openNow`, so the chain really does own it.) */
          if (this.phase.kind === "starting") await this.openFromStore()
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
    return this.run(() => this.openNow(meta, opts))
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
    // A draft has no server session and no agent process — there is nothing to
    // connect to until the first message brings it into existence.
    if (meta.draft) return
    if (this.socket?.connected) return
    /* An archived thread is read over HTTP and holds no socket by design, so
       `connected` cannot answer for it — and what is in the store is already
       the whole of it. Navigating back to the route must not re-fetch the
       transcript. A revive is the exception: it is asking for a process, which
       is exactly what this thread does not have. */
    if (!opts.revive && this.socket?.isArchived && !this.socket.isDisposed) return
    // A thread whose project was deleted can never open. Saying nothing left it
    // stuck on the connecting skeleton forever.
    if (!this.deps.projects().some((p) => p.id === meta.projectId)) {
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
      await this.start(0)
      return
    }
    if (meta.exited) {
      /* Putting a process back is the seconds-long part, exactly as spawning one
         is, and it is worth saying so: without this the thread reads "Reading
         this conversation…" through a wait that is not a read at all. */
      this.apply({ type: "revive-begin" })
      await api(this.deps.settings, `/api/sessions/${this.id}/respawn`, {
        method: "POST",
        body: JSON.stringify({
          profileId: meta.profileId,
          model: meta.model || undefined,
          effort: meta.effort || undefined,
        }),
      })
      await this.deps.refreshSessions()
      if (this.disposed) return
      /* Respawn cleared the server's journal; a saved cursor now points past its
         end. Dropping it makes the attach below a clean `from: 0` rebuild rather
         than leaning on the server's clamp. */
      this.cursor = 0
    }

    await this.start(this.resumeCursor(meta))
  }

  /** Where a reattach picks up. 0 when this device has never folded this
      thread's journal (a fresh connect or a page reload), or when the agent is
      about to be respawned. A value > 0 is the delta: "I already have this
      much; give me the rest." */
  private resumeCursor(meta: SessionMeta): number {
    return meta.exited ? 0 : this.cursor
  }

  /**
   * Read the thread over HTTP, then connect the socket if there is anything live
   * to connect to.
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
   * The archived case is why the socket is conditional: a thread with no agent
   * process has nothing to say on one, and the two things a reader still does to
   * it — paging back, and editing a parked queue — are answered over HTTP or by
   * a socket opened lazily at that moment.
   */
  private async start(cursor: number): Promise<void> {
    /* The HTTP read starts here. `open-begin` deliberately leaves a ladder's
       phase alone (see `reduceConn`): a reconnect attempt *is* an open, and
       while one runs the thread is still recovering rather than merely loading
       — which is what the banner says and what decides whether the composer
       holds the words already typed into it. */
    this.apply({ type: "open-begin" })
    /* Whatever was on this thread before is not this socket, and two sockets on
       one session are two peers folding every event into the same store — which
       is what a duplicated transcript is. */
    this.socket?.close()
    const socket = new ThreadSocket(this.id, this.deps.settings, this.callbacks(() => socket))
    this.socket = socket
    let archived = false
    try {
      ;({ archived } = await socket.load({ cursor }))
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
    if (this.socket !== socket) return
    if (archived) {
      /* Nothing to connect to, and nothing coming — `onCaughtUp` has already
         moved the phase to `archived`, which is a state of its own rather than
         a dressed-up "connected". Sending is what revives it. */
      return
    }
    /* Where the socket picks up: the end of the document, so a turn journaled
       while it was streaming arrives as the delta it is. Read from the cursor
       the fold itself moved rather than from the argument, because it is also
       the right answer when the read failed *part way* — those events are on
       screen, and resuming from before them would fold them a second time. */
    await socket.connect({ cursor: Math.max(cursor, this.cursor) })
  }

  // ---- recovery ----

  /**
   * Reattach, reviving the agent if it is gone.
   *
   * `silent` is the automatic-backoff path: a failed attempt is not worth a
   * transcript row of its own — the ladder reports once, at give-up.
   */
  async reconnect(silent = false, probe?: () => Promise<boolean>): Promise<void> {
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
    /* Always `revive`, on every reconnect path. Opening a thread from the UI may
       serve its archive read-only, but a reconnect never should: the socket
       closed because the process died (or was taken over), and the thread the
       user is looking at was live a moment ago. Attaching to the journal instead
       would turn a crash into a silently read-only thread. */
    await this.open(meta, { revive: true })
  }

  /** Put an agent process back under a thread that has none — the ladder's
      counters cleared first, because this was asked for. */
  async revive(probe?: () => Promise<boolean>): Promise<void> {
    this.clearRecovery()
    await this.reconnect(false, probe)
  }

  private clearRecovery(): void {
    this.attempt = 0
    this.parked = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** Book the next rung, or park. Called by `onStatus` for a close that is
      worth retrying, and re-entered by each failed attempt. */
  scheduleReconnect(lastError: unknown, probe?: () => Promise<boolean>): void {
    if (this.timer || this.disposed) return
    /* Offline, every attempt is a guaranteed failure that burns the budget
       against a network that cannot answer. Park the thread instead — the
       `online` listener retries it the moment there is a network to try. */
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      this.park("There is no network connection.")
      return
    }
    const attempt = this.attempt + 1
    if (attempt > RECONNECT_MAX_ATTEMPTS) {
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
      this.park(info?.title ?? "The server or the agent process is not reachable.")
      return
    }

    this.attempt = attempt
    const backoff = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1), RECONNECT_MAX_DELAY_MS)
    /* Jitter, so every thread a server restart dropped does not knock again in
       the same instant on every device. */
    const delayMs = backoff + Math.random() * backoff * 0.5
    this.apply({
      type: "retry-scheduled",
      attempt,
      nextAt: Date.now() + delayMs,
      reason: lastError ? describeError(lastError).title : undefined,
    })
    this.timer = setTimeout(() => {
      this.timer = null
      void this.attemptReconnect(probe)
    }, delayMs)
  }

  private park(reason?: string): void {
    this.parked = true
    this.apply({ type: "parked", reason, at: Date.now() })
    this.deps.onParked()
  }

  private attemptReconnect(probe?: () => Promise<boolean>): Promise<void> {
    return this.reconnect(true, probe).catch((error) => {
      console.warn(`Reconnecting thread ${this.id} failed`, error)
      this.scheduleReconnect(error, probe)
    })
  }

  /** The network, or the user's attention, came back: reset the counter and try
      once now. A failure re-enters the ladder at rung one. */
  retryNow(probe?: () => Promise<boolean>): void {
    this.clearRecovery()
    void this.attemptReconnect(probe)
  }

  // ---- teardown ----

  /** Drop the socket but keep what this device knows (the cursor above all), so
      re-opening is a delta rather than a rebuild. */
  detach(): void {
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
    this.cursor = 0
  }

  /** The thread is gone, or this whole connection is. Everything device-local
      goes with it — which is the entire point of the object: there is one place
      to forget a thread, and it cannot disagree with itself. */
  destroy(): void {
    this.disposed = true
    this.clearRecovery()
    this.detach()
    this.cursor = 0
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
   * `owner` resolves to the socket these callbacks belong to. A function rather
   * than the socket itself because the callbacks are built *while* constructing
   * it — see the guard in `onStatus`, which is what stops a closing socket from
   * speaking for the one that replaced it.
   */
  private callbacks(owner: () => ThreadSocket): ThreadCallbacks {
    const id = this.id
    const { dispatch, getState } = this.deps
    /* The replay is a few thousand events, and dispatching each one commits a
       render of a transcript nobody has looked at yet — which is what made a
       long thread visibly rebuild itself line by line. So between `attached` and
       `caught_up` the actions go into a list instead.

       Held back until the end, though, it overshot: the screen stayed empty for
       the *whole* replay. So the buffer is committed per `replay` frame
       (`commit`) and only closed at the end (`flush`) — the frame is the
       server's own cut, a handful of them carry a window, and the transcript
       paints from the first one while the rest are still arriving.

       Two rules keep it honest. Everything thread-scoped goes through `send`,
       never `dispatch` — a stray direct dispatch would jump the queue and land
       before the `thread-reset` that is still sitting in the buffer. And any
       exit from the replay flushes: `caught_up` is the ordinary one, a socket
       that dies mid-replay is the other, and without the second the history
       would be dropped on the floor along with the close status. */
    /* Rows this device owns that no journal can produce, held across an attach
       that replaces the transcript. Captured at `attached` and put back at
       `caught_up` — see lib/thread/carry.ts for which rows and why. */
    let carried: ThreadItem[] = []
    /* Whether this attach is serving the journal alone. Read from `attached`,
       where the server states it, and NOT from `ThreadSocket.isArchived`: that
       field is assigned after the whole document has been folded, so at
       `caught_up` — which is where it is needed — it still reads false, and an
       archived thread would sit on `attaching` forever waiting for a socket
       that is never going to be opened. */
    let attachedArchived = false
    let buffer: Action[] | null = null
    const send = (action: Action) => {
      if (buffer) buffer.push(action)
      else dispatch(action)
    }
    /* The one hot dispatch: an agent streams text as dozens of chunks a second,
       and each one is a full state update. Marking it a transition lets React
       treat it as interruptible — a burst of chunks coalesces into the frames
       the display can actually show instead of one render per token. */
    const sendStream = (action: Action) => {
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
      onUpdate: (update, historyReplay, sessionId) =>
        sendStream({ type: "update", id, update, allowUserChunks: historyReplay, sessionId }),
      /* The agent is blocked on this question until somebody answers it. The
         server holds its promise now, so `resolve` is a message rather than a
         callback: it names the request the server minted, which is also how a
         peer's answer is matched against this card. */
      onPermission: (requestId, request) => {
        notifyThreadEvent(
          "permissionNeeded",
          id,
          this.titleOf(),
          request.toolCall?.title ?? undefined
        )
        send({
          type: "permission",
          id,
          permission: {
            requestId,
            request,
            resolve: (response) => {
              send({ type: "permission", id, permission: null })
              owner().answerPermission(requestId, response)
            },
          },
        })
      },
      onElicitation: (requestId, request) => {
        notifyThreadEvent("questionAsked", id, this.titleOf(), request.message)
        send({
          type: "elicitation",
          id,
          elicitation: {
            requestId,
            request,
            resolve: (response) => {
              send({ type: "elicitation", id, elicitation: null })
              owner().answerElicitation(requestId, response)
            },
          },
        })
      },
      /* Somebody else settled this question — another device answered it, or the
         agent's process died holding it. Either way the card is stale and the
         answer is no longer ours to give. */
      onRequestAnswered: (requestId) => {
        const thread = getState().threads[id]
        if (thread?.permission?.requestId === requestId) {
          send({ type: "permission", id, permission: null })
        }
        if (thread?.elicitation?.requestId === requestId) {
          send({ type: "elicitation", id, elicitation: null })
        }
      },
      onStatus: (status, closeInfo) => {
        /* A respawn or a reconnect installs a new socket for this same session
           id while the old one is still closing. The old instance's closing
           status is about a connection nobody is using — letting it through
           marks the live thread dead and, worse, books a reconnect against it. */
        if (this.socket !== owner()) return
        /* Whether this close is the end of the thread's story or an interruption
           in ours. A reconnect always revives and re-folds the transcript, so
           anything left in flight is about to be answered by the server's own
           account of it. */
        const willReconnect =
          status === "closed" &&
          !closeInfo?.clientInitiated &&
          !NON_RECONNECTABLE_CLOSE_CODES.has(closeInfo?.code ?? 0)
        if (status === "connected") {
          this.clearRecovery()
          this.apply({ type: "socket-live" })
        } else if (status === "closed") {
          /* The close first, then the ladder — and the close is a *no-op* on the
             phase when a ladder is going to answer it (`reduceConn`'s
             `socket-closed`). That ordering used to be the bug: `connecting` was
             dispatched by the ladder and `closed` landed on top of it, so a
             thread recovering perfectly well read as dead for the whole of it.
             Here the two cannot argue — one of them has no transition. */
          this.apply({
            type: "socket-closed",
            willReconnect,
            clientInitiated: closeInfo?.clientInitiated,
            reason: closeInfo?.reason,
            code: closeInfo?.code,
          })
          if (willReconnect) {
            // The close frame's reason is the server's own account of what
            // happened ("agent exited (1)") — carry it into the ladder's words.
            this.scheduleReconnect(
              closeInfo?.reason
                ? new Error(`${closeInfo.reason}${closeInfo.code ? ` (${closeInfo.code})` : ""}`)
                : undefined,
              this.probe
            )
          }
        }
        /* A dead socket ends any turn it was carrying. The server does answer
           the prompts an exiting agent never will — but if the close beats the
           `turn_ended` to this tab, the working indicator would outlive the
           process and only a reload would clear it.

           The indicator is all it ends, though: `settle: false` while a
           reconnect is coming, because the turn is the server's and it runs on
           with nobody attached. Settling here is what made a backgrounded phone
           come back to failed tools and disconnected workflow steps that the
           very next attach contradicted. */
        if (status === "closed") {
          send({ type: "turn-active", id, active: false, settle: !willReconnect })
        }
        /* Last, so the status and whatever history was already buffered commit
           together: a close during the replay is the one exit `caught_up` never
           gets to make. */
        if (status !== "connected") flush()
      },
      /* The session's whole settings state, from wherever it changed: the
         handshake, this device, or another one. It is absolute, so applying it
         twice is the same as applying it once. */
      onSessionConfig: (modes, modeId, configOptions) => {
        if (modes !== undefined || configOptions !== undefined) {
          /* Left out means unchanged, and the reducer is what resolves it:
             inside a batched replay this action is not committed yet, so reading
             the current value here would read the thread as it was before the
             replay began. */
          send({ type: "session-config", id, modes: modes ?? null, configOptions })
        } else if (modeId) {
          send({ type: "mode", id, modeId })
        }
        /* Remember what this profile's agent offers. A draft has no process to
           ask, so without this a new thread cannot show a single setting until
           it has already started — see lib/agent-options. */
        const meta = getState().sessions.find((s) => s.id === id)
        if (meta?.profileId && meta.agentId && configOptions && configOptions.length > 0) {
          saveAgentOptions(optionKey(meta.profileId, meta.agentId), configOptions)
        }
      },
      /* The thread was moved to another profile, model or effort with nothing
         restarted. Live-only, so it never arrives inside a replay — and it
         carries the row's own state rather than the agent's, which is why it
         patches the session and not the thread. */
      onSpawnConfig: (profileId, model, effort, personaId) =>
        send({ type: "spawn-config", id, profileId, model, effort, personaId }),
      onTtft: (ms) => send({ type: "ttft", id, ms }),
      onQuota: (quota) => send({ type: "quota", id, quota }),
      onTurnEnded: (usage, error, promptText, catchingUp, continued, turnId) => {
        send({ type: "turn-active", id, active: false })
        if (usage) send({ type: "usage", id, usage, turnId })
        if (error) {
          // Recorded in the transcript either way — a failure that survived a
          // reload is still the answer to the message above it, and carries the
          // text so the row can offer Retry.
          const info = recordThreadError(
            send,
            id,
            error,
            "The agent couldn't answer this message",
            { retryText: promptText }
          )
          /* And on the row, so every list says it too — the transcript is the
             only place a failure was ever visible before, and a thread whose
             last turn failed is one of the two readings worth acting on. Sent
             on a replayed turn as well: folding the log is how a thread this
             device has just opened learns which of its turns was the last one.
             A Stop is not a failure and clears the row like a clean turn. */
          send({
            type: "turn-verdict",
            id,
            error: info.kind === "cancelled" ? null : info.title,
          })
          if (!catchingUp && info.kind !== "cancelled") {
            notifyThreadEvent("turnFailed", id, this.titleOf(), info.title)
          }
        } else {
          send({ type: "turn-verdict", id, error: null })
        }
        if (!error && !catchingUp && !continued) {
          // Notifying on replay would re-announce every turn in the thread on
          // every reload — on a phone, as a push. And not for a turn the queue
          // is about to continue: "finished" would announce a pause that is not
          // there.
          notifyThreadEvent("turnFinished", id, this.titleOf())
        }
      },
      onQueue: (items) => send({ type: "queue", id, items }),
      /* A turn began on words this device did not type — either another peer
         prompted, or this is the replay rebuilding the transcript. Only the
         first is live activity. */
      onTurnStarted: (turnId, text, catchingUp) => {
        send({ type: "user-message", id, text, turnId })
        send({ type: "session-title", id, title: text.slice(0, 60) })
        if (!catchingUp) send({ type: "turn-active", id, active: true })
      },
      /* The replay is about to start. `resumed` decides what happens to what is
         already on screen: a resume is a delta this device asked for and the
         transcript is kept and extended, anything else replaces it. That used to
         be read off `from > 0`, which stopped being enough once the server could
         pick a `from` of its own for a windowed attach — a case where `from` is
         large and the transcript must still be replaced. */
      onAttached: ({ from, to, resumed, earlier, archived }, historyLost) => {
        attachedArchived = archived
        buffer = []
        /* How long this is going to be, before any of it arrives. Zero total
           means the server did not say (one that predates the field), which is
           not the same as a short replay and must not read as one. */
        const total = Math.max(0, to - from)
        this.apply({ type: "attached", total })
        /* Keep what is on screen when resuming; replace it otherwise. A reset
           would throw away the transcript a delta is about to extend, and a
           delta appended onto a stale transcript would double-render whatever
           the server re-sends. The status is left to the socket's `onStatus`
           flow and only committed at `caught_up`; touching it here would race
           the connect() we are inside. */
        if (!resumed) {
          /* Take the rows this device owns out of the transcript before it is
             replaced, and put them back once the replay has landed. Without
             this the reset simply deleted them: the message the user has just
             sent and not yet had acknowledged, and any failure this client had
             recorded — which is exactly how a failed send became an empty
             thread with no explanation in it. */
          carried = carryOf(getState().threads[id]?.items ?? [])
          send({ type: "thread-reset", id, thread: { ...emptyThread, phase: this.phase } })
        }
        send({ type: "thread-window", id, archived, earlier })
        /* The agent would not reload this conversation, so the replay about to
           arrive is empty. Said here rather than left to look like a quiet
           thread — and through `send`, so it lands inside the same fold as the
           (empty) transcript it belongs to rather than ahead of the reset above.
           Repeated on every reattach because the server holds it for as long as
           the process that failed the load is the one running. */
        if (historyLost) {
          recordThreadError(
            send,
            id,
            new AgentError(historyLost.error),
            "Couldn't restore this thread's history"
          )
        }
      },
      /* A frame of history landed. Commit it — the transcript grows a screenful
         at a time instead of appearing whole at the end — and say where the
         replay has got to. */
      onReplayProgress: (done, total) => {
        this.apply({ type: "replay-progress", done, total })
        commit()
      },
      /* The resume point, kept current as the thread streams rather than written
         once at `caught_up` — see `ThreadSocket.cursor` for what the frozen one
         cost. Deliberately not a dispatch: nothing renders from it, and it moves
         at the rate the agent writes. */
      onCursor: (cursor) => {
        this.cursor = cursor
      },
      onCaughtUp: (cursor, promptActive, queue) => {
        this.cursor = cursor
        /* The document (or the socket) reached the end of what it had. An
           archived thread stops here for good — there is no socket coming — and
           everything else is now waiting on one. */
        this.apply({ type: "caught-up", archived: attachedArchived })
        /* Inside the same fold as the transcript they belong to, so they are
           committed with it rather than appearing a frame later on top of a
           thread that had briefly lost them. */
        if (carried.length) {
          send({ type: "thread-carry", id, items: carried })
          carried = []
        }
        if (promptActive) send({ type: "turn-active", id, active: true })
        // Not journaled, so it rides here — the way an open permission is handed
        // over after the replay rather than replayed.
        send({ type: "queue", id, items: queue })
        flush()
      },
      /* A page of older history arrived and the socket is about to fold the
         widened window from the start. Everything but the items is carried over
         rather than reset to `emptyThread`: the agent may be mid-turn or holding
         a question open while someone scrolls back, and a question that vanished
         because the transcript above it grew would be a real loss. Per-step
         usage goes with the items: it is derived from where an update landed in
         the transcript being rebuilt, so carrying the cursor over would have the
         fold's first reading measured against a position from the last one. */
      onRewind: () => {
        buffer = []
        const current = getState().threads[id] ?? emptyThread
        send({
          type: "thread-reset",
          id,
          thread: { ...current, items: [], stepUsage: {}, usageMark: null },
        })
      },
      /* The re-fold is committed as one render. `turnActive` is put back
         afterwards because the fold derives it from the events it saw, and a
         turn this device started itself has no `turn_started` in the log to
         re-derive it from — the prompter is the one peer that never gets one. */
      onRewound: (earlier) => {
        const active = getState().threads[id]?.turnActive ?? false
        send({ type: "thread-window", id, earlier, loadingEarlier: false })
        if (active) send({ type: "turn-active", id, active: true })
        flush()
      },
      // A background task's journal grew server-side. Into the module store, not
      // the reducer: the events are keyed by transcript dir, not by thread, and
      // the panel reading them subscribes there (lib/task-events).
      onTaskEvent: (transcriptDir, event) => {
        appendTaskEvent(transcriptDir, event)
      },
    }
  }
}
