/* ── Subagents ── work handed to another agent, plus the nesting metadata that
   says whose work an update is. */
import type { ToolItem } from "../store"
import { asRecord, str, tagText } from "./helpers"
import { isOneOf } from "./naming"

/**
 * Work handed to another agent. All three runtimes have one and none of them
 * agree: Claude Code's `Task`/`Agent` carries `{description, prompt,
 * subagent_type}` and reports as `kind: "think"`, OpenCode's `task` is the
 * same shape, and Codex describes a subagent's *lifecycle* through `_meta`
 * instead — a start/interact/interrupt activity against a thread id, with no
 * prompt on it at all.
 *
 * The prompt is the interesting half and it is long, so it is returned
 * separately from the one-line description rather than concatenated into it.
 */
export interface SubagentCall {
  /** Which agent — `code-reviewer`, or the leaf of Codex's agent path. */
  agentType?: string
  description?: string
  prompt?: string
  model?: string
  /** Codex (legacy) only: `started` | `interacted` | `interrupted`. */
  activity?: string
  /** Codex (legacy): the thread the row is about. On a lifecycle row that is
      the CHILD; on a collaboration row it is the SENDER — the parent — and
      the children are `receiverThreadIds`. */
  threadId?: string
  /** Codex (legacy) collaboration rows: which of the multi-agent tools —
      `spawnAgent`, `sendInput`, `closeAgent`, … */
  tool?: string
  receiverThreadIds?: string[]
  /** Codex (legacy): this row is the child's start — the anchor the other
      rows about the same thread group under. */
  started?: boolean
  /** Claude Code: how long the subagent ran, from its last progress beat. */
  elapsedSeconds?: number
  /** Claude Code: the launch answered at once and the child runs on in the
      background (`toolResponse.status: "async_launched"`) — so the call
      completing says nothing about the child, whose work keeps arriving
      under it. The runtime never says when such a child finishes; see
      `transcript-rows` for how that is read off the transcript. */
  background?: boolean
  /** OpenCode: the child session the task ran in, and how it ended. */
  sessionId?: string
  state?: string
  /** OpenCode: the report, unwrapped from the `<task>` block the runtime
      returns it in — the raw output is that XML. */
  result?: string
}

/**
 * This is a subagent's launch — the row the child's work groups under —
 * rather than merely a row *about* one. The distinction only matters for
 * Codex's legacy lifecycle rows, where "Interact with subagent x" is about a
 * child that "Start subagent x" already introduced.
 */
export function isSubagentLaunch(item: Pick<ToolItem, "title" | "meta" | "rawInput">): boolean {
  const call = extractSubagent(item)
  if (!call) return false
  if (call.activity !== undefined) return call.started === true
  if (call.tool !== undefined) return call.tool === "spawnAgent"
  return true
}

export function extractSubagent(item: Pick<ToolItem, "title" | "meta" | "rawInput" | "rawOutput">): SubagentCall | null {
  const codex = asRecord(asRecord(asRecord(item.meta)?.codex)?.subagent)
  if (codex) {
    const path = str(codex.path)
    const activity = str(codex.activity) ?? undefined
    return {
      agentType: path?.split("/").filter(Boolean).at(-1) ?? undefined,
      activity,
      threadId: str(codex.threadId) ?? undefined,
      started: activity === "started",
    }
  }
  const collab = asRecord(asRecord(asRecord(item.meta)?.codex)?.collaboration)
  const input = asRecord(item.rawInput)
  if (collab) {
    const receivers = collab.receiverThreadIds ?? input?.receiverThreadIds
    return {
      agentType: str(collab.tool) ?? undefined,
      tool: str(collab.tool) ?? undefined,
      prompt: str(input?.prompt) ?? undefined,
      model: str(input?.model) ?? undefined,
      threadId: str(collab.senderThreadId) ?? undefined,
      receiverThreadIds: Array.isArray(receivers)
        ? receivers.filter((id): id is string => typeof id === "string")
        : undefined,
    }
  }
  const claude = asRecord(asRecord(item.meta)?.claudeCode)
  const response = asRecord(claude?.toolResponse)
  if (claude?.subagent !== true && !isOneOf(item, ["task", "agent", "subagent", "dispatch_agent"])) {
    return null
  }
  /* OpenCode wraps the child's report in `<task id state>…<task_result>…`
     and reports the child session in `rawOutput.metadata`; Claude Code's
     `rawOutput` is the report itself. */
  const output = asRecord(item.rawOutput)
  const wrapper = parseTaskWrapper(str(output?.output))
  const model = asRecord(asRecord(output?.metadata)?.model)
  const elapsed = response?.elapsedTimeSeconds
  const background = response?.isAsync === true || response?.status === "async_launched"
  return {
    agentType:
      str(input?.subagent_type) ??
      str(input?.subagentType) ??
      str(input?.agent) ??
      str(response?.subagentType) ??
      undefined,
    description: str(input?.description) ?? undefined,
    prompt: str(input?.prompt) ?? undefined,
    model: str(input?.model) ?? str(model?.modelID) ?? undefined,
    elapsedSeconds: typeof elapsed === "number" ? elapsed : undefined,
    background: background || undefined,
    sessionId: wrapper?.id ?? str(asRecord(output?.metadata)?.sessionId) ?? undefined,
    state: wrapper?.state,
    result: wrapper?.result,
  }
}

/**
 * OpenCode's task output: `<task id="ses_x" state="completed">…<task_result>
 * …</task_result></task>` (or `<task_error>`). Tolerates an unterminated block
 * — the same bargain `TASK_NOTIFICATION_RE` makes — so a report renders while
 * it is still streaming. Null when the text is not that block, which is what
 * lets every other runtime's plain-text report through untouched.
 */
const TASK_WRAPPER_RE = /^\s*<task\b([^>]*)>([\s\S]*?)(?:<\/task>|$)/
const attr = (attrs: string, name: string): string | undefined =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1]

export function parseTaskWrapper(
  text: string | null | undefined
): { id?: string; state?: string; result?: string } | null {
  if (!text) return null
  const match = TASK_WRAPPER_RE.exec(text)
  if (!match) return null
  const body = match[2]
  const result = tagText(body, "task_result") ?? tagText(body, "task_error") ?? body.trim()
  return {
    id: attr(match[1], "id"),
    state: attr(match[1], "state"),
    result: result || undefined,
  }
}

// ─── Nesting ─────────────────────────────────────────────────────────────────

/**
 * The transcript item an update belongs to, when it is a subagent's and not
 * the thread's own — read out of the vendor `_meta` that says so.
 *
 * Two shapes. Claude Code stamps a child's every update with
 * `_meta.claudeCode.parentToolUseId`, the `toolCallId` of the Task that
 * launched it — so the owner is that tool item. OpenCode (from its
 * `acp-subagent-events` branch) projects a child session onto the root with
 * `_meta["opencode/child-session"] = {id, parentID, depth, title}` — no tool
 * call names the child, so the owner is the child session itself, under the
 * same `subagent:<sessionId>` id the store gives a session announced by the
 * ACP subagent RFD. Codex's RFD-native children never come through here: their
 * updates arrive on the child's own session id, which the store reads first.
 *
 * Called from the reducer, the way `applyTerminalMeta` is: the store passes
 * `_meta` through and does not read it.
 */
export function parentToolIdOf(meta: unknown): string | undefined {
  const record = asRecord(meta)
  const claude = str(asRecord(record?.claudeCode)?.parentToolUseId)
  if (claude) return claude
  const opencode = str(asRecord(record?.["opencode/child-session"])?.id)
  if (opencode) return subagentItemId(opencode)
  return undefined
}

/** The item id of a subagent session — the RFD's `subagentSessionId`, or the
    child session OpenCode names in `_meta`. One scheme for both so a `task`
    tool that later reports its child session id can be matched to it. */
export const subagentItemId = (sessionId: string): string => `subagent:${sessionId}`

/**
 * A child tool's title without the parent's name in front of it. OpenCode's
 * projection prefixes every child tool call with the child's title —
 * `Explore: printf hello` — which reads twice inside a rail that is already
 * headed by that name.
 */
/**
 * A harness workflow step. The server stamps every RFD spawn it mirrors for a
 * workflow with `_meta.daedalus.workflow` — which run this session belongs to
 * and which step of it this is — and an ordinary subagent (a Codex RFD child,
 * a Claude Code Task) carries no such meta, so this returning undefined is
 * what keeps those drawing as plain subagent steps. Read from the reducer the
 * way `parentToolIdOf` is: the store passes `_meta` through, never reads it.
 */
export interface WorkflowStepInfo {
  runId: string
  /** The workflow's name — the run's heading, repeated on every step. */
  name: string
  /** This step's name within the definition. */
  step: string
  /** Position in the definition, 0-based, when the server says. */
  index?: number
  total?: number
  /** The phase the step was written under, when the definition had any. */
  phase?: { index: number; name: string }
  /** The whole run's outline — its phases and their step names, in definition
      order. Repeated on every spawn so the card can draw the shape the user
      wrote from the first step on, rather than growing a row per spawn. One
      entry named `null` is a definition that had no phases. */
  plan?: WorkflowPlanPhase[]
}

export interface WorkflowPlanPhase {
  name: string | null
  steps: string[]
}

export function workflowInfoOf(meta: unknown): WorkflowStepInfo | undefined {
  const wf = asRecord(asRecord(asRecord(meta)?.daedalus)?.workflow)
  const runId = str(wf?.runId)
  const name = str(wf?.name)
  const step = str(wf?.step)
  if (!runId || !name || !step) return undefined
  const phase = asRecord(wf?.phase)
  const phaseName = str(phase?.name)
  return {
    runId,
    name,
    step,
    index: typeof wf?.index === "number" ? wf.index : undefined,
    total: typeof wf?.total === "number" ? wf.total : undefined,
    phase:
      phaseName && typeof phase?.index === "number" ? { index: phase.index, name: phaseName } : undefined,
    plan: parsePlan(wf?.plan),
  }
}

/** The outline, defensively: an older server sends none, and a step drawn from
    a plan that is not a list of `{name, steps[]}` would be a card of holes. */
function parsePlan(raw: unknown): WorkflowPlanPhase[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: WorkflowPlanPhase[] = []
  for (const entry of raw) {
    const phase = asRecord(entry)
    if (!phase || !Array.isArray(phase.steps)) return undefined
    out.push({
      name: str(phase.name) ?? null,
      steps: phase.steps.filter((s): s is string => typeof s === "string"),
    })
  }
  return out.length ? out : undefined
}

export function childToolTitle(item: Pick<ToolItem, "title" | "meta">): string {
  const child = asRecord(asRecord(item.meta)?.["opencode/child-session"])
  const prefix = str(child?.title)
  if (prefix && item.title.startsWith(`${prefix}: `)) return item.title.slice(prefix.length + 2)
  return item.title
}
