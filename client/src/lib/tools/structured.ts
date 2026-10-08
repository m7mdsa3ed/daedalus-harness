/* ── Questions, findings, plans, skills ── the structured calls a runtime's
   workflow tools make, plus the flags a repo search ran with. */
import type * as acp from "@daedalus/acp"
import type { ToolItem } from "../store"
import { asRecord, str, vendorMeta } from "./helpers"
import { isOneOf, toolKindOf } from "./naming"
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
  /* `ask_user` is the harness's own runtime (`agent/src/tools/ask-user.ts`),
     and its absence here is why the one tool we ship ourselves was the one
     rendering as a JSON dump of the form the reader had just filled in. */
  if (!isOneOf(item, ["askuserquestion", "ask_user_question", "ask_user", "question", "ask"]))
    return null
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
   `_meta.claudeCode.toolResponse` (older adapters; AIR gets only its status
   markers), or serialises the whole thing into the output text. So every one of those is read, in that order, and the first
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

  const text = answerText(item)
  for (const source of answerSources(item, text)) {
    const record = asRecord(source)
    readAnswers(record ? (record.answers ?? record) : source, byKey, byIndex)
    readNotes(record?.annotations, notes)
  }
  /* Last, and only into what the structured sources left empty: a runtime that
     sends both means the one with a schema. */
  readArrowAnswers(text, byKey, byIndex)
  readQuotedAnswers(text, byKey)

  const lookup = (question: string, header: string | undefined) =>
    byKey.get(question) ?? (header ? byKey.get(header) : undefined)
  return {
    pick: (question, header, index) => lookup(question, header) ?? byIndex[index],
    note: (question, header) => notes.get(question) ?? (header ? notes.get(header) : undefined),
  }
}

/** Whatever the call reported back, as text — the last resort for both readers
    below, and computed once because both want it. */
function answerText(item: Pick<ToolItem, "rawOutput" | "content">): string {
  return stringifyOutput(item.rawOutput ?? contentText(item.content), 20_000).text
}

/** Everything that might carry the answers, nearest first. Records and arrays
    both — `readAnswers` knows the two shapes. */
function answerSources(
  item: Pick<ToolItem, "meta" | "rawInput" | "rawOutput" | "content">,
  text: string
): unknown[] {
  const raw = asRecord(item.rawOutput)
  const codex = asRecord(raw?.result)
  return [
    asRecord(item.rawInput),
    asRecord(codex?.structuredContent),
    codex,
    raw,
    asRecord(vendorMeta(item.meta, "claudeCode")?.toolResponse),
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

/* ── The arrow form ──
   Our own runtime answers a question by handing the model back the exchange as
   prose: `question\n→ answer`, one block per question, a blank line between
   (`agent/src/tools/ask-user.ts`). That is the right shape for the *model* —
   it reads the reply as text — and it is the only shape that names the
   question and the answer together without a schema, which is what makes it
   readable here rather than a guess.

   Nothing above can see it. Every other source is a record or an array, and
   the `parseJson` fallback declines a string that is not JSON, so a settled
   `ask_user` listed four options and said nothing about which one the reader
   had chosen — the transcript of a question with the reply cut out of it,
   which is the exact failure the `answer` field was added to fix. */
const ARROW_BLOCK_RE = /^([\s\S]+?)\n[ \t]*→[ \t]*([\s\S]+)$/

function readArrowAnswers(text: string, byKey: Map<string, string[]>, byIndex: string[][]): void {
  if (!text.includes("→")) return
  /* The block's position IS the question's: the runtime emits exactly one
     block per question, in order, so a positional read is sound even where the
     prompt was rewritten and the text no longer matches the input's. */
  text.split(/\n[ \t]*\n/).forEach((block, index) => {
    const match = ARROW_BLOCK_RE.exec(block.trim())
    if (!match) return
    const question = match[1].trim()
    const answer = match[2].trim()
    // The runtime's own placeholder for a field the reader left blank. It is
    // not an answer, and drawing it as one would put a tick beside nothing.
    if (!question || !answer || answer === "(no answer)") return
    if (!byKey.has(question)) byKey.set(question, [answer])
    if (byIndex[index] === undefined) byIndex[index] = [answer]
  })
}

/* Claude Code's own result text — `User has answered your questions:
   "Q"="A", "Q2"="A2". You can now continue…` — which, for an AIR client, is
   all there is: claude-agent-acp no longer sends the `toolResponse` that held
   the `answers` record, and puts the result in `content`. Keyed only, into
   what nothing structured already filled. */
const QUOTED_ANSWER_RE = /"((?:[^"\\]|\\.)+)"="((?:[^"\\]|\\.)*)"/g

function readQuotedAnswers(text: string, byKey: Map<string, string[]>): void {
  if (!text.includes('"="')) return
  for (const match of text.matchAll(QUOTED_ANSWER_RE)) {
    const picked = answerValues(match[2])
    if (picked && !byKey.has(match[1])) byKey.set(match[1], picked)
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

/**
 * A permission request's tool call, filled in from the transcript's own row
 * for that call. For an AIR client both adapters send only what the client
 * lacks — claude-agent-acp's request carries `toolCallId`, `title` and a
 * `rawInput` with the file text stripped out, because the `tool_call` it sent
 * first holds the diff, the kind, the locations and the `_meta`. Drawn from
 * the request alone, an Edit's approval is a JSON dump of a path. The request
 * wins wherever it says something; the row fills what it left out.
 */
export function permissionToolCall(
  toolCall: acp.ToolCallUpdate,
  item: ToolItem | undefined
): acp.ToolCallUpdate {
  if (!item) return toolCall
  return {
    ...toolCall,
    title: toolCall.title ?? item.title,
    name: toolCall.name ?? item.name,
    kind: toolCall.kind ?? (item.toolKind as acp.ToolKind | undefined),
    content: toolCall.content?.length ? toolCall.content : item.content,
    locations: toolCall.locations?.length ? toolCall.locations : item.locations,
    rawInput: toolCall.rawInput ?? item.rawInput,
    _meta: { ...item.meta, ...toolCall._meta },
  }
}

/** A skill load: which packaged workflow the agent pulled in, and with what. */
export interface SkillLoad {
  name: string
  args?: string
  /** The skill's own one-line description — from the `SKILL.md` frontmatter a
      runtime read, or from the input when a skill tool carried one. */
  description?: string
}

/* A runtime with no skill *tool* loads one by **reading** its `SKILL.md` — the
   harness's own agent lists skills in its prompt and is told to read the file
   before relying on one. The directory is the name, and both layouts the harness
   materialises into (Claude Code's `.claude/skills`, OpenCode's
   `.opencode/skills`) share the `<dir>/<name>/SKILL.md` shape. */
const SKILL_FILE_RE = /(?:^|\/)(?:\.claude|\.opencode)\/skills\/([^/]+)\/SKILL\.md$/i

/** The value of one key in a leading markdown frontmatter block, `null` when
    absent. Line-based on purpose: skill frontmatter here is `key: value`. */
function frontmatterField(text: string, key: string): string | null {
  if (!text.startsWith("---")) return null
  const end = text.indexOf("\n---", 3)
  if (end === -1) return null
  for (const line of text.slice(3, end).split("\n")) {
    const sep = line.indexOf(":")
    if (sep === -1 || line.slice(0, sep).trim() !== key) continue
    const value = line.slice(sep + 1).trim().replace(/^["']|["']$/g, "")
    if (value) return value
  }
  return null
}

/* The fields a skill can be read out of. Every call site hands over the whole
   `ToolItem`; the ones only a heading or a target holds are optional, so those
   narrower callers can still ask. */
type SkillSource = Pick<ToolItem, "title" | "meta" | "rawInput"> &
  Partial<Pick<ToolItem, "rawOutput" | "content" | "toolKind">>

export function extractSkill(item: SkillSource): SkillLoad | null {
  /* A runtime that ships a skill tool — Claude Code's `Skill` — names the skill
     in the call's input. */
  if (isOneOf(item, ["skill", "loadskill", "load_skill"])) {
    const input = asRecord(item.rawInput)
    const name = str(input?.skill) ?? str(input?.name)
    if (!name) return null
    return {
      name,
      args: str(input?.args) ?? undefined,
      description: str(input?.description) ?? undefined,
    }
  }
  /* Otherwise it is the read of a skill file, and the directory is the name.
     Gated on the kind so an edit that *writes* a `SKILL.md` is never read as
     loading one. */
  if (toolKindOf(item) !== "read") return null
  const input = asRecord(item.rawInput)
  const path = str(input?.file_path) ?? str(input?.filePath) ?? str(input?.path)
  const match = path ? SKILL_FILE_RE.exec(path.replace(/\\/g, "/")) : null
  if (!match) return null
  const output = stringifyOutput(item.rawOutput, 8_000).text
  return { name: match[1], description: output ? (frontmatterField(output, "description") ?? undefined) : undefined }
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
