/* ── How full the window is, and what the turn cost ──
   The context ring the composer footer's cluster ends on and the tab strip
   wears the other way up, its per-turn telemetry, and — under a border, for
   the pair that has a plan to read — the account the thread spends. */
import * as React from "react"
import { useState } from "react"
import { ChevronDownIcon, LoaderCircleIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Notice } from "@/components/notice"
import {
  READING_MARK,
  READING_TRIGGER,
  ReadingBubble,
  ReadingFace,
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
import { addUsage, type ThreadState } from "@/lib/store"
import { formatDuration, formatRate, formatTokens, formatTps, windowEstimated } from "@/lib/tokens"
import { cn } from "@/lib/utils"

/** Above this the agent is about to compact, so the popover says so. */
const COMPACTION_WARN = 85

function Stat({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("font-medium tabular-nums", valueClass)}>{value}</dd>
    </div>
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
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate text-muted-foreground">{label}</span>
        <span className="flex shrink-0 items-baseline gap-1.5">
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
      {reset && <p className="mt-0.5 text-[10px] text-muted-foreground">Resets {reset}</p>}
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
      <div className="border-t pt-2">
        <p className="font-medium">Plan usage</p>
        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
          <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
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
    <div className="border-t pt-2">
      <p className="font-medium">Plan usage</p>
      {quota.windows.length === 0 && accounts.length === 0 ? (
        <p className="mt-0.5 text-xs text-muted-foreground">{quotaStatusText(quota)}</p>
      ) : accounts.length > 0 ? (
        /* A gateway's reading, at a glance's measure: the account is the
           heading — a thread that spends one of four accounts has to be told
           which — and its own bars sit under it. */
        <div className="mt-1.5 max-h-48 space-y-1 overflow-y-auto overscroll-contain pr-1">
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
                <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-2 py-1.5 text-left">
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">{accountTitle(account)}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {windows.length} {windows.length === 1 ? "window" : "windows"}
                  </span>
                  {percent !== null && tone && (
                    <span className={cn("shrink-0 text-xs font-medium tabular-nums", tone.text)}>{percent}%</span>
                  )}
                  <ChevronDownIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="space-y-1.5 pb-2 pl-2">
                    {windows.length === 0 ? (
                      <p className="text-[10px] text-muted-foreground">
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
        <div className="mt-1.5 space-y-2">
          {quota.windows.map((window) => (
            <WindowBar key={window.id} window={window} label={windowTitle(window)} />
          ))}
          {peak && peak.usedPercent >= 90 && (
            <Notice tone="error" className="px-2 py-1.5 text-[11px]">
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
  /* Session-average output speed: summed only over turns the server timed, so
     turns that ended before durations existed dilute neither side. */
  const measured = Object.entries(thread.turnUsage).filter(([id]) => thread.turnDuration[id] !== undefined)
  const measuredOutput = measured.reduce((n, [, u]) => n + u.outputTokens, 0)
  const measuredMs = measured.reduce((n, [id]) => n + (thread.turnDuration[id] ?? 0), 0)
  const avgRate = thread.tps ? formatRate(thread.tps.outputTokens, thread.tps.durationMs) : formatRate(measuredOutput, measuredMs)
  const minRate = thread.tps ? formatTps(thread.tps.min) : null
  const maxRate = thread.tps ? formatTps(thread.tps.max) : null
  const toolDurationMs = thread.tps?.toolDurationMs ??
    Object.values(thread.turnToolDuration).reduce((sum, duration) => sum + duration, 0)

  return (
    <Popover>
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
      <PopoverContent align="end" side={side} className="w-60 gap-2">
        <div>
          <p className="font-medium">Context window</p>
          <p className="text-xs text-muted-foreground">
            {context
              ? `${formatTokens(context.used)} of ${about}${formatTokens(context.size)} tokens`
              : "Not reported by this agent"}
          </p>
          {estimated && (
            <p className="text-[11px] text-muted-foreground">
              This model's window size isn't in the catalog, so the size is a default and every
              figure below it is approximate.
            </p>
          )}
        </div>
        {context && (
          <div
            className="h-1.5 w-full overflow-hidden rounded-pill bg-muted"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="h-full rounded-pill bg-foreground/60 transition-all" style={{ width: `${percent}%` }} />
          </div>
        )}
        {context && !estimated && percent >= COMPACTION_WARN && (
          <Notice tone="warn" className="px-2 py-1.5 text-[11px]">
            Context is nearly full — the agent compacts the history soon to keep the turn going.
          </Notice>
        )}
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
          <Stat label="Requests" value={String(requests)} />
          {context && (
            <>
              <Stat label="Used" value={`${about}${percent}%`} />
              <Stat
                label="Remaining"
                value={`${about}${formatTokens(Math.max(0, context.size - context.used))}`}
              />
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
          {avgRate && <Stat label="Avg whole-turn TPS" value={avgRate} />}
          {toolDurationMs > 0 && <Stat label="Tool-call time" value={formatDuration(toolDurationMs)} />}
          {minRate && <Stat label="Min whole-turn TPS" value={minRate} />}
          {maxRate && <Stat label="Peak TPS" value={maxRate} />}
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
        <PlanUsage thread={thread} meta={meta} actions={actions} />
      </PopoverContent>
    </Popover>
  )
}
