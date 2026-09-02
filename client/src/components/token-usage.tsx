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
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-1 py-0.5 leading-4 tabular-nums",
              "transition-colors duration-150 hover:text-muted-foreground",
              "focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-ring",
              className
            )}
          >
            <CoinsIcon aria-hidden className="size-3 shrink-0" />~{formatTokens(usage.used)} tokens
          </button>
        }
      />
      <PopoverContent align="start" side="top" className="w-56 gap-2">
        <p className="font-medium">This step</p>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
          <Stat label="Request" value={formatTokens(usage.used)} />
          <Stat label="Window" value={formatTokens(usage.size)} />
          {share !== null && <Stat label="Share of window" value={`${share}%`} />}
          {usage.cost && (
            <Stat
              label="Session cost"
              value={`${usage.cost.amount.toFixed(2)} ${usage.cost.currency}`}
            />
          )}
        </dl>
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
