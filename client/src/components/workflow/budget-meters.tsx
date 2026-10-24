/* A run's budgets against what it has used — tokens, cost, agents, wall time.
   A meter is drawn only for a budget that was set: an unbounded run has
   nothing to meter, and a row of empty bars would say it was close to
   something. Warns at 80% and turns destructive at 100%. */
import { Progress } from "@/components/ui/progress"
import { useElapsed, formatElapsed } from "@/components/step-row"
import { formatTokens } from "@/lib/tokens"
import { cn } from "@/lib/utils"
import type { WorkflowBudgets, WorkflowRunView } from "@/lib/queries/workflows"
import { isTerminalRun } from "@/lib/queries/workflows"

const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(1)}`

interface Meter {
  key: string
  label: string
  used: number
  max: number
  reading: string
}

export function BudgetMeters({ run }: { run: Pick<WorkflowRunView, "usage" | "budgets" | "status" | "createdAt" | "endedAt"> }) {
  const budgets: WorkflowBudgets = run.budgets
  const live = !isTerminalRun(run.status)
  /* The wall clock is the run's age. The server excludes paused time and this
     cannot, so the figure is "about", and a held run's meter is a ceiling. */
  const now = useElapsed(0, live && budgets.wallSec !== undefined)
  const wallUsed = ((run.endedAt ?? now ?? Date.now()) - run.createdAt) / 1000
  const meters: Meter[] = []
  if (budgets.tokens !== undefined)
    meters.push({
      key: "tokens",
      label: "Tokens",
      used: run.usage.tokens,
      max: budgets.tokens,
      reading: `${formatTokens(run.usage.tokens)} / ${formatTokens(budgets.tokens)}`,
    })
  if (budgets.costUsd !== undefined)
    meters.push({
      key: "cost",
      label: "Cost",
      used: run.usage.costUsd,
      max: budgets.costUsd,
      reading: `${usd(run.usage.costUsd)} / ${usd(budgets.costUsd)}`,
    })
  if (budgets.agents !== undefined)
    meters.push({
      key: "agents",
      label: "Agents",
      used: run.usage.agents,
      max: budgets.agents,
      reading: `${run.usage.agents} / ${budgets.agents}`,
    })
  if (budgets.wallSec !== undefined)
    meters.push({
      key: "wall",
      label: "Wall time",
      used: wallUsed,
      max: budgets.wallSec,
      reading: `~${formatElapsed(wallUsed * 1000)} / ${formatElapsed(budgets.wallSec * 1000)}`,
    })
  if (meters.length === 0) return null
  return (
    <div role="group" aria-label="Budgets" className="grid gap-x-4 gap-y-2 @panel-sm:grid-cols-2">
      {meters.map((meter) => {
        const ratio = meter.max > 0 ? meter.used / meter.max : 0
        return (
          <Progress
            key={meter.key}
            value={Math.min(100, Math.max(0, ratio * 100))}
            aria-label={`${meter.label}: ${meter.reading}`}
            className={cn(
              "gap-1 [&_[data-slot=progress-track]]:h-1.5",
              ratio >= 1
                ? "[&_[data-slot=progress-indicator]]:bg-destructive"
                : ratio >= 0.8 && "[&_[data-slot=progress-indicator]]:bg-warning"
            )}
          >
            <span className="flex w-full min-w-0 items-baseline justify-between gap-2 text-xs">
              <span className="font-medium">{meter.label}</span>
              <span className="tabular-nums text-muted-foreground">{meter.reading}</span>
            </span>
          </Progress>
        )
      })}
    </div>
  )
}
