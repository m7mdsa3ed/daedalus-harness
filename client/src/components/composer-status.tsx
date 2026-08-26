import { useState } from "react"
import { CheckCircle2Icon, CircleDashedIcon, LoaderCircleIcon, ListTreeIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { PlanItem, ThreadState } from "@/lib/store"
import { cn } from "@/lib/utils"

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function Ring({ percent }: { percent: number }) {
  const radius = 8.5
  const circumference = 2 * Math.PI * radius

  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-6 -rotate-90">
      <circle cx="12" cy="12" r={radius} fill="none" strokeWidth="2" stroke="currentColor" className="opacity-15" />
      <circle
        cx="12"
        cy="12"
        r={radius}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        stroke="currentColor"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - percent / 100)}
      />
    </svg>
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
 * The single home for per-turn telemetry: context occupancy on the ring, and
 * tokens / cache rate / TTFT inside its popover. The header carries none of it.
 */
export function ContextIndicator({ thread }: { thread: ThreadState }) {
  const { context, usage, ttftMs } = thread
  if (!context && !usage && ttftMs === null) return null

  const percent = context
    ? Math.min(100, Math.max(0, Math.round((context.used / context.size) * 100)))
    : 0
  // thread.usage is the store's running total over the session's turns (agents
  // report Usage per turn), so the rate below is a genuine average.
  // `inputTokens` counts only tokens NOT served from cache — the rest of the
  // prompt arrives as cachedRead (hit) or cachedWrite (miss, being cached now).
  // Dividing by inputTokens alone pins the rate at ~100%: the whole prompt is
  // the denominator.
  // One user message === one session/prompt (actions.send is the only caller),
  // and items are rebuilt from the journal on reconnect — so no counter to keep.
  const requests = thread.items.filter((item) => item.kind === "user").length
  const cached = usage?.cachedReadTokens ?? 0
  const prompt = usage ? usage.inputTokens + cached + (usage.cachedWriteTokens ?? 0) : 0
  const cacheRate = prompt > 0 ? Math.round((cached / prompt) * 100) : null

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-lg"
            className="relative shrink-0 rounded-full text-muted-foreground hover:text-foreground"
            title={context ? `Context window — ${percent}% used` : "Turn stats"}
          >
            <Ring percent={percent} />
            <span className="absolute inset-0 grid place-items-center text-[7px] font-semibold tabular-nums">
              {context ? percent : "—"}
            </span>
          </Button>
        }
      />
      <PopoverContent align="end" side="top" className="w-60 gap-2">
        <div>
          <p className="font-medium">Context window</p>
          <p className="text-xs text-muted-foreground">
            {context
              ? `${formatTokens(context.used)} of ${formatTokens(context.size)} tokens`
              : "Not reported by this agent"}
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
          <Stat label="Requests" value={String(requests)} />
          {context && (
            <>
              <Stat label="Used" value={`${percent}%`} />
              <Stat label="Remaining" value={formatTokens(Math.max(0, context.size - context.used))} />
            </>
          )}
          {usage && (
            <>
              <Stat label="Prompt" value={formatTokens(prompt)} />
              <Stat label="Output" value={formatTokens(usage.outputTokens)} />
              <Stat label="New in" value={formatTokens(usage.inputTokens)} />
            </>
          )}
          {usage?.thoughtTokens ? <Stat label="Thinking" value={formatTokens(usage.thoughtTokens)} /> : null}
          {usage?.cachedReadTokens ? <Stat label="Cached" value={formatTokens(usage.cachedReadTokens)} /> : null}
          {usage?.cachedWriteTokens ? <Stat label="Cache write" value={formatTokens(usage.cachedWriteTokens)} /> : null}
          {cacheRate !== null && <Stat label="Cache avg" value={`${cacheRate}%`} />}
          {usage && <Stat label="Total" value={formatTokens(usage.totalTokens)} />}
          {ttftMs !== null && <Stat label="TTFT" value={`${ttftMs}ms`} />}
          {/* Cost is cumulative for the session; agents that don't price turns omit it. */}
          {context?.cost && (
            <Stat label="Cost" value={`${context.cost.amount.toFixed(2)} ${context.cost.currency}`} />
          )}
        </dl>
        {usage && (
          <p className="text-[11px] text-muted-foreground">
            Billed across every model request this session, so totals run far above the
            context size — a turn re-sends the context once per tool call. Revive resets them.
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}

export function ComposerPlan({ thread }: { thread: ThreadState }) {
  const plan = thread.items.find((item): item is PlanItem => item.kind === "plan")
  if (!plan || plan.entries.length === 0) return null

  const total = plan.entries.length
  const completed = plan.entries.filter((entry) => entry.status === "completed").length
  const current = plan.entries.find((entry) => entry.status === "in_progress")
    ?? plan.entries.find((entry) => entry.status !== "completed")
  const percent = Math.round((completed / total) * 100)

  return (
    <div className="relative mb-1 flex h-7 items-center gap-1.5 rounded-lg bg-muted/45 px-2 text-xs text-muted-foreground">
      <ListTreeIcon className="size-3.5 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 truncate">
        {current?.content ?? "All steps complete"}
      </span>
      <span className="shrink-0 font-mono tabular-nums">{completed}/{total}</span>
      <Popover>
        <PopoverTrigger
          render={
            <Button variant="ghost" size="sm" className="h-6 shrink-0 rounded-full px-2 text-[11px]">
              Steps
            </Button>
          }
        />
        <PopoverContent align="end" side="top" className="w-64 gap-2">
          <div className="flex items-center justify-between">
            <p className="font-medium">Plan</p>
            <span className="font-mono tabular-nums text-muted-foreground">{completed}/{total}</span>
          </div>
          <ol className="space-y-1.5">
            {plan.entries.map((entry) => (
              <li key={`${entry.content}-${entry.status}`} className="flex items-start gap-2">
                {entry.status === "completed" ? (
                  <CheckCircle2Icon className="mt-0.5 size-3 shrink-0 text-primary" />
                ) : entry.status === "in_progress" ? (
                  <LoaderCircleIcon className="mt-0.5 size-3 shrink-0 animate-spin text-primary" />
                ) : (
                  <CircleDashedIcon className="mt-0.5 size-3 shrink-0 text-muted-foreground/60" />
                )}
                <span className={cn("min-w-0", entry.status === "completed" ? "text-muted-foreground" : "text-foreground")}>
                  {entry.content}
                </span>
              </li>
            ))}
          </ol>
        </PopoverContent>
      </Popover>
      <div className="absolute inset-x-2 bottom-0 h-px overflow-hidden rounded-full bg-border/60">
        <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}

const WORKING_WORDS = [
  "Thinking", "Pondering", "Cogitating", "Musing", "Scheming", "Brewing",
  "Wandering", "Tinkering", "Puzzling", "Noodling", "Percolating", "Conjuring",
  "Untangling", "Ruminating", "Deliberating", "Spelunking",
]

export function ActivityIndicator({ step }: { step: number }) {
  // Random start per turn (the indicator mounts with the turn), then walk the
  // list by a stride coprime to its length: every step is a new word, and the
  // whole list is used before any repeat. No timers, no state per step.
  const [seed] = useState(() => Math.floor(Math.random() * WORKING_WORDS.length))
  const word = WORKING_WORDS[(seed + step * 7) % WORKING_WORDS.length]

  return (
    <div
      aria-label="Agent working"
      className="inline-flex items-center text-primary"
      role="status"
    >
      {/* ponytail: one flat text node — the shimmer paints a background clipped to
          text, and background-image doesn't inherit, so a nested span goes blank. */}
      {/* leading-6 matches a step row's line box, so the working line keeps the
          transcript's vertical rhythm. */}
      <span aria-hidden className="harness-shimmer text-xs leading-6">
        {word}…
      </span>
    </div>
  )
}
