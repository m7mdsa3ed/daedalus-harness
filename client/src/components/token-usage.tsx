/* ── What it cost ──
   One figure, drawn the same everywhere a unit of work ends: under a finished
   turn, on a workflow step, on a subagent's row, in a run's header.

   Three forms, and which one a surface gets is decided by what it is allowed
   to contain rather than by taste. `TokenFigure` is bare text — a tab, the run
   card that is itself one big button; a popover trigger cannot go inside any
   of those, because a button may not hold a button. `TokenSummary` is the
   figure with the breakdown behind it, for the places that are ordinary flow
   content — chiefly the turn footer, which is where the breakdown is worth
   having: the turn is the thing a reader asks "why was that expensive" about.
   `StepTokens` is the same offer on a transcript step, which is why `StepRow`
   draws its trailing columns beside its disclosure button rather than inside
   it: "how much did this cost, and did it hit the cache" is asked of a step
   in exactly the same breath as of a turn, and answering it with a `title` attribute meant
   the answer was invisible on a phone and unreachable from a keyboard.

   Everything here is gated by the `showTokens` view option at the CALL SITE,
   not in here: a component that renders nothing is still a component the
   transcript mounts per row. */
import * as React from "react"
import { CoinsIcon, DatabaseZapIcon, TimerIcon } from "lucide-react"
import type * as acp from "@daedalus/acp"
import type { ModelCall, TurnGeneration } from "@daedalus/protocol"
import { generationRate, stepRate } from "@daedalus/tps"

import { Popover, PopoverTrigger } from "@/components/ui/popover"
import { ReadingPopoverContent } from "@/components/composer/indicator"
import {
  BilledBar,
  Chips,
  Facts,
  Meter,
  READING_WIDTH,
  ReadingHero,
  ReadingTabs,
  cacheTone,
  formatMs,
  promptBarParts,
  sumSplits,
  TokenBreakdown,
  type BillPart,
} from "@/components/reading-kit"
import { formatDuration, formatRate, formatTokens, formatTps, promptTokens, windowEstimated } from "@/lib/tokens"
import { vendorMeta } from "@/lib/tools"
import { cachePercent, usageOfCalls, type ThreadCall } from "@/lib/trace"
import { cn } from "@/lib/utils"

/* The trigger box both popover figures wear. One padding, one line box, one
   colour, one hover — a step's figure and a turn's are the same reading at two
   scopes and were drawn at two sizes, which is what tilted the coin against the
   timestamp beside it in a step's trailing group. Stated here rather than
   inherited from wherever it lands, so the figure looks the same in a run's
   header, on a step and under a turn. */
const FIGURE =
  "inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-xs leading-4 tabular-nums text-muted-foreground transition-colors duration-150 outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"

/** The headline number: everything the turn or step burned, both directions.
    `totalTokens` is the agent's own sum and is what the composer's popover
    already reports, so the two never disagree. */
export function TokenFigure({
  usage,
  className,
}: {
  usage: acp.Usage
  className?: string
}) {
  return (
    <span className={cn("tabular-nums", className)}>{formatTokens(usage.totalTokens)} tokens</span>
  )
}

/* ── A step's own figure ──
   Three readings meet on a transcript row, each keyed by the row's id and read
   through one store (below): the `usage_update` the request filed there
   (`markStepUsage` — a window share for every runtime, the exact bill as well
   for ours), the model call records joined to the row (`callsByStep` — the
   bill, cache and timing whichever door saw the request), and the turn the
   row sits in, the last resort for a split when neither of the first two has
   one. Read through a store rather than threaded as props because the rows
   that print it are several memoized layers below the transcript. */
type StepCallEntry = { calls: ThreadCall[]; exact: boolean }

type StepTokensValue = {
  /** What the model request that ended on each item filed. */
  step: Record<string, acp.UsageUpdate>
  /** Each item's turn, keyed by the same item ids `step` uses. */
  turn: Record<string, acp.Usage>
  /** The model call records drawn on each item. */
  calls: Record<string, StepCallEntry>
}

/* A store, not a context *value*: `stepUsage` is replaced once per model step,
   and a context value change re-renders every row that reads it — memo or not
   — so each tool call in an agentic turn re-rendered the whole transcript.
   The context carries one store per view for its life; a row subscribes to
   its own entry, and only rows whose entry moved re-render. */
export type StepTokensStore = {
  get: () => StepTokensValue
  /** Write without telling anyone — from the provider's render, so a row
      mounting in the same commit reads the new value on its first render
      (a subscription only starts after paint, and a later notify would be a
      second commit for every step of a replay). */
  prime: (value: StepTokensValue) => void
  /** Tell the rows already subscribed; each re-renders only if its entry moved. */
  publish: () => void
  subscribe: (listener: () => void) => () => void
}

export function createStepTokensStore(): StepTokensStore {
  let value: StepTokensValue = { step: {}, turn: {}, calls: {} }
  let published = value
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    prime: (next) => {
      if (next.step !== value.step || next.turn !== value.turn || next.calls !== value.calls) value = next
    },
    publish: () => {
      if (published === value) return
      published = value
      listeners.forEach((listener) => listener())
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

const StepTokensContext = React.createContext<StepTokensStore>(createStepTokensStore())

export const StepTokensProvider = StepTokensContext.Provider

function useStepTokensEntry<T>(read: (value: StepTokensValue) => T): T {
  const store = React.useContext(StepTokensContext)
  return React.useSyncExternalStore(store.subscribe, () => read(store.get()))
}

/** The reading the model request that ended on this item filed, or undefined
    where none ever was — which is most items, since one request writes
    several. The whole `UsageUpdate`, not its figure: `StepTokens` draws the
    window and the cost behind the number. */
export function useStepTokens(itemId: string): acp.UsageUpdate | undefined {
  return useStepTokensEntry((value) => value.step[itemId])
}

/** The model call records drawn on this item, and whether they were pinned to
    it by their tool call ids or by where they landed. */
export function useStepCallEntry(itemId: string): StepCallEntry | undefined {
  return useStepTokensEntry((value) => value.calls[itemId])
}

/** The turn a step sits in, keyed the same way `useStepTokens` is — the split
    a step falls back to when it has none of its own. */
export function useStepTurnUsage(itemId: string): acp.Usage | undefined {
  return useStepTokensEntry((value) => value.turn[itemId])
}

/** The share of a prompt read from cache, as a chip's trailing mark. */
function CacheFigure({ percent }: { percent: number }) {
  return (
    <span className="ms-1 inline-flex items-center gap-0.5">
      <DatabaseZapIcon aria-hidden className="size-3 shrink-0" />
      {percent}%
    </span>
  )
}

/** Who measured a record, as a chip. */
const MEASURED_SHORT: Record<ModelCall["source"], string> = {
  acp: "Runtime",
  proxy: "Gateway proxy",
  otlp: "Telemetry",
  files: "Session files",
  usage: "Usage reports",
}

/** A request on one bar: the wait for its first token (the network, the
    queue and the prompt's prefill — and any reasoning the provider never
    streamed), the writing after it, and whatever came after the last token
    (the usage chunk, a gateway's flush). */
function timelineOf(call: ModelCall): BillPart[] {
  const ttft = call.timing?.ttftMs
  const writing = call.timing?.decodeMs
  if (ttft === undefined && writing === undefined) return []
  const tail = call.ms !== undefined ? call.ms - (ttft ?? 0) - (writing ?? 0) : 0
  return [
    { label: "To first token", tokens: ttft ?? 0, color: "var(--chart-1)" },
    { label: "Writing", tokens: writing ?? 0, color: "var(--chart-2)" },
    { label: "After last token", tokens: tail > 50 ? tail : 0, color: "var(--chart-3)" },
  ]
}

/** Who measured a record, in words — the popover's footnote. */
const MEASURED_BY: Record<ModelCall["source"], string> = {
  acp: "the runtime",
  proxy: "the harness's gateway proxy",
  otlp: "the runtime's telemetry",
  files: "the runtime's session files",
  usage: "the runtime's usage reports",
}

/** What a step's row can say about the request behind it. */
interface StepReading {
  /** The headline: the request's bill, or its window reading. */
  figure: number
  /** The prompt/output/cache split, and whose it is. */
  split: acp.Usage | null
  scope: "request" | "turn" | null
  /** Figure and split are this request's and pinned to this row exactly. */
  exact: boolean
  /** Share of the prompt read from cache — only ever the request's own. */
  cache: number | null
  /** The record timing is read from: the last one drawn on the row. */
  call?: ThreadCall
}

function readStep(usage: acp.UsageUpdate | undefined, entry: StepCallEntry | undefined, turn: acp.Usage | undefined): StepReading | null {
  const own = usage ? (vendorMeta(usage._meta, "daedalus")?.step as acp.Usage | null | undefined) : undefined
  const fromCalls = entry ? usageOfCalls(entry.calls) : null
  const request = own ?? fromCalls
  const split = request ?? turn ?? null
  const figure = request ? request.totalTokens : (usage?.used ?? 0)
  if (!(figure > 0) && !split) return null
  return {
    figure,
    split,
    scope: request ? "request" : split ? "turn" : null,
    exact: own != null || (fromCalls != null && entry!.exact),
    cache: request ? cachePercent(request) : null,
    call: entry?.calls.at(-1),
  }
}

/**
 * A step's cost, on the step's own row: the request's tokens and, where the
 * door reported one, the share of its prompt read from cache — the figure a
 * reader scans down a run of steps for, since a step that missed the cache is
 * where a turn's bill went.
 *
 * The tilde is the honest part: a figure is exact only when it is the
 * request's own bill pinned to this row by its tool call ids (or our
 * runtime's own step reading). A window reading, or a record placed by where
 * it landed, is the right order of magnitude for this step and not an invoice
 * line, and the popover says which in words.
 *
 * A real button with the same defaults `TokenSummary` opens on — hover, click
 * and keyboard — which is why `StepRow` draws its trailing columns beside its
 * disclosure button: a button may not hold a button.
 */
export function StepTokens({
  usage,
  calls,
  itemId,
  className,
}: {
  /** The `usage_update` filed against this row, if one was. */
  usage?: acp.UsageUpdate
  /** The model call records drawn on this row, if any. */
  calls?: StepCallEntry
  /** The row the figure was filed against, for the containing turn's split. */
  itemId?: string
  className?: string
}) {
  const turnUsage = useStepTurnUsage(itemId ?? "")
  const reading = readStep(usage, calls, turnUsage)
  if (!reading) return null
  const { figure, split, scope, exact, cache, call } = reading
  const approx = exact ? "" : "~"
  const about = windowEstimated(usage) ? "~" : ""
  const share = usage && usage.size > 0 ? Math.round((usage.used / usage.size) * 100) : null
  const rate = call ? stepRate(call) : null
  const timeline = call ? timelineOf(call) : []
  const facts = [
    call ? MEASURED_SHORT[call.source] : null,
    call?.finishReason ? `finish: ${call.finishReason}` : null,
    call?.costUsd !== undefined ? `$${call.costUsd.toFixed(4)}` : null,
  ].filter((fact): fact is string => fact !== null)
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={250}
        render={
          <button
            type="button"
            aria-label={`This step: ${exact ? "" : "about "}${figure} tokens${cache !== null ? `, ${cache}% from cache` : ""}`}
            className={cn(FIGURE, className)}
          >
            {/* Marks, not words: the coin says "tokens" and the cache glyph
                "from cache", so a step's title keeps the line at every width.
                The words are the label's, and the popover's. */}
            <CoinsIcon aria-hidden className="size-3 shrink-0" />
            {approx}
            {formatTokens(figure)}
            {cache !== null && <CacheFigure percent={cache} />}
          </button>
        }
      />
      <ReadingPopoverContent align="start" heading="This step" meta={call?.model} className={READING_WIDTH}>
        <ReadingHero
          value={`${approx}${formatTokens(figure)}`}
          unit="tokens"
          caption={scope === "request" ? (exact ? "This request's bill" : "This request's bill, matched by arrival") : "Window reading · split is the whole turn's"}
          cache={cache}
        />
        <Facts
          items={[
            rate !== null && { label: "Speed", value: formatTps(rate) ?? "—" },
            call?.timing?.ttftMs !== undefined && { label: "First token", value: formatMs(call.timing.ttftMs) },
            call?.ms !== undefined && { label: "Request", value: formatMs(call.ms) },
            share !== null && {
              label: "Window",
              value: `${about}${share}%`,
              valueClass: share >= 85 ? "text-destructive" : share >= 70 ? "text-warning" : undefined,
            },
          ]}
        />
        {split && <TokenBreakdown usage={split} split={scope === "request" ? call?.output : null} />}
        <ReadingTabs
          tabs={[
            call?.called && call.called.length > 0 && {
              id: "tools",
              label: "Asked for",
              meta: `${call.called.length} call${call.called.length === 1 ? "" : "s"}`,
              content: <Chips items={call.called} mono />,
            },
            timeline.length > 0 && {
              id: "timing",
              label: "Timing",
              meta: call?.ms !== undefined ? formatMs(call.ms) : undefined,
              content: <BilledBar parts={timeline} format={formatMs} share />,
            },
            call?.prompt && {
              id: "prompt",
              label: "Prompt",
              meta: "estimated",
              content: <BilledBar parts={promptBarParts(call.prompt)} share legend="grid" />,
            },
            usage && usage.size > 0 && share !== null && {
              id: "window",
              label: "Window",
              meta: `${formatTokens(usage.used)} of ${about}${formatTokens(usage.size)}`,
              content: <Meter value={usage.used} max={usage.size} tone={share >= 85 ? "error" : share >= 70 ? "warn" : undefined} />,
            },
          ]}
        />
        <div className="space-y-1.5 border-t pt-2">
          <Chips items={facts} />
          <p className="text-[11px] leading-4 text-muted-foreground">{stepNote(reading, call)}</p>
        </div>
      </ReadingPopoverContent>
    </Popover>
  )
}

/** What the step's popover can stand behind, in words. */
function stepNote(reading: StepReading, call: ThreadCall | undefined): string {
  if (reading.scope === "turn")
    return "No request record reached this step: the bill is the whole turn's, and the figure is the runtime's window reading."
  if (!reading.exact)
    return `Placed on this step by when ${call ? `${MEASURED_BY[call.source]}'s record` : "its record"} arrived, not by its tool calls, so it can be a step late.`
  return "First token counts the network, the queue and the prompt's prefill; writing is everything after it."
}

/** A turn's wall clock on one bar: the model writing, the tools running, and
    the rest — the waits for each request's first token (network, queue,
    prefill), approvals, and the harness's own work. Writing can overlap tools
    (a subagent's, a parallel call's), so each part is clamped to what is left. */
function turnTimeParts(durationMs: number, toolDurationMs: number | undefined, generation: TurnGeneration | undefined): BillPart[] {
  const writing = Math.min(durationMs, generation?.decodeMs ?? 0)
  const tools = Math.min(durationMs - writing, toolDurationMs ?? 0)
  return [
    { label: "Model writing", tokens: writing, color: "var(--chart-2)" },
    { label: "Running tools", tokens: tools, color: "var(--chart-4)" },
    {
      label: writing > 0 ? "First tokens & overhead" : "Model & overhead",
      tokens: Math.max(0, durationMs - writing - tools),
      color: "var(--chart-1)",
    },
  ]
}

/** What the turn's calls cost, where the runtime priced them; null otherwise. */
function costOfCalls(calls: readonly ThreadCall[]): number | null {
  let total: number | null = null
  for (const call of calls) if (call.costUsd !== undefined) total = (total ?? 0) + call.costUsd
  return total
}

const REQUEST_ROW = "grid grid-cols-[1.5rem_3.5rem_2.5rem_4rem_minmax(0,1fr)] items-baseline gap-x-2 tabular-nums"

/** The turn's requests, one line each: which step, what it sent, how much of
    that came from cache, how fast it wrote and what it asked to run — the
    series that says *which* step lost the cache, which a total cannot. */
function RequestList({ calls }: { calls: ThreadCall[] }) {
  return (
    <div className="text-xs">
      <div className={cn(REQUEST_ROW, "pb-1 text-[11px] text-muted-foreground")} aria-hidden>
        <span>#</span>
        <span className="text-end">Prompt</span>
        <span className="text-end">Cache</span>
        <span className="text-end">Speed</span>
        <span>Asked for</span>
      </div>
    <ol className="max-h-48 space-y-0.5 overflow-y-auto">
      {calls.map((call, index) => {
        const prompt = promptTokens(call.billed)
        const cache = cachePercent(call.billed)
        const rate = stepRate(call)
        return (
          <li key={call.callId} className={REQUEST_ROW}>
            <span className="text-muted-foreground">#{index + 1}</span>
            <span className="text-end">{formatTokens(prompt)}</span>
            <span className={cn("text-end", cacheTone(cache))}>{cache === null ? "—" : `${cache}%`}</span>
            <span className="text-end text-muted-foreground">{rate === null ? "—" : formatTps(rate)?.replace(" tok/s", "/s")}</span>
            <span className="truncate font-mono text-[11px] text-muted-foreground">{call.called?.join(", ") ?? call.finishReason ?? ""}</span>
          </li>
        )
      })}
    </ol>
    </div>
  )
}

/** How long a turn took, for a footer with no token figure to ride on — an
    agent that reports no usage, or a reader who hid tokens. */
export function TurnTime({ durationMs }: { durationMs: number }) {
  return (
    <span className={FIGURE} title="Turn time">
      <TimerIcon aria-hidden className="size-3 shrink-0" />
      {formatDuration(durationMs)}
    </span>
  )
}

/**
 * The figure, with the breakdown one hover away.
 *
 * Hover *and* click: the popover opens on hover for a reader passing over it
 * and on click for one who cannot hover at all — a phone, a keyboard. The
 * trigger is a real button for the same reason.
 *
 * `context` is a subagent's own window occupancy, which only a step has (a step
 * is a whole session; a turn is not). Left out where there is none rather than
 * drawn empty.
 */
export function TokenSummary({
  usage,
  context,
  label = "Tokens",
  durationMs,
  toolDurationMs,
  generation,
  calls,
  className,
}: {
  usage: acp.Usage
  context?: acp.UsageUpdate
  /** What the popover calls this reading — "This turn", "This step". */
  label?: string
  /** Server-measured wall clock for the turn, ms — what tok/s is drawn
      against. Absent on turns that ended before the server measured it. */
  durationMs?: number
  /** Union wall time spent in the thread's own tool calls, ms. */
  toolDurationMs?: number
  /** What the turn's model calls wrote over their decode time — the speed.
      Without it the figure beside the tokens is throughput over the turn's
      wall clock, and is labelled as that. */
  generation?: TurnGeneration
  /** The turn's own model calls, in order — the per-request list. */
  calls?: ThreadCall[]
  className?: string
}) {
  const prompt = promptTokens(usage)
  const firstTokenMs = calls?.[0]?.timing?.ttftMs
  const costUsd = calls ? costOfCalls(calls) : null
  /* Null where the runtime reported no cache figure: "not said" is not 0%. */
  const cacheRate = cachePercent(usage)
  const generationSpeed = generation ? generationRate(generation) : null
  const speed = generationSpeed === null ? null : formatTps(generationSpeed)
  const throughput = durationMs !== undefined ? formatRate(usage.outputTokens, durationMs) : null
  /* The figure on the chip: the speed when it was measured, else throughput —
     never both, and the popover says which one it is. */
  const rate = speed ?? throughput
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={250}
        render={
          <button
            type="button"
            aria-label={`${label}: ${usage.totalTokens} tokens${cacheRate !== null ? `, ${cacheRate}% from cache` : ""}`}
            className={cn(FIGURE, className)}
          >
            <CoinsIcon aria-hidden className="size-3 shrink-0" />
            <TokenFigure usage={usage} />
            {durationMs !== undefined && <span className="text-muted-foreground">· {formatDuration(durationMs)}</span>}
            {rate && <span className="text-muted-foreground">· {rate}</span>}
            {cacheRate !== null && <CacheFigure percent={cacheRate} />}
          </button>
        }
      />
      <ReadingPopoverContent align="start" heading={label} meta={calls?.[0]?.model} className={READING_WIDTH}>
        <ReadingHero
          value={formatTokens(usage.totalTokens)}
          unit="tokens billed"
          caption={[
            calls?.length ? `${calls.length} request${calls.length === 1 ? "" : "s"}` : null,
            `${formatTokens(prompt)} prompt sent`,
          ]
            .filter(Boolean)
            .join(" · ")}
          cache={cacheRate}
        />
        <Facts
          items={[
            durationMs !== undefined && { label: "Time", value: formatDuration(durationMs) },
            rate && { label: speed ? "Speed" : "Throughput", value: rate },
            firstTokenMs !== undefined && { label: "First token", value: formatMs(firstTokenMs) },
            costUsd !== null && { label: "Cost", value: `$${costUsd.toFixed(costUsd < 1 ? 4 : 2)}` },
          ]}
        />
        <TokenBreakdown usage={usage} split={calls ? sumSplits(calls.map((call) => call.output)) : null} />
        <ReadingTabs
          tabs={[
            calls && calls.length > 0 && {
              id: "requests",
              label: "Requests",
              meta: `${calls.length}`,
              content: <RequestList calls={calls} />,
            },
            durationMs !== undefined && {
              id: "time",
              label: "Time",
              meta: speed && throughput ? `whole turn ${throughput}` : formatDuration(durationMs),
              content: <BilledBar parts={turnTimeParts(durationMs, toolDurationMs, generation)} format={formatDuration} share />,
            },
            context && {
              id: "window",
              label: "Window",
              meta: `${formatTokens(context.used)} of ${formatTokens(context.size)}${context.cost ? ` · ${context.cost.amount.toFixed(2)} ${context.cost.currency}` : ""}`,
              content: <Meter value={context.used} max={context.size} />,
            },
          ]}
        />
        {/* The same caveat the composer's popover carries, and for the same
            reason: a turn re-sends its context once per tool call, so a total
            far above the context size is arithmetic, not a bug. */}
        <p className="border-t pt-2 text-[11px] leading-4 text-muted-foreground">
          Billed across every model request in it — a turn re-sends the context once per tool call.
        </p>
      </ReadingPopoverContent>
    </Popover>
  )
}
