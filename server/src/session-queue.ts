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
  ): { turnId: string; deferred?: boolean };
}

// ---- the queue ----

export class SessionQueue {
  constructor(private host: QueueHost) {}

  /** The whole queue to every peer, the origin included: ids are minted here,
      so no peer's own picture of the list is the one to keep. */
  emitQueue(session: Session): void {
    this.host.emit(session, { ev: "queue", items: listQueue(session.id) });
  }

  /**
   * Combine everything queued into ONE prompt and start a turn on it. Only on
   * an idle bridge with no "send now" mid-flight — that path is about to send
   * some of these rows itself and must not find them gone. Rows are deleted
   * after the prompt is dispatched, so nothing here can lose a message.
   */
  drain(session: Session): { turnId: string } | null {
    const bridge = session.bridge;
    if (!bridge || bridge.promptActive || session.queueChain) return null;
    const items = listQueue(session.id);
    if (items.length === 0) return null;
    const result = this.host.startTurn(session, bridge, combineQueued(items), undefined, {
      attachments: attachmentsOf(items),
    });
    removeQueuedMany(session.id, items.map((item) => item.id));
    this.emitQueue(session);
    return result;
  }

  /** `prompt` from a client that already knows the thread is busy. On an idle
      thread it drains straight away — one path, so a client whose picture of
      the turn was stale still gets its words sent. */
  add(session: Session, text: string, attachments: AttachmentRef[] = []): PromptReply {
    const item = enqueue(session.id, text, attachments);
    this.emitQueue(session);
    return this.drain(session) ?? { queued: true, itemId: item.id };
  }

  /* The three edits need no process: a parked queue on an archived thread is
     edited without spawning an agent to do it. */
  update(session: Session, itemId: string, text: string, attachmentIds?: string[]): void {
    if (!updateQueued(session.id, itemId, text, attachmentIds)) {
      throw new Error("that queued message is gone");
    }
    this.emitQueue(session);
  }

  remove(session: Session, itemId: string): void {
    removeQueued(session.id, itemId);
    this.emitQueue(session);
  }

  clear(session: Session): void {
    clearQueue(session.id);
    this.emitQueue(session);
  }

  /** Inject one queued item into the running turn without stopping it — the
      old steering path (`inflight++`). On an idle thread it simply starts one. */
  async steer(session: Session, itemId: string): Promise<{ turnId: string }> {
    const bridge = await this.host.whenSpawnable(session);
    const item = listQueue(session.id).find((entry) => entry.id === itemId);
    if (!item) throw new Error("that queued message is gone");
    const result = this.host.startTurn(session, bridge, item.text, undefined, {
      attachments: item.attachments ?? [],
    });
    removeQueued(session.id, itemId);
    this.emitQueue(session);
    return result;
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
    const all = listQueue(session.id);
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
    if (session.bridge !== bridge) throw new Error("the agent process is gone");
    const result = this.host.startTurn(session, bridge, combineQueued(items), undefined, {
      attachments: attachmentsOf(items),
    });
    removeQueuedMany(session.id, items.map((item) => item.id));
    this.emitQueue(session);
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
