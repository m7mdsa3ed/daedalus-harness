/* ── One layout per kind of tool ──
   `tools.ts` reads a call; this directory draws it. The split is the same one
   the rest of the transcript keeps: nothing here matches on a vendor tool name
   — it asks `toolViewOf` which view applies and asks the matching `extract*`
   for the fields, so teaching the app about a new runtime's tool is an edit to
   one file rather than to a component tree.

   The views exist because three runtimes describe the same act three ways and
   ACP's `kind` is too coarse to separate them. A checklist arrives as tool
   *input* under `kind: "think"` from Claude Code and `kind: "other"` from
   OpenCode; an MCP call arrives under `kind: "execute"` from Codex, which put
   it in the shell layout; a web search arrives under `kind: "search"`, which
   put prose through a `path:line:` splitter. Each of those was a JSON dump or
   a wrong-shaped pane before it had a view.

   The layouts themselves are grouped by family — `./files.tsx` (shell, read,
   search, edit), `./web.tsx`, `./structured.tsx`, `./subagent.tsx`,
   `./mcp.tsx` — and this file is the one place they are dispatched from, the
   same barrel-over-a-directory shape `lib/tools.ts` has. It is also the public
   face of `@/components/tool-views`: everything the transcript imports is
   either declared or re-exported here. */
import * as React from "react"
import { EditDetail, ReadDetail, RunDetail, SearchDetail, TerminalDetail } from "@/components/tool-views/files"
import { HarnessDetail } from "@/components/tool-views/harness"
import { GenericDetail, McpDetail } from "@/components/tool-views/mcp"
import {
  FindingsDetail,
  PlanProposalDetail,
  QuestionsDetail,
  SkillDetail,
  TodosDetail,
  ToolSearchDetail,
} from "@/components/tool-views/structured"
import { AgentMessageDetail, SubagentDetail } from "@/components/tool-views/subagent"
import { FetchDetail, WebFetchDetail, WebSearchDetail } from "@/components/tool-views/web"
import { CodeBlock, DetailSection, JsonView } from "@/components/tool-parts"
import { extractBackgroundTask, safeJson, toolOutputText, toolViewOf, type ToolView } from "@/lib/tools"
import { useLayoutOptionsContext } from "@/lib/layout-options"
import type { ToolItem } from "@/lib/store"

/* What the rest of the transcript reaches for: the pieces of a view that are
   drawn outside their own step (`thread-items/rows.tsx` puts a subagent's transcript
   between its brief and its report, and `thread-cards.tsx` draws a checklist
   from ACP's plan channel), plus the row-level strips. */
export { TodoList, ToolAnswers } from "@/components/tool-views/structured"
export { McpServerChip, useMcpMark } from "@/components/tool-views/mcp"
export { AskAgentChip, BriefSection, SubagentBrief, SubagentReport } from "@/components/tool-views/subagent"
export { ToolSources } from "@/components/tool-views/web"
export type { McpToolView, McpToolViewProps } from "@/components/tool-views/mcp-registry"

// ─── Dispatch ────────────────────────────────────────────────────────────────

/** Everything a view decides about the step that draws it. One row per member
    of `ToolView`, so the three readers below cannot drift apart and a new view
    is one entry here — the `Record` is what makes forgetting one a type error
    rather than a wrong-shaped pane. */
type ToolViewSpec = {
  /** The body of an expanded step. A component that ignores `active` may say so
      in its own props — width subtyping covers it. */
  Detail: React.ComponentType<{ item: ToolItem; active: boolean }>
  /** Open without being asked. A diff is the point of an edit and a checklist
      is the point of a todo write — collapsed, the only thing worth reading is
      the thing that is hidden. Everything else stays folded: a read or a
      search is a fact. */
  opensByDefault: boolean
  /** Override for "would the expansion have anything in it", when the generic
      input/locations/output answer is wrong for this view. */
  hasDetail?: (item: ToolItem) => boolean
}

const TOOL_VIEWS: Record<ToolView, ToolViewSpec> = {
  edit: { Detail: EditDetail, opensByDefault: true },
  todos: { Detail: TodosDetail, opensByDefault: true },
  terminal: { Detail: TerminalDetail, opensByDefault: false },
  mcp: { Detail: McpDetail, opensByDefault: false },
  harness: { Detail: HarnessDetail, opensByDefault: false },
  subagent: { Detail: SubagentDetail, opensByDefault: false },
  message: { Detail: AgentMessageDetail, opensByDefault: false },
  websearch: { Detail: WebSearchDetail, opensByDefault: false },
  webfetch: { Detail: WebFetchDetail, opensByDefault: false },
  questions: { Detail: QuestionsDetail, opensByDefault: true },
  findings: { Detail: FindingsDetail, opensByDefault: false },
  plan: { Detail: PlanProposalDetail, opensByDefault: true },
  skill: { Detail: SkillDetail, opensByDefault: false },
  toolsearch: { Detail: ToolSearchDetail, opensByDefault: false },
  execute: { Detail: RunDetail, opensByDefault: false },
  read: { Detail: ReadDetail, opensByDefault: false },
  search: { Detail: SearchDetail, opensByDefault: false },
  fetch: { Detail: FetchDetail, opensByDefault: false },
  generic: { Detail: GenericDetail, opensByDefault: false },
}

/**
 * The body of an expanded step.
 *
 * `toolViewOf` decides which layout applies — including the priority between
 * them, which is a judgement (a checklist beats its `think` kind; a terminal
 * beats `execute`) and belongs next to the readers that make it, not here.
 */
export function ToolDetail({ item, active }: { item: ToolItem; active: boolean }) {
  const { Detail } = TOOL_VIEWS[toolViewOf(item)]
  const { showRawToolData } = useLayoutOptionsContext()
  if (!showRawToolData) return <Detail item={item} active={active} />
  return (
    <div className="space-y-2">
      {toolHasDetail(item) && <Detail item={item} active={active} />}
      <RawToolData item={item} />
    </div>
  )
}

/* The call as ACP carried it, under the field names it arrived with — not the
   merged `ToolItem`, whose `toolKind`/`meta` are ours. Every view above reads a
   shape; this is where you check the shape. `terminal` is left out: it is the
   streamed bytes, already the body of a shell step. */
function RawToolData({ item }: { item: ToolItem }) {
  const raw = {
    toolCallId: item.id,
    name: item.name,
    title: item.title,
    kind: item.toolKind,
    status: item.status,
    rawInput: item.rawInput,
    rawOutput: item.rawOutput,
    content: item.content,
    locations: item.locations,
    _meta: item.meta,
  }
  /* The text every rendered result above is drawn from (`toolOutputText`),
     verbatim: in the tree it is one escaped string, `\n` and `\"` and all,
     which is the one place you cannot read what the tool returned. */
  const { text: result, truncated } = toolOutputText(item, 200_000)
  return (
    <>
      <DetailSection label="Raw call">
        <JsonView value={raw} text={safeJson(raw)} preview={1} />
      </DetailSection>
      {result.length > 0 && (
        <DetailSection label={truncated ? "Raw result (first 200,000 characters)" : "Raw result"}>
          <CodeBlock>{result}</CodeBlock>
        </DetailSection>
      )}
    </>
  )
}

/**
 * Whether an expanded step would have anything in it. The row's disclosure
 * affordance is drawn from this, so it has to agree with `ToolDetail` — a
 * chevron that opens an empty box is worse than no chevron.
 *
 * The views that read a call's *input* are why the shared answer is not just
 * "is there output": a checklist, a question and a plan all return nothing at
 * all.
 */
export function toolHasDetail(item: ToolItem): boolean {
  const { hasDetail } = TOOL_VIEWS[toolViewOf(item)]
  if (hasDetail) return hasDetail(item)
  return (
    item.content.length > 0 ||
    item.locations.length > 0 ||
    JSON.stringify(item.rawInput ?? null) !== "null" ||
    toolOutputText(item, 1).text.length > 0
  )
}

/** Steps that open by themselves — the view's own call, plus one cross-view
    rule: a background task is still producing after its turn ends, so folded
    it would be the one live thing on screen and invisible. */
export function toolOpensByDefault(item: ToolItem, expandEdits = false): boolean {
  return (
    (TOOL_VIEWS[toolViewOf(item)].opensByDefault && (toolViewOf(item) !== "edit" || expandEdits)) ||
    extractBackgroundTask(item) !== null
  )
}
