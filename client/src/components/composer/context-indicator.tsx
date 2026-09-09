/* ── How full the window is, and what the turn cost ──
   The context ring the composer footer's cluster ends on and the tab strip
   wears the other way up, its per-turn telemetry, and — under a border, for
   the pair that has a plan to read — the account the thread spends. */
import * as React from "react"
import { useState } from "react"
import { LoaderCircleIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Ring } from "@/components/composer/indicator"
import { formatReset, peakWindow, planReadable, quotaStatusText, quotaTone } from "@/lib/quota"
import type { Actions } from "@/lib/actions"
import type { SessionMeta } from "@/lib/settings"
import { useAgents, useProfiles } from "@/lib/queries/catalog"
import type { ThreadState } from "@/lib/store"
import { formatRate, formatTokens } from "@/lib/tokens"
import { cn } from "@/lib/utils"

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

function Stat({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("font-medium tabular-nums", valueClass)}>{value}</dd>
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

  return (
    <div className="border-t pt-2">
      <p className="font-medium">Plan usage</p>
      {quota.windows.length === 0 ? (
        <p className="mt-0.5 text-xs text-muted-foreground">{quotaStatusText(quota)}</p>
      ) : (
        <div className="mt-1.5 space-y-2">
          {quota.windows.map((window) => {
            const percent = Math.min(100, Math.max(0, Math.round(window.usedPercent)))
            const tone = quotaTone(percent)
            const reset = formatReset(window)
            return (
              <div key={window.id}>
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="truncate text-muted-foreground">{window.label}</span>
                  <span className={cn("font-medium tabular-nums", tone.text)}>{percent}%</span>
                </div>
                <div
                  className="mt-1 h-1 w-full overflow-hidden rounded-pill bg-muted"
                  role="progressbar"
                  aria-label={window.label}
                  aria-valuenow={percent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div className={cn("h-full rounded-pill transition-all", tone.bar)} style={{ width: `${percent}%` }} />
                </div>
                {reset && <p className="mt-0.5 text-[10px] text-muted-foreground">Resets {reset}</p>}
              </div>
            )
          })}
          {peak && peak.usedPercent >= 90 && (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
              Nearly out of plan — {peak.label.toLowerCase()} is {Math.round(peak.usedPercent)}% used.
            </p>
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
      pill rather than the composer's `rounded-lg`. */
  triggerClassName?: string
}) {
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
  /* Session-average output speed: summed only over turns the server timed, so
     turns that ended before durations existed dilute neither side. */
  const measured = Object.entries(thread.turnUsage).filter(([id]) => thread.turnDuration[id] !== undefined)
  const measuredOutput = measured.reduce((n, [, u]) => n + u.outputTokens, 0)
  const measuredMs = measured.reduce((n, [id]) => n + (thread.turnDuration[id] ?? 0), 0)
  const avgRate = formatRate(measuredOutput, measuredMs)
  const tone = context ? contextTone(percent) : null

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size={size}
            className={cn(
              "relative shrink-0 rounded-lg hover:text-foreground",
              tone ? tone.text : "text-muted-foreground",
              triggerClassName,
            )}
            title={context ? `Context window — ${percent}% used` : "Turn stats"}
          >
            <Ring percent={percent} />
            <span className="absolute inset-0 grid place-items-center text-[8px] font-semibold tabular-nums">
              {context ? percent : "—"}
            </span>
          </Button>
        }
      />
      <PopoverContent align="end" side={side} className="w-60 gap-2">
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
            className="h-1.5 w-full overflow-hidden rounded-pill bg-muted"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className={cn("h-full rounded-pill transition-all", tone?.bar)} style={{ width: `${percent}%` }} />
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
          {avgRate && <Stat label="Output avg" value={avgRate} />}
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
