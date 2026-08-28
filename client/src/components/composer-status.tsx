import { useState } from "react"
import {
  CheckCircle2Icon,
  CheckIcon,
  ChevronDownIcon,
  CircleDashedIcon,
  LoaderCircleIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Logo } from "@/components/ui/logo"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { PlanItem, ThreadState } from "@/lib/store"
import { cn } from "@/lib/utils"

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

/** Above this the agent is about to compact, so the popover says so. */
const COMPACTION_WARN = 85

/** Urgency colour for the ring and bar: calm while there is room, amber as it
 *  fills, red at the brink. Returns both the text and fill classes so the same
 *  tone paints the dial and the bar without a second threshold check. */
function contextTone(percent: number): { text: string; bar: string } {
  if (percent >= 90) return { text: "text-destructive", bar: "bg-destructive" }
  if (percent >= COMPACTION_WARN) return { text: "text-amber-600 dark:text-amber-400", bar: "bg-amber-500" }
  return { text: "text-emerald-600 dark:text-emerald-400", bar: "bg-emerald-500" }
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

function Stat({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("font-medium tabular-nums", valueClass)}>{value}</dd>
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
  const tone = context ? contextTone(percent) : null

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn(
              "relative shrink-0 rounded-lg hover:text-foreground",
              tone ? tone.text : "text-muted-foreground",
            )}
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
        {context && (
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className={cn("h-full rounded-full transition-all", tone?.bar)} style={{ width: `${percent}%` }} />
          </div>
        )}
        {context && percent >= COMPACTION_WARN && (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">
            Context is nearly full — the agent compacts the history soon to keep the turn going.
          </p>
        )}
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
          <Stat label="Requests" value={String(requests)} />
          {context && (
            <>
              <Stat label="Used" value={`${percent}%`} valueClass={tone?.text} />
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
          {cacheRate !== null && (
            <Stat
              label="Cache avg"
              value={`${cacheRate}%`}
              valueClass={
                cacheRate >= 50
                  ? "text-emerald-600 dark:text-emerald-400"
                  : cacheRate >= 20
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-destructive"
              }
            />
          )}
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
            /* px-2: the strip's own gutter, the one DraftScopeRow sits in — a
               row on the shelf should start where the other row starts. */
            className="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-accent/40"
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
        {/* The count and the chevron are one cluster, not two things that
            happened to end up next to each other: they share a tighter gap than
            the row's, and the chevron sits in a fixed square so it is on the
            same right edge whether the count is 1/9 or 12/40. */}
        <span className="flex shrink-0 items-center gap-1.5">
          {/* Plain caption text, not a filled badge: the strip has no chips on
              it anywhere else, and the ring to the left is already the loud way
              of saying how far along this is. */}
          <span className="text-[11px] tabular-nums text-muted-foreground/70">
            {completed}/{total}
          </span>
          <span className="grid size-4 place-items-center">
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "size-3.5 text-muted-foreground transition-transform duration-200",
                open && "rotate-180"
              )}
            />
          </span>
        </span>
        <span className="sr-only">{open ? "Hide steps" : "Show all steps"}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="harness-collapse">
        {/* Full height, no inner scroll. A plan is read in one piece — which
            step follows which is most of the information in it — and a list
            that scrolls inside a shelf that is itself inside a scrolling page
            gives you two wheels doing different things over one line of text.
            The transcript above is the flexible track (`minmax(0,1fr)`), so an
            open plan takes its room from the conversation and gives it straight
            back on collapse; the composer never moves. It is opened by hand and
            closes the same way, so a long one is on screen because it was
            asked for.

            A plan step IS a transcript step, so it is built like one: a
            `size-3.5` status icon on the first line, `text-xs leading-6` beside
            it, nothing boxed. The Item kit gave every row its own padded,
            rounded, sometimes-filled surface — a list of little cards stacked
            inside a shelf that is itself inside the composer, three frames deep
            for one line of text each. */}
        <ul className="space-y-0.5 border-t border-border/40 px-2 py-1.5">
          {plan.entries.map((entry, index) => (
            <li key={`${entry.content}-${index}`} className="flex items-start gap-2 text-xs">
              {/* `size-6`, the ring's width, so a step's icon sits under the
                  ring's centre and its text starts on the same column as the
                  current-step line above it. Without the box the list was
                  indented ten pixels left of the row it expands from. */}
              <span className="grid size-6 shrink-0 place-items-center">
                {entry.status === "completed" ? (
                  <CheckCircle2Icon aria-hidden className="size-3.5 text-primary" />
                ) : entry.status === "in_progress" ? (
                  <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin text-primary" />
                ) : (
                  <CircleDashedIcon aria-hidden className="size-3.5 text-muted-foreground/60" />
                )}
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 leading-6",
                  entry.status === "completed"
                    ? "text-muted-foreground line-through opacity-70"
                    : entry.status === "in_progress"
                      ? "text-foreground"
                      : "text-muted-foreground"
                )}
              >
                {entry.content}
              </span>
            </li>
          ))}
        </ul>
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
