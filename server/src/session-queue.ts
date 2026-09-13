import type { AcpBridge } from "./acp-bridge.js";
import type { AttachmentRef, PromptReply, QueuedMessage, ThreadEvent } from "./protocol.js";
import {
  clearQueue,
  combineQueued,
  enqueue,
  listQueue,
  queuedAttachmentIds,
  removeQueued,
  removeQueuedMany,
  requeueSteers,
  updateQueued,
} from "./queue.js";
import type { Peer, Session } from "./sessions.js";

/**
 * What the queue block needs from the SessionManager — a port, like the
 * socket's (session-socket.ts). Storage is queue.ts's; the two things the
 * manager keeps are the fan-out and the prompt path, and this is exactly
 * those.
 */
export interface QueueHost {
  emit(session: Session, event: ThreadEvent): void;
  /** The bridge a prompt may be put on, once it exists and is ready. */
  whenSpawnable(session: Session): Promise<AcpBridge>;
  startTurn(
    session: Session,
    bridge: AcpBridge,
    text: string,
    peer: Peer | undefined,
    opts?: { attachments?: AttachmentRef[] },
  ): Promise<{ turnId: string; deferred?: boolean }>;
}

// ---- the queue ----

/** The queue as a peer sees it: the steers the bridge is holding for a step
    boundary first (already sent, flagged `steer`, not editable), then the rows
    waiting for the turn to end. */
export async function queueItems(session: Session): Promise<QueuedMessage[]> {
  return [...(session.bridge?.heldSteers() ?? []), ...(await listQueue(session.id))];
}

/** The newest `emitQueue` read per session — see `emitQueue`. Off to the side
    rather than on `Session`, because it is this module's bookkeeping and
    nothing else ever asks. */
const emitTickets = new WeakMap<Session, number>();

export class SessionQueue {
  constructor(private host: QueueHost) {}

  /**
   * The whole queue to every peer, the origin included: ids are minted here, so
   * no peer's own picture of the list is the one to keep.
   *
   * The event is absolute, and its payload is a *read* — so two of them in
   * flight can be delivered in the order their reads finished rather than the
   * order they were asked for, and the peer's last picture is then an older
   * one. Three settings changed in the same breath left the last `queue` event
   * carrying two of the three held rows, permanently. A ticket per session
   * fixes it without serialising anything: a read that is no longer the newest
   * is dropped on arrival, because a newer one is already on its way with
   * everything it would have said.
   */
  async emitQueue(session: Session): Promise<void> {
    const ticket = (emitTickets.get(session) ?? 0) + 1;
    emitTickets.set(session, ticket);
    const items = await queueItems(session);
    if (emitTickets.get(session) !== ticket) return;
    this.host.emit(session, { ev: "queue", items });
  }

  /**
   * Combine everything queued into ONE prompt and start a turn on it. Only on
   * an idle bridge — a running turn is what the queue is waiting for.
   *
   * **Behind the chain rather than refused by it.** A "send now" mid-flight is
   * about to send some of these rows itself, so a drain must not race it — but
   * a drain that gave up on finding one used to be a drain that never happened:
   * the settle that asked for it had already reported `continued`, and nothing
   * asked again. Waiting instead costs one queue operation's latency and is the
   * same answer a moment later, with the rows the other path claimed already
   * gone (`send`).
   */
  async drain(session: Session): Promise<{ turnId: string } | null> {
    const bridge = session.bridge;
    if (!bridge || bridge.promptActive) return null;
    return this.chain(session, async () => {
      /* Re-read inside the chain: whatever ran ahead of this may have sent some
         of them, and — the case this ordering is for — the thread may have
         started a turn while it did. */
      if (session.bridge !== bridge || bridge.promptActive) return null;
      const items = await listQueue(session.id);
      if (items.length === 0) return null;
      return this.send(session, bridge, items);
    });
  }

  /**
   * Claim these rows and send them as one prompt.
   *
   * **Claiming is deleting.** The rows go before the prompt is dispatched, not
   * after, and that ordering is the whole of what makes `hasQueued` — read at
   * every turn end, by a turn that may end in the middle of this — tell the
   * truth. Deleted after dispatch (which was safe while storage was synchronous
   * and the delete could not be interleaved), the turn started *from* these
   * rows found them still in the table when it ended, said the queue follows
   * it, and sent the same combined message a second time.
   *
   * Nothing is lost by going first: a dispatch that throws puts them back. The
   * one thing that changes across that is their order among rows queued
   * meanwhile, since `enqueue` appends.
   *
   * ponytail: restored by re-queueing, not by a transaction — the prompt is on
   * a socket to another process, so there is nothing for a database to roll
   * back with it.
   */
  private async send(
    session: Session,
    bridge: AcpBridge,
    items: QueuedMessage[],
  ): Promise<{ turnId: string }> {
    await removeQueuedMany(session.id, items.map((item) => item.id));
    await this.emitQueue(session);
    try {
      return await this.host.startTurn(session, bridge, combineQueued(items), undefined, {
        attachments: attachmentsOf(items),
      });
    } catch (error) {
      for (const item of items) await enqueue(session.id, item.text, item.attachments ?? []);
      await this.emitQueue(session);
      throw error;
    }
  }

  /** This thread's queue work, one at a time: behind whatever is already
      running, and — for as long as it runs — what stands another drain down
      (`drain` returns null on a thread that has one going). */
  private chain<T>(session: Session, work: () => Promise<T>): Promise<T> {
    const ahead = session.queueChain;
    const run = (async () => {
      await ahead?.catch(() => {});
      return work();
    })();
    session.queueChain = run;
    void run
      .finally(() => {
        if (session.queueChain === run) session.queueChain = null;
      })
      .catch(() => {});
    return run;
  }

  /** `prompt` from a client that already knows the thread is busy. On an idle
      thread it drains straight away — one path, so a client whose picture of
      the turn was stale still gets its words sent. */
  async add(session: Session, text: string, attachments: AttachmentRef[] = []): Promise<PromptReply> {
    /* On the chain, because two messages typed in one breath are two commands
       racing each other to the table, and the queue is an ordered list. The
       socket hands them to us in order and `chain` links synchronously, so the
       order they were sent in is the order they are written in — which is what
       the position column was already trying to say, and could not while both
       inserts were in flight at once.

       The drain is deliberately outside it: `drain` chains too, and a chain
       waiting on itself waits forever. */
    const item = await this.chain(session, async () => {
      const row = await enqueue(session.id, text, attachments);
      await this.emitQueue(session);
      return row;
    });
    return (await this.drain(session)) ?? { queued: true, itemId: item.id };
  }

  /* The three edits need no process: a parked queue on an archived thread is
     edited without spawning an agent to do it. */
  async update(session: Session, itemId: string, text: string, attachmentIds?: string[]): Promise<void> {
    if (!(await updateQueued(session.id, itemId, text, attachmentIds))) {
      throw new Error("that queued message is gone");
    }
    await this.emitQueue(session);
  }

  async remove(session: Session, itemId: string): Promise<void> {
    await removeQueued(session.id, itemId);
    await this.emitQueue(session);
  }

  async clear(session: Session): Promise<void> {
    await clearQueue(session.id);
    await this.emitQueue(session);
  }

  /** Inject one queued item into the running turn without stopping it — the
      old steering path (`inflight++`). On an idle thread it simply starts one. */
  async steer(session: Session, itemId: string): Promise<{ turnId: string }> {
    const bridge = await this.host.whenSpawnable(session);
    const item = (await listQueue(session.id)).find((entry) => entry.id === itemId);
    if (!item) throw new Error("that queued message is gone");
    const result = await this.host.startTurn(session, bridge, item.text, undefined, {
      attachments: item.attachments ?? [],
    });
    await removeQueued(session.id, itemId);
    await this.emitQueue(session);
    return result;
  }

  /**
   * Stop the running turn, and — with `reclaim` — take back the newest QUEUED
   * row, so the caller can put it back in the composer.
   *
   * A held STEER is no longer the take-back's to touch: the steer's promise
   * was "these words run", so the stop keeps the promise instead of revoking
   * it — the words are re-queued (`takeSteers`, `requeueSteers`) and, once the
   * cancelled turn has settled, run as the next turn. The rows are ordinary
   * queue rows from there: editable, removable, drainable, which is the way
   * back a take-back used to be. A stop that ends a turn the user steered
   * words into no longer strands those words as bubbles in an interrupted
   * transcript.
   *
   * Atomic and server-side for the reason `sendNow` is: take-back → cancel →
   * send is three steps, and a browser driving them could cancel with the
   * words already flushed into the transcript, or take them back and never
   * send the cancel.
   *
   * The take-back and the steer conversion happen BEFORE the cancel, and that
   * ordering is the whole mechanism. A cancel settles the turn, and
   * `settleTurn` treats a settle as a step boundary — it calls `flushSteers`,
   * which emits every held steer as the real `turn_started` it was waiting to
   * become. Taken first, the steers are gone before that runs and the bubbles
   * never appear; the re-queued rows are what survive, in the queue where
   * they are visible.
   *
   * `reclaimed` absent means no row was taken: an ordinary stop, or a queue
   * that was empty. Nothing is lost either way.
   *
   * ponytail: a QUEUED row never left this server, so taking it back is total.
   * A re-queued STEER is not: its words went out as a `session/prompt` the
   * moment they were sent, so the runtime has them buffered even though no
   * step read them — and one that keeps that buffer on cancel (this repo's own
   * agent persists it as context) will see the words twice when the next turn
   * runs. Making it total needs a withdraw the runtime participates in (an
   * `AgentDef` column, like every other thing the harness believes about a
   * runtime), which is worth building when a doubled steer is actually
   * observed.
   */
  async stop(session: Session, reclaim: boolean): Promise<{ reclaimed?: QueuedMessage }> {
    const bridge = session.bridge;
    const reclaimed = reclaim ? await this.takeNewest(session) : null;
    /* The cancel still goes out when nothing was reclaimed: Escape means stop
       first and take back second, never "stop only if there was something to
       take". */
    const steered = bridge?.takeSteers() ?? [];
    if (steered.length > 0) {
      await requeueSteers(session.id, steered);
      await this.emitQueue(session);
    }
    if (bridge) await bridge.cancel();
    if (bridge && steered.length > 0) {
      void this.runSteeredAfter(session, bridge, steered).catch((error: unknown) =>
        console.error(`[queue] steered words could not follow the stop`, error),
      );
    }
    if (reclaimed) await this.emitQueue(session);
    return reclaimed ? { reclaimed } : {};
  }

  /** The steered rows' turn, started once the cancelled one has finished
      settling. The rows are claimed by `send` like any drain — re-read from
      the table inside the chain, so rows the user edited or deleted in the
      window are respected, and a queue that a concurrent drain already sent
      (the bridge is busy again) is left to that turn's own settle-drain. */
  private async runSteeredAfter(
    session: Session,
    bridge: AcpBridge,
    steered: QueuedMessage[],
  ): Promise<void> {
    await bridge.whenIdle();
    if (session.bridge !== bridge) return;
    await this.chain(session, async () => {
      if (session.bridge !== bridge || bridge.promptActive) return;
      const ids = new Set(steered.map((item) => item.id));
      const items = (await listQueue(session.id)).filter((item) => ids.has(item.id));
      if (items.length === 0) return;
      await this.send(session, bridge, items);
    });
  }

  /** The newest queued row — the take-back's whole domain. A held steer is
      not one: its words re-queue on the stop instead of coming back to a
      composer (`stop`). */
  private async takeNewest(session: Session): Promise<QueuedMessage | null> {
    const row = (await listQueue(session.id)).at(-1);
    if (!row) return null;
    return (await removeQueued(session.id, row.id)) ? row : null;
  }

  /**
   * Interrupt the running turn and send what is queued — one item, or all of
   * it combined — in its place. Atomic and server-side for the reason the
   * respawn route is: cancel → wait for the turn to settle → prompt is three
   * steps, and a browser driving them could close halfway and leave a
   * cancelled turn with nothing sent after it. Serialised per thread on
   * `queueChain`, which is also what stands the auto-drain down meanwhile.
   */
  sendNow(session: Session, itemId?: string): Promise<{ turnId: string }> {
    return this.chain(session, () => this.sendNowNow(session, itemId));
  }

  private async sendNowNow(session: Session, itemId?: string): Promise<{ turnId: string }> {
    const bridge = await this.host.whenSpawnable(session);
    const all = await listQueue(session.id);
    const items = itemId ? all.filter((item) => item.id === itemId) : all;
    if (items.length === 0) throw new Error("nothing is queued");
    if (bridge.promptActive) {
      await bridge.cancel();
      // The agent answers the cancelled prompt with `stopReason: "cancelled"`,
      // which settles the turn as interrupted — so nothing drains on its own.
      await bridge.whenIdle();
    }
    /* The process may have died while we waited. The rows are untouched, so
       the queue is exactly as the user left it and the next revive still has
       it. */
    if (session.bridge !== bridge)
      throw new Error(
        "This thread's agent process ended while the queue was waiting for it. The queued messages are kept — sending or reviving the thread runs them.",
      );
    return this.send(session, bridge, items);
  }
}

/** A drain is ONE prompt, so it is one attachment set: the rows' lists unioned
    in row order, deduped. `queuedAttachmentIds` does the dedupe by id; the refs
    come back off the items so nothing is re-read. */
function attachmentsOf(items: QueuedMessage[]): AttachmentRef[] {
  const ids = queuedAttachmentIds(items);
  const byId = new Map<string, AttachmentRef>();
  for (const item of items) {
    for (const ref of item.attachments ?? []) if (!byId.has(ref.id)) byId.set(ref.id, ref);
  }
  return ids.flatMap((id) => {
    const ref = byId.get(id);
    return ref ? [ref] : [];
  });
}
