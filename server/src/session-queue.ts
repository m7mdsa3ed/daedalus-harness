import type { AcpBridge } from "./acp-bridge.js";
import type { AttachmentRef, PromptReply, QueuedMessage, ThreadEvent } from "./protocol.js";
import {
  clearQueue,
  combineQueued,
  enqueue,
  listQueue,
  reorderQueue,
  queuedAttachmentIds,
  removeQueued,
  removeQueuedMany,
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

/** How long a composer steer into a running turn waits as an ordinary queue
    row — editable, removable, Escape's to take back — before it goes out. */
export const STEER_UNDO_MS = 5_000;

/** Rows in their undo window: id -> when it goes out (epoch ms). In memory on
    purpose — a restart drops the window, and the row is then simply queued.
    An entry whose row was edited away is harmless: only listed rows read it. */
const steerDeadlines = new WeakMap<Session, Map<string, number>>();

/** The queue as a peer sees it: the steers the bridge is holding for a step
    boundary first (already sent, flagged `steer`, not editable), then the rows
    waiting for the turn to end — a row in its undo window carrying `steerAt`. */
export async function queueItems(session: Session): Promise<QueuedMessage[]> {
  const deadlines = steerDeadlines.get(session);
  const rows = (await listQueue(session.id)).map((row) => {
    const steerAt = deadlines?.get(row.id);
    return steerAt === undefined ? row : { ...row, steerAt };
  });
  return [...(session.bridge?.heldSteers() ?? []), ...rows];
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
   * Send the OLDEST queued row as its own turn — a real queue, one message per
   * turn, the rest waiting behind it (`continued` re-drains when it ends). Only
   * on an idle bridge — a running turn is what the queue is waiting for.
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
    /* A dead process is checked before any row is claimed: sending to it
       throws, and the claim-then-restore round trip made the queue flicker. */
    if (!bridge || session.exited || bridge.promptActive) return null;
    return this.chain(session, async () => {
      /* Re-read inside the chain: whatever ran ahead of this may have sent some
         of them, and — the case this ordering is for — the thread may have
         started a turn while it did. */
      if (session.bridge !== bridge || session.exited || bridge.promptActive) return null;
      const [head] = await listQueue(session.id);
      if (!head) return null;
      return this.send(session, bridge, [head]);
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

  /**
   * A steer into a running turn, held for `STEER_UNDO_MS` as a queue row and
   * then sent through `steer`. Everything a queued row can do works on it
   * meanwhile — Edit takes it back, Steer sends it now, Escape reclaims it —
   * and whichever of those happened, the timer finds the row gone and stops.
   * A turn that ended inside the window leaves the row where it is: the drain
   * sends it in its place in line, as the next turn.
   */
  async steerSoon(session: Session, text: string, attachments: AttachmentRef[] = []): Promise<PromptReply> {
    const deadlines = steerDeadlines.get(session) ?? new Map<string, number>();
    steerDeadlines.set(session, deadlines);
    const item = await this.chain(session, async () => {
      const row = await enqueue(session.id, text, attachments);
      deadlines.set(row.id, Date.now() + STEER_UNDO_MS);
      await this.emitQueue(session);
      return row;
    });
    setTimeout(() => {
      deadlines.delete(item.id);
      if (!session.bridge?.promptActive || session.exited) {
        void this.emitQueue(session); // the window is over: it reads as queued
        return;
      }
      this.steer(session, item.id).catch((error: unknown) => {
        // "gone" is the common case — edited, sent or reclaimed in the window.
        if (!/is gone/.test(error instanceof Error ? error.message : "")) {
          console.warn(`[queue] ${session.id.slice(0, 8)}: steer after the undo window failed:`, error);
        }
        void this.emitQueue(session);
      });
    }, STEER_UNDO_MS).unref();
    return { queued: true, itemId: item.id };
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

  /** The queue in the order the reader dragged it into. Interrupts nothing:
      the drain takes whichever row is first when the turn ends. On the chain,
      because it rewrites positions `enqueue` reads. */
  async reorder(session: Session, ids: string[]): Promise<void> {
    await this.chain(session, () => reorderQueue(session.id, ids));
    await this.emitQueue(session);
  }

  async clear(session: Session): Promise<void> {
    await clearQueue(session.id);
    await this.emitQueue(session);
  }

  /** Inject one queued item into the running turn without stopping it. */
  steer(session: Session, itemId: string): Promise<{ turnId: string }> {
    return this.chain(session, async () => {
      const bridge = await this.host.whenSpawnable(session);
      const item = (await listQueue(session.id)).find((entry) => entry.id === itemId);
      if (!item) throw new Error("that queued message is gone");
      if (!(await removeQueued(session.id, itemId))) throw new Error("that queued message is gone");
      await this.emitQueue(session);
      try {
        return await this.host.startTurn(session, bridge, item.text, undefined, {
          attachments: item.attachments ?? [],
        });
      } catch (error) {
        await enqueue(session.id, item.text, item.attachments ?? []);
        await this.emitQueue(session);
        throw error;
      }
    });
  }

  /**
   * Stop the running turn, and — with `reclaim` — take back the newest QUEUED
   * row, so the caller can put it back in the composer.
   *
   * A steer still in its undo window IS a queued row, so it is the newest one
   * and Escape takes it back. A held STEER is not the stop's to touch. Its
   * words went out when the window closed, and the runtimes keep them
   * through a cancel — ours persists them as context, Claude's SDK runs them
   * as an orphan turn — so re-queueing one showed the user a message waiting
   * that the agent already had, and then sent it a second time. The cancel
   * settles the turn, `settleTurn` treats that as a step boundary, and
   * `flushSteers` draws the steer as the bubble it is: words the agent got.
   *
   * Atomic and server-side for the reason `sendNow` is: take-back → cancel is
   * two steps, and a browser driving them could take the row back and never
   * send the cancel.
   *
   * `reclaimed` absent means no row was taken: an ordinary stop, or a queue
   * that was empty. Nothing is lost either way.
   */
  async stop(session: Session, reclaim: boolean): Promise<{ reclaimed?: QueuedMessage }> {
    const bridge = session.bridge;
    const reclaimed = reclaim ? await this.takeNewest(session) : null;
    /* The cancel still goes out when nothing was reclaimed: Escape means stop
       first and take back second, never "stop only if there was something to
       take". */
    if (bridge) await bridge.cancel();
    if (reclaimed) await this.emitQueue(session);
    return reclaimed ? { reclaimed } : {};
  }

  /** The newest queued row — the take-back's whole domain. A held steer is
      not one: the agent already has its words (`stop`). */
  private async takeNewest(session: Session): Promise<QueuedMessage | null> {
    const row = (await listQueue(session.id)).at(-1);
    if (!row) return null;
    return (await removeQueued(session.id, row.id)) ? row : null;
  }

  /**
   * Interrupt the running turn and send what is queued — one item, or all of
   * it combined — in its place. `itemIds` picks which rows (in queue order);
   * omitted is all of them. Atomic and server-side for the reason the
   * respawn route is: cancel → wait for the turn to settle → prompt is three
   * steps, and a browser driving them could close halfway and leave a
   * cancelled turn with nothing sent after it. Serialised per thread on
   * `queueChain`, which is also what stands the auto-drain down meanwhile.
   */
  sendNow(session: Session, itemIds?: string[]): Promise<{ turnId: string }> {
    return this.chain(session, () => this.sendNowNow(session, itemIds));
  }

  private async sendNowNow(session: Session, itemIds?: string[]): Promise<{ turnId: string }> {
    const bridge = await this.host.whenSpawnable(session);
    const all = await listQueue(session.id);
    const items = itemIds?.length ? all.filter((item) => itemIds.includes(item.id)) : all;
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
