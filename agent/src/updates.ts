import type * as acp from "./acp.js";
import type { SessionStore } from "./persistence.js";
import type { AnySessionUpdate, UpdateParams } from "./types.js";

/* One emitter per turn: sends `session/update` notifications and writes the
   same params into the session's log, which is exactly what `session/load`
   replays. `record()` persists without notifying (the user's own prompt: the
   harness draws it itself live, but a load replay has to say it).
   `childId` re-addresses an update to a subagent session per the RFD; it is
   persisted too, so a load replays the children in place. */
export class Emitter {
  private ctx: acp.AgentContext;
  private store: SessionStore;
  sessionId: string;
  /** Set on a subagent's emitter: every update is addressed to the child session. */
  childId: string | null;
  /** When false (subagent fallback), nothing notifies — updates are journal-only. */
  live: boolean;

  constructor(ctx: acp.AgentContext, sessionId: string, store: SessionStore, live = true) {
    this.ctx = ctx;
    this.store = store;
    this.sessionId = sessionId;
    this.childId = null;
    this.live = live;
  }

  /** An emitter for a subagent: same log, updates addressed to the child. */
  asChild(childId: string, live: boolean): Emitter {
    const child = new Emitter(this.ctx, this.sessionId, this.store, live);
    child.childId = childId;
    return child;
  }

  private params(update: AnySessionUpdate, childId?: string): UpdateParams {
    return { sessionId: childId ?? this.childId ?? this.sessionId, update };
  }

  async update(update: AnySessionUpdate, childId?: string): Promise<void> {
    const params = this.params(update, childId);
    this.store.appendUpdate(this.sessionId, params);
    if (!this.live) return;
    /* Outbound notifications are not schema-validated by the SDK, which is
       what lets the RFD subagent kinds travel on the same method. */
    await this.ctx.notify("session/update", params as acp.SessionNotification);
  }

  /** Persist-only: journaled for load replay, never notified live. */
  record(update: AnySessionUpdate, childId?: string): void {
    this.store.appendUpdate(this.sessionId, this.params(update, childId));
  }

  /** Writes the compaction barrier + summary message into the session's log. */
  storeCompaction(summary: import("ai").ModelMessage): void {
    this.store.appendCompaction(this.sessionId);
    this.store.appendMessages(this.sessionId, [summary]);
  }

  /** Live-only: notified but not journaled (live progress like terminal deltas). */
  async transient(update: AnySessionUpdate, childId?: string): Promise<void> {
    if (!this.live) return;
    await this.ctx.notify("session/update", this.params(update, childId) as acp.SessionNotification);
  }
}
