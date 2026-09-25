/* ── Reading a thread's spans ──
   The pure half of the Trajectory view (`components/trajectory/`): the tree
   the spans form, the turn each belongs to, the figures a span carries and the
   totals across the thread. No React, so `trajectory.check.mjs` can run it.

   What a span *is* comes from the server (`kind`); what it *cost* is read off
   its attributes, preferring the harness's own keys (`daedalus.*`, ms) over the
   GenAI conventions (`gen_ai.*`, where time to first chunk is in seconds). */
import type { TraceAttributeValue, TraceSpan, TraceSpanKind } from "@daedalus/protocol"

export interface SpanNode {
  span: TraceSpan
  children: SpanNode[]
  depth: number
  /** The root this span hangs under — a turn, or a spawn outside one. */
  root: TraceSpan
}

/** The forest the spans form. A span whose parent is not in the set is a root
    (a spawn or load outside a turn, or an agent span whose parent was lost).
    Children and roots in start order. */
export function buildTree(spans: TraceSpan[]): SpanNode[] {
  const byId = new Map<string, SpanNode>()
  for (const span of spans) byId.set(span.spanId, { span, children: [], depth: 0, root: span })
  const roots: SpanNode[] = []
  for (const node of byId.values()) {
    const parent = node.span.parentSpanId ? byId.get(node.span.parentSpanId) : undefined
    // A span naming itself as parent would loop forever below; treat it as a root.
    if (parent && parent !== node) parent.children.push(node)
    else roots.push(node)
  }
  const byStart = (a: SpanNode, b: SpanNode) => a.span.start - b.span.start
  const settle = (node: SpanNode, depth: number, root: TraceSpan) => {
    node.depth = depth
    node.root = root
    node.children.sort(byStart)
    for (const child of node.children) settle(child, depth + 1, root)
  }
  roots.sort(byStart)
  for (const root of roots) settle(root, 0, root.span)
  return roots
}

/** Depth-first, the order the waterfall draws. `collapsed` spans keep their
    row and drop their subtree. */
export function flatten(roots: SpanNode[], collapsed: ReadonlySet<string> = new Set()): SpanNode[] {
  const out: SpanNode[] = []
  const walk = (node: SpanNode) => {
    out.push(node)
    if (!collapsed.has(node.span.spanId)) node.children.forEach(walk)
  }
  roots.forEach(walk)
  return out
}

/** The end a still-open span is drawn to. */
export const spanEnd = (span: TraceSpan, now: number) => span.end ?? Math.max(now, span.start)
export const spanDuration = (span: TraceSpan, now: number) => spanEnd(span, now) - span.start

const num = (value: TraceAttributeValue | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))
      ? Number(value)
      : null

export interface SpanUsage {
  input: number | null
  output: number | null
  cacheRead: number | null
  cacheWrite: number | null
}

export function spanUsage(span: TraceSpan): SpanUsage {
  const a = span.attributes
  return {
    input: num(a["gen_ai.usage.input_tokens"]),
    output: num(a["gen_ai.usage.output_tokens"]),
    cacheRead: num(a["gen_ai.usage.cache_read.input_tokens"]),
    cacheWrite: num(a["gen_ai.usage.cache_creation.input_tokens"]),
  }
}

/** Time to first token in ms: the harness's own reading, else the AI SDK's
    (seconds). */
export function spanTtft(span: TraceSpan): number | null {
  const ms = num(span.attributes["daedalus.ttft_ms"])
  if (ms !== null) return ms
  const s = num(span.attributes["gen_ai.client.operation.time_to_first_chunk"])
  return s === null ? null : s * 1000
}

export interface SpanTiming {
  duration: number | null
  ttft: number | null
  /** Duration less TTFT — the time spent writing. */
  decode: number | null
  /** Output tokens over the decode time (the whole duration when TTFT is
      unknown). */
  tps: number | null
}

/** Only a closed span has a duration to divide by. */
export function spanTiming(span: TraceSpan): SpanTiming {
  const duration = span.end === null ? null : span.end - span.start
  const ttft = spanTtft(span)
  const decode = duration !== null && ttft !== null ? Math.max(0, duration - ttft) : null
  const output = spanUsage(span).output
  const over = decode ?? duration
  const tps = output && over && over > 0 ? (output * 1000) / over : null
  return { duration, ttft, decode, tps }
}

export interface TrajectoryTotals {
  turns: number
  modelCalls: number
  toolCalls: number
  errors: number
  /** ms, open spans counted to `now`. */
  modelTime: number
  toolTime: number
  input: number
  output: number
  cacheRead: number
  avgTtft: number | null
  avgTps: number | null
}

export function totals(spans: TraceSpan[], now: number): TrajectoryTotals {
  const t: TrajectoryTotals = {
    turns: 0,
    modelCalls: 0,
    toolCalls: 0,
    errors: 0,
    modelTime: 0,
    toolTime: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    avgTtft: null,
    avgTps: null,
  }
  const ttfts: number[] = []
  const rates: number[] = []
  // Usage is summed over the model spans; a turn's own usage (the harness's
  // reading of `turn_ended`) only when no model span carried any, so the two
  // never count one call twice.
  const add = (span: TraceSpan) => {
    const u = spanUsage(span)
    t.input += u.input ?? 0
    t.output += u.output ?? 0
    t.cacheRead += u.cacheRead ?? 0
    return u.input !== null || u.output !== null
  }
  let modelUsage = false
  for (const span of spans) {
    if (span.status === "error") t.errors++
    if (span.kind === "turn") t.turns++
    else if (span.kind === "tool") {
      t.toolCalls++
      t.toolTime += spanDuration(span, now)
    } else if (span.kind === "model") {
      t.modelCalls++
      t.modelTime += spanDuration(span, now)
      if (add(span)) modelUsage = true
      const timing = spanTiming(span)
      if (timing.ttft !== null) ttfts.push(timing.ttft)
      if (timing.tps !== null) rates.push(timing.tps)
    }
  }
  if (!modelUsage) for (const span of spans) if (span.kind === "turn") add(span)
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
  t.avgTtft = mean(ttfts)
  t.avgTps = mean(rates)
  return t
}

/** The text a search is matched against: the name, and every short string
    attribute (a prompt, a tool name, a model id). */
export function spanMatches(span: TraceSpan, needle: string): boolean {
  if (!needle) return true
  const q = needle.toLowerCase()
  if (span.name.toLowerCase().includes(q) || span.kind.includes(q)) return true
  for (const value of Object.values(span.attributes))
    if (typeof value === "string" && value.toLowerCase().includes(q)) return true
  return false
}

/** Rows to draw for a search and a kind filter: a matching span keeps its
    ancestors, so a hit is never drawn without the turn it happened in. */
export function visibleRows(
  rows: SpanNode[],
  byId: Map<string, TraceSpan>,
  needle: string,
  hidden: ReadonlySet<TraceSpanKind>
): SpanNode[] {
  const shown = rows.filter((node) => !hidden.has(node.span.kind))
  if (!needle) return shown
  const keep = new Set<string>()
  for (const node of shown) {
    if (!spanMatches(node.span, needle)) continue
    for (let s: TraceSpan | undefined = node.span; s && !keep.has(s.spanId); ) {
      keep.add(s.spanId)
      s = s.parentSpanId ? byId.get(s.parentSpanId) : undefined
    }
  }
  return shown.filter((node) => keep.has(node.span.spanId))
}

/** A JSON-string attribute, parsed; the raw string when it is not JSON. */
export function parseJsonAttr(value: TraceAttributeValue | undefined): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/* ── Prompt changes ──
   What a model call was sent that the one before it was not. A GenAI span
   carries its whole prompt (`gen_ai.input.messages`, and the system
   instructions and tool definitions beside it), so the change is a diff of two
   spans' attributes — nothing is recorded for it. */

/** The attributes a prompt is made of, in the order the diff reads them. */
export const PROMPT_KEYS = ["gen_ai.system_instructions", "gen_ai.tool.definitions", "gen_ai.input.messages"] as const

export const hasPrompt = (span: TraceSpan) => PROMPT_KEYS.some((key) => key in span.attributes)

/**
 * The model call this one is compared against. `"call"` is the one just before
 * it; `"turn"` is the last call of the turn before — one trace per turn, so a
 * turn is a `traceId`. Only calls of the same agent are candidates (a
 * subagent's system prompt is another prompt, not a change to this one), and
 * only calls that recorded a prompt at all.
 */
export function previousModelCall(spans: TraceSpan[], span: TraceSpan, scope: "call" | "turn"): TraceSpan | null {
  const agent = span.attributes["gen_ai.agent.name"]
  let best: TraceSpan | null = null
  for (const other of spans) {
    if (other.kind !== "model" || other.spanId === span.spanId || other.start >= span.start || !hasPrompt(other)) continue
    if (other.attributes["gen_ai.agent.name"] !== agent) continue
    if (scope === "turn" && other.traceId === span.traceId) continue
    if (!best || other.start > best.start) best = other
  }
  return best
}

export type LineOp = { op: "same" | "add" | "del"; text: string }

/** Past this many lines a side, the diff is not computed — an O(n·m) table on
    two whole prompts would stall the pane, and the caller says "changed". */
export const DIFF_LINE_LIMIT = 3_000

/** A line diff by longest common subsequence, with the common head and tail
    trimmed first (the usual case — a prompt that grew — never builds a table).
    Null when either side is past `DIFF_LINE_LIMIT`. */
export function diffLines(before: string, after: string): LineOp[] | null {
  const a = before.split("\n")
  const b = after.split("\n")
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const x = a.slice(head, a.length - tail)
  const y = b.slice(head, b.length - tail)
  if (x.length > DIFF_LINE_LIMIT || y.length > DIFF_LINE_LIMIT) return null
  // lcs[i][j]: the common subsequence length of x[i..] and y[j..].
  const lcs = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1))
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const middle: LineOp[] = []
  let i = 0
  let j = 0
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      middle.push({ op: "same", text: x[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) middle.push({ op: "del", text: x[i++] })
    else middle.push({ op: "add", text: y[j++] })
  }
  while (i < x.length) middle.push({ op: "del", text: x[i++] })
  while (j < y.length) middle.push({ op: "add", text: y[j++] })
  return [
    ...a.slice(0, head).map((text): LineOp => ({ op: "same", text })),
    ...middle,
    ...b.slice(b.length - tail).map((text): LineOp => ({ op: "same", text })),
  ]
}

export interface MessageDiff<M> {
  /** Messages both prompts open with, unchanged. */
  kept: number
  /** What the earlier prompt had past that point — non-empty only when the
      history was rewritten (a compaction, a rewind). */
  removed: M[]
  added: M[]
}

/** Two message lists compared as a conversation: the shared opening, then what
    each has past it. A prompt only ever grows between calls unless something
    rewrote the history, and that is exactly what `removed` says. */
export function diffMessages<M>(before: M[], after: M[]): MessageDiff<M> {
  const same = (m: M, n: M) => JSON.stringify(m) === JSON.stringify(n)
  let kept = 0
  while (kept < before.length && kept < after.length && same(before[kept], after[kept])) kept++
  return { kept, removed: before.slice(kept), added: after.slice(kept) }
}
