/* ── The Tokens panel's arithmetic ──
   Every figure the thread inspector's Tokens tab draws that is not simply a
   provider's own count is made here, and nothing else reads it: no other
   surface prints an estimate, so a number with a `~` before it is one place to
   look for.

   Two kinds of figure meet in that panel and are kept apart. **Billed** is what
   the provider reported (`acp.Usage`: fresh input, cache read and write, output,
   of which reasoning) — exact, and every runtime sends it. **Prompt** is what
   the request held (system prompt, built-in tools, MCP tools, and the history
   by who wrote it) — our own runtime's measurement (`agent/src/token-breakdown.ts`):
   the static parts tokenized locally, the history's share of the provider's
   remainder divided in proportion. It sums to the provider's prompt total and is
   still an estimate, which is why the panel says so.

   A runtime that does not measure its prompt still gets a reading, **inferred**
   rather than measured: what the transcript holds up to the request (your
   messages, the assistant's replies, tool results — about four characters a
   token) is the part the harness can see, and what is left of the request's
   total is "Agent overhead", the system prompt and tool schemas that live
   inside that agent's own process and are not ours to split. A journal written
   while the gateway shim still split its requests carries `source: "gateway"`
   breakdowns, which are drawn as they were; the shim no longer produces them.

   The third source is the runtime's own saved files (`server/src/prompt-files.ts`):
   the static part of a request — system, tools, MCP — counted from what the
   runtime wrote down, with the history still read off the transcript. It also
   says what the file does *not* hold (`missing`), and that is the one place
   "Agent overhead" is a named gap rather than a guess: tool schemas the runtime
   never saved are in it, and the panel says so. */
import type * as acp from "@daedalus/acp"

import type { ThreadItem } from "@/lib/store/items"
import { formatDuration } from "@/lib/tokens"
import { parseMcpToolName, toolDisplayName, toolNameOf, vendorMeta } from "@/lib/tools"

/** How a request's prompt divided, as our runtime measured it. Absent for any
    runtime that does not, which is every one but ours. `user`/`assistant`/
    `results` are null on a step journaled before they were counted; `conversation`
    (everything that is not the system prompt or a tool block) is always there. */
export interface PromptBreakdown {
  total: number
  source: "agent" | "gateway"
  overhead: number
  system: number
  /** Built-in tools only; MCP servers' tools are `mcp`. */
  tools: number
  /** 0 on a step journaled before the MCP share was counted apart. */
  mcp: number
  conversation: number
  user: number | null
  assistant: number | null
  results: number | null
}

export function promptBreakdown(usage: acp.UsageUpdate | null | undefined): PromptBreakdown | null {
  const raw = vendorMeta(usage?._meta, "daedalus")?.breakdown
  if (raw === null || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null)
  const [total, system, tools, conversation] = [num(r.total), num(r.system), num(r.tools), num(r.conversation)]
  return total === null || system === null || tools === null || conversation === null
    ? null
    : {
        total,
        source: r.source === "gateway" ? "gateway" : "agent",
        overhead: num(r.overhead) ?? 0,
        system,
        tools,
        mcp: num(r.mcp) ?? 0,
        conversation,
        user: num(r.user),
        assistant: num(r.assistant),
        results: num(r.results),
      }
}

/** The static part of a request as a runtime's saved files describe it. Counts
    are the server's tokenizer's, so only their proportions are trusted; `missing`
    is what the file does not hold, in words. `items` rides the first reading
    after a change and is carried forward by `prefixItemsOf`. */
export interface PromptPrefix {
  system: number
  tools: number
  mcp: number
  missing: string[]
}

export function promptPrefix(usage: acp.UsageUpdate | null | undefined): PromptPrefix | null {
  const raw = vendorMeta(usage?._meta, "daedalus")?.prefix
  if (raw === null || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0)
  return {
    system: num(r.system),
    tools: num(r.tools),
    mcp: num(r.mcp),
    missing: Array.isArray(r.missing) ? r.missing.filter((m): m is string => typeof m === "string") : [],
  }
}

/* ── What a prompt held ── */

export type PromptKey = "system" | "tools" | "mcp" | "user" | "assistant" | "results" | "history" | "overhead"
export type PromptParts = Record<PromptKey, number>

/** Swatches are literal classes so Tailwind sees them, and fixed hues rather
    than `--chart-*`: several themes (the default included) make those five greys,
    which draws a stacked bar as one colour in five shades. `history` is only what
    an older journal could not tell apart. */
export const PROMPT_PARTS: { key: PromptKey; label: string; swatch: string }[] = [
  { key: "system", label: "System prompt", swatch: "bg-violet-500" },
  { key: "tools", label: "Built-in tools", swatch: "bg-sky-500" },
  { key: "mcp", label: "MCP tools", swatch: "bg-teal-500" },
  { key: "user", label: "Your messages", swatch: "bg-emerald-500" },
  { key: "assistant", label: "Assistant replies", swatch: "bg-amber-500" },
  { key: "results", label: "Tool results", swatch: "bg-rose-500" },
  { key: "history", label: "History (unsplit)", swatch: "bg-zinc-400" },
  { key: "overhead", label: "Agent overhead", swatch: "bg-zinc-500/60" },
]

const NO_PARTS: PromptParts = { system: 0, tools: 0, mcp: 0, user: 0, assistant: 0, results: 0, history: 0, overhead: 0 }

/** What one request's prompt held, and whether the runtime said so (`measured`)
    or the transcript was read to guess (`inferred`). */
export interface RequestParts {
  parts: PromptParts
  inferred: boolean
  source: "agent" | "gateway" | "files" | "transcript"
  /** What the source could not say, as the runtime's files told it. Only
      `files` has any; for `transcript` the panel says the general thing. */
  missing: string[]
}

/** One request's prompt by part. Null only where there is nothing to divide:
    no measurement, and no transcript before the request to read. */
export function promptParts(step: TurnStep): RequestParts | null {
  const split = promptBreakdown(step.update)
  if (split) {
    const [user, assistant, results] = [split.user ?? 0, split.assistant ?? 0, split.results ?? 0]
    return {
      inferred: split.source === "gateway",
      source: split.source,
      missing: [],
      parts: {
        ...NO_PARTS,
        system: split.system,
        tools: split.tools,
        mcp: split.mcp,
        overhead: split.overhead,
        user,
        assistant,
        results,
        history: Math.max(0, split.conversation - user - assistant - results),
      },
    }
  }
  const { used } = step.update
  const h = step.history
  const counted = h.user + h.assistant + h.results
  const prefix = promptPrefix(step.update)
  if (prefix && used > 0) {
    const known = prefix.system + prefix.tools + prefix.mcp
    const all = known + counted
    if (all > 0) {
      /* The files hold the whole prefix when nothing is missing, so the gap
         between their tokenizer and the provider's is spread over every part
         (nothing is "overhead"). With something missing, that part is real and
         unmeasured — it is what is left once the known parts are taken out, and
         the known ones are only ever scaled *down* to fit. */
      const scale = prefix.missing.length === 0 ? used / all : Math.min(1, used / all)
      const take = (n: number, room: number) => Math.min(room, Math.round(n * scale))
      const system = take(prefix.system, used)
      const mcp = take(prefix.mcp, used - system)
      const tools = take(prefix.tools, used - system - mcp)
      const user = take(h.user, used - system - mcp - tools)
      const assistant = take(h.assistant, used - system - mcp - tools - user)
      const results = take(h.results, used - system - mcp - tools - user - assistant)
      const overhead = used - system - mcp - tools - user - assistant - results
      return { inferred: true, source: "files", missing: prefix.missing, parts: { ...NO_PARTS, system, tools, mcp, user, assistant, results, overhead } }
    }
  }
  if (!(used > 0) || counted === 0) return null
  /* A transcript longer than the prompt it fed (a compaction the runtime did not
     announce, a tokenizer that runs long) is scaled down to fit, and the
     overhead is what is left — which is then nothing. The parts always sum to
     `used`, as the measured ones do. */
  const scale = Math.min(1, used / counted)
  const user = Math.round(h.user * scale)
  const assistant = Math.min(used - user, Math.round(h.assistant * scale))
  const results = Math.min(used - user - assistant, Math.round(h.results * scale))
  return { inferred: true, source: "transcript", missing: [], parts: { ...NO_PARTS, user, assistant, results, overhead: used - user - assistant - results } }
}

/** Requests' prompts added up — what was *billed*, since each request re-sends
    the lot. `requests` is how many carried a split, `inferred` how many of those
    were read off the transcript rather than measured. */
export function sumPromptParts(steps: TurnStep[]): { parts: PromptParts; total: number; requests: number; inferred: number } | null {
  const parts = { ...NO_PARTS }
  let requests = 0
  let inferred = 0
  for (const step of steps) {
    const one = promptParts(step)
    if (!one) continue
    requests++
    if (one.inferred) inferred++
    for (const key of Object.keys(parts) as PromptKey[]) parts[key] += one.parts[key]
  }
  return requests > 0 ? { parts, total: Object.values(parts).reduce((n, v) => n + v, 0), requests, inferred } : null
}

/* ── A model span's own account of its prompt ──
   A runtime that reports its OpenTelemetry (`server/src/otlp.ts`), or the AI
   SDK's spans of our own agent, has the server divide the request on arrival and
   write the result beside the span as `daedalus.prompt_parts` — the same shape as
   `breakdown`, scaled to the provider's total for *that* request. Read here so
   the Trajectory draws it with the same parts, labels and swatches as the panel
   above. */

/** The span attribute the server writes a request's parts to. */
export const PROMPT_PARTS_ATTR = "daedalus.prompt_parts"

export interface SpanPromptParts {
  total: number
  source: string
  parts: PromptParts
  items: Record<"system" | "tools" | "mcp", { name: string; tokens: number }[]>
}

export function spanPromptParts(attributes: Record<string, unknown>): SpanPromptParts | null {
  const raw = attributes[PROMPT_PARTS_ATTR]
  let r: Record<string, unknown> | null = null
  try {
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw
    r = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
  if (!r) return null
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0)
  const total = num(r.total)
  if (total === 0) return null
  const [user, assistant, results] = [num(r.user), num(r.assistant), num(r.results)]
  const list = (v: unknown): { name: string; tokens: number }[] =>
    Array.isArray(v)
      ? v.filter((i): i is { name: string; tokens: number } => typeof i?.name === "string" && typeof i?.tokens === "number")
      : []
  const items = (r.items ?? {}) as Record<string, unknown>
  return {
    total,
    source: typeof r.source === "string" ? r.source : "agent",
    parts: {
      ...NO_PARTS,
      system: num(r.system),
      tools: num(r.tools),
      mcp: num(r.mcp),
      user,
      assistant,
      results,
      history: Math.max(0, num(r.conversation) - user - assistant - results),
      overhead: num(r.overhead),
    },
    items: { system: list(items.system), tools: list(items.tools), mcp: list(items.mcp) },
  }
}

/* ── What the provider billed ── */

export type BilledKey = "input" | "cacheRead" | "cacheWrite" | "output" | "reasoning"
export type BilledParts = Record<BilledKey, number>

export const BILLED_PARTS: { key: BilledKey; label: string; swatch: string }[] = [
  { key: "input", label: "New input", swatch: "bg-sky-500" },
  { key: "cacheRead", label: "Cache read", swatch: "bg-emerald-500" },
  { key: "cacheWrite", label: "Cache write", swatch: "bg-amber-500" },
  { key: "output", label: "Output", swatch: "bg-violet-500" },
  { key: "reasoning", label: "Reasoning", swatch: "bg-fuchsia-500" },
]

/** A usage reading divided so the parts sum to its total: ACP's output figure
    includes the reasoning inside it, so "output" here is what was left once
    that is taken out. */
export function billedParts(usage: acp.Usage): BilledParts {
  const reasoning = Math.min(usage.thoughtTokens ?? 0, usage.outputTokens)
  return {
    input: usage.inputTokens,
    cacheRead: usage.cachedReadTokens ?? 0,
    cacheWrite: usage.cachedWriteTokens ?? 0,
    output: usage.outputTokens - reasoning,
    reasoning,
  }
}

/** One model request's own bill (`_meta.daedalus.step`, our runtime only) —
    its output and reasoning, which the `used` total folds together. */
export function stepBill(usage: acp.UsageUpdate | null | undefined): acp.Usage | null {
  const step = vendorMeta(usage?._meta, "daedalus")?.step as acp.Usage | undefined
  return step && typeof step.outputTokens === "number" ? step : null
}

/* ── Turn by turn ── */

/** What the transcript held before a request, by who wrote it. */
export interface HistoryCounts {
  user: number
  assistant: number
  results: number
}

/** One piece of the history, as the transcript has it: a message, a tool call,
    a tool result. `group` is what the panel folds it under. */
export interface HistoryEntry {
  part: "user" | "assistant" | "results"
  group: string
  name: string
  tokens: number
}

/** One model request: the usage reading the runtime filed, and the transcript
    as it stood when it did — `entries[from, to)` is what it carried. */
export interface TurnStep {
  update: acp.UsageUpdate
  history: HistoryCounts
  from: number
  to: number
  /** What the step produced — the row it was filed under: the call it made,
      the reply it wrote. */
  label: string
  /** The turn it ran in, 1-based. */
  turn: number
  /** Wall time since the boundary before it — the user's message for a turn's
      first step, the previous step's reading after that — so the tool calls
      that ran in between are inside it. Absent where either end has no stamp. */
  durationMs?: number
}

export interface TurnTokens {
  /** The user row that opened the turn. */
  id: string
  /** The server's turn id, which keys durations — the user row's id does not. */
  turnId?: string
  prompt: string
  /** What the runtime billed for the whole turn, once it ended. */
  usage?: acp.Usage
  /** Each model request in it, in order, as `markStepUsage` filed them. */
  steps: TurnStep[]
}

/* About four characters a token — the composer's own rule for a draft, and said
   as an estimate everywhere it is drawn. Counted off the transcript rather than
   tokenized: every figure it feeds is scaled to a real total (the measured
   part, or the request's `used`), so only its proportions are read. */
const approx = (text: string) => Math.ceil(text.length / 4)

const textOf = (blocks: acp.ContentBlock[]) =>
  blocks.map((block) => (block.type === "text" ? block.text : "")).join("")

const preview = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > 60 ? `${line.slice(0, 60)}…` : line || "(no text)"
}

function toolEntries(item: Extract<ThreadItem, { kind: "tool" }>): HistoryEntry[] {
  const name = toolNameOf(item)
  const group = name ? toolDisplayName(name) : item.toolKind ?? "Other tools"
  const call = approx(item.name ?? item.title) + (item.rawInput === undefined ? 0 : approx(JSON.stringify(item.rawInput)))
  const fromContent = item.content
    .map((part) => (part.type === "content" && part.content.type === "text" ? part.content.text : part.type === "diff" ? part.newText : ""))
    .join("")
  const output = fromContent || (item.rawOutput === undefined ? "" : typeof item.rawOutput === "string" ? item.rawOutput : JSON.stringify(item.rawOutput))
  return [
    { part: "assistant", group: `Calls: ${group}`, name: preview(item.title), tokens: call },
    { part: "results", group, name: preview(item.title), tokens: approx(output) },
  ]
}

/** A step is filed under the transcript's tail when its reading arrived
    (`markStepUsage`), which is the row that step produced. */
function stepLabel(item: ThreadItem): string {
  if (item.kind === "tool") return preview(item.title)
  if (item.kind === "agent") return preview(item.text)
  if (item.kind === "thought") return "Thinking"
  if (item.kind === "user") return "Before any reply"
  return item.kind
}

/** The thread's tokens, turn by turn: the same nearest-user-row walk that
    `withStepTurnUsage` does, collecting the step readings filed on the way and
    the transcript as entries, so each request knows what it carried. A
    subagent's rows are skipped — their requests are the child's — and a
    finished compaction replaces what came before it with its summary. */
export function tokensByTurn(
  items: ThreadItem[],
  stepUsage: Record<string, acp.UsageUpdate>,
  turnUsage: Record<string, acp.Usage>,
  stepAt: Record<string, number> = {}
): { turns: TurnTokens[]; entries: HistoryEntry[] } {
  const turns: TurnTokens[] = []
  const entries: HistoryEntry[] = []
  const running: HistoryCounts = { user: 0, assistant: 0, results: 0 }
  let from = 0
  /** The last step boundary's stamp; a user row resets it, so no step is ever
      timed across a turn. */
  let clock: number | undefined
  const add = (entry: HistoryEntry) => {
    entries.push(entry)
    running[entry.part] += entry.tokens
  }
  for (const item of items) {
    if (item.parentId) continue
    if (item.kind === "user") {
      clock = item.at
      turns.push({ id: item.id, turnId: item.turnId, prompt: item.text, usage: item.turnId ? turnUsage[item.turnId] : undefined, steps: [] })
      add({ part: "user", group: "", name: `#${turns.length} ${preview(item.text)}`, tokens: approx(item.text) })
    } else if (item.kind === "agent") {
      add({ part: "assistant", group: "Text replies", name: preview(item.text), tokens: approx(item.text) })
    } else if (item.kind === "tool") {
      for (const entry of toolEntries(item)) add(entry)
    } else if (item.kind === "compaction" && item.status === "completed") {
      from = entries.length
      Object.assign(running, { user: 0, assistant: 0, results: 0 })
      add({ part: "assistant", group: "", name: "Compaction summary", tokens: approx(textOf(item.summary)) })
    }
    const update = stepUsage[item.id]
    if (update) {
      const at = stepAt[item.id]
      const durationMs = at !== undefined && clock !== undefined && at >= clock ? at - clock : undefined
      if (at !== undefined) clock = at
      turns.at(-1)?.steps.push({ update, history: { ...running }, from, to: entries.length, label: stepLabel(item), turn: turns.length, durationMs })
    }
  }
  return { turns: turns.filter((turn) => turn.usage || turn.steps.length > 0), entries }
}

/* ── One request, item by item ── */

/** A row of a part's list: one item, or a group of them. */
export interface DetailItem {
  name: string
  tokens: number
  children?: { name: string; tokens: number }[]
}

interface PrefixItem {
  name: string
  tokens: number
}

/** The static prefix's item lists our runtime sends on the first step of each
    attempt (`agent/src/token-breakdown.ts`). */
function prefixItemsOf(update: acp.UsageUpdate): Record<"system" | "tools" | "mcp", PrefixItem[]> | null {
  const meta = vendorMeta(update._meta, "daedalus")
  const raw = (meta?.breakdown as { items?: unknown } | undefined)?.items ?? (meta?.prefix as { items?: unknown } | undefined)?.items
  if (!raw || typeof raw !== "object") return null
  const list = (v: unknown): PrefixItem[] =>
    Array.isArray(v)
      ? v.filter((i): i is PrefixItem => typeof i?.name === "string" && typeof i?.tokens === "number" && Number.isFinite(i.tokens))
      : []
  const r = raw as Record<string, unknown>
  return { system: list(r.system), tools: list(r.tools), mcp: list(r.mcp) }
}

/* Scale raw counts to the figure the part was given — the items are only
   proportions — then fold `group`s into one row with their children, biggest
   first. A group of one becomes that one row. */
function detail(raw: { group: string; name: string; tokens: number }[], value: number): DetailItem[] {
  const sum = raw.reduce((n, i) => n + i.tokens, 0)
  if (sum === 0 || value <= 0) return []
  const scale = value / sum
  const groups = new Map<string, DetailItem>()
  const rows: DetailItem[] = []
  for (const item of raw) {
    const tokens = item.tokens * scale
    if (!item.group) {
      rows.push({ name: item.name, tokens })
      continue
    }
    let group = groups.get(item.group)
    if (!group) {
      group = { name: item.group, tokens: 0, children: [] }
      groups.set(item.group, group)
      rows.push(group)
    }
    group.tokens += tokens
    group.children!.push({ name: item.name, tokens })
  }
  const round = <T extends { tokens: number }>(row: T): T => ({ ...row, tokens: Math.round(row.tokens) })
  return rows
    .map((row) => {
      if (row.children?.length === 1) return round({ name: `${row.name} · ${row.children[0].name}`, tokens: row.tokens })
      return row.children
        ? { ...round(row), children: row.children.map(round).sort((x, y) => y.tokens - x.tokens) }
        : round(row)
    })
    .sort((x, y) => y.tokens - x.tokens)
}

/**
 * What each part of the request at `index` (in the flat list of the thread's
 * requests) was made of, scaled so every part's rows add up to the part's own
 * figure. The static prefix's lists come from the newest request at or before
 * this one that carried them; the history's from the transcript it carried.
 */
export function requestDetail(
  steps: TurnStep[],
  index: number,
  entries: HistoryEntry[],
  parts: PromptParts
): Partial<Record<PromptKey, DetailItem[]>> {
  const step = steps[index]
  let prefix: ReturnType<typeof prefixItemsOf> = null
  for (let i = index; i >= 0 && !prefix; i--) prefix = prefixItemsOf(steps[i].update)
  const carried = entries.slice(step.from, step.to)
  const of = (part: HistoryEntry["part"]) => carried.filter((entry) => entry.part === part)
  const sectioned = (prefix?.system ?? []).map((item) => {
    const [group, ...rest] = item.name.split(" › ")
    return rest.length ? { group, name: rest.join(" › "), tokens: item.tokens } : { group: "", name: item.name, tokens: item.tokens }
  })
  const byServer = (prefix?.mcp ?? []).map((item) => {
    const mcp = parseMcpToolName(item.name)
    return mcp ? { group: mcp.server, name: mcp.tool, tokens: item.tokens } : { group: "", name: item.name, tokens: item.tokens }
  })
  return {
    system: detail(sectioned, parts.system),
    tools: detail((prefix?.tools ?? []).map((item) => ({ group: "", ...item })), parts.tools),
    mcp: detail(byServer, parts.mcp),
    user: detail(of("user"), parts.user),
    assistant: detail(of("assistant"), parts.assistant),
    results: detail(of("results"), parts.results),
  }
}

/** One child's spend: a subagent session or a background task/workflow run. */
export interface SubagentSpend {
  id: string
  name: string
  tokens: number
  /** The full billed split, when the child's runtime reported one — an async
      task's totals are a single figure. */
  usage?: acp.Usage
  workflow: boolean
  /** Time spent running, settled turns only; absent while unmeasured. */
  durationMs?: number
  running: boolean
}

/** What every child of the thread billed, biggest first. A `subagent` row and
    an `async-task` row never describe the same child (a native workflow's
    steps are synthesized at view time, not stored), so their sum is honest.
    ponytail: attribution only — whether a child's tokens are also inside the
    parent's turn total is the runtime's choice (our `task` tool bills its
    children to the parent; a workflow step is its own session), so callers
    never add this to the thread total. */
export function subagentSpend(items: ThreadItem[]): SubagentSpend[] {
  const out: SubagentSpend[] = []
  for (const item of items) {
    if (item.kind === "subagent" && item.usage) {
      out.push({
        id: item.id,
        name: item.name,
        tokens: item.usage.totalTokens,
        usage: item.usage,
        workflow: !!item.workflow,
        durationMs: item.durationMs,
        running: item.state === "running",
      })
    } else if (item.kind === "async-task" && item.usage?.totalTokens) {
      out.push({
        id: item.id,
        name: item.description || item.name,
        tokens: item.usage.totalTokens,
        workflow: true,
        durationMs: item.usage.durationMs || undefined,
        running: item.state === "running",
      })
    }
  }
  return out.sort((a, b) => b.tokens - a.tokens)
}

/** A child's time as one short phrase: "running", its measured time, or
    nothing when the runtime gave us no way to tell. */
export function spendTime(child: SubagentSpend): string | undefined {
  if (child.running) return "running"
  return child.durationMs ? formatDuration(child.durationMs) : undefined
}
