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

export class SessionQueue {
  constructor(private host: QueueHost) {}

  /** The whole queue to every peer, the origin included: ids are minted here,
      so no peer's own picture of the list is the one to keep. */
  async emitQueue(session: Session): Promise<void> {
    this.host.emit(session, { ev: "queue", items: await queueItems(session) });
  }

  /**
   * Combine everything queued into ONE prompt and start a turn on it. Only on
   * an idle bridge with no "send now" mid-flight — that path is about to send
   * some of these rows itself and must not find them gone. Rows are deleted
   * after the prompt is dispatched, so nothing here can lose a message.
   */
  async drain(session: Session): Promise<{ turnId: string } | null> {
    const bridge = session.bridge;
    if (!bridge || bridge.promptActive || session.queueChain) return null;
    const items = await listQueue(session.id);
    if (items.length === 0) return null;
    const result = await this.host.startTurn(session, bridge, combineQueued(items), undefined, {
      attachments: attachmentsOf(items),
    });
    await removeQueuedMany(session.id, items.map((item) => item.id));
    await this.emitQueue(session);
    return result;
  }

  /** `prompt` from a client that already knows the thread is busy. On an idle
      thread it drains straight away — one path, so a client whose picture of
      the turn was stale still gets its words sent. */
  async add(session: Session, text: string, attachments: AttachmentRef[] = []): Promise<PromptReply> {
    const item = await enqueue(session.id, text, attachments);
    await this.emitQueue(session);
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
   * Stop the running turn, and — with `reclaim` — take back the newest message
   * that has not landed, so the caller can put it back in the composer.
   *
   * Atomic and server-side for the reason `sendNow` is: take-back → cancel is
   * two steps, and a browser driving them could cancel with the words already
   * flushed into the transcript, or take them back and never send the cancel.
   *
   * The take-back happens BEFORE the cancel, and that ordering is the whole
   * mechanism. A cancel settles the turn, and `settleTurn` treats a settle as a
   * step boundary — it calls `flushSteers`, which emits every held steer as the
   * real `turn_started` it was waiting to become. Taken first, the steer is
   * gone before that runs and the bubble never appears; taken after, the words
   * are in the transcript and the composer would be a second copy of them.
   *
   * Exactly one message, because the composer is one box. A steer outranks a
   * queued row only by being newer — the rows are ordered by `createdAt` and
   * the last one is the one the user just sent, which is the one Escape is
   * about. Everything older stays parked with its own Edit and ✕.
   *
   * `reclaimed` absent means nothing was taken: an ordinary stop, or a steer
   * whose step boundary beat this call. Nothing is lost either way — a steer
   * past its boundary is a bubble in the transcript, not a message dropped.
   *
   * ponytail: a QUEUED row never left this server, so taking it back is total.
   * A reclaimed STEER is not: its words went out as a `session/prompt` the
   * moment they were sent, so the runtime has them buffered even though no
   * step read them, and a runtime that keeps that buffer on cancel keeps them
   * as context for the next turn. The harness undoes everything on its own
   * side — no bubble, no journal row, the words back in the box. Making it
   * total needs a withdraw the runtime participates in (an `AgentDef` column,
   * like every other thing the harness believes about a runtime), which is
   * worth building when a doubled steer is actually observed.
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

  /** The newest un-landed message, removed from wherever it lives: a held
      steer is the bridge's, a queued row is the table's. Newest by
      `createdAt`, not by which list it is in — a steer sent into the turn and
      then a second message typed behind it leaves the queued row the newer of
      the two. */
  private async takeNewest(session: Session): Promise<QueuedMessage | null> {
    const rows = await listQueue(session.id);
    const row = rows[rows.length - 1];
    const steer = session.bridge?.newestSteer();
    if (steer && (!row || steer.createdAt >= row.createdAt)) {
      /* `null` if the step boundary emitted it between the peek and here: the
         words landed, and that is an answer — never a reason to reach past it
         and take back some older message the user did not mean. */
      return session.bridge?.takeSteer(steer.id) ?? null;
    }
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
    const ahead = session.queueChain;
    const run = (async () => {
      await ahead?.catch(() => {});
      return this.sendNowNow(session, itemId);
    })();
    session.queueChain = run;
    void run
      .finally(() => {
        if (session.queueChain === run) session.queueChain = null;
      })
      .catch(() => {});
    return run;
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
    const result = await this.host.startTurn(session, bridge, combineQueued(items), undefined, {
      attachments: attachmentsOf(items),
    });
    await removeQueuedMany(session.id, items.map((item) => item.id));
    await this.emitQueue(session);
    return result;
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
