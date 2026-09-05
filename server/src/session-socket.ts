import { WebSocket } from "ws";
import { toWireError } from "./acp-bridge.js";
import { queueItems } from "./session-queue.js";
import type { SessionJournal } from "./session-journal.js";
import type { Peer, Session } from "./sessions.js";
import { REPLAY_WINDOW_BYTES } from "./protocol.js";

/* The hold, in the one shape the `paused` event carries it (`AcpBridge.hold`),
   so an attaching peer and a live one can never disagree about why a turn is
   stopped. A thread with no process is not held; it is archived. */
function holdFields(session: Session): { hold?: ThreadHold } {
  const bridge = session.bridge;
  return bridge?.paused ? { hold: bridge.hold() } : {};
}
import type { EarlierPage, PromptReply, ThreadCommand, ThreadEvent, ThreadHold, WireError } from "./protocol.js";

/**
 * What the socket router needs from the SessionManager — a port, so this
 * module owns the wire (the attached/replay/caught_up bracket, the command
 * dispatch, the reply plumbing) without reaching into the manager's process
 * lifecycle. The manager hands over an object literal bound to its own
 * methods; the sessions themselves are shared state (peers, bridge), which is
 * exactly the state the socket exists to serve.
 */
export interface SocketHost {
  getSession(id: string): Session | undefined;
  journal: SessionJournal;
  prompt(
    id: string,
    text: string,
    peer?: Peer,
    opts?: { steer?: boolean; attachmentIds?: string[]; forceLink?: boolean },
  ): Promise<PromptReply>;
  queueAdd(id: string, text: string, attachmentIds?: string[]): PromptReply;
  queueSendNow(id: string, itemId?: string): Promise<{ turnId: string }>;
  queueSteer(id: string, itemId: string): Promise<{ turnId: string }>;
  queueUpdate(id: string, itemId: string, text: string, attachmentIds?: string[]): void;
  queueRemove(id: string, itemId: string): void;
  queueClear(id: string): void;
  enrichError(session: Session, error: WireError): WireError;
}

export class SessionSocket {
  constructor(private host: SocketHost) {}

  /**
   * Write to a peer directly, past its replay buffer.
   *
   * Everything this module sends is either the attach bracket itself
   * (`attached`, `caught_up`) or an answer to something the peer asked for (a
   * `reply`, a handed-over question) — none of which is a live event with a
   * place in the journal's order, and the first of which has to be the very
   * first line on the socket. The buffer exists to keep *fan-out* behind the
   * replay (see `Peer.pending`); putting the bracket through it would hold the
   * `attached` that opens the replay until after the replay had ended.
   */
  private send(peer: Peer, event: ThreadEvent): void {
    peer.ws.send(JSON.stringify(event));
  }

  /**
   * Put one replay frame on the socket and wait for it to be written.
   *
   * This is the whole of the backpressure. `ws.send`'s callback fires when the
   * frame has been flushed to the underlying socket, so awaiting it paces the
   * replay at the speed the client can actually take it — where the loop that
   * did not await handed a slow peer (a phone on cellular, the case windowing
   * exists for) the entire window at once and held it in this process's memory
   * until it drained. It also yields the event loop between frames, which is
   * the half that costs everyone else: one attach to a heavy thread used to
   * run to completion before any other thread's turn got a tick.
   */
  private sendFrame(ws: WebSocket, frame: string): Promise<void> {
    return new Promise((resolve, reject) => {
      ws.send(frame, (error) => (error ? reject(error) : resolve()));
    });
  }

  /**
   * Attach a WebSocket. Replays journaled events from `cursor`, brackets them
   * with `attached`/`caught_up` so the client can tell history from news, then
   * hands over whatever question the agent is currently blocked on.
   *
   * Returns null on success, or why it refused — that string becomes the close
   * reason, and "unknown session" for all three cases was a lie in two.
   */
  async attach(
    id: string,
    ws: WebSocket,
    cursor = 0,
    batch = false,
    opts: { window?: number } = {},
  ): Promise<string | null> {
    const session = this.host.getSession(id);
    if (!session) return "no such thread on this server";
    if (session.deletedAt !== null) return "this thread is in the trash";
    /* A thread with no process is served read-only from its journal — but only
       if there IS one. An archive that was pruned, or a thread from before the
       archive existed, has nothing to show, and replaying nothing would render
       a blank transcript for a conversation that is still sitting in the
       agent's store. That is the case the old refusal was always about, so it
       is still the answer: the client reads it and revives. */
    if (session.exited && session.eventCount === 0) {
      return "this thread has no running agent — revive it first";
    }
    /* Buffered from the very first line: the replay below yields, so a live
       event can be journaled while it is still going out, and it must not
       overtake the history it belongs after (see `Peer.pending`). */
    const peer: Peer = { ws, pending: [] };
    session.peers.add(peer);
    session.detachedAt = null;

    /* Bound before the replay rather than after it, for the same reason. The
       replay is only ever [from, to), and everything from `to` onward reaches
       this peer as a live event — buffered until `caught_up`, then flushed. A
       replay that instead ran to the end of the log would race the buffer and
       send those events twice. */
    const to = session.eventCount;

    /* Both listeners are registered before the first frame, not after the last
       one. The synchronous replay could leave this until the end because
       nothing could arrive during it; an awaited one cannot — a command sent
       before `caught_up` (the client's own liveness ping, at worst a prompt)
       would land on a socket with no `message` listener and simply vanish. The
       handler is safe to run mid-replay: a command's reply is not part of the
       attach bracket, and anything it makes the agent emit is journaled and
       buffered like any other live event. */
    ws.on("message", (data) => this.onCommand(session, peer, data.toString()));
    ws.on("close", () => {
      session.peers.delete(peer);
      // Nothing is ever going to flush this now; a peer that died mid-replay
      // must not keep its share of the window alive in the heap.
      peer.pending = null;
      if (session.peers.size === 0) session.detachedAt = Date.now();
    });

    /* A cursor past the end of the journal means the log shrank under the
       client — a respawn or retirement clears it, and the id the client saved
       is no longer a position in it. Asking for a delta then would append
       nothing onto a transcript the client still believes is current, which is
       worse than the full rebuild it is being asked to avoid. So clamp to 0
       and let `attached.from` tell the truth: `from: 0` is the client's cue to
       reset and rebuild. */
    if (cursor > session.eventCount) cursor = 0;
    const resumed = cursor > 0;

    /* A client that named a window wants the tail, not the thread: an archive
       hundreds of turns long is opened to read the end of it, and paying for
       all of it to look at the last screen is the cost windowing removes. The
       rest stays on the server and is fetched backwards with `load_earlier`.
       The window is counted in **steps** (turns), and the replay starts at the
       `turn_started` of the first step it includes — a transcript that begins
       in the middle of a turn would re-fold into a half turn the reducer has
       never seen opened. `earlier` says how many whole steps were withheld.
       Never applied to a resume — the client is asking for a delta it already
       knows the size of, and windowing that would hide events it is missing.

       Steps are not the whole budget, because a step is not a size: `windowStart`
       cuts on `REPLAY_WINDOW_BYTES` too, whichever binds first. Everything else
       about the cut — that it lands on a turn boundary, that it is made only
       when a turn is genuinely withheld, and that the window reaching the oldest
       turn takes the log's headless start along with it — is that method's, and
       the reasoning is written there. */
    const journal = this.host.journal;
    const window = opts.window && opts.window > 0 ? opts.window : 0;
    const from = resumed ? cursor : journal.windowStart(session.id, window, REPLAY_WINDOW_BYTES);

    this.send(peer, {
      ev: "attached",
      from,
      // Where the replay ends, which is now a real bound on it and not just a
      // reading of the log — so `to - from` is exactly the number of events the
      // client is about to be sent, and the progress bar it draws from that
      // cannot be outrun by a turn streaming while it connects.
      to,
      resumed,
      earlier: resumed ? 0 : journal.countTurnsBefore(session.id, from),
      archived: session.bridge === null,
      acpSessionId: session.liveAcpSessionId ?? session.acpSessionId ?? null,
      ...(session.historyLost ? { historyLost: session.historyLost } : {}),
      /* The rail's whole table of contents, up front: turns whose messages are
         still behind `earlier` need ticks too, and nothing but the journal can
         name them. Omitted on a resume — the client already holds the thread
         and an absent list must not clear it. */
      ...(!resumed ? { turns: journal.turnTicks(session.id) } : {}),
    });
    /* Same events, same order, still inside the bracket — `batch` only decides
       how many frames carry them. One per event is a wake-up, a parse and a
       render each on the client, which is what made a long thread visibly
       rebuild itself; a client that says it can unroll a chunk gets the whole
       replay in a handful of frames instead. Frames come out pre-serialized
       (see `replayFrames`), so they go straight onto the socket. */
    for (const frame of journal.replayFrames(session.id, from, batch, to)) {
      /* The peer went away mid-replay. Without this the generator keeps paging
         SQLite and serializing frames for a socket nobody is on the other end
         of — the whole window, for nothing. */
      if (ws.readyState !== WebSocket.OPEN) return null;
      try {
        await this.sendFrame(ws, frame);
      } catch {
        return null; // socket died under us; `close` has already cleaned up
      }
    }
    if (ws.readyState !== WebSocket.OPEN) return null;
    /* `cursor` is the end of the replay, not the log as it stands now: a turn
       may have run while the archive was going out, and those events are in
       this peer's buffer, about to be sent as the live events they are. Each
       carries its own seq and the client advances its cursor over them, so the
       resume point stays exact either way. */
    this.send(peer, {
      ev: "caught_up",
      cursor: to,
      promptActive: session.bridge?.promptActive ?? false,
      queue: queueItems(session),
      ...holdFields(session),
    });
    /* Caught up: everything held while the replay was on the wire goes out now,
       in the order it was journaled, and from here the peer is live. */
    const held = peer.pending ?? [];
    peer.pending = null;
    for (const line of held) ws.send(line);
    /* An unanswered question is sent whatever the cursor says. A client that
       reloaded reattaches from the END of the log, and the agent is still
       blocked — so without this it would show nothing to answer with. There is
       no filtering to do: an answered request is not in the map. */
    for (const event of session.bridge?.pendingEvents() ?? []) this.send(peer, event);
    return null;
  }

  /**
   * The same attach bracket, as one HTTP document.
   *
   * The bracket, the window, the frames and the `caught_up` line are the
   * socket's — this reuses every one of them, so there is still exactly one
   * replay and one parser. What it does not have is a peer: nothing is
   * registered on the session, nothing is buffered, and a turn journaled while
   * the body streams is simply not in it. That is the point rather than a gap.
   * `caughtUp.cursor` is the `to` this document was bounded at, and the socket
   * the client opens next resumes from exactly there — so the events this read
   * missed arrive as the delta they are, on the connection that can also carry
   * what comes after them.
   *
   * Why a transcript is read over HTTP at all: opening a thread is a read, and
   * a read had to wait for a WebSocket handshake, an attach and a paced stream
   * of frames before the first line of it could be drawn. Over HTTP the browser
   * asks for it on a connection it already holds, the reply compresses in the
   * one place a stream of small frames could not, and the socket that follows
   * is a cheap resume instead of the thing the whole wait was made of. An
   * archived thread needs no socket at all — see `ThreadSocket.load`.
   *
   * The frames come out pre-serialized (`replayFrames`) and are spliced
   * straight into the body, so a replay is still never parsed and re-emitted
   * on this side; and the body is a generator so a long thread streams rather
   * than being held whole here, which is the same budget the socket pays with
   * `sendFrame`.
   */
  snapshot(
    id: string,
    cursor = 0,
    opts: { window?: number } = {},
  ): { refused: string } | { body: Generator<string> } {
    const session = this.host.getSession(id);
    // The three refusals the socket makes, verbatim — the client reads them
    // the same way (a thread with no archive revives instead).
    if (!session) return { refused: "no such thread on this server" };
    if (session.deletedAt !== null) return { refused: "this thread is in the trash" };
    if (session.exited && session.eventCount === 0) {
      return { refused: "this thread has no running agent — revive it first" };
    }
    return { body: this.snapshotBody(session, cursor, opts) };
  }

  private *snapshotBody(
    session: Session,
    cursor: number,
    opts: { window?: number },
  ): Generator<string> {
    const to = session.eventCount;
    // Same clamp as `attach`: a cursor past the end of the log means the log
    // shrank under the client, and `from: 0` is its cue to rebuild.
    if (cursor > to) cursor = 0;
    const resumed = cursor > 0;
    const journal = this.host.journal;
    const window = opts.window && opts.window > 0 ? opts.window : 0;
    const from = resumed ? cursor : journal.windowStart(session.id, window, REPLAY_WINDOW_BYTES);

    const attached: ThreadEvent = {
      ev: "attached",
      from,
      to,
      resumed,
      earlier: resumed ? 0 : journal.countTurnsBefore(session.id, from),
      archived: session.bridge === null,
      acpSessionId: session.liveAcpSessionId ?? session.acpSessionId ?? null,
      ...(session.historyLost ? { historyLost: session.historyLost } : {}),
      // Same table of contents as the socket attach below — see there.
      ...(!resumed ? { turns: journal.turnTicks(session.id) } : {}),
    };
    yield `{"attached":${JSON.stringify(attached)},"frames":[`;
    let first = true;
    for (const frame of journal.replayFrames(session.id, from, true, to)) {
      yield first ? frame : `,${frame}`;
      first = false;
    }
    const caughtUp: ThreadEvent = {
      ev: "caught_up",
      cursor: to,
      promptActive: session.bridge?.promptActive ?? false,
      queue: queueItems(session),
      ...holdFields(session),
    };
    yield `],"caughtUp":${JSON.stringify(caughtUp)}}`;
  }

  /** One page of history, answered without a socket — the HTTP half of
      `load_earlier`, so a thread being read from its archive can page back
      without opening (or reviving) anything. */
  earlierPage(id: string, before: number): EarlierPage | null {
    const session = this.host.getSession(id);
    if (!session || session.deletedAt !== null) return null;
    return this.host.journal.earlierPage(session.id, before);
  }

  private onCommand(session: Session, peer: Peer, line: string): void {
    let command: ThreadCommand;
    try {
      command = JSON.parse(line) as ThreadCommand;
    } catch {
      return; // not JSON — nothing to answer
    }
    /* Answered before the bridge check, and it is the only command that is:
       paging back through history is a read of the journal, and an archived
       thread — one with no process at all — is exactly where someone is doing
       it. Requiring an agent for it would mean spawning one to scroll. */
    /* Liveness, answered before everything for the same reason `load_earlier`
       is answered before the bridge check and then some: the question is about
       the socket, not the agent, so a thread whose process is gone must still
       say it is there — the client reads silence as a dead path and reconnects,
       which for an archived thread would mean spawning an agent to prove a
       WebSocket is open. */
    /* Answered by doing nothing else: it is a statement about the peer, not a
       request of the agent, so — like `ping` — a thread whose process is gone
       must still accept it. No reply, because nothing waits on one. */
    if (command.cmd === "background") {
      peer.background = command.background;
      return;
    }
    if (command.cmd === "ping") {
      this.send(peer, { ev: "reply", id: command.id, result: {} });
      return;
    }
    if (command.cmd === "load_earlier") {
      this.send(peer, { ev: "reply", id: command.id, result: this.host.journal.earlierPage(session.id, command.before) });
      return;
    }
    /* The queue edits, for the same reason: a queue parked on a thread whose
       process is gone is still the user's words, and taking one back should
       not cost a spawn. */
    switch (command.cmd) {
      case "queue_update":
        this.run(session, peer, command.id, async () => {
          this.host.queueUpdate(session.id, command.itemId, command.text, command.attachmentIds);
          return {};
        });
        return;
      case "queue_remove":
        this.run(session, peer, command.id, async () => {
          this.host.queueRemove(session.id, command.itemId);
          return {};
        });
        return;
      case "queue_clear":
        this.run(session, peer, command.id, async () => {
          this.host.queueClear(session.id);
          return {};
        });
        return;
    }
    const bridge = session.bridge;
    if (!bridge) {
      if ("id" in command) {
        this.send(peer, {
          ev: "reply",
          id: command.id,
          error: { code: -32603, message: "this thread has no running agent" },
        });
      }
      return;
    }

    switch (command.cmd) {
      case "answer_permission":
      case "answer_elicitation": {
        // First answer wins. A loser is told directly, so its card clears even
        // though it never saw the winner's broadcast.
        const answered = bridge.answer(command.requestId, command.response, peer);
        if (!answered) this.send(peer, { ev: "request_answered", requestId: command.requestId });
        return;
      }
      case "prompt":
        this.run(session, peer, command.id, () =>
          this.host.prompt(session.id, command.text, peer, {
            steer: command.steer,
            attachmentIds: command.attachmentIds,
            forceLink: command.forceLink,
          }),
        );
        return;
      case "queue_add":
        this.run(session, peer, command.id, async () =>
          this.host.queueAdd(session.id, command.text, command.attachmentIds),
        );
        return;
      case "queue_send_now":
        this.run(session, peer, command.id, () => this.host.queueSendNow(session.id, command.itemId));
        return;
      case "queue_steer":
        this.run(session, peer, command.id, () => this.host.queueSteer(session.id, command.itemId));
        return;
      case "cancel":
        this.run(session, peer, command.id, () => bridge.cancel());
        return;
      case "pause":
        this.run(session, peer, command.id, () => bridge.pause());
        return;
      case "resume":
        this.run(session, peer, command.id, () => bridge.resume());
        return;
      case "set_mode":
        this.run(session, peer, command.id, () => bridge.setMode(command.modeId, peer));
        return;
      case "set_config_option":
        this.run(session, peer, command.id, async () => ({
          configOptions: await bridge.setConfigOption(command.configId, command.value, peer),
        }));
        return;
    }
  }

  /** One command, one reply. Failures carry the agent's stderr, so the browser
      gets the explanation and not just the code. */
  private run(
    session: Session,
    peer: Peer,
    id: number,
    op: () => Promise<unknown>,
  ): void {
    void op().then(
      (result) => this.send(peer, { ev: "reply", id, result }),
      (error: unknown) =>
        this.send(peer, { ev: "reply", id, error: this.host.enrichError(session, toWireError(error)) }),
    );
  }
}
