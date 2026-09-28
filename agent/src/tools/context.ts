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
  runSubagent(name: string, prompt: string, toolCallId?: string): Promise<string>;
  /** Lists this session's persisted subagents. */
  listSubagents(): Array<{ id: string; name: string; task: string; status: string }>;
  /** Sends a follow-up to a subagent, resuming its saved conversation if needed. */
  sendMessage(agent: string, message: string): Promise<string>;
}

/* How the transcript should draw a call of this tool: the ACP `kind` picks
   the layout family on the client, `title` is the row's line, `locations`
   feeds follow-along. Content beyond the result text (diffs, terminal
   deltas) is emitted by the tool itself mid-execute. */
export interface ToolMeta {
  kind: acp.ToolKind;
  title(input: unknown): string;
  locations?(input: unknown): acp.ToolCallLocation[];
  /* This tool's work is already announced as a session of its own — the
     subagent RFD's `subagent_spawned`, which carries the name, the brief and
     the child's whole transcript. Its ACP tool row is then the same subagent
     said twice: a row holding the brief as `rawInput` and the report as its
     content, drawn beside the card that holds both. So the row is not sent
     while the client is listening to the RFD, and Claude Code's shape — one
     card per child, the launch and the work in the same place — is ours too.
     Only while it is listening: with no RFD there is no card, and the row is
     the only trace the child ever ran. A *failure* is always sent, whole
     (`tool_call`, not an update the client has no row to fold into), because
     the state event says a child failed and never why. */
  announcesOwnSession?: boolean;
}

export function inputOf(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

/* What a tool may hand the *model*. Deliberately not `turn.ts`'s
   `OUTPUT_CONTENT_LIMIT`, which is an order of magnitude smaller and governs
   only what the transcript draws: the display clamp made a 116MB grep result
   look like a tidy 30k row while the next request carried the whole thing and
   the gateway answered with something that was not JSON. A cap on what is
   drawn is not a cap on what is sent. */
export const TOOL_OUTPUT_LIMIT = 200_000;

/* Applied to every tool's result on the way out (`buildTools`), so a new tool
   — or an MCP server nobody here wrote — cannot be the one that blows the
   request up. A non-string result is left whole while it fits, because an MCP
   tool's structured content is a shape its reader knows; over the limit it is
   already fatal, so a note the model can act on beats a body the provider
   rejects. */
export function clampToolOutput(output: unknown): unknown {
  if (typeof output === "string") {
    if (output.length <= TOOL_OUTPUT_LIMIT) return output;
    return `${output.slice(0, TOOL_OUTPUT_LIMIT)}\n[output truncated: ${output.length} bytes total. Narrow the call — a path, a glob, or fewer lines.]`;
  }
  if (output === null || output === undefined) return output;
  let encoded: string;
  try {
    encoded = JSON.stringify(output) ?? "";
  } catch {
    return output; // circular or otherwise unserialisable: not ours to judge
  }
  if (encoded.length <= TOOL_OUTPUT_LIMIT) return output;
  return `${encoded.slice(0, TOOL_OUTPUT_LIMIT)}\n[output truncated: ${encoded.length} bytes total. Narrow the call.]`;
}
