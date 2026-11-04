import type * as acp from "./acp.js";
import type { ModelCall } from "./trace.js";

/* The Subagent Sessions RFD's own `subagent_update` is in the SDK's
   SessionUpdate union (the `/unstable` entry), so the spawn, the state changes
   and the ending travel as `acp.SessionUpdate`. What ACP has no field for —
   the child's settled usage per attempt, one record per model call — rides
   the harness's own `_daedalus/*` kinds. Outbound notifications are not
   schema-validated, so they travel as plain objects cast at the send site. */
export interface SubagentUsage {
  sessionUpdate: "_daedalus/subagent_usage";
  subagentSessionId: string;
  usage: acp.Usage;
  _meta?: Record<string, unknown>;
}

/** One model call, as `trace.ts` built it — journaled on the session it
    belongs to (a subagent's on the child's). */
export interface ModelCallUpdate {
  sessionUpdate: "_daedalus/model_call";
  call: ModelCall;
  _meta?: Record<string, unknown>;
}

export interface SessionInfoUpdate {
  sessionUpdate: "session_info_update";
  title?: string;
  updatedAt?: string;
}

export type AnySessionUpdate =
  | acp.SessionUpdate
  | SubagentUsage
  | ModelCallUpdate
  | SessionInfoUpdate;

/** The `session/update` params shape, widened to carry the harness's own kinds. */
export interface UpdateParams {
  sessionId: string;
  update: AnySessionUpdate;
  _meta?: Record<string, unknown>;
}
