import type { WebSocket } from "ws";
import { toWireError } from "./acp-bridge.js";
import { listQueue } from "./queue.js";
import type { SessionJournal } from "./session-journal.js";
import type { Peer, Session } from "./sessions.js";
import type { PromptReply, ThreadCommand, ThreadEvent, WireError } from "./protocol.js";

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
  prompt(id: string, text: string, peer?: Peer, opts?: { steer?: boolean }): Promise<PromptReply>;
  queueAdd(id: string, text: string): PromptReply;
  queueSendNow(id: string, itemId?: string): Promise<{ turnId: string }>;
  queueSteer(id: string, itemId: string): Promise<{ turnId: string }>;
  queueUpdate(id: string, itemId: string, text: string): void;
  queueRemove(id: string, itemId: string): void;
  queueClear(id: string): void;
  enrichError(session: Session, error: WireError): WireError;
}

export class SessionSocket {
  constructor(private host: SocketHost) {}

  private send(peer: Peer, event: ThreadEvent): void {
    peer.ws.send(JSON.stringify(event));
  }

  /**
   * Attach a WebSocket. Replays journaled events from `cursor`, brackets them
   * with `attached`/`caught_up` so the client can tell history from news, then
   * hands over whatever question the agent is currently blocked on.
   *
   * Returns null on success, or why it refused — that string becomes the close
   * reason, and "unknown session" for all three cases was a lie in two.
   */
  attach(
    id: string,
    ws: WebSocket,
    cursor = 0,
    batch = false,
    opts: { window?: number } = {},
  ): string | null {
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
    const peer: Peer = { ws };
    session.peers.add(peer);
    session.detachedAt = null;

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

       The cut is only made when there is genuinely something to withhold
       (`skip > 0`). Jumping to the first `turn_started` unconditionally looks
       equivalent and is not, because a log does not have to begin with one: a
       revive clears the journal and refills it from the `session/load` replay,
       which is the whole prior conversation with no turn boundaries in it, and
       the first `turn_started` is then the turn the user typed *after* the
       revive. So a thread of one turn, well inside any window, replayed from
       that seq and dropped everything the load had put back — `earlier` said 0
       (there are no whole turns behind it), so nothing offered it back either.
       A crash-and-revive lost the conversation on screen while every event of
       it sat in the table. */
    const journal = this.host.journal;
    const window = opts.window && opts.window > 0 ? opts.window : 0;
    const skip = window ? journal.turnCount(session.id) - window : 0;
    const from = resumed ? cursor : skip > 0 ? journal.turnStartAt(session.id, skip) ?? 0 : 0;

    this.send(peer, {
      ev: "attached",
      from,
      resumed,
      earlier: resumed ? 0 : journal.countTurnsBefore(session.id, from),
      archived: session.bridge === null,
      acpSessionId: session.liveAcpSessionId ?? session.acpSessionId ?? null,
      ...(session.historyLost ? { historyLost: session.historyLost } : {}),
    });
    /* Same events, same order, still inside the bracket — `batch` only decides
       how many frames carry them. One per event is a wake-up, a parse and a
       render each on the client, which is what made a long thread visibly
       rebuild itself; a client that says it can unroll a chunk gets the whole
       replay in a handful of frames instead. Frames come out pre-serialized
       (see `replayFrames`), so they go straight onto the socket. */
    for (const frame of journal.replayFrames(session.id, from, batch)) peer.ws.send(frame);
    // Read in the same tick as the log it follows, so a client can't pair a
    // stale turn state with a fresh replay window (or vice versa).
    this.send(peer, {
      ev: "caught_up",
      cursor: session.eventCount,
      promptActive: session.bridge?.promptActive ?? false,
      queue: listQueue(session.id),
    });
    /* An unanswered question is sent whatever the cursor says. A client that
       reloaded reattaches from the END of the log, and the agent is still
       blocked — so without this it would show nothing to answer with. There is
       no filtering to do: an answered request is not in the map. */
    for (const event of session.bridge?.pendingEvents() ?? []) this.send(peer, event);

    ws.on("message", (data) => this.onCommand(session, peer, data.toString()));
    ws.on("close", () => {
      session.peers.delete(peer);
      if (session.peers.size === 0) session.detachedAt = Date.now();
    });
    return null;
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
          this.host.queueUpdate(session.id, command.itemId, command.text);
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
          this.host.prompt(session.id, command.text, peer, { steer: command.steer }),
        );
        return;
      case "queue_add":
        this.run(session, peer, command.id, async () => this.host.queueAdd(session.id, command.text));
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
