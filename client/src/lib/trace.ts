/* ── Model calls, read ──
   The pure half of the Trace panel: how a thread's `ModelCall` records
   (`_daedalus/model_call`, filed in `ThreadState.calls`) are grouped, summed
   and worded. Nothing here branches on `source` or on the runtime — the record
   is the contract (docs/protocol.md "Model calls") and `missing` is drawn in
   the door's own words. Type imports only, so `trace.check.mjs` runs it under
   plain Node. */
import type * as acp from "@daedalus/acp"
import type { CallsVia, ModelCall, PrefixItem, PrefixItems, PromptParts } from "@daedalus/protocol"
import type { ThreadItem } from "./store"

/** A record as the thread holds it: the turn it was filed under, which the
    server knows and the wire record does not carry. Null for a call outside any
    turn (a title call after the turn ended, a record on an old journal). */
export type ThreadCall = ModelCall & { turnId: string | null }

/** The turn a record arriving now belongs to: the newest user bubble's. The
    harness's `turn_started` is the only thing that mints a `turnId`, and it
    lands before the turn's first call can. */
export function openTurnId(items: readonly ThreadItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind === "user" && item.turnId && !item.parentId) return item.turnId
  }
  return null
}

/** File one record; the same `callId` twice is the same news (a fan-out and a
    cold read of the route both say it) and must not row twice. */
export function fileCall(calls: readonly ThreadCall[], call: ModelCall, turnId: string | null, childId?: string): ThreadCall[] {
  if (calls.some((c) => c.callId === call.callId)) return calls as ThreadCall[]
  return [...calls, { ...call, ...(childId && !call.childId ? { childId } : {}), turnId }]
}

/** Records from the route and the ones the socket filed, as one list in `at`
    order — the route answers the turns the window withheld. */
export function mergeCalls(stored: readonly ThreadCall[], live: readonly ThreadCall[]): ThreadCall[] {
  let out: ThreadCall[] = [...stored]
  for (const call of live) out = fileCall(out, call, call.turnId, call.childId)
  return out.sort((a, b) => a.at - b.at)
}

export interface Billed {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning: number
  /** Everything sent up — fresh, read and written. */
  prompt: number
}

export function billedOf(usage: acp.Usage): Billed {
  const input = usage.inputTokens
  const cacheRead = usage.cachedReadTokens ?? 0
  const cacheWrite = usage.cachedWriteTokens ?? 0
  return { input, cacheRead, cacheWrite, output: usage.outputTokens, reasoning: usage.thoughtTokens ?? 0, prompt: input + cacheRead + cacheWrite }
}

export function sumBilled(calls: readonly ModelCall[]): Billed {
  const total: Billed = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, prompt: 0 }
  for (const call of calls) {
    const b = billedOf(call.billed)
    total.input += b.input
    total.cacheRead += b.cacheRead
    total.cacheWrite += b.cacheWrite
    total.output += b.output
    total.reasoning += b.reasoning
    total.prompt += b.prompt
  }
  return total
}

export const PART_KEYS = ["system", "tools", "mcp", "user", "assistant", "results"] as const
export type PartKey = (typeof PART_KEYS)[number]

/** The ~ parts over several calls, null-aware: a part is null when no call
    could see it — its share is already inside each call's `unknown`. Null
    when no call carried a prompt split at all. */
export function sumParts(calls: readonly ModelCall[]): PromptParts | null {
  let out: PromptParts | null = null
  for (const call of calls) {
    if (!call.prompt) continue
    out ??= { system: null, tools: null, mcp: null, user: null, assistant: null, results: null, unknown: 0 }
    for (const key of PART_KEYS) {
      const value = call.prompt[key]
      if (value !== null) out[key] = (out[key] ?? 0) + value
    }
    out.unknown += call.prompt.unknown
  }
  return out
}

/** Share of the prompt that came from cache, 0–1; null with nothing sent. */
export function cacheSaved(billed: Billed): number | null {
  return billed.prompt > 0 ? billed.cacheRead / billed.prompt : null
}

/** Only what a runtime reported; null when none did. */
export function costOf(calls: readonly ModelCall[]): number | null {
  let total: number | null = null
  for (const call of calls) if (call.costUsd !== undefined) total = (total ?? 0) + call.costUsd
  return total
}

/** The newest prefix breakdown — sent when the prefix changes, never every step. */
export function latestItems(calls: readonly ModelCall[]): PrefixItems | null {
  for (let i = calls.length - 1; i >= 0; i--) if (calls[i].items) return calls[i].items!
  return null
}

/** Calls by turn, in first-seen order; `null` is the turnless bucket. */
export function byTurn(calls: readonly ThreadCall[]): Map<string | null, ThreadCall[]> {
  const groups = new Map<string | null, ThreadCall[]>()
  for (const call of calls) {
    const group = groups.get(call.turnId)
    if (group) group.push(call)
    else groups.set(call.turnId, [call])
  }
  return groups
}

/** Every reason a part is unseen, each once, in the doors' own words. */
export function missingWords(calls: readonly ModelCall[]): string[] {
  const seen = new Set<string>()
  for (const call of calls) for (const word of call.missing ?? []) seen.add(word)
  return [...seen]
}

/* ── tools and MCP servers ── */

/** The MCP server a tool name belongs to — `mcp__<server>__<tool>` (Claude
    Code, OpenCode, our runtime) or `mcp.<server>.<tool>` (Codex) — else null.
    The same split `lib/tools` makes; repeated here so this file stays
    type-import-only and runs under plain Node. */
export function mcpOfName(name: string): { server: string; tool: string } | null {
  const dotted = /^mcp\.([^.]+)\.(.+)$/.exec(name)
  if (dotted) return { server: dotted[1], tool: dotted[2] }
  if (!name.startsWith("mcp__")) return null
  const rest = name.slice("mcp__".length)
  const sep = rest.indexOf("__")
  /* `mcp__web-search instructions` (a server's guidance, not a tool). */
  if (sep <= 0) {
    const [server, ...words] = rest.split(" ")
    return { server, tool: words.join(" ") }
  }
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) }
}

/** One tool, across a thread's calls: how often the model asked for it, the
    ~ tokens its calls and results took in the history the newest call carried,
    and its definition's share of the prefix. */
export interface ToolStat {
  name: string
  /** The MCP server, or null for a built-in. */
  server: string | null
  /** The tool's own name inside its server (the whole name for a built-in). */
  tool: string
  /** Times a response asked for it (`ModelCall.called`). */
  called: number
  /** Its calls in the newest history (`toolUse.calls`). */
  inHistory: number
  /** ~ Billed tokens of its calls and results in that history. */
  args: number
  results: number
  /** ~ Billed tokens its definition costs on every call; null when the
      prefix was not split or the tool was not listed in it. */
  schema: number | null
}

/** One MCP server (or "built-in"), its tools folded together. */
export interface ServerStat {
  /** null for the built-in tools. */
  server: string | null
  tools: ToolStat[]
  called: number
  args: number
  results: number
  schema: number | null
}

/** Prefix items in billed tokens: the items are raw local counts, so each is
    worth its part times its share of the list. Biggest first; empty when the
    part was not seen. */
export function anchorItems(items: readonly PrefixItem[], part: number | null): PrefixItem[] {
  const total = items.reduce((n, item) => n + item.tokens, 0)
  if (part === null || total <= 0) return []
  return items
    .map((item) => ({ name: item.name, tokens: Math.round((item.tokens / total) * part) }))
    .sort((a, b) => b.tokens - a.tokens)
}

const schemaTokens = (items: PrefixItem[], part: number | null) =>
  new Map(anchorItems(items, part).map((item) => [item.name, item.tokens]))

/** The prefix a call was sent with: its own, else the newest one before it
    (a prefix is said only when it changes). */
export function itemsAt(calls: readonly ModelCall[], index: number): PrefixItems | null {
  for (let i = index; i >= 0; i--) if (calls[i].items) return calls[i].items!
  return null
}

/**
 * Every tool the thread touched or carried, one row each. The history figures
 * are the **newest** call's (a history is re-sent every step, so summing calls
 * would count one result as many times as there were steps after it) and the
 * schema is the newest prefix's, anchored to that call's `tools`/`mcp` parts.
 * `called` is summed over every call, because each response is its own news.
 */
export function toolStats(calls: readonly ModelCall[]): ToolStat[] {
  const stats = new Map<string, ToolStat>()
  const stat = (name: string): ToolStat => {
    let entry = stats.get(name)
    if (!entry) {
      const mcp = mcpOfName(name)
      entry = { name, server: mcp?.server ?? null, tool: mcp?.tool || name, called: 0, inHistory: 0, args: 0, results: 0, schema: null }
      stats.set(name, entry)
    }
    return entry
  }
  for (const call of calls) for (const name of call.called ?? []) stat(name).called += 1
  let history: ModelCall | undefined
  for (let i = calls.length - 1; i >= 0 && !history; i--) if (calls[i].toolUse) history = calls[i]
  for (const use of history?.toolUse ?? []) {
    const entry = stat(use.name)
    entry.inHistory = use.calls
    entry.args = use.args
    entry.results = use.results
  }
  /* The newest call that carried a split, and the prefix it was sent with. */
  let index = -1
  for (let i = calls.length - 1; i >= 0 && index < 0; i--) if (calls[i].prompt) index = i
  if (index >= 0) {
    const items = itemsAt(calls, index)
    if (items) {
      const prompt = calls[index].prompt!
      for (const [name, tokens] of schemaTokens(items.tools, prompt.tools)) stat(name).schema = tokens
      for (const [name, tokens] of schemaTokens(items.mcp, prompt.mcp)) stat(name).schema = tokens
    }
  }
  return [...stats.values()].sort(
    (a, b) => b.args + b.results + (b.schema ?? 0) - (a.args + a.results + (a.schema ?? 0)) || b.called - a.called
  )
}

/** The tools folded by MCP server (built-ins as `null`), heaviest first. */
export function serverStats(tools: readonly ToolStat[]): ServerStat[] {
  const groups = new Map<string | null, ServerStat>()
  for (const tool of tools) {
    let group = groups.get(tool.server)
    if (!group) groups.set(tool.server, (group = { server: tool.server, tools: [], called: 0, args: 0, results: 0, schema: null }))
    group.tools.push(tool)
    group.called += tool.called
    group.args += tool.args
    group.results += tool.results
    if (tool.schema !== null) group.schema = (group.schema ?? 0) + tool.schema
  }
  const weight = (g: ServerStat) => g.args + g.results + (g.schema ?? 0)
  return [...groups.values()].sort((a, b) => weight(b) - weight(a) || b.called - a.called)
}

/** A call's tools in order with repeats folded: `[["bash", 2], ["read", 1]]`. */
export function calledCounts(call: Pick<ModelCall, "called">): [string, number][] {
  const out = new Map<string, number>()
  for (const name of call.called ?? []) out.set(name, (out.get(name) ?? 0) + 1)
  return [...out]
}

/* ── the time between calls ── */

/** One thing that filled part of a gap. `kind` is the cause class; `label` names
    the particular (the tool, the subagent). */
export interface GapReason {
  kind: "tool" | "permission" | "subagent" | "compaction" | "idle" | "paused" | "retry"
  label: string
  ms: number
}

/** Where time nothing named a cause for fell, relative to the tools that ran in
    the gap — the one thing the thread's own clock can still say about it. */
export type SilenceWhere = "quiet" | "before-tools" | "between-tools" | "after-tools"

export interface Silence {
  where: SilenceWhere
  ms: number
}

/** What the agent itself booked against the wait before a model request
    (`_meta.daedalus.lead` on its first tool call). A reader hands this in
    because the `_meta` namespace is `lib/tools`' to spell, not this file's. */
export interface GapLead {
  heldMs?: number
  compactMs?: number
  retryMs?: number
}

/** The silence between a call's response and the next request on the same lane,
    and what the thread's own record says happened in it. */
export interface Gap {
  /** The response of the previous call (epoch ms). */
  from: number
  /** The next request. */
  to: number
  ms: number
  /** Biggest first; sums, with `unaccounted`, to `ms`. */
  reasons: GapReason[]
  /** Time nothing recorded a cause for — the provider queueing, the network, a
      harness stall. Said as such, never folded into a reason. */
  unaccounted: number
  /** `unaccounted`, split by where it fell among the tools; sums to it, biggest
      first. Empty when there is none. */
  silences: Silence[]
}

type Span = [number, number]

/** Claim the part of `span` inside `window` that no earlier claim holds, and
    return how much that was. `claimed` stays sorted and disjoint. */
function claim(window: Span, claimed: Span[], span: Span): number {
  const start = Math.max(window[0], span[0])
  const end = Math.min(window[1], span[1])
  if (!(end > start)) return 0
  let free = 0
  let cursor = start
  for (const [s, e] of claimed) {
    if (e <= cursor) continue
    if (s >= end) break
    if (s > cursor) free += s - cursor
    cursor = Math.max(cursor, e)
    if (cursor >= end) break
  }
  if (cursor < end) free += end - cursor
  if (free > 0) {
    claimed.push([start, end])
    claimed.sort((a, b) => a[0] - b[0])
    const merged: Span[] = []
    for (const span of claimed) {
      const last = merged[merged.length - 1]
      if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1])
      else merged.push([span[0], span[1]])
    }
    claimed.splice(0, claimed.length, ...merged)
  }
  return free
}

const laneOf = (call: ModelCall) => call.childId ?? ""

/**
 * For every call that follows another on its lane (the thread's own, or one
 * subagent's), the gap before it and what filled it, keyed by `callId`.
 *
 * A gap is read, never guessed: it is split among what the thread's items say
 * was running (tool calls, less the permission waits they carry; a subagent's
 * model calls; compactions), then "waiting for you" when a user message ended it, and the
 * rest is `unaccounted`. Overlapping causes (parallel tools) are counted once,
 * the earlier-started claiming the time. A call whose predecessor's response
 * time is unknown has no gap — start-to-start would be a lie about idleness.
 * Titles and compactions run beside the turn and are neither end nor start.
 *
 * `leadOf` reads the agent's own bookkeeping off a tool call (held, retry
 * backoff, compaction); what it booked is taken out of the leftover, latest
 * time first, because those waits sit right before the request they delayed.
 * What stays unaccounted is placed among the tools (`silences`).
 */
export function gapsOf(
  calls: readonly ThreadCall[],
  items: readonly ThreadItem[],
  leadOf?: (tool: Extract<ThreadItem, { kind: "tool" }>) => GapLead | undefined
): Map<string, Gap> {
  const gaps = new Map<string, Gap>()
  const lanes = new Map<string, ThreadCall>()
  const sorted = [...calls].sort((a, b) => a.at - b.at)
  for (const call of sorted) {
    if (call.who === "title" || call.who === "compaction") continue
    const lane = laneOf(call)
    const prev = lanes.get(lane)
    lanes.set(lane, call)
    if (!prev || prev.ms === undefined) continue
    const from = prev.at + prev.ms
    const to = call.at
    if (!(to > from)) continue
    const window: Span = [from, to]
    const claimed: Span[] = []
    const reasons = new Map<string, GapReason>()
    const add = (kind: GapReason["kind"], label: string, ms: number) => {
      if (ms <= 0) return
      const key = `${kind}:${label}`
      const entry = reasons.get(key)
      if (entry) entry.ms += ms
      else reasons.set(key, { kind, label, ms })
    }
    const owner = lane ? `subagent:${lane}` : undefined
    const toolSpans: Span[] = []
    /* Tools first: a tool that ran is the best explanation there is. */
    const tools = items
      .filter((i): i is Extract<ThreadItem, { kind: "tool" }> => i.kind === "tool" && i.parentId === owner && i.endedAt !== undefined)
      .sort((a, b) => a.startedAt - b.startedAt)
    for (const tool of tools) {
      const held = claim(window, claimed, [tool.startedAt, tool.endedAt!])
      if (held <= 0) continue
      toolSpans.push([Math.max(from, tool.startedAt), Math.min(to, tool.endedAt!)])
      /* The wait is the reader's, not the tool's: split it out of what it held. */
      const waited = Math.min(held, tool.waitedMs ?? 0)
      add("permission", tool.title, waited)
      add("tool", tool.name ?? tool.title, held - waited)
    }
    for (const other of sorted) {
      if (other === call || other.at >= to) continue
      const end = other.ms === undefined ? undefined : other.at + other.ms
      if (end === undefined) continue
      if (other.who === "compaction" && laneOf(other) === lane) add("compaction", "context compaction", claim(window, claimed, [other.at, end]))
      else if (lane === "" && other.childId) add("subagent", "subagent calls", claim(window, claimed, [other.at, end]))
    }
    /* A new turn begins with a message: before it, the thread was waiting on the reader. */
    if (lane === "") {
      let said: number | undefined
      for (const item of items) if (item.kind === "user" && !item.parentId && item.at !== undefined && item.at > from && item.at <= to) said = item.at
      if (said !== undefined) add("idle", "waiting for you", claim(window, claimed, [from, said]))
    }
    const ms = to - from
    /* The free stretches of the window, in time order, placed among the tools. */
    const free: { where: SilenceWhere; ms: number }[] = []
    const firstTool = toolSpans.length ? Math.min(...toolSpans.map((t) => t[0])) : undefined
    const lastTool = toolSpans.length ? Math.max(...toolSpans.map((t) => t[1])) : undefined
    let cursor = from
    for (const [s, e] of [...claimed, [to, to] as Span]) {
      if (s > cursor) {
        const where: SilenceWhere =
          firstTool === undefined || lastTool === undefined ? "quiet" : s <= firstTool ? "before-tools" : cursor >= lastTool ? "after-tools" : "between-tools"
        free.push({ where, ms: s - cursor })
      }
      cursor = Math.max(cursor, e)
    }
    /* What the agent booked, out of the leftover: it sat just before the request. */
    const lead = leadOf ? firstLead(items, owner, call, leadOf) : undefined
    if (lead) {
      const book = (kind: GapReason["kind"], label: string, booked: number | undefined) => {
        let left = Math.round(booked ?? 0)
        for (let i = free.length - 1; i >= 0 && left > 0; i--) {
          const take = Math.min(left, free[i].ms)
          free[i].ms -= take
          left -= take
          add(kind, label, take)
        }
      }
      book("paused", "held by you (paused)", lead.heldMs)
      book("retry", "backing off a failed request", lead.retryMs)
      if (![...reasons.values()].some((r) => r.kind === "compaction")) book("compaction", "context compaction", lead.compactMs)
    }
    const silences = new Map<SilenceWhere, number>()
    for (const piece of free) if (piece.ms > 0) silences.set(piece.where, (silences.get(piece.where) ?? 0) + piece.ms)
    const explained = [...reasons.values()].reduce((n, r) => n + r.ms, 0)
    gaps.set(call.callId, {
      from,
      to,
      ms,
      reasons: [...reasons.values()].sort((a, b) => b.ms - a.ms),
      unaccounted: Math.max(0, ms - explained),
      silences: [...silences].map(([where, span]) => ({ where, ms: span })).sort((a, b) => b.ms - a.ms),
    })
  }
  return gaps
}

/** The lead the agent stamped on the first tool call of this request: the
    earliest call on the same owner that began while the response was streaming. */
function firstLead(
  items: readonly ThreadItem[],
  owner: string | undefined,
  call: ThreadCall,
  leadOf: (tool: Extract<ThreadItem, { kind: "tool" }>) => GapLead | undefined
): GapLead | undefined {
  const until = call.at + (call.ms ?? 0) + 1000
  let best: { at: number; lead: GapLead } | undefined
  for (const item of items) {
    if (item.kind !== "tool" || item.parentId !== owner || item.startedAt < call.at || item.startedAt > until) continue
    if (best && item.startedAt >= best.at) continue
    const lead = leadOf(item)
    if (lead) best = { at: item.startedAt, lead }
  }
  return best?.lead
}

/** What the door is, in the panel's words. */
export const DOOR_WORDS: Record<CallsVia, string> = {
  acp: "Records from the agent itself: it counts every call at the seam it sends it from.",
  otlp: "Records from the runtime's telemetry, paired with the request bodies it exports.",
  proxy: "Records from the gateway: the request and the bill as they pass through the shim.",
  files: "Records from the runtime's saved session files on this machine.",
  usage: "The provider's bill per step only — no door into this runtime's prompts, so no split.",
}

/**
 * Billed-only rows for a thread with no records at all — a journal written
 * before the door existed. The per-step reading `markStepUsage` filed is the
 * same bill a `usage` record carries, so the panel can still say what each
 * step cost. ponytail: an old journal only; a thread on any door has records.
 */
export function rowsFromStepUsage(
  items: readonly ThreadItem[],
  stepUsage: Readonly<Record<string, acp.UsageUpdate>>,
  stepAt: Readonly<Record<string, number>>,
  model: string
): ThreadCall[] {
  const rows: ThreadCall[] = []
  let turnId: string | null = null
  let step = 0
  for (const item of items) {
    if (item.parentId) continue
    if (item.kind === "user" && item.turnId) {
      turnId = item.turnId
      step = 0
    }
    const reading = stepUsage[item.id]
    if (!reading) continue
    rows.push({
      callId: `step:${item.id}`,
      at: stepAt[item.id] ?? 0,
      who: "turn",
      step: ++step,
      model,
      source: "usage",
      billed: { totalTokens: reading.used, inputTokens: reading.used, outputTokens: 0 },
      turnId,
    })
  }
  return rows
}
