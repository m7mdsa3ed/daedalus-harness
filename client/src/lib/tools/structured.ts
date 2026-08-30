/* ── Questions, findings, plans, skills ── the structured calls a runtime's
   workflow tools make, plus the flags a repo search ran with. */
import type * as acp from "@agentclientprotocol/sdk"
import type { ToolItem } from "../store"
import { asRecord, str } from "./helpers"
import { isOneOf } from "./naming"

/**
 * The questions an `AskUserQuestion` call is asking.
 *
 * This is the *record* of a question, not the live one — a question the user
 * still has to answer arrives as an `elicitation/create` request and is drawn
 * by `elicitation-form.tsx`. What lands in the transcript afterwards is the
 * tool call, and left generic it renders as a nested JSON blob of the exact
 * thing the user was just shown a form for.
 */
export interface ToolQuestion {
  question: string
  header?: string
  multiSelect?: boolean
  options: { label: string; description?: string }[]
}

export function extractQuestions(item: Pick<ToolItem, "title" | "meta" | "rawInput">): ToolQuestion[] | null {
  if (!isOneOf(item, ["askuserquestion", "ask_user_question", "question", "ask"])) return null
  const raw = asRecord(item.rawInput)?.questions
  if (!Array.isArray(raw)) return null
  const questions = raw.flatMap((entry) => {
    const record = asRecord(entry)
    const question = str(record?.question)
    if (!question) return []
    const options = Array.isArray(record?.options)
      ? record.options.flatMap((option) => {
          const opt = asRecord(option)
          const label = str(opt?.label)
          return label ? [{ label, description: str(opt?.description) ?? undefined }] : []
        })
      : []
    return [{
      question,
      header: str(record?.header) ?? undefined,
      multiSelect: record?.multiSelect === true,
      options,
    }]
  })
  return questions.length > 0 ? questions : null
}

/** A `ReportFindings` call: a review's results, which are a table and not prose. */
export interface ToolFinding {
  file: string
  line?: number
  summary: string
  category?: string
  verdict?: string
  severity?: string
}

export function extractFindings(item: Pick<ToolItem, "title" | "meta" | "rawInput">): ToolFinding[] | null {
  if (!isOneOf(item, ["reportfindings", "report_findings"])) return null
  const raw = asRecord(item.rawInput)?.findings
  if (!Array.isArray(raw)) return null
  // An empty array is a real answer — "reviewed, found nothing" — so it is
  // returned as an empty list rather than as null.
  return raw.flatMap((entry) => {
    const record = asRecord(entry)
    const file = str(record?.file)
    const summary = str(record?.short_summary) ?? str(record?.summary)
    if (!file || !summary) return []
    return [{
      file,
      line: typeof record?.line === "number" ? record.line : undefined,
      summary,
      category: str(record?.category) ?? undefined,
      verdict: str(record?.verdict) ?? undefined,
      severity: str(record?.severity) ?? undefined,
    }]
  })
}

/** An `ExitPlanMode` call: the plan the agent is asking permission to run. It
    is markdown, and it is the entire point of the call. */
export function extractPlanProposal(item: Pick<ToolItem, "title" | "meta" | "rawInput" | "toolKind">): string | null {
  if (item.toolKind !== "switch_mode" && !isOneOf(item, ["exitplanmode", "exit_plan_mode"])) {
    return null
  }
  const input = asRecord(item.rawInput)
  return str(input?.plan) ?? str(input?.markdown) ?? null
}

/** A plan proposal carried by a *live* permission request, not a settled tool
    item. Same condition as `extractPlanProposal` but reads a `ToolCallUpdate`
    — the shape ACP uses on the pending question — where the kind is `kind`, not
    `toolKind`. A codex plan approval arrives exactly like this: kind
    `switch_mode`, title "Implement this plan?", `rawInput: { plan: markdown }`.
    Without this the approval card rendered the plan as a raw JSON dump. */
export function extractPlanProposalFromPermission(
  toolCall: Pick<acp.ToolCallUpdate, "kind" | "title" | "name" | "rawInput">
): string | null {
  if (toolCall.kind !== "switch_mode" && !/^(exit_plan_mode|exitplanmode|plan)$/.test(toolCall.name?.toLowerCase() ?? "")) {
    return null
  }
  const input = asRecord(toolCall.rawInput)
  return str(input?.plan) ?? str(input?.markdown) ?? null
}

/** A `Skill` load: which packaged workflow the agent pulled in, and with what. */
export interface SkillLoad {
  name: string
  args?: string
}

export function extractSkill(item: Pick<ToolItem, "title" | "meta" | "rawInput">): SkillLoad | null {
  if (!isOneOf(item, ["skill", "loadskill", "load_skill"])) return null
  const input = asRecord(item.rawInput)
  const name = str(input?.skill) ?? str(input?.name)
  return name ? { name, args: str(input?.args) ?? undefined } : null
}

// ─── Search options ──────────────────────────────────────────────────────────

/**
 * The flags a repo search actually ran with. Claude Code's `Grep` carries nine
 * of them (`-i`, `-n`, `-A`/`-B`/`-C`, `output_mode`, `head_limit`, `glob`,
 * `type`, `multiline`) as separate input keys, and a layout that reads only
 * `pattern` and `path` silently claims a case-insensitive search with two
 * lines of context was a plain one.
 */
export function searchFlags(item: Pick<ToolItem, "rawInput">): string[] {
  const input = asRecord(item.rawInput)
  if (!input) return []
  const flags: string[] = []
  if (input["-i"] === true) flags.push("case-insensitive")
  if (input.multiline === true) flags.push("multiline")
  for (const key of ["-A", "-B", "-C"] as const) {
    if (typeof input[key] === "number") flags.push(`${key} ${input[key]}`)
  }
  const mode = str(input.output_mode)
  if (mode && mode !== "content") flags.push(mode.replace(/_/g, " "))
  const type = str(input.type)
  if (type) flags.push(`type ${type}`)
  if (typeof input.head_limit === "number") flags.push(`first ${input.head_limit}`)
  return flags
}
