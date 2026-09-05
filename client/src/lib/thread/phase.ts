/**
 * What this device's connection to one thread is doing — the whole vocabulary,
 * as data.
 *
 * It replaces a four-value `status` (`idle | connecting | connected | closed`)
 * that could not describe what the app actually does. Reading a transcript over
 * HTTP, folding a replay, opening the socket behind it, spawning an agent,
 * sitting out a backoff rung and having given up waiting were all "connecting"
 * or all "closed", so every surface that wanted to say something specific had to
 * guess from a second field — and two of them guessed wrong in ways nobody could
 * see from the code:
 *
 * - a thread in the reconnect ladder read `closed`, because `scheduleReconnect`
 *   dispatched `connecting` and `onStatus` then dispatched `closed` over the top
 *   of it. So the composer locked and the "this thread is dead" banner showed for
 *   the whole of a recovery that was going fine.
 * - the replay bar's total was sent and then thrown away in the same batch,
 *   because `thread-reset` carried `emptyThread` (whose `replay` is null) and the
 *   reducer's `batch` is a left fold.
 *
 * Both are ordering bugs between two writers of one field. Here there is one
 * writer (`ThreadConnection.setPhase`) and one total function deciding what a
 * given event does to a given phase, so an event that arrives late cannot
 * overwrite a state that has moved on: `reduceConn` simply does not have a
 * transition for it.
 *
 * Deliberately NOT the turn. Whether the agent is working is orthogonal to
 * whether we are attached — a turn runs on with nobody watching, which is the
 * whole reason `settle: false` exists — so `turnActive` stays its own field and
 * the reading a list row shows is composed from both (`markFor`).
 */
export type ConnPhase =
  /** Never opened on this device: a draft, or a row nothing has asked for. */
  | { kind: "idle" }
  /** `POST /api/sessions` is in flight — the server is spawning the agent and
      running the ACP handshake, which is the seconds-long part. */
  | { kind: "starting" }
  /** `POST …/respawn` is in flight — putting a process back under a thread. */
  | { kind: "reviving" }
  /** `GET …/replay` is in flight; nothing has been folded yet. */
  | { kind: "loading" }
  /** Folding the transcript. `total` is 0 when the server did not state one,
      which is not the same as a short replay and must not read as one. */
  | { kind: "replaying"; done: number; total: number }
  /** Transcript folded; the socket is opening and resuming from the cursor. */
  | { kind: "attaching" }
  /** Attached and caught up. The only phase in which a command goes straight
      out. */
  | { kind: "live" }
  /** Read from the journal, with no agent process behind it. Not a failure —
      sending revives. */
  | { kind: "archived" }
  /** The transcript is read and up to date, and this device holds no socket —
      by design, not by failure. Opening a thread is a read (`GET …/replay`),
      and a read needs no peer: the socket is what a *message* needs, so it is
      opened by `ready()` at the moment one is sent. Everything a reader still
      does to a thread in this state — paging back, editing a parked queue — is
      answered over HTTP or by a socket opened lazily for it. Distinct from
      `archived`, which says the agent is gone: here it may well be running,
      we are simply not listening. */
  | { kind: "read" }
  /** In the ladder. `attempt` of `max`; `nextAt` is when the next rung fires,
      so a surface can count down rather than spin. */
  | { kind: "reconnecting"; attempt: number; max: number; nextAt: number; reason?: string }
  /** The ladder is spent, or there is no network. Retries itself when the
      network, the tab or the health poll says the world is back. */
  | { kind: "parked"; reason?: string; since: number }
  /** Nothing a retry can fix by itself. `recover` says what the button offers. */
  | {
      kind: "failed"
      title: string
      reason: string
      detail?: string
      recover: "revive" | "reconnect" | "none"
    }
  /** In Trash on the server. Terminal until a restore. */
  | { kind: "deleted" }

export const IDLE_PHASE: ConnPhase = { kind: "idle" }

/**
 * Whether two phases say the same thing.
 *
 * `reduceConn` builds a fresh object per transition, so identity is not the
 * question — a thread re-attaching to the same archive would otherwise dispatch
 * `{kind:"archived"}` over `{kind:"archived"}` and re-render every surface
 * reading it for no news at all. Compared field by field because two of the
 * kinds carry numbers that genuinely move (`replaying`'s progress, the ladder's
 * attempt), and those must not be flattened into "unchanged".
 */
export function samePhase(a: ConnPhase, b: ConnPhase): boolean {
  if (a === b) return true
  if (a.kind !== b.kind) return false
  if (a.kind === "replaying" && b.kind === "replaying")
    return a.done === b.done && a.total === b.total
  if (a.kind === "reconnecting" && b.kind === "reconnecting")
    return a.attempt === b.attempt && a.nextAt === b.nextAt && a.reason === b.reason
  if (a.kind === "parked" && b.kind === "parked")
    return a.reason === b.reason && a.since === b.since
  if (a.kind === "failed" && b.kind === "failed")
    return a.title === b.title && a.reason === b.reason && a.recover === b.recover
  return true
}

/** Everything that can happen to a connection, from every source: the store,
    the socket, the ladder's own timer, and the routes the user's actions call. */
export type ConnEvent =
  | { type: "open-begin" }
  | { type: "create-begin" }
  | { type: "revive-begin" }
  | { type: "attached"; total: number }
  | { type: "replay-progress"; done: number; total: number }
  /** The snapshot document ended: either there is no socket coming (archived)
      or one is opening behind it. */
  | { type: "caught-up"; archived: boolean }
  /** The HTTP read finished and no socket is being opened for it. */
  | { type: "read" }
  /** The socket said `caught_up`. */
  | { type: "socket-live" }
  | {
      type: "socket-closed"
      willReconnect: boolean
      /** We asked for this close (a respawn, a detach, a socket being replaced).
          A close we caused says nothing about the thread and must not be read as
          one that happened to us — see `reduceConn`. */
      clientInitiated?: boolean
      reason?: string
      code?: number
    }
  | { type: "retry-scheduled"; attempt: number; nextAt: number; reason?: string }
  | { type: "parked"; reason?: string; at: number }
  | { type: "failed"; title: string; reason: string; detail?: string; recover: "revive" | "reconnect" | "none" }
  | { type: "deleted" }
  /** The connection was dropped on purpose (a respawn, a teardown). */
  | { type: "detached" }

export const RECONNECT_MAX_ATTEMPTS = 5

/** Phases that mean "on its way to being live" — the ones a surface draws as a
    wait rather than as a state. */
export function isOpening(phase: ConnPhase): boolean {
  return (
    phase.kind === "starting" ||
    phase.kind === "reviving" ||
    phase.kind === "loading" ||
    phase.kind === "replaying" ||
    phase.kind === "attaching"
  )
}

/**
 * The transition table, total and pure.
 *
 * The `default: return phase` at the end is not a formality — it is the whole
 * guarantee. Events arrive from four sources on their own clocks, and a socket's
 * `closed` landing after the ladder has already booked a rung must leave the
 * ladder alone. A machine that ignores what it has no transition for cannot have
 * that argument; two dispatchers writing one field always will.
 */
export function reduceConn(phase: ConnPhase, event: ConnEvent): ConnPhase {
  switch (event.type) {
    case "create-begin":
      return { kind: "starting" }
    case "revive-begin":
      return { kind: "reviving" }
    case "open-begin":
      /* A reconnect attempt is an open, and while it runs the thread is still
         *recovering* rather than merely loading — the difference is what the
         banner says and whether the composer's words are held. Keeping the
         ladder's phase here is what stops a rung from looking like a fresh
         open every few seconds.

         `starting` and `reviving` are the same rule for the same reason: the
         open that follows a create or a respawn POST is the second half of ONE
         wait, and letting it overwrite them made a new thread say "Spawning the
         agent…", then "Reading this conversation…" about a conversation that
         does not exist yet, then "Connecting…" — three lines for one uninterrupted
         second. The transitions that mean something still land on top: `attached`
         moves to `replaying`/`attaching` whatever this says, so a revive whose
         `session/load` really is streaming a long transcript still shows the
         bar. */
      return phase.kind === "reconnecting" ||
        phase.kind === "parked" ||
        phase.kind === "starting" ||
        phase.kind === "reviving"
        ? phase
        : { kind: "loading" }
    case "attached":
      /* A resume with nothing behind it — the ordinary case for the socket that
         follows an HTTP read — is not a replay and must not be drawn as one. It
         goes straight to `attaching`, which is what it actually is. */
      if (event.total > 0) return { kind: "replaying", done: 0, total: event.total }
      /* …unless we are still in the one wait a create or a respawn opened. There
         is nothing to replay (a thread created a second ago has no transcript),
         so the attach is not a stage the reader has any use for — it is the tail
         of "starting the agent", and naming it separately makes the same second
         read as two. A replay with something in it still wins, above. */
      return phase.kind === "starting" || phase.kind === "reviving" ? phase : { kind: "attaching" }
    case "replay-progress":
      // Only while replaying: a frame arriving after the bracket closed (a
      // re-fold that was superseded) must not reopen a bar that is over.
      return phase.kind === "replaying"
        ? { kind: "replaying", done: event.done, total: event.total }
        : phase
    case "caught-up":
      if (event.archived) return { kind: "archived" }
      /* Only from a replay. The socket raises `connected` *before* it hands the
         `caught_up` frame to the fold (see `ThreadSocket.connect`), so on the
         live path this event arrives after `socket-live` — and treating it as a
         transition would knock an attached thread back to `attaching` and leave
         it there, because nothing else was ever going to say `connected` again. */
      return phase.kind === "replaying" || phase.kind === "loading"
        ? { kind: "attaching" }
        : phase
    case "read":
      /* Only out of the read itself. A socket that has since attached (a send
         landing while the document was still folding) outranks a statement
         about the document, and every terminal state below is one this must not
         reopen. */
      return phase.kind === "attaching" || phase.kind === "loading" || phase.kind === "replaying"
        ? { kind: "read" }
        : phase
    case "socket-live":
      return { kind: "live" }
    case "socket-closed":
      /* A close we asked for is not news. `reconnect` and `start` both drop the
         socket they are replacing, and the `close` event lands asynchronously —
         so this arrived mid-revive, was read as a connection that had died, and
         marked the thread `failed` on its way to reviving it. */
      if (event.clientInitiated) return phase
      /* A close that a ladder is going to answer is not a state of its own: the
         `retry-scheduled` or `parked` event that follows says what is happening,
         and letting the close land first is exactly how a recovering thread came
         to read `closed`. A close nobody will answer is a failure, and its words
         come from `failureFor`. */
      if (event.willReconnect) return phase
      return failureFor(event.code, event.reason)
    case "retry-scheduled":
      return {
        kind: "reconnecting",
        attempt: event.attempt,
        max: RECONNECT_MAX_ATTEMPTS,
        nextAt: event.nextAt,
        reason: event.reason,
      }
    case "parked":
      return { kind: "parked", reason: event.reason, since: event.at }
    case "failed":
      return {
        kind: "failed",
        title: event.title,
        reason: event.reason,
        detail: event.detail,
        recover: event.recover,
      }
    case "deleted":
      return { kind: "deleted" }
    case "detached":
      // Deliberately not a failure: a socket we closed on purpose says nothing
      // about the thread, and the next open starts from `idle` as it should.
      return { kind: "idle" }
    default:
      return phase
  }
}

/**
 * What a dead socket means, in words, keyed on the code the server closed with.
 *
 * The codes are the server's (see server/src/sessions.ts): 4000 killed, 4001
 * agent exited, 4002 replaced by another connection, 4004 unknown thread, 4100
 * this client's own watchdog. Anything else — `undefined`, or a bare 1006 — is a
 * socket that closed with no word from the server at all: the server process
 * went away, or the network did. That case used to be filed under "the agent
 * process exited", which named a cause the client had no evidence for and sent
 * people looking at the agent when the server had just rebooted.
 */
/**
 * Close codes that say something about the *thread*, not about the path to it.
 *
 * A socket dying for any other reason — a bare 1006, no code at all, or this
 * client's own watchdog giving up on a silent path — is the connection's
 * problem and the connection's to solve: `ThreadConnection` books the ladder
 * rather than leaving a dead banner in front of a thread that is very likely
 * still there. These four are the ones a retry cannot help with, because the
 * process is gone (4000, 4001), the thread is not the server's any more (4004),
 * or another device is deliberately holding it (4002) — reattaching to that one
 * is a fight between two tabs, and the user says who wins.
 */
const NON_RECONNECTABLE_CLOSE_CODES = new Set([4000, 4001, 4002, 4004])

/**
 * Whether a close is one this device should answer by reattaching, on its own.
 *
 * The rule this narrows still holds: nothing *respawns* an idle-retired agent
 * behind the reader's back. An automatic attempt asks for the thread as it is —
 * a live process gets a socket, a retired one reads its journal — and only a
 * send (or the button) puts a process back.
 */
export function isRecoverableClose(code: number | undefined): boolean {
  return code === undefined || !NON_RECONNECTABLE_CLOSE_CODES.has(code)
}

export function failureFor(code: number | undefined, reason?: string): ConnPhase {
  if (code === 4002) {
    return {
      kind: "failed",
      title: "This connection was taken over",
      reason: "Another device attached to this thread — reconnect to take it back.",
      recover: "reconnect",
    }
  }
  if (code === 4000 || code === 4004) {
    return {
      kind: "failed",
      title: "This thread is no longer running",
      reason: "The conversation is restored when the agent is revived.",
      detail: reason,
      recover: "revive",
    }
  }
  if (code === 4001) {
    return {
      kind: "failed",
      title: "The agent process exited",
      reason: "The conversation is restored when the agent is revived.",
      detail: reason,
      recover: "revive",
    }
  }
  return {
    kind: "failed",
    title: "Lost the connection to the server",
    reason: "It may have restarted. Reconnecting picks the thread back up.",
    detail: reason,
    recover: "reconnect",
  }
}

/* ── What each surface draws ─────────────────────────────────────────────── */

/**
 * Whether the composer takes words, and whether it will send them yet.
 *
 * The two are separate because the answer is usually "yes, and hold them". A
 * thread that is reconnecting, parked or archived should still accept typing —
 * refusing words the user has already written is the bug, not the safety — and
 * the only phases that genuinely cannot take a message are the ones where there
 * is nothing to send it to and no way to get one.
 *
 * `submittable: false` while a thread is opening is the other half, and it is
 * what stops the double-POST: the composer was fully live during a draft's
 * `starting` phase, so a second Enter re-entered `send`, found the row still
 * flagged as a draft, and POSTed the same session id again.
 */
export function composerLock(
  phase: ConnPhase,
  draft: boolean
): { typable: boolean; submittable: boolean; note?: string } {
  /* A draft has no connection to be waiting on — until its first message gives
     it one. `idle` is the whole of "nothing is in flight", and the moment the
     create POST starts the phase is `starting` and the rules below apply, which
     is exactly what stops a second Enter from creating the same thread twice. */
  if (draft && phase.kind === "idle") return { typable: true, submittable: true }
  switch (phase.kind) {
    case "starting":
      return { typable: true, submittable: false, note: "Starting the agent…" }
    case "reviving":
      return { typable: true, submittable: false, note: "Restarting the agent…" }
    case "loading":
    case "replaying":
    case "attaching":
      return { typable: true, submittable: false, note: "Opening this thread…" }
    case "deleted":
      return { typable: false, submittable: false, note: "This thread is in Trash." }
    case "failed":
      return phase.recover === "none"
        ? { typable: false, submittable: false, note: phase.reason }
        : { typable: true, submittable: true }
    default:
      return { typable: true, submittable: true }
  }
}

export interface ConnBanner {
  tone: "info" | "warn" | "error"
  title: string
  message: string
  action?: { label: string; busyLabel: string; kind: "revive" | "reconnect" | "restore" }
}

/**
 * The one line a thread says about its own connection, above the composer.
 *
 * `parked` is here rather than in the transcript, and that is a move: the ladder
 * used to write an error *row* when it gave up. But giving up is a state that
 * ends on its own — the health poll un-parks it — and a state that ends on its
 * own must not leave a row behind saying it happened. A banner can disappear;
 * a transcript row is a permanent record of a temporary condition, one per
 * outage, in the middle of a conversation.
 */
export function bannerFor(phase: ConnPhase): ConnBanner | null {
  switch (phase.kind) {
    case "reconnecting":
      return {
        tone: "warn",
        title: `Reconnecting — attempt ${phase.attempt} of ${phase.max}`,
        message: phase.reason ?? "The connection to this thread dropped.",
        action: { label: "Reconnect now", busyLabel: "Reconnecting…", kind: "reconnect" },
      }
    case "parked":
      return {
        tone: "warn",
        title: "Waiting for the server",
        message: `${phase.reason ?? "The server or the agent process is not reachable."} This reconnects on its own once the server answers.`,
        action: { label: "Retry now", busyLabel: "Reconnecting…", kind: "reconnect" },
      }
    case "failed":
      return {
        tone: "error",
        title: phase.title,
        message: phase.reason,
        action:
          phase.recover === "revive"
            ? { label: "Revive", busyLabel: "Reviving…", kind: "revive" }
            : phase.recover === "reconnect"
              ? { label: "Reconnect", busyLabel: "Reconnecting…", kind: "reconnect" }
              : undefined,
      }
    case "deleted":
      return {
        tone: "error",
        title: "This thread is in Trash",
        message: "Restore it to open it again.",
        action: { label: "Restore", busyLabel: "Restoring…", kind: "restore" },
      }
    default:
      return null
  }
}

/**
 * The one reading a list row, a dock tab or a project card shows.
 *
 * There used to be two unrelated types called `ThreadStatus` — this connection
 * status, and an activity reading (`idle | running | waiting`) declared in
 * `components/sidebar/thread-row.tsx` and derived from `turnActive` alone. The
 * second could not see the first at all, so a thread whose socket had died
 * thirty seconds ago and was mid-backoff read "Idle" in every list on screen.
 */
export type ThreadActivity =
  | "idle"
  | "running"
  | "waiting"
  | "failed"
  | "connecting"
  | "reconnecting"
  | "offline"
  | "stopped"
  | "gone"

/**
 * Precedence, most interrupting first: a question the user has to answer beats
 * everything, a thread that is gone beats a thread that is merely stopped, and a
 * turn that is running beats the transient phases — because a reconnect during a
 * turn is still, to the reader, a turn.
 *
 * `failed` is the last turn's verdict rather than a state of the connection, so
 * it is read *after* every phase and after `turnActive`: a thread already
 * working again is running, whatever the turn before it did, and a thread whose
 * process has died says the louder of the two things wrong with it. It still
 * outranks `connecting`, because opening a thread is not news about it and the
 * failure is the reason someone is opening it.
 */
export function markFor(
  phase: ConnPhase,
  turnActive: boolean,
  waiting: boolean,
  failed = false
): ThreadActivity {
  if (waiting) return "waiting"
  if (phase.kind === "deleted") return "gone"
  if (phase.kind === "failed") return "stopped"
  if (phase.kind === "parked") return "offline"
  if (phase.kind === "reconnecting") return "reconnecting"
  if (turnActive) return "running"
  if (failed) return "failed"
  if (isOpening(phase)) return "connecting"
  if (phase.kind === "archived") return "stopped"
  return "idle"
}

/**
 * The line at the foot of a transcript that is not ready yet, and the bar under
 * it when there is a number behind the wait.
 *
 * Each phase says what it is actually doing, where the old line inferred a stage
 * from `draft` plus the presence of a replay total and got it wrong in both
 * directions: it said "Spawning the agent…" for a draft that was already past
 * the spawn, and it blamed "a long conversation" for a wait that was frequently
 * the network.
 */
export function startingLine(
  phase: ConnPhase
): { text: string; bar?: { done: number; total: number } } | null {
  switch (phase.kind) {
    case "starting":
      return { text: "Spawning the agent…" }
    case "reviving":
      return { text: "Restarting the agent…" }
    case "loading":
      return { text: "Reading this conversation…" }
    case "replaying":
      return {
        text: "Loading this conversation…",
        bar: phase.total > 0 ? { done: phase.done, total: phase.total } : undefined,
      }
    case "attaching":
      return { text: "Connecting…" }
    case "reconnecting":
      return { text: `Reconnecting — attempt ${phase.attempt} of ${phase.max}…` }
    default:
      return null
  }
}

/** The phase in words, for a message a person is going to read (and report). */
export function describePhase(phase: ConnPhase): string {
  switch (phase.kind) {
    case "idle":
      return "unopened"
    case "starting":
      return "waiting for the agent to spawn"
    case "reviving":
      return "waiting for the agent to restart"
    case "loading":
      return "reading the conversation"
    case "replaying":
      return `folding the conversation (${phase.done}/${phase.total})`
    case "attaching":
      return "opening the connection"
    case "live":
      return "attached but without a usable connection"
    case "archived":
      return "reading from the archive with no agent running"
    case "read":
      return "read, with no socket open"
    case "reconnecting":
      return `reconnecting (attempt ${phase.attempt} of ${phase.max})`
    case "parked":
      return "waiting for the server to come back"
    case "failed":
      return `stopped: ${phase.title}`
    case "deleted":
      return "in the trash"
  }
}

/** The second line a wait is allowed to add once it has gone on long enough to
    need explaining. Null when the phase already carries a number. */
export function slowLine(phase: ConnPhase): string | null {
  switch (phase.kind) {
    case "starting":
    case "reviving":
      return "Still starting — the first launch of an agent can take a while."
    case "loading":
    case "attaching":
      return "Still connecting — the server hasn't sent this thread's history yet."
    default:
      return null
  }
}
