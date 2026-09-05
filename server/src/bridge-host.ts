import type { BridgeHost } from "./acp-bridge.js";
import type { ThreadEvent } from "./protocol.js";
import { listQueue } from "./queue.js";
import { getProfile } from "./profiles.js";
import { bareModelId } from "./registry.js";
import { enrichError, markTurnStderr } from "./stderr-ring.js";
import { watchers, type Peer, type Session, type SessionEvents, type TurnOutcome } from "./sessions.js";

/**
 * What the bridge-callback adapter needs from the SessionManager — a port,
 * like the socket's (session-socket.ts): the manager hands over an object
 * literal bound to its own methods, and everything else here is either the
 * session's own state or a module the adapter can reach itself (the stderr
 * ring, the queue storage).
 */
export interface BridgeHostOwner {
  emit(session: Session, event: ThreadEvent, except?: Peer): void;
  settleWaiters(session: Session, turnId: string, outcome: TurnOutcome): void;
  refreshQuota(session: Session): void;
  drainQueue(session: Session): unknown;
  emitQueue(session: Session): void;
  persist(session: Session): void;
  events: SessionEvents;
}

/** What the bridge calls back into. One per session, reused across respawns —
    the `session` closure is stable, the bridge inside it is not. */
export function makeBridgeHost(session: Session, owner: BridgeHostOwner): BridgeHost {
  return {
    emit: (event, except) => owner.emit(session, event, except),
    peerCount: () => session.peers.size,
    markTurnStderr: () => markTurnStderr(session),
    enrichError: (error) => enrichError(session, error),
    /* A workflow step never pushes: its question and its turn end belong to
       the run, and a phone told "turn finished" per step would be told it
       five times for one workflow. */
    onPermissionRequest: () => {
      if (!session.parentSessionId) owner.events.onPermissionRequest?.(session);
    },
    onElicitationRequest: () => {
      if (!session.parentSessionId) owner.events.onElicitationRequest?.(session);
    },
    onSessionTitle: (title) => {
      const next = title.trim().slice(0, 200);
      if (!next || (session.title !== "New thread" && session.titleFromPrompt !== session.title)) return;
      session.title = next;
      session.titleFromPrompt = null;
      owner.persist(session);
      owner.emit(session, { ev: "session_title", title: next });
    },
    /* The model's half of the attachment decision (delivery.ts). Read per
       prompt rather than captured at spawn, and that is the point: the model
       and the profile both change on a running agent now, so a queued message
       drained after a live model change must be resolved against the model it
       is actually being sent to. `hasCatalog` is the carve-out — a profile with
       no `models[]` defers to the agent by construction, which is exactly where
       `promptCapabilities` is authoritative. */
    deliveryContext: () => {
      const profile = getProfile(session.profileId);
      const models = profile?.models ?? [];
      if (models.length === 0) return { modalities: undefined, hasCatalog: false };
      const wanted = bareModelId(profile!, session.model);
      const entry = models.find((model) => model.id === wanted || model.id === session.model);
      return { modalities: entry?.modalities, hasCatalog: true };
    },
    autonomy: () => session.autonomy,
    onAutonomyBlocked: () => {
      session.autonomyBlocked += 1;
    },
    hasQueued: () => !session.queueChain && listQueue(session.id).length > 0,
    onHeldSteersChanged: () => owner.emitQueue(session),
    /* The drain runs here, synchronously after `turn_ended` was journaled,
       so the log reads turn_ended(continued) → turn_started(combined). The
       push says "turn finished" only for a turn nothing follows. */
    onTurnSettled: ({ error, interrupted, continued, turnId }) => {
      owner.settleWaiters(session, turnId, { error, interrupted });
      /* A turn is what spends the plan, so it is also what dates the reading.
         Before the `continued` return: a queue draining into the next turn is
         still a turn that just ended, and skipping it would leave a long drain
         showing the number from before any of it. */
      owner.refreshQuota(session);
      if (continued) {
        owner.drainQueue(session);
        return;
      }
      if (watchers(session) === 0 && !session.parentSessionId) owner.events.onTurnEnd?.(session, error);
    },
    /* Two callbacks where there was one, and the gap between them is the
       point — but the gap is about *precedence*, not about whether to write
       anything down. A session the agent has just created exists in its
       memory and nowhere else, so its id is unproven until a turn commits to
       it; withholding it entirely, though, is how a thread killed inside that
       window (a restart, a crash, `tsx watch`) ended up pointing at nothing
       while the agent's rollout sat on disk with the whole conversation in
       it, reachable by no one. So an unproven id IS persisted — flagged
       provisional, which makes it the one id the next `session/new` is
       allowed to replace. A proven id (a load that answered, or a turn that
       committed) is never replaced on the strength of a `session/new`. */
    onAcpSessionId: (acpSessionId, proven) => {
      session.liveAcpSessionId = acpSessionId;
      if (proven) {
        // The agent found this session and read it back: nothing outranks it.
        if (session.acpSessionId === acpSessionId && !session.acpSessionProvisional) return;
        session.acpSessionId = acpSessionId;
        session.acpSessionProvisional = false;
      } else {
        // Fresh session. Take the slot only when what is in it is unproven.
        if (session.acpSessionId && !session.acpSessionProvisional) return;
        session.acpSessionId = acpSessionId;
        session.acpSessionProvisional = true;
      }
      owner.persist(session);
    },
    onSessionDurable: () => {
      const live = session.liveAcpSessionId;
      if (!live) return;
      if (live === session.acpSessionId && !session.acpSessionProvisional) {
        if (session.historyLost) {
          session.historyLost = null;
          owner.persist(session);
        }
        return;
      }
      session.acpSessionId = live;
      session.acpSessionProvisional = false;
      session.historyLost = null; // superseded: this session is the thread now
      owner.persist(session);
    },
    /* Recorded, not broadcast. A load only ever runs inside a spawn, and a
       spawn is either a revive (no peers yet) or a respawn (whose
       `clearEvents` forces every peer to reconnect anyway) — so the peers
       that need to hear it are the ones about to attach, and `attached` is
       where they hear it. Re-sending `attached` to a live peer would reset a
       transcript and then never close the replay it opened. */
    onHistoryLost: (lost) => {
      /* A provisional id never had a turn behind it, so a refusal to load it
         is the agent saying "I never wrote that down" — which is the truth
         about an empty thread, not the loss of a conversation. Reporting it
         would put an error row at the top of every thread that was killed
         before its first turn ever finished. */
      if (session.acpSessionProvisional) return;
      session.historyLost = lost;
    },
    onSpawnStateChange: (next) => {
      /* The agent reports the id it was given, which for Claude Code carries
         the 1M suffix the env template appends. What the row holds is the
         catalog's own id — the one every menu matches against and the one a
         revive resolves the suffix from again. */
      if (next.model !== undefined) {
        session.model = session.profile ? bareModelId(session.profile, next.model) : next.model;
      }
      if (next.effort !== undefined) session.effort = next.effort;
      /* The permission mode a `session/set_mode` just confirmed, or what the
         handshake answered: the row is what a revive with no live process
         restores from, so it always names the last confirmed mode. */
      if (next.modeId !== undefined) session.modeId = next.modeId;
      owner.persist(session);
    },
  };
}
