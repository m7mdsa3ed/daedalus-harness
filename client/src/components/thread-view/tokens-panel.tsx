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

   Nothing else in the app prints an estimate: the composer's popovers and the
   transcript's footers show only what was reported. */
import * as React from "react"

import { Empty } from "@/components/empty"
import {
  BILLED_PARTS,
  PROMPT_PARTS,
  billedParts,
  promptParts,
  requestDetail,
  stepBill,
  sumPromptParts,
  tokensByTurn,
  type DetailItem,
  type PromptKey,
  type PromptParts,
  type TurnStep,
  type TurnTokens,
} from "@/lib/token-breakdown"
import { formatDuration, formatTokens, promptTokens, sumUsage, windowEstimated } from "@/lib/tokens"
import type { ThreadState } from "@/lib/store"
import { cn } from "@/lib/utils"

const pct = (n: number, total: number) => (total > 0 ? `${Math.round((n / total) * 100)}%` : "—")
const about = (n: number) => `~${formatTokens(n)}`
const sum = (parts: PromptParts) => Object.values(parts).reduce((n, v) => n + v, 0)
/** The columns the request chart draws, newest last — more would be slivers. */
const CHART_MAX = 48

function Block({ title, hint, children }: { title: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border/60 bg-card/55 p-2.5">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{title}</h2>
        {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] text-muted-foreground">{label}</dt>
      <dd className="text-[11px] font-medium tabular-nums">{value}</dd>
    </div>
  )
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full bg-muted px-1.5 py-px text-[9px] font-medium text-muted-foreground">{children}</span>
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
    <div role="img" aria-label={label} className={cn("flex h-2 w-full gap-px overflow-hidden rounded-full bg-muted", className)}>
      {parts.map((part, i) =>
        part.tokens > 0 ? <div key={i} className={part.swatch} style={{ width: `${(part.tokens / total) * 100}%` }} /> : null
      )}
    </div>
  )
}

/** A thin bar for a share of a whole, under a row's name. */
function ShareBar({ swatch, value, total }: { swatch: string; value: number; total: number }) {
  return (
    <span className="mt-1 block h-1 overflow-hidden rounded-full bg-muted/70" aria-hidden>
      <span className={cn("block h-full rounded-full", swatch)} style={{ width: `${total > 0 ? Math.max(2, (value / total) * 100) : 0}%` }} />
    </span>
  )
}

interface Row {
  label: string
  swatch: string
  value: number
}

/** A legend that is also the table: swatch, name over its share bar, figure and
    percentage. A row with nothing in it is not drawn. */
function Rows({ rows, total }: { rows: Row[]; total: number }) {
  return (
    <div className="mt-3 grid grid-cols-[auto_1fr_auto] items-start gap-x-2.5 gap-y-2 text-[11px] tabular-nums">
      {rows
        .filter((row) => row.value > 0)
        .map((row) => (
          <React.Fragment key={row.label}>
            <span className={cn("mt-[3px] size-2 rounded-sm", row.swatch)} />
            <span className="min-w-0">
              <span className="block truncate">{row.label}</span>
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
  ok: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  bad: "text-destructive",
}
const TONE_FILL: Record<Tone, string> = { ok: "bg-emerald-500", warn: "bg-amber-500", bad: "bg-destructive" }

/** One headline figure: label, value, and a line of what it is made of. */
function Tile({ label, value, hint, tone, fill }: { label: string; value: string; hint?: string; tone?: Tone; fill?: number }) {
  return (
    <div className="min-w-0 rounded-md bg-muted/45 px-2 py-1.5">
      <p className="truncate text-[9px] text-muted-foreground">{label}</p>
      <p className={cn("mt-0.5 text-base font-semibold leading-none tabular-nums", tone && TONE_TEXT[tone])}>{value}</p>
      {fill !== undefined && (
        <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
          <span className={cn("block h-full rounded-full", TONE_FILL[tone ?? "ok"])} style={{ width: `${Math.min(100, fill)}%` }} />
        </span>
      )}
      {hint && <p className="mt-1 truncate text-[9px] text-muted-foreground" title={hint}>{hint}</p>}
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
    <ul className="space-y-0.5">
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
    <div className="space-y-0.5 py-1 pl-4 text-[10px]">
      {items.map((item, i) =>
        item.children ? (
          <details key={i} className="group/item">
            <summary className="grid cursor-pointer list-none grid-cols-[1fr_auto_2rem] items-baseline gap-x-2 tabular-nums">
              <span className="min-w-0 truncate font-medium" title={item.name}>
                <span className="mr-1 inline-block text-muted-foreground transition-transform group-open/item:rotate-90">›</span>
                {item.name} <span className="font-normal text-muted-foreground">({item.children.length})</span>
              </span>
              <span className="text-right">{about(item.tokens)}</span>
              <span className="text-right text-muted-foreground">{pct(item.tokens, part)}</span>
            </summary>
            <div className="mt-0.5 border-l border-border/60 pl-2.5 text-muted-foreground">
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
  const cols = "grid grid-cols-[0.75rem_auto_1fr_auto_auto] items-start gap-x-2.5"
  return (
    <div className="mt-3 space-y-1.5 text-[11px] tabular-nums">
      <div className={cn(cols, "text-[10px] text-muted-foreground")}>
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
            <span className="text-[9px] text-muted-foreground transition-transform group-open/part:rotate-90">{items.length ? "›" : ""}</span>
            <span className={cn("mt-[3px] size-2 rounded-sm", part.swatch)} />
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
            <summary className={cn(cols, "cursor-pointer list-none rounded hover:bg-muted/50")}>{row}</summary>
            <PartItems items={items} part={parts[part.key]} />
          </details>
        ) : (
          <div key={part.key} className={cols}>{row}</div>
        )
      })}
      <div className={cn(cols, "border-t border-border/50 pt-1 font-medium")}>
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
      <span className="absolute inset-x-0 top-0 flex items-center gap-1.5 text-[9px] tabular-nums text-muted-foreground" aria-hidden>
        <span>{formatTokens(max)}</span>
        <span className="flex-1 border-t border-dashed border-border" />
      </span>
      <div className="flex h-20 items-end gap-px" role="group" aria-label="Prompt size by request">
        {shown.map((r) => {
          const used = r.step.update.used
          return (
            <button
              key={r.number}
              type="button"
              aria-pressed={r.number === picked}
              aria-label={`Request ${r.number}: ${formatTokens(used)} tokens`}
              title={`Request ${r.number} · ${formatTokens(used)}`}
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
    () => tokensByTurn(thread.items, thread.stepUsage, thread.turnUsage),
    [thread.items, thread.stepUsage, thread.turnUsage]
  )
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
      <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
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
  const maxTurn = Math.max(1, ...turns.map((t) => t.usage?.totalTokens ?? 0))
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
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5">
      {billed && billedRows && (
        <Block title="Billed" hint={`${billedTurns} turns · ${steps.length} requests`}>
          <p className="text-2xl font-semibold leading-none tabular-nums">{formatTokens(billed.totalTokens)}</p>
          <p className="mt-1 text-[10px] text-muted-foreground">tokens in total · {formatTokens(prompt)} sent, {formatTokens(billed.outputTokens)} generated</p>

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
            {billedTurns > 0 && <Tile label="Average per turn" value={formatTokens(Math.round(billed.totalTokens / billedTurns))} hint={`${(steps.length / billedTurns).toFixed(1)} requests a turn`} />}
            {peak.number > 0 && <Tile label="Largest prompt" value={formatTokens(peak.used)} hint={`request ${peak.number}`} />}
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
        </Block>
      )}

      <Block title="Prompt" hint={selected ? (selected.inferred ? <Tag>inferred</Tag> : <Tag>measured</Tag>) : undefined}>
        {selected && all ? (
          <>
            <RequestChart requests={requests} picked={selected.number} onPick={setPicked} />
            <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-3 text-[11px]">
              <span className="font-medium">Request {selected.number}</span>
              <span className="tabular-nums text-muted-foreground">
                {formatTokens(selected.step.update.used)} in the prompt
                {delta !== null && delta !== 0 && (
                  <span className={cn("ml-1.5", delta > 0 ? TONE_TEXT.warn : TONE_TEXT.ok)}>
                    {delta > 0 ? "+" : "−"}
                    {formatTokens(Math.abs(delta))}
                  </span>
                )}
              </span>
            </div>
            {largest && selectedTotal > 0 && (
              <p className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span className={cn("size-1.5 rounded-full", largest.swatch)} />
                {largest.label} lead at {pct(selected.parts[largest.key], selectedTotal)}
                {selected.step.update.size > 0 && !windowEstimated(selected.step.update) && ` · ${pct(selected.step.update.used, selected.step.update.size)} of the window`}
              </p>
            )}
            <StackBar
              className="mt-2 h-2.5"
              label={`Request ${selected.number} prompt by part`}
              total={selectedTotal}
              parts={PROMPT_PARTS.map((part) => ({ swatch: part.swatch, tokens: selected.parts[part.key] }))}
            />
            <PromptRows
              head={[`Request ${selected.number}`, "All requests"]}
              totals={[selectedTotal, all.total]}
              parts={selected.parts}
              all={all.parts}
              details={details}
            />
            <details className="group/notes mt-3 text-[10px] leading-4 text-muted-foreground">
              <summary className="cursor-pointer list-none hover:text-foreground">
                <span className="mr-1 inline-block transition-transform group-open/notes:rotate-90">›</span>How these are measured
              </summary>
              <div className="mt-1 space-y-1">
                {all.inferred < all.requests && (
                  <p>
                    Measured requests: the system prompt and tool schemas are tokenized here; your messages, replies and tool
                    results share what the provider billed beyond them, in proportion.
                  </p>
                )}
                {all.inferred > 0 && (
                  <p>
                    Inferred requests: this agent doesn't report what its prompt held, so your messages, replies and tool
                    results are estimated from the transcript (about 4 characters a token) and agent overhead — its system
                    prompt and tool schemas, unsplit — is what is left of the request's total. After a compaction the
                    transcript is longer than the prompt, so those run high.
                  </p>
                )}
                <p>
                  Every part sums to the request's total; "All requests" counts what each request re-sent.
                  {all.parts.history > 0 && " Older requests were recorded without the history split and show it as one row."}
                </p>
              </div>
            </details>
          </>
        ) : (
          <p className="text-[11px] leading-4 text-muted-foreground">
            This agent doesn't report a prompt size per request, so only the billed figures above can be shown.
          </p>
        )}
      </Block>

      <Block title="By turn" hint={`${turns.length} ${turns.length === 1 ? "turn" : "turns"}`}>
        <div className="space-y-1.5 text-[11px]">
          {turns.map((turn, index) => (
            <TurnRow
              key={turn.id}
              turn={turn}
              index={index}
              open={index === turns.length - 1}
              max={maxUsed}
              maxTurn={maxTurn}
              duration={turn.turnId ? thread.turnDuration[turn.turnId] : undefined}
            />
          ))}
        </div>
      </Block>
    </div>
  )
}

function TurnRow({
  turn,
  index,
  open,
  max,
  maxTurn,
  duration,
}: {
  turn: TurnTokens
  index: number
  open: boolean
  max: number
  maxTurn: number
  duration?: number
}) {
  const usage = turn.usage
  const billed = usage ? billedParts(usage) : null
  const sums = sumPromptParts(turn.steps)
  const turnPrompt = usage ? promptTokens(usage) : 0
  const cache = usage && turnPrompt > 0 ? Math.round(((usage.cachedReadTokens ?? 0) / turnPrompt) * 100) : null
  return (
    <details open={open} className="group/turn rounded-md bg-muted/35 px-2 py-1.5">
      <summary className="cursor-pointer list-none">
        <span className="flex items-baseline gap-2">
          <span className="shrink-0 font-medium tabular-nums">{index + 1}</span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground" title={turn.prompt}>
            {turn.prompt || "(no text)"}
          </span>
          <span className="shrink-0 font-medium tabular-nums">{usage ? formatTokens(usage.totalTokens) : "…"}</span>
        </span>
        {billed && usage && (
          <span className="mt-1.5 block">
            <StackBar
              className="h-1.5"
              label={`Turn ${index + 1} billed tokens by kind`}
              total={maxTurn}
              parts={BILLED_PARTS.map((part) => ({ swatch: part.swatch, tokens: billed[part.key] }))}
            />
          </span>
        )}
        <span className="mt-1 flex flex-wrap gap-x-2.5 text-[9px] tabular-nums text-muted-foreground">
          <span>{turn.steps.length} {turn.steps.length === 1 ? "request" : "requests"}</span>
          {duration ? <span>{formatDuration(duration)}</span> : null}
          {cache !== null && <span>{cache}% cached</span>}
        </span>
      </summary>
      <dl className="mt-2 grid grid-cols-3 gap-x-2 gap-y-1">
        {billed &&
          BILLED_PARTS.map((part) =>
            billed[part.key] > 0 ? <Stat key={part.key} label={part.label} value={formatTokens(billed[part.key])} /> : null
          )}
        {sums &&
          PROMPT_PARTS.map((part) =>
            sums.parts[part.key] > 0 ? <Stat key={part.key} label={part.label} value={about(sums.parts[part.key])} /> : null
          )}
      </dl>
      {turn.steps.length > 0 && (
        <ol className="mt-1.5 space-y-1 border-t border-border/40 pt-1.5">
          {turn.steps.map((step, i) => {
            const one = promptParts(step)
            const bill = stepBill(step.update)
            const used = step.update.used
            return (
              <li key={i} className="grid grid-cols-[1.25rem_1fr_auto] items-center gap-x-2">
                <span className="text-[10px] text-muted-foreground tabular-nums">{i + 1}</span>
                <div style={{ width: `${Math.max(4, (used / max) * 100)}%` }}>
                  <StackBar
                    label={`Request ${i + 1} prompt by part`}
                    total={used}
                    parts={
                      one
                        ? PROMPT_PARTS.map((part) => ({ swatch: part.swatch, tokens: one.parts[part.key] }))
                        : [{ swatch: "bg-zinc-400", tokens: used }]
                    }
                  />
                </div>
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {formatTokens(used)}
                  {bill && ` · ${formatTokens(bill.outputTokens)} out`}
                  {bill?.thoughtTokens ? ` · ${formatTokens(bill.thoughtTokens)} think` : ""}
                </span>
              </li>
            )
          })}
        </ol>
      )}
    </details>
  )
}
