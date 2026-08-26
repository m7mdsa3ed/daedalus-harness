import { useState } from "react"
import {
  CheckCircle2Icon,
  CheckIcon,
  ChevronDownIcon,
  CircleDashedIcon,
  LoaderCircleIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
} from "@/components/ui/item"
import { Logo } from "@/components/ui/logo"
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
            size="icon-sm"
            className="relative shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
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

/**
 * The plan above the composer. Collapsed it is one line — what the agent is on
 * now, and a segment per step so the *shape* of the plan is visible at a
 * glance: how many steps there are, how many are behind you, which one is
 * live. Expanded it is the whole checklist, in place.
 *
 * ponytail: this used to hide the list behind a popover. A popover is for
 * things you consult; a plan is something you watch, so it opens downward into
 * the page instead of floating over it.
 */
export function ComposerPlan({ thread }: { thread: ThreadState }) {
  const [open, setOpen] = useState(false)
  const plan = thread.items.find((item): item is PlanItem => item.kind === "plan")
  if (!plan || plan.entries.length === 0) return null

  const total = plan.entries.length
  const completed = plan.entries.filter((entry) => entry.status === "completed").length
  const current = plan.entries.find((entry) => entry.status === "in_progress")
    ?? plan.entries.find((entry) => entry.status !== "completed")
  const running = current?.status === "in_progress"
  const done = completed === total
  const percent = Math.round((completed / total) * 100)

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="w-full"
    >
      <CollapsibleTrigger
        render={
          <button
            type="button"
            className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors hover:bg-accent/40"
          />
        }
      >
        {/* The ring carries the progress — same dial the context indicator uses,
            so "how far through" reads the same way everywhere in the composer. */}
        <span className="relative grid size-6 shrink-0 place-items-center text-primary">
          <Ring percent={percent} />
          <span className="absolute grid place-items-center text-[8px] font-semibold tabular-nums">
            {done ? <CheckIcon className="size-2.5" /> : completed}
          </span>
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-xs",
            // The live step shimmers like the transcript's working line, so
            // "which step" and "still going" are the same signal.
            running ? "harness-shimmer text-primary" : "text-muted-foreground"
          )}
        >
          {current?.content ?? "All steps complete"}
        </span>
        <Badge variant="secondary" className="shrink-0 font-mono tabular-nums">
          {completed}/{total}
        </Badge>
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
            open && "rotate-180"
          )}
        />
        <span className="sr-only">{open ? "Hide steps" : "Show all steps"}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="harness-collapse">
        {/* A twenty-step plan must not push the composer off screen: the list
            caps out and scrolls, so the shelf stays a shelf. */}
        <ItemGroup className="max-h-56 gap-0.5 overflow-y-auto border-t border-border/40 p-1 overscroll-contain">
          {plan.entries.map((entry, index) => (
            <Item
              key={`${entry.content}-${index}`}
              size="xs"
              variant={entry.status === "in_progress" ? "muted" : "default"}
              className="items-start gap-2 rounded-lg py-1.5"
            >
              <ItemMedia variant="icon" className="mt-px">
                {entry.status === "completed" ? (
                  <CheckCircle2Icon className="size-3.5 text-primary" />
                ) : entry.status === "in_progress" ? (
                  <LoaderCircleIcon className="size-3.5 animate-spin text-primary" />
                ) : (
                  <CircleDashedIcon className="size-3.5 text-muted-foreground/60" />
                )}
              </ItemMedia>
              <ItemContent>
                <ItemDescription
                  className={cn(
                    "line-clamp-none text-xs",
                    entry.status === "completed"
                      ? "line-through opacity-60"
                      : "text-foreground"
                  )}
                >
                  {entry.content}
                </ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      </CollapsibleContent>
    </Collapsible>
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
      className="inline-flex items-center gap-2 text-primary"
      role="status"
    >
      {/* The mark traces itself for as long as the turn runs — the same three
          paths the boot splash draws, so starting a turn rhymes with starting
          the app. size-4 sits on the step row's 1.5rem line box. */}
      <Logo working className="size-4 shrink-0" />
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
