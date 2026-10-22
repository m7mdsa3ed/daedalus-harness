/* ── Reading a thread's spans ──
   The pure half of the Trajectory view (`components/trajectory/`): the tree
   the spans form, the turn each belongs to, the figures a span carries and the
   totals across the thread. No React, so `trajectory.check.mjs` can run it.

   What a span *is* comes from the server (`kind`); what it *cost* is read off
   its attributes, preferring the harness's own keys (`daedalus.*`, ms) over the
   GenAI conventions (`gen_ai.*`, where time to first chunk is in seconds). */
import type { TraceAttributeValue, TraceSpan, TraceSpanKind, TraceSpanOtelKind } from "@daedalus/protocol"

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

/* ── Traces ──
   OpenTelemetry's unit is the trace: every span sharing a `traceId`. Here a
   trace is a turn (the harness roots one per turn) or a spawn outside one. */

export interface TraceGroup {
  traceId: string
  roots: SpanNode[]
  spans: TraceSpan[]
  /** Earliest start; and the latest end, null while any span is still open. */
  start: number
  end: number | null
  errors: number
}

/** The forest, grouped by the trace its roots belong to, in start order. */
export function groupTraces(roots: SpanNode[]): TraceGroup[] {
  const by = new Map<string, TraceGroup>()
  for (const root of roots) {
    let group = by.get(root.span.traceId)
    if (!group) by.set(root.span.traceId, (group = { traceId: root.span.traceId, roots: [], spans: [], start: Infinity, end: 0, errors: 0 }))
    group.roots.push(root)
    for (const node of flatten([root])) {
      group.spans.push(node.span)
      group.start = Math.min(group.start, node.span.start)
      if (node.span.status === "error") group.errors++
    }
  }
  for (const group of by.values()) {
    group.end = group.spans.some((span) => span.end === null) ? null : Math.max(...group.spans.map((span) => span.end!))
  }
  return [...by.values()].sort((a, b) => a.start - b.start)
}

/** What a trace was about: the turn's prompt, else its root's name. */
export function traceLabel(group: TraceGroup): string {
  const root = group.roots[0].span
  const prompt = root.attributes["daedalus.prompt"]
  return typeof prompt === "string" && prompt.trim() ? prompt.trim().replace(/\s+/g, " ") : root.name
}

/** Time in a span that none of its children account for: its own work, or
    waiting. Children's overlapping intervals are merged first, so parallel
    children are not subtracted twice. */
export function selfTime(node: SpanNode, now: number): number {
  const end = spanEnd(node.span, now)
  const spans = node.children
    .map((child) => [Math.max(child.span.start, node.span.start), Math.min(spanEnd(child.span, now), end)] as const)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0])
  let covered = 0
  let at = -Infinity
  for (const [a, b] of spans) {
    const from = Math.max(a, at)
    if (b > from) covered += b - from
    at = Math.max(at, b)
  }
  return Math.max(0, end - node.span.start - covered)
}

/** Axis ticks over `[0, duration]` ms at 1/2/5 steps — about `target` of them. */
export function niceTicks(duration: number, target = 5): number[] {
  if (!(duration > 0)) return [0]
  const raw = duration / target
  const pow = 10 ** Math.floor(Math.log10(raw))
  const step = ([1, 2, 5, 10].find((m) => m * pow >= raw) ?? 10) * pow
  const ticks: number[] = []
  for (let t = 0; t <= duration; t += step) ticks.push(t)
  return ticks
}

/** A span's OTel `SpanKind`; a span stored before the server kept it is internal. */
export const otelKindOf = (span: TraceSpan): TraceSpanOtelKind => span.spanKind ?? "internal"

/* ── OTLP/JSON ──
   A span said back in the wire format every collector reads — what Copy as
   OTLP puts on the clipboard. Only what the span carries is written. */

type AnyValue = Record<string, unknown>

function anyValue(value: TraceAttributeValue): AnyValue {
  if (Array.isArray(value)) return { arrayValue: { values: (value as (string | number | boolean)[]).map((v) => anyValue(v)) } }
  if (typeof value === "string") return { stringValue: value }
  if (typeof value === "boolean") return { boolValue: value }
  return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
}

const keyValues = (attributes: Record<string, TraceAttributeValue> | undefined) =>
  Object.entries(attributes ?? {}).map(([key, value]) => ({ key, value: anyValue(value) }))

const nanos = (ms: number) => String(BigInt(Math.round(ms * 1e6)))
const OTLP_KIND = { internal: 1, server: 2, client: 3, producer: 4, consumer: 5 } as const
const OTLP_STATUS = { unset: 0, ok: 1, error: 2 } as const

export function toOtlp(span: TraceSpan): unknown {
  const body = {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    ...(span.traceState ? { traceState: span.traceState } : {}),
    name: span.name,
    kind: OTLP_KIND[otelKindOf(span)],
    startTimeUnixNano: nanos(span.start),
    ...(span.end !== null ? { endTimeUnixNano: nanos(span.end) } : {}),
    attributes: keyValues(span.attributes),
    events: span.events.map((e) => ({ timeUnixNano: nanos(e.at), name: e.name, attributes: keyValues(e.attributes) })),
    links: (span.links ?? []).map((l) => ({ traceId: l.traceId, spanId: l.spanId, attributes: keyValues(l.attributes) })),
    status: { code: OTLP_STATUS[span.status], ...(span.statusMessage ? { message: span.statusMessage } : {}) },
  }
  return {
    resourceSpans: [
      {
        resource: { attributes: keyValues(span.resource) },
        scopeSpans: [{ ...(span.scope ? { scope: span.scope } : {}), spans: [body] }],
      },
    ],
  }
}

/** Every span as one OTLP/JSON document — a file a collector or Jaeger reads. */
export const toOtlpDocument = (spans: TraceSpan[]) => ({
  resourceSpans: spans.flatMap((span) => (toOtlp(span) as { resourceSpans: unknown[] }).resourceSpans),
})

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
  /* A turn span says its own decode time and what was written in it — the
     sum over its model calls (`BridgeTrace.generation`). Duration less TTFT
     would put every tool call of the turn in the denominator. */
  const saidDecode = num(span.attributes["daedalus.decode_ms"])
  const saidTokens = num(span.attributes["daedalus.generated_tokens"])
  const decode =
    span.kind === "turn" && saidDecode !== null
      ? saidDecode
      : duration !== null && ttft !== null
        ? Math.max(0, duration - ttft)
        : null
  const output = span.kind === "turn" && saidTokens !== null ? saidTokens : spanUsage(span).output
  const over = decode ?? (span.kind === "turn" ? null : duration)
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
  /* Token-weighted: tokens over decode time, summed — a mean of per-call
     rates let a 20-token call count as much as a 4,000-token one. */
  let rateTokens = 0
  let rateMs = 0
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
      const output = spanUsage(span).output
      const over = timing.decode ?? timing.duration
      if (timing.tps !== null && output && over) {
        rateTokens += output
        rateMs += over
      }
    }
  }
  if (!modelUsage) for (const span of spans) if (span.kind === "turn") add(span)
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
  t.avgTtft = mean(ttfts)
  t.avgTps = rateMs > 0 ? (rateTokens * 1000) / rateMs : null
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
