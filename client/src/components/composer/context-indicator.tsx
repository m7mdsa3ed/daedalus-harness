/* ── How full the window is, and what the turn cost ──
   The context ring the composer footer's cluster ends on and the tab strip
   wears the other way up, its per-turn telemetry, and — under a border, for
   the pair that has a plan to read — the account the thread spends. */
import * as React from "react"
import { Spinner } from "@/components/ui/spinner"
import { useState } from "react"
import { ChevronDownIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Popover, PopoverTrigger } from "@/components/ui/popover"
import { Notice } from "@/components/notice"
import {
  OpenInInspector,
  READING_MARK,
  READING_TRIGGER,
  ReadingBubble,
  ReadingFace,
  ReadingPopoverContent,
  Ring,
} from "@/components/composer/indicator"
import {
  accountTitle,
  formatAmount,
  formatReset,
  peakWindow,
  planReadable,
  quotaStatusText,
  quotaTone,
  windowTitle,
  type QuotaWindow,
} from "@/lib/quota"
import type { Actions } from "@/lib/actions"
import type { SessionMeta } from "@/lib/settings"
import { useAgents, useProfiles } from "@/lib/queries/catalog"
import { useFeature } from "@/lib/queries/surfaces"
import { addUsage, type ThreadState } from "@/lib/store"
import { spendTime, subagentSpend } from "@/lib/subagent-spend"
import {
  formatDuration,
  formatTokens,
  formatTps,
  windowEstimated,
} from "@/lib/tokens"
import { cn } from "@/lib/utils"
import { tpsAverage } from "@daedalus/tps"

/** Above this the agent is about to compact, so the popover says so. */
const COMPACTION_WARN = 85

/** One figure on one line: the label at the start, the value at the end, so a
    column of them reads down like a receipt rather than across like a grid. */
function Row({
  label,
  value,
  hint,
  valueClass,
}: {
  label: string
  value: string
  hint?: string
  valueClass?: string
}) {
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <dt className="min-w-0 flex-1 truncate text-muted-foreground">{label}</dt>
      {hint && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{hint}</span>}
      <dd className={cn("shrink-0 font-medium tabular-nums", valueClass)}>{value}</dd>
    </div>
  )
}

/** Children listed by name before the rest fold into "N more"; the Agents
    panel has the whole list. */
const SUBAGENT_ROWS = 4

/** A captioned group under a hairline — the popover's one unit. The caption
    may carry a fact at its end (a count, a share). */
function Section({ title, meta, children }: { title: string; meta?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 border-t pt-3">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <p className="font-medium text-muted-foreground">{title}</p>
        {meta && <span className="tabular-nums text-muted-foreground">{meta}</span>}
      </div>
      {children}
    </section>
  )
}

/** One figure at a glance: a caption over its value, in a muted tile. Laid
    out in a row of up to three, so the numbers the eye looks for first — the
    bill, the last turn, the speed — are read across, not hunted down a list. */
function Tile({ label, value, hint, valueClass }: { label: string; value: string; hint?: string; valueClass?: string }) {
  return (
    <div className="min-w-0 flex-1 basis-0 rounded-lg bg-muted/50 px-2.5 py-2">
      <p className="truncate text-xs text-muted-foreground">{label}</p>
      <p className={cn("truncate text-sm font-medium tabular-nums", valueClass)}>{value}</p>
      {hint && <p className="truncate text-xs tabular-nums text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** A billed-token part: its colour in the stacked bar and its legend row. */
interface Part {
  label: string
  tokens: number
  color: string
  hint?: string
}

/** What the session was billed for, as one bar of its parts and a legend —
    the shape of the bill, which a column of numbers made the reader assemble. */
function BilledBar({ parts }: { parts: Part[] }) {
  const total = parts.reduce((n, part) => n + part.tokens, 0)
  if (total <= 0) return null
  return (
    <>
      <div className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-muted" aria-hidden>
        {parts.map((part) =>
          part.tokens > 0 ? (
            <div key={part.label} className="h-full" style={{ width: `${(part.tokens / total) * 100}%`, background: part.color }} />
          ) : null
        )}
      </div>
      <dl className="space-y-1">
        {parts.map((part) =>
          part.tokens > 0 ? (
            <div key={part.label} className="flex items-center gap-2 text-sm">
              <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: part.color }} />
              <dt className="min-w-0 flex-1 truncate text-muted-foreground">{part.label}</dt>
              {part.hint && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{part.hint}</span>}
              <dd className="shrink-0 font-medium tabular-nums">{formatTokens(part.tokens)}</dd>
            </div>
          ) : null
        )}
      </dl>
    </>
  )
}

/** One window of a plan, at a glance's measure: the name, the amounts behind
    the percentage, the bar and when it rolls over. Shared by a flat reading and
    by each account inside a gateway's, because an account's bars are the same
    bars. A window nothing is counted against wears `Unlimited` instead of a
    track — a bar at 0% and "there is no ceiling" are different statements. */
function WindowBar({ window, label }: { window: QuotaWindow; label: string }) {
  const percent = Math.min(100, Math.max(0, Math.round(window.usedPercent)))
  const tone = quotaTone(percent)
  const reset = formatReset(window)
  const amount = formatAmount(window)
  const metered = window.unlimited === true
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="truncate text-muted-foreground">{label}</span>
        <span className="flex shrink-0 items-baseline gap-1">
          {amount && <span className="text-muted-foreground tabular-nums">{amount}</span>}
          {metered ? (
            <span className="font-medium text-muted-foreground">Unlimited</span>
          ) : (
            <span className={cn("font-medium tabular-nums", tone.text)}>{percent}%</span>
          )}
        </span>
      </div>
      {!metered && (
        <div
          className="mt-1 h-1 w-full overflow-hidden rounded-pill bg-muted"
          role="progressbar"
          aria-label={label}
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className={cn("h-full rounded-pill transition-all", tone.bar)} style={{ width: `${percent}%` }} />
        </div>
      )}
      {reset && <p className="mt-1 text-xs text-muted-foreground">Resets {reset}</p>}
    </div>
  )
}

/**
 * The plan behind the turn, under the turn's own numbers.
 *
 * Two different questions share this popover on purpose. The stats above it are
 * about *this thread* — how full its context is, what the last turn cost. This
 * is about the account the thread spends, which is the thing that decides
 * whether there is a next turn at all, and there was nowhere in the app to see
 * it. Settings › Usage is the full view; this is the glance. It is drawn for a
 * pair with a plan to read (`planReadable`): a profile that names one of its
 * own, or a thread on the agent's Default profile, which spends the machine's
 * own `claude`/`codex login` and is read by the agent's own probe. A thread on
 * a stored profile with neither is billed to an API key and has nothing a
 * glance could say.
 *
 * Fetched when the popover first opens rather than with the thread: it costs a
 * process on the server, and a thread nobody expands should not pay for one.
 * After that the socket keeps it current on its own — the server re-reads on
 * every settled turn — so this asks once and then only listens.
 */
function PlanUsage({ thread, meta, actions }: { thread: ThreadState; meta?: SessionMeta; actions: Actions }) {
  const profileId = meta?.profileId
  const agentId = meta?.agentId
  const profile = useProfiles().find((p) => p.id === profileId) ?? null
  const agent = useAgents().find((a) => a.id === agentId) ?? null
  const readable = planReadable(profile, agent)
  const { quota } = thread
  const asked = React.useRef(false)
  /* True from the ask until the answer: the probe spawns a CLI on the server,
     which can take seconds, and the section should say so rather than appear
     from nowhere once it lands. Cleared on failure too — a swallowed error
     leaves `quota` null, and a spinner that never stops is worse than no row. */
  const [pending, setPending] = useState(false)
  React.useEffect(() => {
    if (asked.current || quota || !meta || !readable) return
    asked.current = true
    setPending(true)
    void actions.loadQuota(meta).finally(() => setPending(false))
  }, [quota, meta, actions, readable])

  /* A thread on a stored profile with no plan of its own draws nothing here:
     the reading an agent probe would give back belongs to the machine's login,
     which that thread never spent, and Settings › Usage is where that answer
     lives. */
  if (!readable) return null
  if (!quota) {
    if (!pending) return null
    return (
      <div className="border-t pt-3">
        <p className="text-xs font-medium text-muted-foreground">Plan</p>
        <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground" aria-live="polite">
          <Spinner aria-hidden className="size-3" />
          Reading plan usage…
        </p>
      </div>
    )
  }
  if (quota.status === "unsupported") return null
  const peak = peakWindow(quota)
  const accounts = quota.accounts ?? []
  const windowsByGroup = new Map<string, QuotaWindow[]>()
  for (const window of quota.windows) {
    if (!window.group) continue
    const grouped = windowsByGroup.get(window.group)
    if (grouped) grouped.push(window)
    else windowsByGroup.set(window.group, [window])
  }

  return (
    <div className="border-t pt-3">
      <p className="text-xs font-medium text-muted-foreground">Plan</p>
      {quota.windows.length === 0 && accounts.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">{quotaStatusText(quota)}</p>
      ) : accounts.length > 0 ? (
        /* A gateway's reading, at a glance's measure: the account is the
           heading — a thread that spends one of four accounts has to be told
           which — and its own bars sit under it. */
        <div className="mt-2 max-h-48 space-y-1 overflow-y-auto overscroll-contain pr-1">
          {accounts.map((account, index) => {
            const windows = windowsByGroup.get(account.group) ?? []
            const accountPeak = windows.reduce<QuotaWindow | null>(
              (worst, window) => (!worst || window.usedPercent > worst.usedPercent ? window : worst),
              null
            )
            const percent = accountPeak ? Math.min(100, Math.max(0, Math.round(accountPeak.usedPercent))) : null
            const tone = percent === null ? null : quotaTone(percent)
            return (
              <Collapsible key={account.id} defaultOpen={index === 0} className="border-b last:border-0">
                <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-2 py-2 text-left">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{accountTitle(account)}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {windows.length} {windows.length === 1 ? "window" : "windows"}
                  </span>
                  {percent !== null && tone && (
                    <span className={cn("shrink-0 text-sm font-medium tabular-nums", tone.text)}>{percent}%</span>
                  )}
                  <ChevronDownIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="space-y-2 pb-2 pl-2">
                    {windows.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        {account.disabled ? "Turned off in the gateway" : (account.state ?? "No quota reported")}
                      </p>
                    ) : (
                      windows.map((window) => (
                        <WindowBar key={window.id} window={window} label={window.label} />
                      ))
                    )}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )
          })}
        </div>
      ) : (
        <div className="mt-2 space-y-3">
          {quota.windows.map((window) => (
            <WindowBar key={window.id} window={window} label={windowTitle(window)} />
          ))}
          {peak && peak.usedPercent >= 90 && (
            <Notice
              tone="error"
              copy={`Nearly out of plan — ${windowTitle(peak).toLowerCase()} is ${Math.round(peak.usedPercent)}% used.`}
            >
              Nearly out of plan — {windowTitle(peak).toLowerCase()} is {Math.round(peak.usedPercent)}% used.
            </Notice>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The single home for per-turn telemetry: context occupancy on the ring, and
 * tokens / cache rate / TTFT inside its popover. The header carries none of it.
 */
export function ContextIndicator({
  thread,
  meta,
  actions,
  side = "top",
  size = "icon-xs",
  triggerClassName,
}: {
  thread: ThreadState
  /** The thread's row, for the (profile, agent) pair the quota is read under.
      Absent for a draft, which has no server-side thread to ask about yet. */
  meta?: SessionMeta
  actions: Actions
  /** Where the popover opens. The composer's ring opens upward; the header's
      rides at the top of the screen, so it opens downward. */
  side?: "top" | "bottom"
  /** The trigger's scale: 24px on the composer's toolbar, 32px in the header
      beside the bell, which is the header's other silent-size control. */
  size?: "icon-xs" | "icon-sm"
  /** Extra trigger classes. The header rounds its controls like the bell's
      pill, which the composer's own toolbar wears too. */
  triggerClassName?: string
}) {
  const [open, setOpen] = useState(false)
  /* Where the prompt went is the Trace panel's to say — on a server that
     records model calls. */
  const modelCalls = useFeature("modelCalls")
  const { context, ttftMs } = thread
  /* The finished turns plus the running one's steps so far, so every figure
     below moves per step rather than jumping once at `turn_ended`. */
  const usage = thread.liveUsage ? addUsage(thread.usage, thread.liveUsage) : thread.usage
  if (!context && !usage && ttftMs === null) return null

  const percent = context
    ? Math.min(100, Math.max(0, Math.round((context.used / context.size) * 100)))
    : 0
  /* The window was not in any catalog, so the runtime reported a fallback and
     said so. Everything derived from it is drawn as an approximation and the
     compaction warning is withheld — a warning about a threshold nobody can
     locate is worse than silence. */
  const estimated = windowEstimated(context)
  const about = estimated ? "~" : ""
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
  /* Session-average output speed, token-weighted over the turns whose model
     calls were timed (`tps.ts`); throughput over wall clock only for a thread
     that has none, and labelled as that. */
  const average = tpsAverage(thread.tps)
  const avgRate = average ? formatTps(average.rate) : null
  const minRate = thread.tps ? formatTps(thread.tps.min) : null
  const maxRate = thread.tps ? formatTps(thread.tps.max) : null
  const toolDurationMs = thread.tps?.toolDurationMs ??
    Object.values(thread.turnToolDuration).reduce((sum, duration) => sum + duration, 0)

  const cacheTone =
    cacheRate === null
      ? undefined
      : cacheRate >= 50
        ? "text-success"
        : cacheRate >= 20
          ? "text-warning"
          : "text-destructive"
  /* The gaps between the model's requests, and what the agent could tell apart
     in them; the rest of the total is the tools (approvals too) and the
     harness's own work. */
  const waits = thread.tps?.waits
  const waitRows = waits
    ? ([
        ["Tools & other", waits.totalMs - (waits.heldMs ?? 0) - (waits.compactMs ?? 0) - (waits.retryMs ?? 0)],
        ["Held", waits.heldMs ?? 0],
        ["Compacting", waits.compactMs ?? 0],
        ["Retry backoff", waits.retryMs ?? 0],
      ] as const).filter(([, ms]) => ms > 0)
    : []
  const spend = subagentSpend(thread.items)
  const spendTotal = spend.reduce((n, child) => n + child.tokens, 0)
  /* `turnUsage` is filled in turn order, so its last entry is the newest turn. */
  const lastTurn = Object.values(thread.turnUsage).at(-1)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size={size}
            className={cn(
              /* A reading, not a button: the dial is the mark, and the panel's
                 own width decides whether it also gets words. Deliberately
                 uncoloured — the fill that turned amber then red was a second,
                 quieter way of saying what the warning in the popover says once,
                 and a mark that changes colour as a thread fills reads as an
                 alarm in a cluster of settled facts. */
              READING_TRIGGER,
              "text-muted-foreground hover:text-foreground",
              triggerClassName,
            )}
            title={
              context
                ? `Context window — ${about}${percent}% used${estimated ? " (window size estimated)" : ""}`
                : "Turn stats"
            }
          >
            {/* The dial rides inside the pill, so the reading is one face rather
                than a ring with a label parked beside it. */}
            <ReadingFace
              icon={<Ring percent={percent} className={READING_MARK} />}
              label={context ? `${about}${percent}%` : "Stats"}
              after={<ReadingBubble>{context ? percent : "—"}</ReadingBubble>}
            />
          </Button>
        }
      />
      <ReadingPopoverContent
        side={side}
        wide
        heading="Context window"
        meta={estimated ? "Size estimated" : undefined}
        className="gap-3"
        action={modelCalls && <OpenInInspector tab="trace" label="Open Trace panel" onOpen={() => setOpen(false)} />}
      >
        {/* The window, first and largest: the dial the footer wears, at a size
            that can hold its own figure, beside what is held and what is left.
            What the prompt is made of is the Trace panel's to say. */}
        <div className="flex items-center gap-3">
          <div className="relative grid size-14 shrink-0 place-items-center">
            <Ring percent={percent} className="absolute inset-0 size-14 text-foreground" />
            <span className="text-sm font-medium tabular-nums">{context ? `${about}${percent}%` : "—"}</span>
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium tabular-nums">
              {context ? `${formatTokens(context.used)} of ${about}${formatTokens(context.size)}` : "Not reported"}
            </p>
            <p className="truncate text-xs tabular-nums text-muted-foreground">
              {context
                ? `${about}${formatTokens(Math.max(0, context.size - context.used))} free`
                : "This agent does not report its window"}
            </p>
          </div>
        </div>
        {estimated && (
          <p className="text-xs text-muted-foreground">
            This model's window size isn't in the catalog, so the size is a default and every share is
            approximate.
          </p>
        )}
        {context && !estimated && percent >= COMPACTION_WARN && (
          <Notice tone="warn">
            Context is nearly full — the agent compacts the history soon to keep the turn going.
          </Notice>
        )}

        {/* The three numbers looked for first, read across. Billed, not held:
            every request re-sends the context, so these run far above the
            window. Totals over the session; a revive resets them. */}
        {usage && (
          <div className="flex gap-2">
            <Tile label="Billed" value={formatTokens(usage.totalTokens)} hint={`${requests} ${requests === 1 ? "request" : "requests"}`} />
            <Tile label="Last turn" value={lastTurn ? formatTokens(lastTurn.totalTokens) : "—"} />
            {/* Cost is cumulative for the session; agents that don't price turns omit it. */}
            {context?.cost ? (
              <Tile label="Cost" value={`${context.cost.amount.toFixed(2)} ${context.cost.currency}`} />
            ) : (
              <Tile label="Cache hit" value={cacheRate !== null ? `${cacheRate}%` : "—"} valueClass={cacheTone} />
            )}
          </div>
        )}

        {usage && (
          <Section title="Billed tokens" meta={cacheRate !== null && context?.cost ? `${cacheRate}% from cache` : undefined}>
            <BilledBar
              parts={[
                { label: "From cache", tokens: cached, color: "var(--chart-2)", hint: cacheRate !== null ? `${cacheRate}%` : undefined },
                { label: "Cache write", tokens: usage.cachedWriteTokens ?? 0, color: "var(--chart-3)" },
                { label: "Fresh input", tokens: usage.inputTokens, color: "var(--chart-1)" },
                {
                  label: "Output",
                  tokens: usage.outputTokens,
                  color: "var(--chart-4)",
                  hint: usage.thoughtTokens ? `${formatTokens(usage.thoughtTokens)} thinking` : undefined,
                },
              ]}
            />
          </Section>
        )}

        {(avgRate || ttftMs !== null || toolDurationMs > 0) && (
          <Section title="Speed">
            <div className="flex gap-2">
              {ttftMs !== null && <Tile label="First token" value={`${ttftMs}ms`} />}
              {avgRate && (
                <Tile
                  label={average?.kind === "throughput" ? "Throughput" : "Output"}
                  value={avgRate}
                  hint={minRate && maxRate ? `${minRate.replace(" tok/s", "")}–${maxRate}` : undefined}
                />
              )}
              {toolDurationMs > 0 && <Tile label="In tools" value={formatDuration(toolDurationMs)} />}
            </div>
          </Section>
        )}

        {waits && (
          <Section title="Between requests" meta={formatDuration(waits.totalMs)}>
            <dl className="space-y-1">
              {waitRows.map(([label, ms]) => (
                <Row key={label} label={label} value={formatDuration(ms)} />
              ))}
            </dl>
          </Section>
        )}

        {/* Each child's own bill, apart from the session's: some runtimes count a
            child in the turn that launched it, so adding them would double those. */}
        {spend.length > 0 && (
          <Section title="Subagents" meta={`${spend.length} · ${formatTokens(spendTotal)}`}>
            <dl className="space-y-1">
              {spend.slice(0, SUBAGENT_ROWS).map((child) => (
                <Row
                  key={child.id}
                  label={child.name}
                  hint={[child.workflow && "workflow", spendTime(child)].filter(Boolean).join(" · ") || undefined}
                  value={formatTokens(child.tokens)}
                />
              ))}
              {spend.length > SUBAGENT_ROWS && <Row label={`${spend.length - SUBAGENT_ROWS} more`} value="" />}
            </dl>
          </Section>
        )}
        <PlanUsage thread={thread} meta={meta} actions={actions} />
      </ReadingPopoverContent>
    </Popover>
  )
}
