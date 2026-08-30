/* ── Reading a tool call ──
   ACP describes a tool call generically: a title, an optional `kind`, and two
   opaque blobs (`rawInput`, `rawOutput`) whose shape is the runtime's business,
   not the protocol's. Rendering a shell run as a shell run — command on a `$`
   line, stream underneath — means looking inside those blobs.

   Everything here is best-effort inference, and it is all in one place so that
   "the client knows too much about agents" stays quarantined rather than
   spreading through the transcript components. The rule: read `kind` first
   (that IS protocol), fall back to the tool's name only when the agent did not
   send one, and return null rather than guessing when neither answers.

   Ported from /var/www/mawared-off/social-live-agent/ai-agent-web.

   This file is the barrel over `lib/tools/` — every call site imports from
   here, and the modules underneath import each other (helpers ← naming ← the
   extractors ← view, never the reverse). */

export type { ToolKind } from "./tools/naming"
export {
  toolNameOf,
  toolKindOf,
  toolLeafName,
  parseMcpToolName,
  toolDisplayName,
  toolIdentity,
} from "./tools/naming"

export type { ToolHeading } from "./tools/heading"
export {
  shortPath,
  toolTarget,
  toolDescription,
  toolHeading,
  toolPrimaryText,
} from "./tools/heading"

export type { CommandSegment } from "./tools/shell"
export { splitCommand, toolLanguage } from "./tools/shell"

export type { EditInputDiff } from "./tools/edits"
export { extractEditInput, extractEdits, diffStats } from "./tools/edits"

export { stringifyOutput, toolOutputText, toolFailed } from "./tools/output"

export type {
  BackgroundTask,
  TaskAgentRow,
  TaskFailure,
  TaskNotification,
} from "./tools/tasks"
export {
  extractBackgroundTask,
  taskAgentRows,
  parseTaskNotification,
  taskFindings,
} from "./tools/tasks"

export type { TerminalState } from "./tools/terminal"
export { applyTerminalMeta, hasTerminalContent } from "./tools/terminal"

export type { TodoEntry } from "./tools/todos"
export { extractTodos } from "./tools/todos"

export type { McpCall } from "./tools/mcp"
export { extractMcpCall } from "./tools/mcp"

export type { SubagentCall } from "./tools/subagents"
export {
  isSubagentLaunch,
  extractSubagent,
  parseTaskWrapper,
  parentToolIdOf,
  subagentItemId,
  childToolTitle,
} from "./tools/subagents"

export type { WebResult, WebSearchCall, WebFetchCall } from "./tools/web"
export {
  displayUrl,
  hostOf,
  webInput,
  parseWebResults,
  extractWebSearch,
  extractWebFetch,
} from "./tools/web"

export type { ToolQuestion, ToolFinding, SkillLoad } from "./tools/structured"
export {
  extractQuestions,
  extractFindings,
  extractPlanProposal,
  extractPlanProposalFromPermission,
  extractSkill,
  searchFlags,
} from "./tools/structured"

export type { ToolView } from "./tools/view"
export { toolSummary, toolViewOf } from "./tools/view"
