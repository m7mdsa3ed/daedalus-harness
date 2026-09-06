/* ── A routine's runs ──
   The list leads with the **verdict** where the routine declared an output
   schema, because that is the only thing on a run row that is about the *work*
   rather than about the process. Where there is no schema the row says what it
   honestly knows and no more — "the turn ended" — with the run's own thread one
   click away for anyone who wants the rest. A status word standing alone in
   that column would be read as a result, which it is not: `completed` says the
   turn settled, not that the review found nothing.

   Every run's thread is an ordinary thread — its own transcript, searchable,
   revivable — so the link is `threadPath(run.sessionId)` and there is nothing
   new to route. It is null on a skipped run and for the first moments of a
   running one (the fire answers before the thread exists), which is why the
   link is conditional rather than always drawn and sometimes broken. */
import * as React from "react"
import { ChevronRightIcon, ExternalLinkIcon, HistoryIcon, SquareIcon } from "lucide-react"
import { useNavigate } from "react-router"

import { EmptyCard } from "@/components/settings/primitives"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { reportError } from "@/lib/errors"
import { threadPath } from "@/lib/router"
import type { RoutineRun } from "@/lib/settings"
import { shortAge } from "@/lib/time"
import { cn } from "@/lib/utils"
import { SOURCE_LABEL, runStatus } from "./status"

export function RunList({
  /** Undefined means "not read yet" and draws skeletons; an empty array means
      "this routine has never run" and draws the empty card. The store keys runs
      by routine precisely so those two can be told apart. */
  runs,
  hasOutputSchema,
  onCancel,
}: {
  runs: RoutineRun[] | undefined
  hasOutputSchema: boolean
  /** Stop a run that is still going. Omitted where there is nothing to act on. */
  onCancel?: (runId: string) => Promise<void>
}) {
  if (runs === undefined) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-14 w-full rounded-xl" />
        ))}
      </div>
    )
  }
  if (runs.length === 0) {
    return <EmptyCard icon={HistoryIcon} text="This routine has not run yet." />
  }
  return (
    <div className="divide-y overflow-hidden rounded-xl border">
      {runs.map((run) => (
        <RunRow key={run.id} run={run} hasOutputSchema={hasOutputSchema} onCancel={onCancel} />
      ))}
    </div>
  )
}

function RunRow({
  run,
  hasOutputSchema,
  onCancel,
}: {
  run: RoutineRun
  hasOutputSchema: boolean
  onCancel?: (runId: string) => Promise<void>
}) {
  const navigate = useNavigate()
  const [open, setOpen] = React.useState(false)
  const [stopping, setStopping] = React.useState(false)
  const tone = runStatus(run.status)
  const failedActions = run.actions.filter((a) => !a.ok)
  const live = run.status === "running"

  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2 sm:flex-nowrap">
        <span
          aria-hidden
          className={cn("mt-1.5 size-2 shrink-0 rounded-full", tone.dot)}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn("text-sm font-medium", tone.text)}>{tone.label}</span>
            <span className="rounded-pill bg-muted px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase text-muted-foreground">
              {SOURCE_LABEL[run.source] ?? run.source}
            </span>
            {run.dryRun && (
              <span className="rounded-pill bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase text-primary">
                Forced to ask
              </span>
            )}
            <span className="text-xs text-muted-foreground">{shortAge(run.startedAt)}</span>
            {run.tokens !== null && (
              <span className="text-xs tabular-nums text-muted-foreground">
                {run.tokens.toLocaleString()} tokens
              </span>
            )}
          </div>

          {/* The lead column. A verdict when there is one; otherwise the status
              said as a sentence, so `completed` cannot be mistaken for a
              finding. `error` outranks both — it is the run explaining itself. */}
          <div className="mt-1 min-w-0 text-xs">
            {run.error ? (
              <p className={cn("text-pretty", tone.text)}>{run.error}</p>
            ) : hasOutputSchema && run.verdict !== null && run.verdict !== undefined ? (
              <pre className="truncate font-mono text-[11px] text-foreground">
                {compact(run.verdict)}
              </pre>
            ) : (
              <p className="text-muted-foreground">{tone.meaning}</p>
            )}
          </div>

          {failedActions.length > 0 && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
              {failedActions.length === 1 ? "One follow-up action" : `${failedActions.length} follow-up actions`}{" "}
              failed after the run — the run itself is unaffected.
            </p>
          )}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {(run.output || run.actions.length > 0 || run.verdict != null) && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-expanded={open}
              title={open ? "Hide details" : "Show details"}
              onClick={() => setOpen(!open)}
            >
              <ChevronRightIcon className={cn("transition-transform", open && "rotate-90")} />
              <span className="sr-only">{open ? "Hide details" : "Show details"}</span>
            </Button>
          )}
          {/* Only while it is still going. This is the one control on the page
              that is about what is happening rather than what will happen, so
              it says the word rather than being an icon to decode. A row action
              in a list — so a failure is a toast, not an inline note. */}
          {live && onCancel && (
            <Button
              variant="outline"
              size="sm"
              disabled={stopping}
              onClick={() => {
                setStopping(true)
                void onCancel(run.id)
                  .catch((err) => reportError(err, "Couldn't stop the run"))
                  .finally(() => setStopping(false))
              }}
            >
              <SquareIcon />
              {stopping ? "Stopping…" : "Stop"}
            </Button>
          )}
          {run.sessionId && (
            <Button
              variant="ghost"
              size="icon-sm"
              title="Open this run's thread"
              onClick={() => void navigate(threadPath(run.sessionId!))}
            >
              <ExternalLinkIcon />
              <span className="sr-only">Open this run&rsquo;s thread</span>
            </Button>
          )}
        </div>
      </div>

      {open && (
        <div className="mt-3 space-y-3 rounded-lg border bg-muted/30 p-3">
          {run.verdict != null && (
            <div>
              <h4 className="text-[11px] font-medium tracking-wide uppercase text-muted-foreground">Verdict</h4>
              <pre className="mt-1 overflow-x-auto font-mono text-[11px] whitespace-pre-wrap">
                {JSON.stringify(run.verdict, null, 2)}
              </pre>
            </div>
          )}
          {run.output && (
            <div>
              <h4 className="text-[11px] font-medium tracking-wide uppercase text-muted-foreground">Answer</h4>
              <p className="mt-1 max-h-64 overflow-y-auto text-xs whitespace-pre-wrap">{run.output}</p>
            </div>
          )}
          {run.actions.length > 0 && (
            <div>
              <h4 className="text-[11px] font-medium tracking-wide uppercase text-muted-foreground">
                Follow-up actions
              </h4>
              <ul className="mt-1 space-y-0.5 text-xs">
                {run.actions.map((action, i) => (
                  <li key={i} className={action.ok ? "text-muted-foreground" : "text-destructive"}>
                    {action.kind} — {action.ok ? (action.ref ?? "done") : (action.error ?? "failed")}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** A verdict on one line for the row. It is arbitrary JSON — the schema is the
    routine's — so there is nothing to key on; the shape is shown, truncated by
    the row, and the fold below has the whole of it. */
function compact(verdict: unknown): string {
  if (typeof verdict === "string") return verdict
  try {
    return JSON.stringify(verdict)
  } catch {
    return String(verdict)
  }
}
