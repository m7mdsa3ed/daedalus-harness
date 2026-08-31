/* ── Questions, findings, plans, skills ── the structured calls a runtime's
   workflow tools make, plus the flags a repo search ran with. */
import type * as acp from "@agentclientprotocol/sdk"
import type { ToolItem } from "../store"
import { asRecord, str } from "./helpers"
import { isOneOf } from "./naming"
import { stringifyOutput } from "./output"

/**
 * The questions an `AskUserQuestion` call is asking — and, once it has been
 * answered, what was picked.
 *
 * This is the *record* of a question, not the live one — a question the user
 * still has to answer arrives as an `elicitation/create` request and is drawn
 * by `elicitation-form.tsx`. What lands in the transcript afterwards is the
 * tool call, and left generic it renders as a nested JSON blob of the exact
 * thing the user was just shown a form for.
 *
 * The answer is half of that record and was the missing half: a settled call
 * that lists four options and does not say which one the reader chose is a
 * transcript of the question with the reply cut out of it.
 */
export interface ToolQuestion {
  question: string
  header?: string
  multiSelect?: boolean
  options: { label: string; description?: string }[]
  /** What was chosen, once the call has settled. One entry for a single
      select, several for a multi-select; an entry that matches no option is
      the free-text "Other" the bridges pair with a select field. */
  answer?: string[]
  /** Free text the reader added alongside the pick (`annotations[…].notes`). */
  notes?: string
}

export function extractQuestions(
  item: Pick<ToolItem, "title" | "meta" | "rawInput" | "rawOutput" | "content">
): ToolQuestion[] | null {
  if (!isOneOf(item, ["askuserquestion", "ask_user_question", "question", "ask"])) return null
  const raw = asRecord(item.rawInput)?.questions
  if (!Array.isArray(raw)) return null
  const answers = collectAnswers(item)
  const questions = raw.flatMap((entry, index) => {
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
    const header = str(record?.header) ?? undefined
    return [{
      question,
      header,
      multiSelect: record?.multiSelect === true,
      options,
      answer: answers.pick(question, header, index),
      notes: answers.note(question, header),
    }]
  })
  return questions.length > 0 ? questions : null
}

/* ── Reading the answer back ──
   Nobody agrees on where it goes. Claude Code's own schema declares `answers`
   and `annotations` *on the input*, keyed by the question text, and fills them
   in when the permission component collects them; a bridge that answers over
   ACP puts the same map on `rawOutput`, or on the MCP envelope inside it, or on
   `_meta.claudeCode.toolResponse`, or serialises the whole thing into the
   output text. So every one of those is read, in that order, and the first
   place that names a question wins. The keying is just as loose — question
   text, else the header, else position — because a bridge that rewrites the
   prompt still emits the answers in order. */

interface AnswerIndex {
  pick(question: string, header: string | undefined, index: number): string[] | undefined
  note(question: string, header: string | undefined): string | undefined
}

function collectAnswers(item: Pick<ToolItem, "meta" | "rawInput" | "rawOutput" | "content">): AnswerIndex {
  const byKey = new Map<string, string[]>()
  const byIndex: string[][] = []
  const notes = new Map<string, string>()

  for (const source of answerSources(item)) {
    const record = asRecord(source)
    readAnswers(record ? (record.answers ?? record) : source, byKey, byIndex)
    readNotes(record?.annotations, notes)
  }

  const lookup = (question: string, header: string | undefined) =>
    byKey.get(question) ?? (header ? byKey.get(header) : undefined)
  return {
    pick: (question, header, index) => lookup(question, header) ?? byIndex[index],
    note: (question, header) => notes.get(question) ?? (header ? notes.get(header) : undefined),
  }
}

/** Everything that might carry the answers, nearest first. Records and arrays
    both — `readAnswers` knows the two shapes. */
function answerSources(item: Pick<ToolItem, "meta" | "rawInput" | "rawOutput" | "content">): unknown[] {
  const raw = asRecord(item.rawOutput)
  const codex = asRecord(raw?.result)
  const text = stringifyOutput(item.rawOutput ?? contentText(item.content), 20_000).text
  return [
    asRecord(item.rawInput),
    asRecord(codex?.structuredContent),
    codex,
    raw,
    asRecord(asRecord(asRecord(item.meta)?.claudeCode)?.toolResponse),
    parseJson(text),
  ].filter((source) => source !== null && source !== undefined)
}

function readAnswers(value: unknown, byKey: Map<string, string[]>, byIndex: string[][]): void {
  if (Array.isArray(value)) {
    // `[{question, answer}]` — positional, and keyed too when it names one.
    value.forEach((entry, index) => {
      const record = asRecord(entry)
      if (!record) return
      const picked = answerValues(record.answer ?? record.answers ?? record.selected ?? record.value)
      if (!picked) return
      const key = str(record.question) ?? str(record.header)
      if (key && !byKey.has(key)) byKey.set(key, picked)
      if (byIndex[index] === undefined) byIndex[index] = picked
    })
    return
  }
  const record = asRecord(value)
  if (!record) return
  for (const [key, entry] of Object.entries(record)) {
    const picked = answerValues(entry)
    if (picked && !byKey.has(key)) byKey.set(key, picked)
  }
}

function readNotes(value: unknown, notes: Map<string, string>): void {
  const record = asRecord(value)
  if (!record) return
  for (const [key, entry] of Object.entries(record)) {
    const note = str(asRecord(entry)?.notes)
    if (note && !notes.has(key)) notes.set(key, note)
  }
}

/** One answer as the list of labels it stands for. A multi-select arrives
    either as an array or as the comma-separated string a text field can hold. */
function answerValues(value: unknown): string[] | null {
  if (typeof value === "string") {
    const parts = value.split(",").map((part) => part.trim()).filter(Boolean)
    return parts.length > 0 ? parts : null
  }
  if (Array.isArray(value)) {
    const parts = value.flatMap((entry) => {
      const label = typeof entry === "string" ? entry : (str(asRecord(entry)?.label) ?? str(asRecord(entry)?.value))
      return label ? [label] : []
    })
    return parts.length > 0 ? parts : null
  }
  return null
}

function contentText(content: ToolItem["content"]): string {
  return content
    .map((block) => (block.type === "content" && block.content.type === "text" ? block.content.text : ""))
    .filter(Boolean)
    .join("\n")
}

function parseJson(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
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
