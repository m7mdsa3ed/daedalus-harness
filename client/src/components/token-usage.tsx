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
   it: the step's own reading says less than a turn's (a window and a share,
   not a prompt/output split), but "how much did this cost" is asked of a step
   in exactly the same breath, and answering it with a `title` attribute meant
   the answer was invisible on a phone and unreachable from a keyboard.

   Everything here is gated by the `showTokens` view option at the CALL SITE,
   not in here: a component that renders nothing is still a component the
   transcript mounts per row. */
import * as React from "react"
import { CoinsIcon } from "lucide-react"
import type * as acp from "@daedalus/acp"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  formatDuration,
  formatRate,
  formatTokens,
  promptBreakdown,
  promptTokens,
  stepBill,
  windowEstimated,
  type TurnTokens,
} from "@/lib/tokens"
import { cn } from "@/lib/utils"

/* The trigger box both popover figures wear. One padding, one line box, one
   colour, one hover — a step's figure and a turn's are the same reading at two
   scopes and were drawn at two sizes, which is what tilted the coin against the
   timestamp beside it in a step's trailing group. Stated here rather than
   inherited from wherever it lands, so the figure looks the same in a run's
   header, on a step and under a turn. */
const FIGURE =
  "inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[11px] leading-4 tabular-nums text-muted-foreground/60 transition-colors duration-150 hover:text-muted-foreground focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-ring"

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
   `ThreadState.stepUsage` keyed by item id (see `markStepUsage`), read through
   a context for the reason the view options are: the rows that print it are
   `ToolStep` and a thought inside `ThreadItemView`, both several layers below
   the transcript and both already memoized per item, and threading a map
   through every row of `buildRows` to reach two of them is a prop nothing in
   between is about. The same context carries each step's *turn* — the billed
   split behind the `used` total — because a step cannot say what its prompt
   and output were on its own: both runtimes report one total per request, and
   the split only when a turn ends. */
type StepTokensValue = {
  /** What the model request that ended on each item filed. */
  step: Record<string, acp.UsageUpdate>
  /** Each item's turn, keyed by the same item ids `step` uses. */
  turn: Record<string, acp.Usage>
}

const StepTokensContext = React.createContext<StepTokensValue>({ step: {}, turn: {} })

export const StepTokensProvider = StepTokensContext.Provider

/** The reading the model request that ended on this item filed, or undefined
    where none ever was — which is most items, since one request writes
    several. The whole `UsageUpdate`, not its figure: `StepTokens` draws the
    window and the cost behind the number. */
export function useStepTokens(itemId: string): acp.UsageUpdate | undefined {
  return React.useContext(StepTokensContext).step[itemId]
}

/** The turn a step sits in, keyed the same way `useStepTokens` is — a step
    itself carries no prompt/output split (runtimes report one total per
    request), but its turn does, and that is what the breakdown is drawn
    from. */
export function useStepTurnUsage(itemId: string): acp.Usage | undefined {
  return React.useContext(StepTokensContext).turn[itemId]
}

/**
 * A step's cost, on the step's own row — the figure, with the same breakdown
 * behind it that a turn's has. The breakdown is the *turn's*, not the step's:
 * a runtime reports one total per model request and the prompt/output/cache
 * split only when the turn ends, so the split lives two hops away and the
 * popover says so rather than pretending each row was billed separately.
 *
 * Written `~12.4k tokens`, and the tilde is the honest part: unlike a turn's
 * figure or a workflow step's — both of which an agent *reported* — this one is
 * a mid-turn reading matched to a position (see `markStepUsage`), so it is the
 * right order of magnitude for this step and not an invoice line. The popover
 * says so in words, because a number with a breakdown under it reads as an
 * invoice unless something says otherwise.
 *
 * It is a real button with the same defaults `TokenSummary` opens on — hover
 * for a reader passing over it, click for one who cannot hover at all, keyboard
 * for one who does not point — which is why `StepRow` had to move its trailing
 * columns out of the disclosure button: a button may not hold a button, and the
 * figure was inside one everywhere it is drawn.
 */
export function StepTokens({
  usage,
  itemId,
  className,
}: {
  usage: acp.UsageUpdate
  /** The row the figure was filed against, for the containing turn's split. */
  itemId?: string
  className?: string
}) {
  const share = usage.size > 0 ? Math.round((usage.used / usage.size) * 100) : null
  /* Both figures are a fraction of a window the runtime had to guess at — the
     request count beside them is real either way. */
  const about = windowEstimated(usage) ? "~" : ""
  /* What this request's prompt was made of. Our runtime measures it and no
     other does, so the whole block is absent rather than zeroed elsewhere. */
  const split = promptBreakdown(usage)
  const turn = useStepTurnUsage(itemId ?? "")
  const prompt = turn ? promptTokens(turn) : 0
  const cacheRate = turn && prompt > 0 ? Math.round(((turn.cachedReadTokens ?? 0) / prompt) * 100) : null
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={250}
        render={
          <button
            type="button"
            aria-label={`This step: about ${usage.used} tokens`}
            className={cn(FIGURE, className)}
          >
            <CoinsIcon aria-hidden className="size-3 shrink-0" />~{formatTokens(usage.used)} tokens
          </button>
        }
      />
      <PopoverContent align="start" side="top" className="w-56 gap-2">
        <p className="font-medium">This step</p>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
          <Stat label="Request" value={formatTokens(usage.used)} />
          <Stat label="Window" value={`${about}${formatTokens(usage.size)}`} />
          {share !== null && <Stat label="Share of window" value={`${about}${share}%`} />}
          {usage.cost && (
            <Stat
              label="Session cost"
              value={`${usage.cost.amount.toFixed(2)} ${usage.cost.currency}`}
            />
          )}
        </dl>
        {split ? (
          <>
            {/* Where that request's prompt went. The system prompt and the tool
                block are counted locally — approximate, and the tilde says so —
                while the conversation is what the provider's own total left over,
                so the three sum to the headline figure exactly. */}
            <p className="pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              This request's prompt
            </p>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
              <Stat label="System" value={`~${formatTokens(split.system)}`} />
              <Stat label="Tools" value={`~${formatTokens(split.tools)}`} />
              {split.mcp > 0 && <Stat label="MCP tools" value={`~${formatTokens(split.mcp)}`} />}
              {split.user !== null && <Stat label="User messages" value={`~${formatTokens(split.user)}`} />}
              <Stat label="History/tools" value={formatTokens(split.conversation)} />
              <Stat label="Prompt" value={formatTokens(split.total)} />
            </dl>
          </>
        ) : null}
        {turn ? (
          <>
            <p className="pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              This turn
            </p>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
              <Stat label="Prompt" value={formatTokens(prompt)} />
              <Stat label="Output" value={formatTokens(turn.outputTokens)} />
              <Stat label="New in" value={formatTokens(turn.inputTokens)} />
              {turn.thoughtTokens ? <Stat label="Thinking" value={formatTokens(turn.thoughtTokens)} /> : null}
              {turn.cachedReadTokens ? <Stat label="Cached" value={formatTokens(turn.cachedReadTokens)} /> : null}
              {turn.cachedWriteTokens ? (
                <Stat label="Cache write" value={formatTokens(turn.cachedWriteTokens)} />
              ) : null}
              {cacheRate !== null && <Stat label="Cache rate" value={`${cacheRate}%`} />}
              <Stat label="Total" value={formatTokens(turn.totalTokens)} />
            </dl>
          </>
        ) : null}
        {/* What the runtime reports here is the *last model request's* own
            count — the context it carried plus what it wrote — and which step
            it belongs to is inferred from where it landed. Both halves of that
            are why the figure is written with a tilde. */}
        <p className="text-[11px] text-muted-foreground">
          Roughly what the model request behind this step cost — the context it carried plus what it
          wrote. The split is the whole turn's: runtimes report a per-step total, and the
          prompt/output/cache breakdown only when a turn ends.
        </p>
      </PopoverContent>
    </Popover>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
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
  className?: string
}) {
  const prompt = promptTokens(usage)
  const cached = usage.cachedReadTokens ?? 0
  const cacheRate = prompt > 0 ? Math.round((cached / prompt) * 100) : null
  const rate = durationMs !== undefined ? formatRate(usage.outputTokens, durationMs) : null
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={250}
        render={
          <button
            type="button"
            aria-label={`${label}: ${usage.totalTokens} tokens`}
            className={cn(FIGURE, className)}
          >
            <CoinsIcon aria-hidden className="size-3 shrink-0" />
            <TokenFigure usage={usage} />
            {rate && <span className="text-muted-foreground/80">· {rate}</span>}
          </button>
        }
      />
      <PopoverContent align="start" side="top" className="w-56 gap-2">
        <p className="font-medium">{label}</p>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
          <Stat label="Prompt" value={formatTokens(prompt)} />
          <Stat label="Output" value={formatTokens(usage.outputTokens)} />
          <Stat label="New in" value={formatTokens(usage.inputTokens)} />
          {usage.thoughtTokens ? <Stat label="Thinking" value={formatTokens(usage.thoughtTokens)} /> : null}
          {usage.cachedReadTokens ? <Stat label="Cached" value={formatTokens(usage.cachedReadTokens)} /> : null}
          {usage.cachedWriteTokens ? (
            <Stat label="Cache write" value={formatTokens(usage.cachedWriteTokens)} />
          ) : null}
          {cacheRate !== null && <Stat label="Cache rate" value={`${cacheRate}%`} />}
          <Stat label="Total" value={formatTokens(usage.totalTokens)} />
          {durationMs !== undefined && (
            <>
              <Stat label="Turn time" value={formatDuration(durationMs)} />
              {toolDurationMs !== undefined && (
                <>
                  <Stat label="Tool calls" value={formatDuration(toolDurationMs)} />
                  <Stat
                    label="Outside tools"
                    value={formatDuration(Math.max(0, durationMs - toolDurationMs))}
                  />
                </>
              )}
            </>
          )}
          {rate && <Stat label="Whole-turn speed" value={rate} />}
          {context && (
            <Stat label="Context" value={`${formatTokens(context.used)} / ${formatTokens(context.size)}`} />
          )}
          {context?.cost && (
            <Stat label="Cost" value={`${context.cost.amount.toFixed(2)} ${context.cost.currency}`} />
          )}
        </dl>
        {/* The same caveat the composer's popover carries, and for the same
            reason: a turn re-sends its context once per tool call, so a total
            far above the context size is arithmetic, not a bug. */}
        <p className="text-[11px] text-muted-foreground">
          Billed across every model request in it — a turn re-sends the context once per tool call.
        </p>
      </PopoverContent>
    </Popover>
  )
}

/* ── The thread, turn by turn ──
   Every model request the thread made, grouped under the message that started
   its turn, each drawn as where its prompt went (system / built-in tools / MCP
   tools / user messages / history and tool results — our runtime's split, see
   `promptBreakdown`) and what it wrote (output, of which reasoning). Another
   runtime reports only a total per request, so its bar is one grey segment and
   the turn's billed split is all there is. */
const PARTS = [
  { key: "system", label: "System", swatch: "bg-chart-1" },
  { key: "tools", label: "Tools", swatch: "bg-chart-2" },
  { key: "mcp", label: "MCP tools", swatch: "bg-chart-4" },
  { key: "conversation", label: "History/tools", swatch: "bg-chart-3" },
] as const

function Bar({ parts, total, max }: { parts: { swatch: string; tokens: number }[]; total: number; max: number }) {
  return (
    <div className="flex h-1.5 overflow-hidden rounded-full bg-muted" style={{ width: `${Math.max(4, (total / max) * 100)}%` }}>
      {parts.map((part, i) =>
        part.tokens > 0 ? (
          <div key={i} className={part.swatch} style={{ width: `${(part.tokens / total) * 100}%` }} />
        ) : null
      )}
    </div>
  )
}

function stepParts(step: acp.UsageUpdate) {
  const split = promptBreakdown(step)
  return split
    ? [
        ...PARTS.map((part) => ({ ...part, tokens: split[part.key] })),
        ...(split.user === null ? [] : [{ key: "user", label: "User messages", swatch: "bg-chart-5", tokens: split.user }]),
      ]
    : [{ key: "used", label: "Prompt", swatch: "bg-foreground/40", tokens: step.used }]
}

export function TurnTokensList({ turns }: { turns: TurnTokens[] }) {
  const max = Math.max(1, ...turns.flatMap((turn) => turn.steps.map((step) => step.used)))
  const measured = turns.some((turn) => turn.steps.some((step) => promptBreakdown(step)))
  return (
    <div className="space-y-1.5 text-[11px]">
      {measured && (
        <p className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-[10px] text-muted-foreground">
          {PARTS.map((part) => (
            <span key={part.key} className="inline-flex items-center gap-1">
              <span className={cn("size-2 rounded-sm", part.swatch)} />
              {part.label}
            </span>
          ))}
        </p>
      )}
      {turns.map((turn, index) => {
        /* The turn's prompt parts, summed over its requests — billed, not held:
           each request re-sends the lot. */
        const sums = new Map<string, { label: string; swatch: string; tokens: number }>()
        for (const step of turn.steps)
          for (const part of stepParts(step)) {
            const held = sums.get(part.key)
            sums.set(part.key, { ...part, tokens: (held?.tokens ?? 0) + part.tokens })
          }
        const usage = turn.usage
        return (
          <details key={turn.id} open={index === turns.length - 1} className="group rounded-md bg-muted/35 px-2 py-1.5">
            <summary className="flex cursor-pointer list-none items-baseline gap-2">
              <span className="shrink-0 font-medium tabular-nums">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground" title={turn.prompt}>
                {turn.prompt || "(no text)"}
              </span>
              <span className="shrink-0 font-medium tabular-nums">
                {usage ? formatTokens(usage.totalTokens) : "…"}
              </span>
            </summary>
            <dl className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-1">
              {usage && <Stat label="Prompt" value={formatTokens(promptTokens(usage))} />}
              {usage && <Stat label="Output" value={formatTokens(usage.outputTokens)} />}
              {usage?.thoughtTokens ? <Stat label="Reasoning" value={formatTokens(usage.thoughtTokens)} /> : null}
              {usage?.cachedReadTokens ? <Stat label="Cached" value={formatTokens(usage.cachedReadTokens)} /> : null}
              {[...sums.values()].map((part) =>
                part.tokens > 0 ? (
                  <Stat
                    key={part.label}
                    label={part.label}
                    value={`${part.label === "History/tools" || part.label === "Prompt" ? "" : "~"}${formatTokens(part.tokens)}`}
                  />
                ) : null
              )}
              <Stat label="Requests" value={String(turn.steps.length)} />
            </dl>
            {turn.steps.length > 0 && (
              <ol className="mt-1.5 space-y-1 border-t border-border/40 pt-1.5">
                {turn.steps.map((step, i) => {
                  const bill = stepBill(step)
                  const parts = stepParts(step)
                  return (
                    <li
                      key={i}
                      className="grid grid-cols-[1.25rem_1fr_auto] items-center gap-x-2"
                      title={parts.map((part) => `${part.label} ${formatTokens(part.tokens)}`).join(" · ")}
                    >
                      <span className="text-[10px] text-muted-foreground tabular-nums">{i + 1}</span>
                      <Bar parts={parts} total={step.used} max={max} />
                      <span className="text-[10px] tabular-nums text-muted-foreground">
                        {formatTokens(step.used)}
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
      })}
    </div>
  )
}
