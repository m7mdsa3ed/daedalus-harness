/**
 * The pause/hold protocol — the harness's own extension methods and the shapes
 * they carry. ACP has no pause: its only interruption is `session/cancel`,
 * which throws the step in flight away. This runtime owns its loop, so it can
 * stop at a step boundary and carry on with nothing lost.
 *
 * Two things hold that loop, and they are the same wait for different reasons:
 * the user's pause, and a **turn that failed**. A provider error — a rate
 * limit, an exhausted quota, a key that stopped working — used to end the turn
 * and throw away every tool call it had already made. Held instead, the turn
 * waits at the boundary while the user changes the model or the profile (which
 * the harness can do live, mid-turn) and then carries on from the next model
 * step. Nothing recovers on its own; the release is always the user's.
 *
 * Named in this leaf module rather than in `app.ts` because `turn.ts` sends the
 * outbound notification and `app.ts` serves the inbound pair — importing either
 * from the other would be a cycle. The server's `acp-bridge.ts` spells the same
 * strings from its side.
 */

export const PAUSE_METHOD = "_daedalus/session/pause";
export const RESUME_METHOD = "_daedalus/session/resume";
/** Agent → client. The one direction the pause pair never had: a hold this end
    took on its own, which the harness could not otherwise learn about. */
export const PAUSED_NOTIFICATION = "_daedalus/session/paused";
export const PAUSE_CAPABILITY = "daedalus/pause";

/** Why the loop is holding. `"user"` is the pause toggle; `"error"` is a turn
    that failed and is waiting to be told what to try instead. */
export type HoldReason = "user" | "error";

/** A turn that failed and is waiting. `message` is the sentence to show;
    `detail` is the provider's own account of it, for the fold. */
export interface ErrorHold {
  message: string;
  detail?: string;
}

/** How a hold ended. Never a throw: a cancel has to end the turn as
    `stopReason: "cancelled"`, and an exception here would end it as a failure. */
export type Release = "released" | "cancelled";

export interface PauseResponse {
  paused: boolean;
  /** Whether a turn is open — what the pause is holding, or what the next
      prompt will meet at its first step. */
  turnActive: boolean;
}

export interface PausedNotification {
  sessionId: string;
  paused: boolean;
  reason?: HoldReason;
  message?: string;
  detail?: string;
}
