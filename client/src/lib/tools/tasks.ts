/* ── Background tasks ── work a tool call launched that outlives its turn, and
   the task-notification blocks the harness injects when it finishes. */
import type { TextItem, ThreadItem, ToolItem } from "../store"
import { asRecord, str, tagText } from "./helpers"

/**
 * Work a tool call launched that outlives its turn: the agent keeps running it
 * after the prompt returns and appends progress to a journal on the server's
 * disk. Claude Code's Workflow tool reports the launch through
 * `_meta.claudeCode.toolResponse` — a vendor shape, which is why reading it
 * lives here. The transcript dir is the handle everything else keys on: the
 * server tails `<dir>/journal.jsonl` (`/api/tasks/watch`) and the panel reads
 * the events out of `lib/task-events`.
 */
export interface BackgroundTask {
  transcriptDir: string
  /** The runtime's id for the task — the same id its AIR async-task lifecycle
      is keyed by (`AsyncTaskItem.taskId`). What lets a native workflow run find
      the call that launched it without waiting for the adapter to get around to
      mentioning a `toolCallId`; see `placeNativeWorkflows`. */
  taskId?: string
  runId?: string
  workflowName?: string
  summary?: string
}

export function extractBackgroundTask(item: Pick<ToolItem, "meta">): BackgroundTask | null {
  const claude = asRecord(asRecord(item.meta)?.claudeCode)
  const response = asRecord(claude?.toolResponse)
  const transcriptDir = str(response?.transcriptDir)
  if (!transcriptDir) return null
  return {
    transcriptDir,
    taskId: str(response?.taskId) ?? undefined,
    runId: str(response?.runId) ?? undefined,
    workflowName: str(response?.workflowName) ?? undefined,
    summary: str(response?.summary) ?? undefined,
  }
}

/** One subagent's life in a task journal: `started` opens it, `result` (or
    `error`) closes it. Order of first appearance is the display order. */
export interface TaskAgentRow {
  agentId: string
  done: boolean
  failed: boolean
  result?: unknown
}

export function taskAgentRows(events: { type?: string; agentId?: string; [k: string]: unknown }[]): TaskAgentRow[] {
  const rows = new Map<string, TaskAgentRow>()
  for (const event of events) {
    if (typeof event.agentId !== "string") continue
    const row = rows.get(event.agentId) ?? {
      agentId: event.agentId,
      done: false,
      failed: false,
    }
    if (event.type === "result") {
      row.done = true
      row.result = event.result
    } else if (event.type === "error") {
      row.done = true
      row.failed = true
    }
    rows.set(event.agentId, row)
  }
  return [...rows.values()]
}

/**
 * The end of a background task, as the harness announces it.
 *
 * When the task finishes, the runtime injects a `<task-notification>` block
 * into the conversation as a synthetic *user* turn — the model is meant to
 * read it and carry on. It is not prose and nobody typed it, so left alone it
 * renders as a user bubble full of XML. Parsing it here (vendor shape, same
 * quarantine as everything else in this file) lets the transcript show what
 * actually happened: how many agents ran, which failed, and why.
 *
 * Tolerates an unterminated block so a notification renders while it is still
 * streaming, the same bargain `PROPOSED_PLAN_RE` makes in thread-items.
 */
const TASK_NOTIFICATION_RE = /<task-notification>([\s\S]*?)(?:<\/task-notification|$)/

export interface TaskFailure {
  /** The stage that failed, e.g. `audit:server`. */
  label: string
  message: string
}

export interface TaskNotification {
  taskId?: string
  status?: string
  summary?: string
  /** The task's return value, when it returned one worth showing. */
  result?: string
  failures: TaskFailure[]
  /** The per-agent journal named in the diagnostics — the same directory the
      live panel tails, so the two halves describe one task. */
  transcriptDir?: string
  agentCount?: number
  agentsDone?: number
  agentsError?: number
  subagentTokens?: number
  toolUses?: number
  durationMs?: number
}

const tagNumber = (body: string, name: string): number | undefined => {
  const text = tagText(body, name)
  const value = text === null ? NaN : Number(text)
  return Number.isFinite(value) ? value : undefined
}

/** `[stage] failed: why` — one per line, with wrapped messages continuing. */
const FAILURE_RE = /^\[([^\]]+)\]\s*(?:failed:)?\s*([\s\S]*)$/

export function parseTaskNotification(text: string): TaskNotification | null {
  const match = TASK_NOTIFICATION_RE.exec(text.trim())
  if (!match) return null
  const body = match[1]

  const failures: TaskFailure[] = []
  for (const line of (tagText(body, "failures") ?? "").split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const failure = FAILURE_RE.exec(trimmed)
    if (failure) failures.push({ label: failure[1], message: failure[2].trim() })
    // A message that wrapped onto its own line belongs to the failure above it.
    else if (failures.length > 0) failures[failures.length - 1].message += ` ${trimmed}`
  }

  const usage = tagText(body, "usage") ?? ""
  const journal = /(\/\S+)\/journal\.jsonl/.exec(tagText(body, "diagnostics") ?? "")
  // `null` is the runtime's own word for "the task returned nothing" — showing
  // it would be quoting a placeholder back at the reader.
  const result = tagText(body, "result")
  return {
    taskId: tagText(body, "task-id") ?? undefined,
    status: tagText(body, "status") ?? undefined,
    summary: tagText(body, "summary") ?? undefined,
    result: result && result !== "null" ? result : undefined,
    failures,
    transcriptDir: journal?.[1],
    agentCount: tagNumber(usage, "agent_count"),
    agentsDone: tagNumber(usage, "agents_done"),
    agentsError: tagNumber(usage, "agents_error"),
    subagentTokens: tagNumber(usage, "subagent_tokens"),
    toolUses: tagNumber(usage, "tool_uses"),
    durationMs: tagNumber(usage, "duration_ms"),
  }
}

/** Finding titles out of structured agent results, when they carry any — the
    `{findings: [{title}]}` shape workflow finder/verifier stages return. */
export function taskFindings(rows: TaskAgentRow[]): string[] {
  return rows.flatMap((row) => {
    const findings = asRecord(row.result)?.findings
    if (!Array.isArray(findings)) return []
    return findings
      .map((finding) => str(asRecord(finding)?.title))
      .filter((title): title is string => title !== null)
  })
}


/* ── One workflow agent's own transcript ──
   A native (Claude Code) dynamic workflow keeps its agents inside the CLI: they
   have no session the harness can open and produce no ACP frames, so a step
   drawn from the progress array alone has nothing under it — it says what the
   agent is doing and never what it did. What it did is on the server's disk,
   one `agent-<agentId>.jsonl` beside the run's journal, in the CLI's own record
   format (`/api/tasks/agent` hands the lines back unread; the server does not
   interpret an agent's payloads, so the reading happens here with every other
   vendor shape).

   Turning those records into ordinary `ThreadItem`s is the whole point: a step's
   steps then draw through the same rows, the same tool views and the same rail
   as everything else in the transcript, and nothing downstream learns that this
   worker's history arrived as a file rather than as a stream. */

/** The record shape: an assistant turn carries text, thinking and tool calls;
    a user turn carries the results of those calls. Anything else in the file
    (attachments, meta rows) has no row of its own and is skipped. */
export function workflowAgentItems(events: unknown[]): ThreadItem[] {
  const items: ThreadItem[] = []
  const calls = new Map<string, ToolItem>()
  let n = 0

  for (const raw of events) {
    const record = asRecord(raw)
    const type = str(record?.type)
    const content = asRecord(record?.message)?.content
    if (!Array.isArray(content)) continue

    for (const entry of content) {
      const block = asRecord(entry)
      const kind = str(block?.type)
      if (!block || !kind) continue

      if (type === "assistant" && kind === "text") {
        const text = str(block.text)
        if (text?.trim()) items.push({ kind: "agent", id: `wfa:${n++}`, text } satisfies TextItem)
        continue
      }
      /* A thinking block whose text is empty is a signature-only record — the
         CLI writes one per redacted thought. A row saying nothing is worse than
         no row. */
      if (type === "assistant" && kind === "thinking") {
        const text = str(block.thinking)
        if (text?.trim()) items.push({ kind: "thought", id: `wfa:${n++}`, text } satisfies TextItem)
        continue
      }
      if (type === "assistant" && kind === "tool_use") {
        const id = str(block.id) ?? `wfa:tool:${n++}`
        /* `in_progress` until its result is read below — an agent killed
           mid-call leaves a row that never settles, which is the truth. */
        const call: ToolItem = {
          kind: "tool",
          id,
          title: str(block.name) ?? "tool",
          name: str(block.name) ?? undefined,
          status: "in_progress",
          rawInput: block.input,
          content: [],
          locations: [],
          startedAt: 0,
        }
        calls.set(id, call)
        items.push(call)
        continue
      }
      if (type === "user" && kind === "tool_result") {
        const call = calls.get(str(block.tool_use_id) ?? "")
        if (!call) continue
        call.status = block.is_error === true ? "failed" : "completed"
        call.rawOutput = toolResultText(block.content)
      }
    }
  }
  return items
}

/** A tool result is a string, or the block list the API returns. Only its text
    is kept: an image a worker's tool returned has no row here, and quoting its
    base64 into one would be worse than leaving it out. */
function toolResultText(value: unknown): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  return value
    .map((entry) => str(asRecord(entry)?.text) ?? "")
    .filter(Boolean)
    .join("\n")
}
