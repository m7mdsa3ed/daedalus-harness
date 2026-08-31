/* ── What it cost ──
   One figure, drawn the same everywhere a unit of work ends: under a finished
   turn, on a workflow step, on a subagent's row, in a run's header.

   Two forms, and which one a surface gets is decided by what it is allowed to
   contain rather than by taste. `TokenFigure` is bare text — a step row's
   trailing column, a tab, the card that is itself one big button; a popover
   trigger cannot go inside any of those, because a button may not hold a
   button. `TokenSummary` is the figure with the breakdown behind it, for the
   places that are ordinary flow content — chiefly the turn footer, which is
   where the breakdown is actually worth having: the turn is the thing a reader
   asks "why was that expensive" about.

   Everything here is gated by the `showTokens` view option at the CALL SITE,
   not in here: a component that renders nothing is still a component the
   transcript mounts per row. */
import * as React from "react"
import { CoinsIcon } from "lucide-react"
import type * as acp from "@agentclientprotocol/sdk"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { formatTokens, promptTokens } from "@/lib/tokens"
import { cn } from "@/lib/utils"

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
   between is about. */
const StepTokensContext = React.createContext<Record<string, number>>({})

export const StepTokensProvider = StepTokensContext.Provider

/** What the model request that ended on this item cost, or undefined where no
    reading was ever filed against it — which is most items, since one request
    writes several. */
export function useStepTokens(itemId: string): number | undefined {
  return React.useContext(StepTokensContext)[itemId]
}

/**
 * A step's cost, on the step's own row.
 *
 * Written `~12.4k tokens`, and the tilde is the honest part: unlike a turn's
 * figure or a workflow step's — both of which an agent *reported* — this one is
 * a mid-turn reading matched to a position (see `markStepUsage`), so it is the
 * right order of magnitude for this step and not an invoice line. Bare text,
 * because every surface that draws it is inside `StepRow`'s disclosure button.
 */
export function StepTokens({ tokens, className }: { tokens: number; className?: string }) {
  return (
    <span
      className={cn("tabular-nums", className)}
      title="Roughly what the model request behind this step cost — the context it carried plus what it wrote"
    >
      ~{formatTokens(tokens)} tokens
    </span>
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
  className,
}: {
  usage: acp.Usage
  context?: acp.UsageUpdate
  /** What the popover calls this reading — "This turn", "This step". */
  label?: string
  className?: string
}) {
  const prompt = promptTokens(usage)
  const cached = usage.cachedReadTokens ?? 0
  const cacheRate = prompt > 0 ? Math.round((cached / prompt) * 100) : null
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={250}
        render={
          <button
            type="button"
            aria-label={`${label}: ${usage.totalTokens} tokens`}
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[11px] leading-4 text-muted-foreground/60",
              "transition-colors duration-150 hover:text-muted-foreground",
              "focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-ring",
              className
            )}
          >
            <CoinsIcon aria-hidden className="size-3 shrink-0" />
            <TokenFigure usage={usage} />
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
