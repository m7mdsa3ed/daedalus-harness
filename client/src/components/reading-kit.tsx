/* ── The pieces a reading popover is built from ──
   One look for every popover that says what something cost and how fast it
   went: the composer's context reading, a turn's footer and a step's figure.
   They are the same reading at three scopes, and were three layouts — a tiled
   one in the composer and two flat grids of eight numbers each under the
   transcript, which made the reader hunt for the cache rate in one and not
   find it in the other. */
import * as React from "react"

import { Ring } from "@/components/composer/indicator"
import { formatTokens } from "@/lib/tokens"
import { cn } from "@/lib/utils"

/** A captioned group under a hairline — the popover's one unit. The caption
    may carry a fact at its end (a count, a share). */
export function ReadingSection({ title, meta, children }: { title: string; meta?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 border-t pt-3">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <p className="font-medium text-muted-foreground">{title}</p>
        {meta && <span className="tabular-nums text-muted-foreground">{meta}</span>}
      </div>
      {children}
    </section>
  )
}

/** One figure at a glance: a caption over its value, in a muted tile. Laid
    out in a row of up to three, so the numbers the eye looks for first are
    read across, not hunted down a list. */
export function Tile({ label, value, hint, valueClass }: { label: string; value: string; hint?: string; valueClass?: string }) {
  return (
    <div className="min-w-0 flex-1 basis-0 rounded-lg bg-muted/50 px-2.5 py-2">
      <p className="truncate text-xs text-muted-foreground">{label}</p>
      <p className={cn("truncate text-sm font-medium tabular-nums", valueClass)}>{value}</p>
      {hint && <p className="truncate text-xs tabular-nums text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** A part of a whole: its colour in the stacked bar and its legend row. `tokens`
    is the part's size in whatever the bar measures — tokens, or ms for a
    timeline (`format`). */
export interface BillPart {
  label: string
  tokens: number
  color: string
  /** Overrides `color` — the hatch a part nobody could see is drawn in. */
  style?: React.CSSProperties
  hint?: string
}

/** A part the door could not see: drawn as a hatch, never as a smaller whole. */
export const HATCH: React.CSSProperties = {
  backgroundImage: "repeating-linear-gradient(45deg, transparent 0 3px, var(--border) 3px 5px)",
}

/** A whole as one bar of its parts and a legend — the shape of it, which a
    column of numbers made the reader assemble. `legend: "grid"` lays the rows
    two across, for a bar of six parts in a popover. */
export function BilledBar({
  parts,
  format = formatTokens,
  share = false,
  legend = "list",
}: {
  parts: BillPart[]
  format?: (value: number) => string
  /** Each row's share of the whole after its figure. */
  share?: boolean
  legend?: "list" | "grid"
}) {
  const total = parts.reduce((n, part) => n + part.tokens, 0)
  if (total <= 0) return null
  const shown = parts.filter((part) => part.tokens > 0)
  return (
    <>
      <div className="flex h-2 w-full gap-px overflow-hidden rounded-full bg-muted" aria-hidden>
        {shown.map((part) => (
          <div
            key={part.label}
            className="h-full"
            style={{ width: `${(part.tokens / total) * 100}%`, background: part.color, ...part.style }}
          />
        ))}
      </div>
      <dl className={cn("text-xs", legend === "grid" ? "grid grid-cols-2 gap-x-4 gap-y-1" : "space-y-1")}>
        {shown.map((part) => (
          <div key={part.label} className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden className="size-2 shrink-0 rounded-[3px]" style={{ background: part.color, ...part.style }} />
            <dt className="min-w-0 flex-1 truncate text-muted-foreground">{part.label}</dt>
            {part.hint && <span className="shrink-0 tabular-nums text-muted-foreground">{part.hint}</span>}
            <dd className="shrink-0 font-medium tabular-nums">{format(part.tokens)}</dd>
            {share && (
              <dd className="w-8 shrink-0 text-end tabular-nums text-muted-foreground">
                {Math.round((part.tokens / total) * 100)}%
              </dd>
            )}
          </div>
        ))}
      </dl>
    </>
  )
}

/** One reading against its ceiling — a window's occupancy. */
export function Meter({ value, max, tone }: { value: number; max: number; tone?: "warn" | "error" }) {
  const width = max > 0 ? Math.min(100, (value / max) * 100) : 0
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
      <div
        className={cn("h-full rounded-full", tone === "error" ? "bg-destructive" : tone === "warn" ? "bg-warning" : "bg-primary")}
        style={{ width: `${width}%` }}
      />
    </div>
  )
}

/** Short facts as quiet chips — the tools a request asked for, a source, a
    finish reason. A repeated name is counted rather than drawn twice. */
export function Chips({ items, mono = false }: { items: string[]; mono?: boolean }) {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1)
  if (counts.size === 0) return null
  return (
    <div className="flex flex-wrap gap-1">
      {[...counts].map(([item, n]) => (
        <span
          key={item}
          className={cn("max-w-full truncate rounded-md bg-muted px-1.5 py-0.5 text-[11px] leading-4 text-muted-foreground", mono && "font-mono")}
        >
          {item}
          {n > 1 ? ` ×${n}` : ""}
        </span>
      ))}
    </div>
  )
}

/* ── Where a prompt went ── the parts a door anchors to the billed prompt
   (`ModelCall.prompt`), named and coloured once for every surface. */
export const PROMPT_PART_KEYS = ["system", "tools", "mcp", "user", "assistant", "results"] as const
export type PromptPartKey = (typeof PROMPT_PART_KEYS)[number]
export const PART_LABEL: Record<PromptPartKey, string> = {
  system: "System prompt",
  tools: "Tool definitions",
  mcp: "MCP definitions",
  user: "Your messages",
  assistant: "Assistant replies",
  results: "Tool results",
}
export const PART_COLOR: Record<PromptPartKey, string> = {
  system: "var(--chart-1)",
  tools: "var(--chart-2)",
  mcp: "var(--chart-3)",
  user: "var(--chart-4)",
  assistant: "var(--chart-5)",
  results: "var(--primary)",
}

/** A prompt split as bar parts: each seen part, then what no door could see. */
export function promptBarParts(parts: Record<PromptPartKey, number | null> & { unknown: number }): BillPart[] {
  return [
    ...PROMPT_PART_KEYS.flatMap((key) => (parts[key] ? [{ label: PART_LABEL[key], tokens: parts[key]!, color: PART_COLOR[key] }] : [])),
    ...(parts.unknown > 0 ? [{ label: "Not seen", tokens: parts.unknown, color: "transparent", style: HATCH }] : []),
  ]
}

/** How good a cache rate is, as a text tone: most of the prompt from cache is
    the cache working; a fifth or less is a prefix being rewritten. */
export function cacheTone(percent: number | null): string | undefined {
  if (percent === null) return undefined
  return percent >= 50 ? "text-success" : percent >= 20 ? "text-warning" : "text-destructive"
}

/** `840ms`, `12.4s` — a model request's latency, finer than a turn's `12s`. */
export function formatMs(ms: number): string {
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

/* ── The reading's face ──
   A reading popover is laid out top to bottom as: the one figure (big, with the
   cache ring beside it, because "how much, and did it hit the cache" is the
   question it was opened for), a strip of the figures read next (speed, first
   token, time, cost), the bill split into what went in and what came out side
   by side, and then whatever is left (timing, the prompt's parts, the window,
   the requests) behind tabs, so the popover is one screen tall rather than a
   column of six sections to scroll. */

/** The headline: one figure, what it is, and the share of the prompt read from
    cache as a ring in its tone. A ring and not a number because the eye reads
    "most of it" from the arc before it reads the digits. */
export function ReadingHero({
  value,
  unit,
  caption,
  cache,
}: {
  value: string
  unit: string
  caption?: string
  /** Percent of the prompt read from cache; null when the runtime never said. */
  cache: number | null
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-1.5">
          <span className="text-2xl leading-8 font-semibold tracking-tight tabular-nums">{value}</span>
          <span className="truncate text-xs text-muted-foreground">{unit}</span>
        </p>
        {caption && <p className="truncate text-xs text-muted-foreground">{caption}</p>}
      </div>
      {cache !== null && (
        <div
          className={cn("relative grid size-12 shrink-0 place-items-center", cacheTone(cache))}
          title={`${cache}% of the prompt was read from cache`}
        >
          <Ring percent={cache} className="absolute inset-0 size-12" />
          <span className="flex flex-col items-center leading-none">
            <span className="text-xs font-semibold tabular-nums">{cache}%</span>
            <span className="mt-0.5 text-[9px] text-muted-foreground">cached</span>
          </span>
        </div>
      )}
    </div>
  )
}

/** One fact in the strip: a caption over its value. */
export interface Fact {
  label: string
  value: string
  valueClass?: string
}

/** The figures read after the headline, in one muted band split by hairlines —
    read across, like a receipt's line of totals. A fact with nothing to say is
    left out, never drawn as a dash. */
export function Facts({ items }: { items: (Fact | null | false | undefined | "")[] }) {
  const shown = items.filter((item): item is Fact => !!item)
  if (shown.length === 0) return null
  return (
    <dl className="grid auto-cols-fr grid-flow-col divide-x rounded-lg bg-muted/50 py-2">
      {shown.map((fact) => (
        <div key={fact.label} className="min-w-0 px-2.5">
          <dt className="truncate text-[11px] text-muted-foreground">{fact.label}</dt>
          <dd className={cn("truncate text-sm font-medium tabular-nums", fact.valueClass)}>{fact.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** One tab of the popover's lower half. */
export interface ReadingTab {
  id: string
  label: string
  /** A fact at the strip's end while this tab is open — a total, a share. */
  meta?: string
  content: React.ReactNode
}

/** The detail behind the bill, one view at a time. A tab with nothing to show
    is left out by its caller; the first one left is open. Its state is the
    popover's own and resets when it closes, which is the moment a reader is
    done with it. */
export function ReadingTabs({
  tabs,
  value,
  onChange,
}: {
  tabs: (ReadingTab | null | false | undefined | 0)[]
  /** Held by the caller when something outside the tabs opens one. */
  value?: string
  onChange?: (id: string) => void
}) {
  const shown = tabs.filter((tab): tab is ReadingTab => !!tab)
  const [own, setOwn] = React.useState<string | undefined>(undefined)
  const active = value ?? own
  const setActive = (id: string) => (onChange ? onChange(id) : setOwn(id))
  const refs = React.useRef<(HTMLButtonElement | null)[]>([])
  const current = shown.find((tab) => tab.id === active) ?? shown[0]
  if (!current) return null
  const index = shown.indexOf(current)
  const go = (next: number) => {
    const tab = shown[(next + shown.length) % shown.length]
    setActive(tab.id)
    refs.current[shown.indexOf(tab)]?.focus()
  }
  return (
    <section className="space-y-3 border-t pt-2">
      <div className="flex items-center gap-3 text-xs">
        <div
          role="tablist"
          className="flex items-center gap-3"
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") go(index + 1)
            else if (event.key === "ArrowLeft") go(index - 1)
            else return
            event.preventDefault()
          }}
        >
          {shown.map((tab, i) => {
            const selected = tab === current
            return (
              <button
                key={tab.id}
                ref={(node) => {
                  refs.current[i] = node
                }}
                type="button"
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => setActive(tab.id)}
                className={cn(
                  "relative rounded-sm py-1 font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  selected
                    ? "text-foreground after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {tab.label}
              </button>
            )
          })}
        </div>
        {current.meta && <span className="ms-auto shrink-0 tabular-nums text-muted-foreground">{current.meta}</span>}
      </div>
      <div role="tabpanel" className="space-y-2">
        {current.content}
      </div>
    </section>
  )
}

/* ── A bill, in full ──
   Every field a bill can carry, always as a row, in two columns: what went in
   (read from the cache, written to it, sent uncached) beside what came out
   (reasoning, text, tool calls), and the total under both. Side by side
   because the two are never the same order of magnitude — one bar over both
   drew the output as a hairline — and each column's bar is its own whole. A
   field the runtime did not report says so in words rather than vanishing: a
   reader asking "was there reasoning?" must be able to tell "none" from "not
   said". */

/** One row: a figure, `null` for not reported; `approx` for a door's estimate. */
interface BreakdownRow {
  label: string
  value: number | null
  color: string
  approx?: boolean
  hint?: string
}

/** What a door estimated the output was made of (`ModelCall.output`). */
export type OutputSplit = { text: number; reasoning: number; toolCalls: number }

export function TokenBreakdown({
  usage,
  split,
}: {
  usage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    cachedReadTokens?: number | null
    cachedWriteTokens?: number | null
    thoughtTokens?: number | null
  }
  /** The output by kind, when a door counted it — drawn with a tilde. */
  split?: OutputSplit | null
}) {
  const read = usage.cachedReadTokens ?? null
  const write = usage.cachedWriteTokens ?? null
  const prompt = usage.inputTokens + (read ?? 0) + (write ?? 0)
  const reasoning = usage.thoughtTokens ?? null
  const input: BreakdownRow[] = [
    { label: "Cache read", value: read, color: "var(--chart-2)" },
    { label: "Cache write", value: write, color: "var(--chart-3)" },
    {
      label: "Uncached",
      value: usage.inputTokens,
      color: "var(--chart-1)",
      /* Anthropic counts only what follows the last cache breakpoint here, so a
         cached run reads a few tokens; the new content is the cache write. */
      hint: read !== null && usage.inputTokens < 16 && prompt > 1_000 ? "after breakpoint" : undefined,
    },
  ]
  const output: BreakdownRow[] = split
    ? [
        { label: "Reasoning", value: reasoning ?? split.reasoning, color: "var(--chart-5)", approx: reasoning === null },
        { label: "Text", value: split.text, color: "var(--chart-4)", approx: true },
        { label: "Tool calls", value: split.toolCalls, color: "var(--primary)", approx: true },
      ]
    : [
        { label: "Reasoning", value: reasoning, color: "var(--chart-5)" },
        {
          label: "Text & tools",
          value: Math.max(0, usage.outputTokens - (reasoning ?? 0)),
          color: "var(--chart-4)",
          hint: reasoning === null ? "may hold reasoning" : undefined,
        },
      ]
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-x-4">
        <BreakdownGroup title="Input" total={prompt} rows={input} />
        <BreakdownGroup title="Output" total={usage.outputTokens} rows={output} />
      </div>
      <div className="flex items-baseline justify-between border-t border-dashed pt-1.5 text-xs">
        <span className="text-muted-foreground">Total billed</span>
        <span className="font-semibold tabular-nums">{formatTokens(usage.totalTokens)}</span>
      </div>
    </div>
  )
}

function BreakdownGroup({ title, total, rows }: { title: string; total: number; rows: BreakdownRow[] }) {
  const sum = rows.reduce((n, row) => n + (row.value ?? 0), 0)
  const percent = (value: number) => (sum > 0 ? `${Math.round((value / sum) * 100)}%` : "")
  return (
    /* A container, so the per-row share shows only where the column has room
       for it — the composer's popover is narrower than a step's. */
    <div className="@container min-w-0 space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{title}</span>
        <span className="text-sm font-semibold tabular-nums">{formatTokens(total)}</span>
      </div>
      <div className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-muted" aria-hidden>
        {sum > 0 &&
          rows.map((row) =>
            row.value ? (
              <div key={row.label} className="h-full" style={{ width: `${(row.value / sum) * 100}%`, background: row.color }} />
            ) : null
          )}
      </div>
      <dl className="space-y-1 text-xs">
        {rows.map((row) => (
          <div
            key={row.label}
            title={row.value === null ? `${row.label}: not reported` : `${row.label}: ${row.value.toLocaleString()} (${percent(row.value)})`}
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <span aria-hidden className="size-2 shrink-0 rounded-[3px]" style={{ background: row.color, opacity: row.value ? 1 : 0.35 }} />
              <dt className="min-w-0 flex-1 truncate text-muted-foreground">{row.label}</dt>
              {row.value === null ? (
                <dd className="shrink-0 text-[11px] text-muted-foreground italic">not reported</dd>
              ) : (
                <>
                  <dd className="shrink-0 font-medium tabular-nums">
                    {row.approx ? "~" : ""}
                    {formatTokens(row.value)}
                  </dd>
                  <dd className="hidden w-8 shrink-0 text-end text-[11px] tabular-nums text-muted-foreground @min-[10.5rem]:block">
                    {percent(row.value)}
                  </dd>
                </>
              )}
            </div>
            {row.hint && <p className="ps-3.5 text-[10px] leading-3 text-muted-foreground/80">{row.hint}</p>}
          </div>
        ))}
      </dl>
    </div>
  )
}

/** Several calls' output splits as one, or null when none was counted. */
export function sumSplits(splits: (OutputSplit | undefined)[]): OutputSplit | null {
  let out: OutputSplit | null = null
  for (const s of splits) {
    if (!s) continue
    out = out ? { text: out.text + s.text, reasoning: out.reasoning + s.reasoning, toolCalls: out.toolCalls + s.toolCalls } : { ...s }
  }
  return out
}

/** The width every reading popover in the transcript opens at, held to what
    the viewport leaves (`--available-width`, Base UI's). */
export const READING_WIDTH = "w-[22rem] max-w-(--available-width)"
