import type * as acp from "../acp.js";
import type { Session } from "../session.js";
import type { Emitter } from "../updates.js";

/** Everything a tool needs at execute time, built once per turn by turn.ts. */
export interface ToolRuntime {
  ctx: acp.AgentContext;
  session: Session;
  emit: Emitter;
  clientCaps: acp.ClientCapabilities | null;
  /** Runs a nested subagent loop and returns its final report (task tool). */
  runSubagent(name: string, prompt: string): Promise<string>;
}

/* How the transcript should draw a call of this tool: the ACP `kind` picks
   the layout family on the client, `title` is the row's line, `locations`
   feeds follow-along. Content beyond the result text (diffs, terminal
   deltas) is emitted by the tool itself mid-execute. */
export interface ToolMeta {
  kind: acp.ToolKind;
  title(input: unknown): string;
  locations?(input: unknown): acp.ToolCallLocation[];
}

export function inputOf(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}
