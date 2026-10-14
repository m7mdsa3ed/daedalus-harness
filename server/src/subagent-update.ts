/**
 * The current Subagent Sessions RFD, said in the draft every reader here speaks.
 *
 * SDK 1.6+ carries the RFD's one upsert variant, `subagent_update {sessionId
 * (the child), title?, description?, capabilities?, state?}`, sent on the
 * parent's session — the first for an unknown child announces it, an omitted
 * field is unchanged, and `state` is a snapshot (`running`, `idle` with a
 * stopReason, `requires_action`, `unknown`, `_`-extensions). The adapters still
 * send the superseded draft pair (`subagent_spawned` / `subagent_state_update`),
 * and the bridge, the tracer, the journal and the client tree all read that
 * pair. So the new shape is translated once, on the way in (`agentStream`), and
 * nothing downstream learns a second one — the same bargain the OpenCode feed
 * makes. Old journals keep their shape for free.
 *
 * Stateful per process, because an upsert omits what it does not change: the
 * name and task a spawn must restate, and whether the child was running.
 */
import type { SubagentSpawned, SubagentState, SubagentStateUpdate, SubagentUsage } from "./protocol.js";

/** A draft notification on the parent's session. */
export interface DraftSubagentNotification {
  sessionId: string;
  update: SubagentSpawned | SubagentStateUpdate | SubagentUsage;
}

export interface KnownSubagent {
  name: string;
  task: string;
  running: boolean;
}

interface SubagentUpdate {
  sessionUpdate: "subagent_update";
  sessionId: string;
  title?: string | null;
  description?: string | null;
  capabilities?: { cancel?: unknown } | null;
  state?: { state: string; stopReason?: unknown; usage?: SubagentUsage["usage"] | null } | null;
  _meta?: Record<string, unknown> | null;
}

export const isRfdSubagentUpdate = (update: unknown): update is SubagentUpdate =>
  (update as { sessionUpdate?: unknown } | null)?.sessionUpdate === "subagent_update" &&
  typeof (update as { sessionId?: unknown }).sessionId === "string";

/** `idle` is the draft's ending; how it ended is its stop reason. */
function endingOf(stopReason: unknown): SubagentState {
  if (stopReason === "cancelled") return "cancelled";
  if (stopReason === "error" || stopReason === "refusal") return "failed";
  return "completed";
}

/**
 * The draft notifications one `subagent_update` stands for, in order — none
 * when it changes nothing the draft can say. Updates `known` in place.
 */
export function translateSubagentUpdate(
  parentSessionId: string,
  update: SubagentUpdate,
  known: Map<string, KnownSubagent>,
): DraftSubagentNotification[] {
  const child = update.sessionId;
  const prev = known.get(child);
  const state = update.state?.state;
  /* `requires_action` is a child blocked on a question — still at work.
     `unknown` and an extension state say nothing the draft can, so they keep
     what was known; a child first seen that way is taken to be running. */
  const running =
    state === "running" || state === "requires_action"
      ? true
      : state === "idle"
        ? false
        : (prev?.running ?? true);
  const next: KnownSubagent = {
    name: update.title ?? prev?.name ?? "Subagent",
    task: update.description ?? prev?.task ?? "",
    running,
  };
  known.set(child, next);

  const out: DraftSubagentNotification[] = [];
  const say = (u: DraftSubagentNotification["update"]) =>
    out.push({ sessionId: parentSessionId, update: u });
  /* A spawn upserts on the client and reads as "running", so it is said for a
     child first seen, one whose name or task changed, and one that woke up. */
  const respawn =
    !prev || prev.name !== next.name || prev.task !== next.task || (!prev.running && running);
  if (respawn) {
    say({
      sessionUpdate: "subagent_spawned",
      subagentSessionId: child,
      name: next.name,
      task: next.task,
      capabilities: update.capabilities?.cancel ? { cancel: true } : {},
      ...(update._meta ? { _meta: update._meta } : {}),
    });
  }
  if (!running && (respawn || prev?.running)) {
    /* The turn that just ended, as the cost the client adds up per child —
       said on the transition only, so a restated snapshot is not counted twice. */
    if (update.state?.usage) {
      say({ sessionUpdate: "_daedalus/subagent_usage", subagentSessionId: child, usage: update.state.usage });
    }
    say({
      sessionUpdate: "subagent_state_update",
      subagentSessionId: child,
      state: endingOf(update.state?.stopReason),
    });
  }
  return out;
}

/**
 * OpenCode 2's own child-session extension, said in the same draft pair.
 *
 * `opencode acp` (2.x) sends a child's work on an extension notification —
 * once the client opts in with `clientCapabilities._meta["opencode/child-session-updates"]`
 * (`CLIENT_CAPABILITIES`) — shaped `{rootSessionId, childSessionId,
 * parentSessionId, depth, title?, type, …}`: `type: "status"` with `created`,
 * `running`, `completed`, `interrupted` or `failed`, and `type: "update"`
 * carrying an ordinary `SessionUpdate` (already stamped with
 * `_meta["opencode/child-session"]`, which the client reads as the same owner).
 * It is the RFD sequence in other words, so it becomes exactly that. (1.x
 * sent no children at all; a server-side sidecar read them off its event bus
 * until seed 30.) The method goes out without ACP's
 * `_` prefix (2.0.26, observed live), so it is matched both ways and taken
 * here, before the SDK's router would refuse it.
 */
export const OPENCODE_CHILD_UPDATE_METHODS: ReadonlySet<string> = new Set([
  "opencode/session/child_update",
  "_opencode/session/child_update",
]);

interface OpencodeChildUpdate {
  childSessionId: string;
  parentSessionId: string;
  title?: string;
  type: string;
  status?: string;
  update?: { sessionUpdate: string } & Record<string, unknown>;
}

const OPENCODE_ENDINGS: Record<string, SubagentState> = {
  completed: "completed",
  interrupted: "cancelled",
  failed: "failed",
};

/** The notifications one child update stands for: a draft spawn or ending on
    the parent's session, or the child's own update on the child's session.
    `running` says nothing the draft does not already assume. */
export function translateOpencodeChildUpdate(
  params: unknown,
): { sessionId: string; update: { sessionUpdate: string } & Record<string, unknown> }[] {
  const p = params as Partial<OpencodeChildUpdate> | null;
  if (!p || typeof p.childSessionId !== "string" || typeof p.parentSessionId !== "string") return [];
  if (p.type === "update" && p.update && typeof p.update.sessionUpdate === "string") {
    return [{ sessionId: p.childSessionId, update: p.update }];
  }
  if (p.type !== "status") return [];
  if (p.status === "created") {
    const spawned: SubagentSpawned = {
      sessionUpdate: "subagent_spawned",
      subagentSessionId: p.childSessionId,
      name: p.title || "Subagent",
      task: p.title ?? "",
      capabilities: {},
    };
    return [{ sessionId: p.parentSessionId, update: { ...spawned } }];
  }
  const state = p.status ? OPENCODE_ENDINGS[p.status] : undefined;
  if (!state) return [];
  const ended: SubagentStateUpdate = { sessionUpdate: "subagent_state_update", subagentSessionId: p.childSessionId, state };
  return [{ sessionId: p.parentSessionId, update: { ...ended } }];
}
