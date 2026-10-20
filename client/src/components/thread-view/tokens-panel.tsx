/* ── The Tokens panel ──
   The one place the harness divides tokens. Two readings, kept apart because
   they are not the same kind of fact:

   - **Billed** is the provider's own count — fresh input, cache read, cache
     write, output, of which reasoning. Exact, and every runtime reports it.
   - **Prompt** is what a request held — system prompt, built-in tools, MCP
     tools, your messages, the assistant's replies, tool results. Our runtime
     measures it; any other is *inferred* from the transcript, with what is left
     of the request called agent overhead (`lib/token-breakdown.ts`). Both sum to
     the request's real total and both are estimates, so each carries a `~`.

   Both are read per step — one model request — never per turn: a turn is the
   tag on a step's row. Only Billed's total sums turns, because a runtime that
   bills per step at all is the exception (`stepBill`).

   Nothing else in the app prints an estimate: the composer's popovers and the
   transcript's footers show only what was reported. */
import * as React from "react"
import { ChevronRightIcon } from "lucide-react"

import { Empty } from "@/components/empty"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import {
  BILLED_PARTS,
  PROMPT_PARTS,
  billedParts,
  promptParts,
  requestDetail,
  spendTime,
  stepBill,
  subagentSpend,
  sumPromptParts,
  tokensByTurn,
  type DetailItem,
  type PromptKey,
  type PromptParts,
  type SubagentSpend,
  type TurnStep,
} from "@/lib/token-breakdown"
import { formatDuration, formatTokens, promptTokens, sumUsage, windowEstimated } from "@/lib/tokens"
import type { ThreadState } from "@/lib/store"
import { cn } from "@/lib/utils"

const pct = (n: number, total: number) => (total > 0 ? `${Math.round((n / total) * 100)}%` : "—")
const about = (n: number) => `~${formatTokens(n)}`
const sum = (parts: PromptParts) => Object.values(parts).reduce((n, v) => n + v, 0)
/** The columns the request chart draws, newest last — more would be slivers. */
const CHART_MAX = 48

/** A figure tile inside an `InspectorCard` body: its corner is the card's
    less the body's padding (`frame-2xl` / `frame-p-3` → `rounded-inner`). */
export const INSPECTOR_TILE = "rounded-inner bg-muted px-3 py-2"

/** One card of an inspector reading (Details, Tokens): a caption strip — its
    mark, its title and a hint at the end — over the card's body. The one
    shape, so every reading's cards are the same card. */
export function InspectorCard({
  title,
  icon,
  hint,
  children,
}: {
  title: React.ReactNode
  icon?: React.ReactNode
  hint?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Card size="sm" className="frame-2xl gap-0 py-0">
      <div className="flex min-w-0 items-center gap-2 border-b px-3 py-2">
        <h2 className="flex min-w-0 flex-1 items-center gap-2 text-xs font-medium text-muted-foreground [&_svg:not([class*='size-'])]:size-3">
          {icon}
          {title}
        </h2>
        {hint && <span className="shrink-0 truncate text-xs text-muted-foreground">{hint}</span>}
      </div>
      <div className="frame-p-3">{children}</div>
    </Card>
  )
}

function Tag({ children }: { children: React.ReactNode }) {
  return <Badge variant="secondary">{children}</Badge>
}

/** Segments in one line, each its share of `total`. A part with nothing in it
    draws nothing rather than a hairline. */
function StackBar({
  parts,
  total,
  label,
  className,
}: {
  parts: { swatch: string; tokens: number }[]
  total: number
  label: string
  className?: string
}) {
  return (
    <span role="img" aria-label={label} className={cn("flex h-2 w-full gap-px overflow-hidden rounded-full bg-muted", className)}>
      {parts.map((part, i) =>
        part.tokens > 0 ? <span key={i} className={cn("block", part.swatch)} style={{ width: `${(part.tokens / total) * 100}%` }} /> : null
      )}
    </span>
  )
}

/** A thin bar for a share of a whole, under a row's name. */
function ShareBar({ swatch, value, total }: { swatch: string; value: number; total: number }) {
  return (
    <span className="mt-1 block h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
      <span className={cn("block h-full rounded-full", swatch)} style={{ width: `${total > 0 ? Math.max(2, (value / total) * 100) : 0}%` }} />
    </span>
  )
}

interface Row {
  label: string
  /** A muted note after the name — a child's time, say. */
  hint?: string
  swatch: string
  value: number
}

/** A legend that is also the table: swatch, name over its share bar, figure and
    percentage. A row with nothing in it is not drawn. */
function Rows({ rows, total }: { rows: Row[]; total: number }) {
  return (
    <div className="mt-3 grid grid-cols-[auto_1fr_auto] items-start gap-x-2 gap-y-2 text-xs tabular-nums">
      {rows
        .filter((row) => row.value > 0)
        .map((row) => (
          <React.Fragment key={row.label}>
            <span className={cn("mt-1 size-2 rounded-sm", row.swatch)} />
            <span className="min-w-0">
              <span className="block truncate">
                {row.label}
                {row.hint && <span className="text-muted-foreground"> · {row.hint}</span>}
              </span>
              <ShareBar swatch={row.swatch} value={row.value} total={total} />
            </span>
            <span className="text-right">
              {formatTokens(row.value)} <span className="inline-block w-8 text-muted-foreground">{pct(row.value, total)}</span>
            </span>
          </React.Fragment>
        ))}
    </div>
  )
}

type Tone = "ok" | "warn" | "bad"
const TONE_TEXT: Record<Tone, string> = {
  ok: "text-success",
  warn: "text-warning",
  bad: "text-destructive",
}
const TONE_FILL: Record<Tone, string> = { ok: "bg-success", warn: "bg-warning", bad: "bg-destructive" }

/** One headline figure: label, value, and a line of what it is made of. */
function Tile({ label, value, hint, tone, fill }: { label: string; value: string; hint?: string; tone?: Tone; fill?: number }) {
  return (
    <div className={cn("min-w-0", INSPECTOR_TILE)}>
      <p className="truncate text-xs text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-base font-medium leading-none tabular-nums", tone && TONE_TEXT[tone])}>{value}</p>
      {fill !== undefined && (
        <span className="mt-2 block h-1 overflow-hidden rounded-full bg-background" aria-hidden>
          <span className={cn("block h-full rounded-full", TONE_FILL[tone ?? "ok"])} style={{ width: `${Math.min(100, fill)}%` }} />
        </span>
      )}
      {hint && <p className="mt-1 truncate text-xs text-muted-foreground" title={hint}>{hint}</p>}
    </div>
  )
}

/** How many of a list's rows are drawn before "N more" — a thread with two
    hundred tool results is a scroll, not a reading. */
const LIST_MAX = 12

function ItemList({ items, part }: { items: { name: string; tokens: number }[]; part: number }) {
  const [all, setAll] = React.useState(false)
  const shown = all ? items : items.slice(0, LIST_MAX)
  return (
    <ul className="space-y-1">
      {shown.map((item, i) => (
        <li key={i} className="grid grid-cols-[1fr_auto_2rem] items-baseline gap-x-2 tabular-nums">
          <span className="min-w-0 truncate" title={item.name}>{item.name}</span>
          <span className="text-right">{about(item.tokens)}</span>
          <span className="text-right text-muted-foreground">{pct(item.tokens, part)}</span>
        </li>
      ))}
      {items.length > LIST_MAX && (
        <li>
          <button type="button" className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => setAll(!all)}>
            {all ? "Show fewer" : `${items.length - LIST_MAX} more`}
          </button>
        </li>
      )}
    </ul>
  )
}

/** One part's contents: its items, a group opening onto its children. */
function PartItems({ items, part }: { items: DetailItem[]; part: number }) {
  return (
    <div className="space-y-1 py-1 pl-4 text-xs">
      {items.map((item, i) =>
        item.children ? (
          <details key={i} className="group/item">
            <summary className="grid cursor-pointer list-none grid-cols-[1fr_auto_2rem] items-baseline gap-x-2 tabular-nums">
              <span className="flex min-w-0 items-center gap-1 font-medium" title={item.name}>
                <ChevronRightIcon aria-hidden className="size-3 shrink-0 text-muted-foreground transition-transform group-open/item:rotate-90" />
                <span className="min-w-0 truncate">
                  {item.name} <span className="font-normal text-muted-foreground">({item.children.length})</span>
                </span>
              </span>
              <span className="text-right">{about(item.tokens)}</span>
              <span className="text-right text-muted-foreground">{pct(item.tokens, part)}</span>
            </summary>
            <div className="mt-1 border-l pl-3 text-muted-foreground">
              <ItemList items={item.children} part={part} />
            </div>
          </details>
        ) : (
          <ItemList key={i} items={[item]} part={part} />
        )
      )}
    </div>
  )
}

/** The prompt table: a part per row, each opening onto what it was made of. */
function PromptRows({
  head,
  totals,
  parts,
  all,
  details,
}: {
  head: string[]
  totals: number[]
  parts: PromptParts
  all: PromptParts
  details: Partial<Record<PromptKey, DetailItem[]>>
}) {
  const cols = "grid grid-cols-[0.75rem_auto_1fr_auto_auto] items-start gap-x-2"
  return (
    <div className="mt-3 space-y-1 text-xs tabular-nums">
      <div className={cn(cols, "text-xs text-muted-foreground")}>
        <span />
        <span />
        <span />
        <span className="text-right">{head[0]}</span>
        <span className="w-14 text-right">{head[1]}</span>
      </div>
      {PROMPT_PARTS.filter((part) => parts[part.key] > 0 || all[part.key] > 0).map((part) => {
        const items = details[part.key] ?? []
        const row = (
          <>
            <span className="flex h-4 items-center text-muted-foreground">
              {items.length > 0 && (
                <ChevronRightIcon aria-hidden className="size-3 transition-transform group-open/part:rotate-90" />
              )}
            </span>
            <span className={cn("mt-1 size-2 rounded-sm", part.swatch)} />
            <span className="min-w-0">
              <span className="block truncate">{part.label}</span>
              <ShareBar swatch={part.swatch} value={parts[part.key]} total={totals[0]} />
            </span>
            <span className="text-right">
              {about(parts[part.key])} <span className="inline-block w-8 text-muted-foreground">{pct(parts[part.key], totals[0])}</span>
            </span>
            <span className="w-14 text-right">{about(all[part.key])}</span>
          </>
        )
        return items.length ? (
          <details key={part.key} className="group/part">
            <summary className={cn(cols, "-mx-1 cursor-pointer list-none rounded-md px-1 py-0.5 hover:bg-muted")}>{row}</summary>
            <PartItems items={items} part={parts[part.key]} />
          </details>
        ) : (
          <div key={part.key} className={cols}>{row}</div>
        )
      })}
      <div className={cn(cols, "border-t pt-1 font-medium")}>
        <span />
        <span />
        <span>Total</span>
        <span className="text-right">{about(totals[0])}</span>
        <span className="w-14 text-right">{about(totals[1])}</span>
      </div>
    </div>
  )
}

interface Request {
  number: number
  source: "agent" | "gateway" | "transcript"
  /** Position in the thread's flat list of requests. */
  index: number
  step: TurnStep
  parts: PromptParts
  inferred: boolean
}

/** One column per request, as tall as its prompt and stacked by part — the
    thread's context growing, readable at a glance. A column is a button: the
    table below it reads the one picked. A dashed rule marks the peak. */
function RequestChart({
  requests,
  picked,
  onPick,
}: {
  requests: Request[]
  picked: number
  onPick: (number: number) => void
}) {
  const shown = requests.slice(-CHART_MAX)
  const max = Math.max(1, ...shown.map((r) => r.step.update.used))
  return (
    <div className="relative pt-3">
      <span className="absolute inset-x-0 top-0 flex items-center gap-2 text-xs tabular-nums text-muted-foreground" aria-hidden>
        <span>{formatTokens(max)}</span>
        <span className="flex-1 border-t border-dashed border-border" />
      </span>
      <div className="flex h-20 items-end gap-px" role="group" aria-label="Prompt size by step">
        {shown.map((r) => {
          const used = r.step.update.used
          return (
            <button
              key={r.number}
              type="button"
              aria-pressed={r.number === picked}
              aria-label={`Step ${r.number}: ${formatTokens(used)} tokens`}
              title={`Step ${r.number} · ${formatTokens(used)}`}
              onClick={() => onPick(r.number)}
              className={cn(
                "flex min-w-0 flex-1 flex-col-reverse overflow-hidden rounded-[2px] bg-muted outline-offset-1 transition-opacity focus-visible:outline-2 focus-visible:outline-ring",
                r.number === picked ? "opacity-100 outline outline-1 outline-foreground/60" : "opacity-55 hover:opacity-90"
              )}
              style={{ height: `${Math.max(6, (used / max) * 100)}%` }}
            >
              {PROMPT_PARTS.map((part) =>
                r.parts[part.key] > 0 ? (
                  <span key={part.key} className={part.swatch} style={{ height: `${(r.parts[part.key] / used) * 100}%` }} />
                ) : null
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Fill thresholds for the context window: calm, then amber, then red where the
    inspector's own meter turns destructive. */
const windowTone = (percent: number): Tone => (percent >= 85 ? "bad" : percent >= 65 ? "warn" : "ok")

export function TokensPanel({ thread }: { thread: ThreadState }) {
  const { turns, entries } = React.useMemo(
    () => tokensByTurn(thread.items, thread.stepUsage, thread.turnUsage, thread.stepAt),
    [thread.items, thread.stepUsage, thread.turnUsage, thread.stepAt]
  )
  const spend = React.useMemo(() => subagentSpend(thread.items), [thread.items])
  const [pickedNumber, setPicked] = React.useState<number | null>(null)

  const steps = React.useMemo(() => turns.flatMap((turn) => turn.steps), [turns])
  const requests = React.useMemo<Request[]>(
    () =>
      steps.flatMap((step, i) => {
        const one = promptParts(step)
        return one ? [{ number: i + 1, index: i, step, ...one }] : []
      }),
    [steps]
  )

  if (turns.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <Empty>No token usage has been recorded for this thread.</Empty>
      </div>
    )
  }

  const billed = sumUsage(turns.map((turn) => turn.usage))
  const billedRows = billed ? billedParts(billed) : null
  const prompt = billed ? promptTokens(billed) : 0
  const all = sumPromptParts(steps)
  const billedTurns = turns.filter((t) => t.usage).length
  const maxUsed = Math.max(1, ...steps.map((s) => s.update.used))
  /* Latest unless one was picked; a picked request that has since scrolled out
     of the list (a compaction rebuilt the thread) falls back to the latest. */
  const selected = requests.find((r) => r.number === pickedNumber) ?? requests.at(-1)
  const selectedTotal = selected ? sum(selected.parts) : 0
  const details = selected ? requestDetail(steps, selected.index, entries, selected.parts) : {}
  const previous = selected ? requests.find((r) => r.index === selected.index - 1) : undefined
  const delta = selected && previous ? selected.step.update.used - previous.step.update.used : null
  const largest = selected ? PROMPT_PARTS.reduce((a, b) => (selected.parts[b.key] > selected.parts[a.key] ? b : a)) : null

  const context = thread.context
  const windowPercent = context && context.size > 0 ? Math.round((context.used / context.size) * 100) : null
  const cache = billed && prompt > 0 ? Math.round(((billed.cachedReadTokens ?? 0) / prompt) * 100) : null
  const peak = steps.reduce((best, step, i) => (step.update.used > best.used ? { used: step.update.used, number: i + 1 } : best), { used: 0, number: 0 })

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
      {billed && billedRows && (
        <InspectorCard title="Billed" hint={`${steps.length} steps · ${billedTurns} turns`}>
          <p className="text-2xl font-medium leading-none tabular-nums">{formatTokens(billed.totalTokens)}</p>
          <p className="mt-1 text-xs text-muted-foreground">tokens in total · {formatTokens(prompt)} sent, {formatTokens(billed.outputTokens)} generated</p>

          <div className="mt-3 grid grid-cols-2 gap-2">
            {windowPercent !== null && context && (
              <Tile
                label="Context window"
                value={`${windowPercent}%`}
                tone={windowTone(windowPercent)}
                fill={windowPercent}
                hint={`${formatTokens(context.used)} / ${formatTokens(context.size)}${windowEstimated(context) ? " (est.)" : ""}`}
              />
            )}
            {cache !== null && (
              <Tile
                label="Cache hit"
                value={`${cache}%`}
                tone={cache >= 50 ? "ok" : cache >= 20 ? "warn" : undefined}
                fill={cache}
                hint={`${formatTokens(billed.cachedReadTokens ?? 0)} read from cache`}
              />
            )}
            {steps.length > 0 && <Tile label="Average per step" value={formatTokens(Math.round(billed.totalTokens / steps.length))} hint={`${(steps.length / Math.max(1, billedTurns)).toFixed(1)} steps a turn`} />}
            {peak.number > 0 && <Tile label="Largest prompt" value={formatTokens(peak.used)} hint={`step ${peak.number}`} />}
            {context?.cost && <Tile label="Reported cost" value={`${context.cost.amount.toFixed(2)} ${context.cost.currency}`} />}
            {(billedRows.reasoning > 0 || billed.outputTokens > 0) && (
              <Tile
                label="Output share"
                value={pct(billed.outputTokens, billed.totalTokens)}
                hint={billedRows.reasoning > 0 ? `${pct(billedRows.reasoning, billed.outputTokens)} of it reasoning` : undefined}
              />
            )}
          </div>

          <StackBar
            className="mt-3 h-2.5"
            label="Billed tokens by kind"
            total={billed.totalTokens}
            parts={BILLED_PARTS.map((part) => ({ swatch: part.swatch, tokens: billedRows[part.key] }))}
          />
          <Rows total={billed.totalTokens} rows={BILLED_PARTS.map((part) => ({ label: part.label, swatch: part.swatch, value: billedRows[part.key] }))} />
        </InspectorCard>
      )}

      {spend.length > 0 && <SubagentsBlock spend={spend} />}

      <InspectorCard title="Prompt" hint={selected ? <Tag>{selected.source === "agent" ? "agent breakdown" : selected.source === "gateway" ? "gateway estimate" : "transcript estimate"}</Tag> : undefined}>
        {selected && all ? (
          <>
            <RequestChart requests={requests} picked={selected.number} onPick={setPicked} />
            <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
              <span className="font-medium">Step {selected.number}</span>
              <span className="tabular-nums text-muted-foreground">
                {formatTokens(selected.step.update.used)} in the prompt
                {delta !== null && delta !== 0 && (
                  <span className={cn("ml-1", delta > 0 ? TONE_TEXT.warn : TONE_TEXT.ok)}>
                    {delta > 0 ? "+" : "−"}
                    {formatTokens(Math.abs(delta))}
                  </span>
                )}
              </span>
            </div>
            {largest && selectedTotal > 0 && (
              <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                <span className={cn("size-1.5 shrink-0 rounded-full", largest.swatch)} />
                {largest.label} lead at {pct(selected.parts[largest.key], selectedTotal)}
                {selected.step.update.size > 0 && !windowEstimated(selected.step.update) && ` · ${pct(selected.step.update.used, selected.step.update.size)} of the window`}
              </p>
            )}
            <StackBar
              className="mt-2 h-2.5"
              label={`Step ${selected.number} prompt by part`}
              total={selectedTotal}
              parts={PROMPT_PARTS.map((part) => ({ swatch: part.swatch, tokens: selected.parts[part.key] }))}
            />
            <PromptRows
              head={[`Step ${selected.number}`, "All steps"]}
              totals={[selectedTotal, all.total]}
              parts={selected.parts}
              all={all.parts}
              details={details}
            />
            <details className="group/notes mt-3 text-xs text-muted-foreground">
              <summary className="flex cursor-pointer list-none items-center gap-1 hover:text-foreground">
                <ChevronRightIcon aria-hidden className="size-3 shrink-0 transition-transform group-open/notes:rotate-90" />
                How these are measured
              </summary>
              <div className="mt-1 space-y-1">
                {all.inferred < all.requests && (
                  <p>
                    Measured steps: the system prompt and tool schemas are tokenized here; your messages, replies and tool
                    results share what the provider billed beyond them, in proportion.
                  </p>
                )}
                {requests.some((request) => request.source === "gateway") && (
                  <p>
                    Gateway estimates tokenize the request body and use the provider's prompt total. System text, tool schemas,
                    and message roles are estimated separately; framing and agent-internal prompt content remain overhead.
                    Tokenizer differences can shift these estimates.
                  </p>
                )}
                {requests.some((request) => request.source === "transcript") && (
                  <p>
                    Transcript-only estimates use about 4 characters per token; what is left of the provider total is agent
                    overhead. After compaction the transcript can be longer than the prompt, so those estimates can run high.
                  </p>
                )}
                <p>
                  Every part sums to the step's total; "All steps" counts what each step re-sent.
                  {all.parts.history > 0 && " Older steps were recorded without the history split and show it as one row."}
                </p>
              </div>
            </details>
          </>
        ) : (
          <p className="text-xs leading-4 text-muted-foreground">
            This agent doesn't report a prompt size per step, so only the billed figures above can be shown.
          </p>
        )}
      </InspectorCard>

      <InspectorCard title="By step" hint={`${steps.length} ${steps.length === 1 ? "step" : "steps"} · ${turns.length} ${turns.length === 1 ? "turn" : "turns"}`}>
        <StepList steps={steps} picked={selected?.number} onPick={setPicked} max={maxUsed} />
      </InspectorCard>
    </div>
  )
}

/** Children's own bills — subagents, workflow steps, background runs. Kept out
    of Billed: some runtimes already count a child in the parent's turn, others
    run it as a session of its own, so adding the two would double some. */
const CHILD_SWATCHES = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5", "bg-muted-foreground"]

function SubagentsBlock({ spend }: { spend: SubagentSpend[] }) {
  const total = spend.reduce((n, child) => n + child.tokens, 0)
  const rows = spend.map((child, i) => ({
    label: child.workflow ? `${child.name} · workflow` : child.name,
    hint: spendTime(child),
    swatch: CHILD_SWATCHES[i % CHILD_SWATCHES.length],
    value: child.tokens,
  }))
  return (
    <InspectorCard title="Subagents" hint={`${spend.length} ${spend.length === 1 ? "child" : "children"}`}>
      <p className="text-2xl font-medium leading-none tabular-nums">{formatTokens(total)}</p>
      <p className="mt-1 text-xs text-muted-foreground">tokens billed by subagents and workflow steps</p>
      <StackBar className="mt-3 h-2.5" label="Subagent tokens by child" total={total} parts={rows.map((r) => ({ swatch: r.swatch, tokens: r.value }))} />
      <Rows total={total} rows={rows} />
      <p className="mt-3 text-xs leading-4 text-muted-foreground">
        Shown apart from Billed: depending on the agent, a child's tokens may already be counted in the turn that launched it.
      </p>
    </InspectorCard>
  )
}

/** Steps drawn before "Show N earlier" — newest last, like the chart. */
const STEP_LIST_MAX = 30

/** Every model request in the thread, flat: a turn is only the tag on a row. */
function StepList({
  steps,
  picked,
  onPick,
  max,
}: {
  steps: TurnStep[]
  picked?: number
  onPick: (number: number) => void
  max: number
}) {
  const [all, setAll] = React.useState(false)
  const start = all ? 0 : Math.max(0, steps.length - STEP_LIST_MAX)
  return (
    <ol className="space-y-1">
      {start > 0 && (
        <li>
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => setAll(true)}
          >
            Show {start} earlier
          </button>
        </li>
      )}
      {steps.slice(start).map((step, j) => {
        const i = start + j
        return <StepRow key={i} step={step} number={i + 1} previous={steps[i - 1]} picked={picked === i + 1} onPick={onPick} max={max} />
      })}
    </ol>
  )
}

/** One request: what it produced, how big its prompt was and what that was
    made of, and — where the runtime bills per step — what it generated. Picking
    it is picking it in the chart above. */
function StepRow({
  step,
  number,
  previous,
  picked,
  onPick,
  max,
}: {
  step: TurnStep
  number: number
  previous?: TurnStep
  picked: boolean
  onPick: (number: number) => void
  max: number
}) {
  const one = promptParts(step)
  const bill = stepBill(step.update)
  const used = step.update.used
  const delta = previous ? used - previous.update.used : 0
  const prompt = bill ? promptTokens(bill) : 0
  const cache = bill && prompt > 0 ? Math.round(((bill.cachedReadTokens ?? 0) / prompt) * 100) : null
  return (
    <li>
      <button
        type="button"
        aria-pressed={picked}
        onClick={() => onPick(number)}
        className={cn(
          INSPECTOR_TILE,
          "block w-full text-start text-xs transition-colors outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50",
          picked ? "bg-muted ring-1 ring-foreground/10" : "bg-muted/50"
        )}
      >
        <span className="flex items-baseline gap-2">
          <span className="shrink-0 font-medium tabular-nums">{number}</span>
          <span className="min-w-0 flex-1 truncate" title={step.label}>{step.label}</span>
          <span className="shrink-0 font-medium tabular-nums">{formatTokens(used)}</span>
        </span>
        <span className="mt-2 block" style={{ width: `${Math.max(4, (used / max) * 100)}%` }}>
          <StackBar
            className="h-1.5"
            label={`Step ${number} prompt by part`}
            total={used}
            parts={
              one ? PROMPT_PARTS.map((part) => ({ swatch: part.swatch, tokens: one.parts[part.key] })) : [{ swatch: "bg-muted-foreground", tokens: used }]
            }
          />
        </span>
        <span className="mt-1 flex flex-wrap gap-x-2 text-xs tabular-nums text-muted-foreground">
          <span>turn {step.turn}</span>
          {step.durationMs !== undefined && (
            <span title="Time since the step before it, tool calls included">{formatDuration(step.durationMs)}</span>
          )}
          {delta !== 0 && (
            <span className={delta > 0 ? TONE_TEXT.warn : TONE_TEXT.ok}>
              {delta > 0 ? "+" : "−"}
              {formatTokens(Math.abs(delta))}
            </span>
          )}
          {bill && <span>{formatTokens(bill.outputTokens)} out</span>}
          {bill?.thoughtTokens ? <span>{formatTokens(bill.thoughtTokens)} think</span> : null}
          {cache !== null && <span>{cache}% cached</span>}
          {one?.inferred && <span>estimated</span>}
        </span>
      </button>
    </li>
  )
}
