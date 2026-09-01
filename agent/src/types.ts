import type * as acp from "@agentclientprotocol/sdk";

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

export type AnySessionUpdate = acp.SessionUpdate | SubagentSpawned | SubagentStateUpdate;

/** The `session/update` params shape, widened to carry the RFD kinds. */
export interface UpdateParams {
  sessionId: string;
  update: AnySessionUpdate;
  _meta?: Record<string, unknown>;
}
