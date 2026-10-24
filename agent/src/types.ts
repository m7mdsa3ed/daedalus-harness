import type * as acp from "./acp.js";
import type { ModelCall } from "./trace.js";

/* The ACP Subagent Sessions RFD's two update kinds are not in the SDK's
   generated SessionUpdate union yet. Outbound notifications are not
   schema-validated, so they travel as plain objects cast at the send site. */
export interface SubagentSpawned {
  sessionUpdate: "subagent_spawned";
  subagentSessionId: string;
  name: string;
  task?: string;
  capabilities?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface SubagentStateUpdate {
  sessionUpdate: "subagent_state_update";
  subagentSessionId: string;
  state: "completed" | "failed" | "cancelled" | "disconnected";
  _meta?: Record<string, unknown>;
}

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
  | SubagentSpawned
  | SubagentStateUpdate
  | SubagentUsage
  | ModelCallUpdate
  | SessionInfoUpdate;

/** The `session/update` params shape, widened to carry the RFD kinds. */
export interface UpdateParams {
  sessionId: string;
  update: AnySessionUpdate;
  _meta?: Record<string, unknown>;
}
