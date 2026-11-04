/**
 * The harness's canonical subagent shape is the Subagent Sessions RFD's own
 * `subagent_update` — the one the SDK's `SessionUpdate` union carries, so it
 * arrives on the typed path and passes through untouched. Everything that
 * still speaks the superseded draft pair (`subagent_spawned` /
 * `subagent_state_update`: older adapters, OpenCode 2's child extension) is
 * translated INTO it here, once, on the way in, so nothing downstream learns a
 * second shape. The draft pair stays declared in `protocol.ts` because old
 * journals hold it (an old reader is never deleted — docs/protocol.md "AIR")
 * and the workflow engine's own mirror still emits it straight into the
 * journal; the client reads both.
 *
 * `subagent_update {sessionId (the child), title?, description?,
 * capabilities?, state?, cwd?, additionalDirectories?}` is an upsert on the
 * parent's session: the first for an unknown child announces it, an omitted
 * field is unchanged, `null` clears one, and `state` is a whole snapshot
 * (`running`, `idle` with a `stopReason`, `requires_action`, `unknown`, or an
 * `_`-prefixed extension). The draft pair is stateless by comparison — a spawn
 * restates name and task, an ending names its own state — so the translation
 * needs no memory: each draft frame is one whole `subagent_update`.
 *
 * Our own `_daedalus/subagent_usage` is not part of this: it is the harness's,
 * said beside the ending, and stays its own frame.
 */
import type {
  SessionUpdate,
  SubagentDisconnectedState,
  SubagentSpawned,
  SubagentState,
  SubagentStateUpdate,
  SubagentUpdate,
} from "./protocol.js";

/** The one extension state the harness speaks: a draft `disconnected` ending
    has no RFD stop reason (the child was lost, not finished), so it rides the
    RFD's reserved `_` prefix. The client reads the same literal through
    `protocol.ts`'s `SubagentDisconnectedState`. */
export const DISCONNECTED_STATE: SubagentDisconnectedState = "_daedalus/disconnected";

export const isRfdSubagentUpdate = (update: unknown): update is SubagentUpdate =>
  (update as { sessionUpdate?: unknown } | null)?.sessionUpdate === "subagent_update" &&
  typeof (update as { sessionId?: unknown }).sessionId === "string";

/** The draft's ending, as the RFD's `idle` snapshot (or the extension state
    for a child that was lost rather than finished). */
export function endingSnapshot(state: SubagentState): NonNullable<SubagentUpdate["state"]> {
  switch (state) {
    case "completed":
      return { state: "idle", stopReason: "end_turn" };
    case "failed":
      return { state: "idle", stopReason: "error" };
    case "cancelled":
      return { state: "idle", stopReason: "cancelled" };
    case "disconnected":
      return { state: DISCONNECTED_STATE };
  }
}

/** A draft `subagent_spawned`, said as the RFD's announcement: a whole
    snapshot (the draft restates everything), running. The brief the draft
    carried on `prompt` has no RFD field, so it rides `_meta.daedalus.prompt`
    — where our own runtime already puts it. Placement keys are carried only
    when the draft said them: an omitted key is "unchanged" to the RFD too. */
export function spawnToUpdate(update: SubagentSpawned): SubagentUpdate {
  const meta: Record<string, unknown> | null | undefined = update._meta;
  const daedalus =
    meta && typeof meta.daedalus === "object" && meta.daedalus !== null
      ? (meta.daedalus as Record<string, unknown>)
      : undefined;
  const withPrompt =
    update.prompt !== undefined && daedalus?.prompt === undefined
      ? { ...(meta ?? {}), daedalus: { ...(daedalus ?? {}), prompt: update.prompt } }
      : meta;
  return {
    sessionUpdate: "subagent_update",
    sessionId: update.subagentSessionId,
    title: update.name,
    description: update.task,
    capabilities: update.capabilities?.cancel ? { cancel: {} } : {},
    state: { state: "running" },
    ...(update.cwd !== undefined ? { cwd: update.cwd } : {}),
    ...(update.additionalDirectories !== undefined ? { additionalDirectories: update.additionalDirectories } : {}),
    ...(withPrompt !== undefined ? { _meta: withPrompt } : {}),
  };
}

/** A draft `subagent_state_update`, said as the RFD's state snapshot alone —
    a patch that leaves title, brief and placement as they were. */
export function endingToUpdate(update: SubagentStateUpdate): SubagentUpdate {
  return {
    sessionUpdate: "subagent_update",
    sessionId: update.subagentSessionId,
    state: endingSnapshot(update.state),
    ...(update._meta !== undefined ? { _meta: update._meta } : {}),
  };
}

/** The one door: a draft frame becomes the RFD's; anything else is itself. */
export function translateDraftSubagent(update: SessionUpdate): SessionUpdate {
  if (update.sessionUpdate === "subagent_spawned") return spawnToUpdate(update);
  if (update.sessionUpdate === "subagent_state_update") return endingToUpdate(update);
  return update;
}

/** The same, on a notification: the frame's address is untouched. The
    result is the input itself, or the input with its `update` said as the
    RFD's `subagent_update` — an SDK variant the extension path's own type
    excludes, which the return type says rather than hiding behind a cast. The
    caller hands it on to `onUpdate`, which takes both. */
export function translateDraftNotification<T extends { update: SessionUpdate }>(
  notification: T,
): T | (Omit<T, "update"> & { update: SubagentUpdate }) {
  const { update } = notification;
  if (update.sessionUpdate === "subagent_spawned") return { ...notification, update: spawnToUpdate(update) };
  if (update.sessionUpdate === "subagent_state_update") return { ...notification, update: endingToUpdate(update) };
  return notification;
}

/**
 * OpenCode 2's own child-session extension, said as `subagent_update`.
 *
 * `opencode acp` (2.x) sends a child's work on an extension notification —
 * once the client opts in with `clientCapabilities._meta["opencode/child-session-updates"]`
 * (`CLIENT_CAPABILITIES`) — shaped `{rootSessionId, childSessionId,
 * parentSessionId, depth, title?, type, …}`: `type: "status"` with `created`,
 * `running`, `completed`, `interrupted` or `failed`, and `type: "update"`
 * carrying an ordinary `SessionUpdate` (already stamped with
 * `_meta["opencode/child-session"]`, which the client reads as the same owner).
 * It is the RFD sequence in other words, so it becomes exactly that — on the
 * typed path, since `subagent_update` is in the SDK's union. (1.x sent no
 * children at all; a server-side sidecar read them off its event bus until
 * seed 30.) The method goes out without ACP's `_` prefix (2.0.26, observed
 * live), so it is matched both ways and taken in `rewriteInbound`, before the
 * SDK's router would refuse it.
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

/** The notifications one child update stands for: the RFD's announcement or
    ending on the parent's session, or the child's own update on the child's
    session. `running` says nothing the announcement did not already. */
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
    const announced: SubagentUpdate = {
      sessionUpdate: "subagent_update",
      sessionId: p.childSessionId,
      title: p.title || "Subagent",
      description: p.title ?? "",
      capabilities: {},
      state: { state: "running" },
    };
    return [{ sessionId: p.parentSessionId, update: { ...announced } }];
  }
  const state = p.status ? OPENCODE_ENDINGS[p.status] : undefined;
  if (!state) return [];
  const ended: SubagentUpdate = { sessionUpdate: "subagent_update", sessionId: p.childSessionId, state: endingSnapshot(state) };
  return [{ sessionId: p.parentSessionId, update: { ...ended } }];
}
