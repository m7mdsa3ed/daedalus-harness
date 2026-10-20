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
import { ExternalLinkIcon, HistoryIcon, SquareIcon } from "lucide-react"
import { useNavigate } from "react-router"

import { Empty } from "@/components/empty"
import { StatusBadge } from "@/components/settings/primitives"
import { SettingsList, type ListAction, type ListColumn } from "@/components/settings/list"
import { Button } from "@/components/ui/button"
import { reportError } from "@/lib/errors"
import { automationRunPath, threadPath } from "@/lib/router"
import type { RoutineRun } from "@/lib/settings"
import { shortAge } from "@/lib/time"
import { SOURCE_LABEL, runStatus, skipLabel } from "./status"

export function RunList({
  routineId,
  /** Undefined means "not read yet" and draws skeletons; an empty array means
      "this routine has never run" and draws the empty card. The store keys runs
      by routine precisely so those two can be told apart. */
  runs,
  hasOutputSchema,
  onCancel,
}: {
  routineId: string
  runs: RoutineRun[] | undefined
  hasOutputSchema: boolean
  /** Stop a run that is still going. Omitted where there is nothing to act on. */
  onCancel?: (runId: string) => Promise<void>
}) {
  const navigate = useNavigate()
  const [stopping, setStopping] = React.useState<ReadonlySet<string>>(new Set())

  /* A row action in a list - so a failure is a toast, not an inline note. */
  const stop = (run: RoutineRun) => {
    if (!onCancel) return
    setStopping((prev) => new Set(prev).add(run.id))
    void onCancel(run.id)
      .catch((err) => reportError(err, "Couldn't stop the run"))
      .finally(() =>
        setStopping((prev) => {
          const next = new Set(prev)
          next.delete(run.id)
          return next
        })
      )
  }

  const columns = React.useMemo<ListColumn<RoutineRun>[]>(
    () => [
      {
        id: "status",
        header: "Run",
        title: true,
        cell: (run) => <RunHead run={run} />,
      },
      {
        /* The lead column. A verdict when there is one; otherwise the status
           said as a sentence, so `completed` cannot be mistaken for a finding.
           `error` outranks both - it is the run explaining itself. */
        id: "result",
        header: "Result",
        cell: (run) => <RunResult run={run} hasOutputSchema={hasOutputSchema} />,
      },
      {
        id: "when",
        header: "Started",
        align: "end",
        width: "w-32 whitespace-nowrap",
        cell: (run) => (
          <span className="text-xs text-muted-foreground" title={new Date(run.startedAt).toLocaleString()}>
            {shortAge(run.startedAt)}
            {run.tokens !== null && ` · ${run.tokens.toLocaleString()} tokens`}
          </span>
        ),
      },
    ],
    [hasOutputSchema]
  )

  const actions = React.useMemo<ListAction<RoutineRun>[]>(
    () => [
      {
        id: "stop",
        label: "Stop",
        icon: <SquareIcon />,
        position: "right",
        hidden: (run) => !onCancel || run.status !== "running",
        disabled: (run) => stopping.has(run.id),
        onClick: stop,
      },
      {
        id: "thread",
        label: "Open this run\u2019s thread",
        icon: <ExternalLinkIcon />,
        position: "left",
        hidden: (run) => !run.sessionId,
        onClick: (run) => void navigate(threadPath(run.sessionId!)),
      },
    ],
    // `stop` closes over `onCancel` only; `navigate` is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onCancel, stopping, navigate]
  )

  return (
    <SettingsList
        columns={columns}
        rows={runs ?? []}
        rowId={(run) => run.id}
        loading={runs === undefined}
        skeletonRows={3}
        actions={actions}
        mark={() => <HistoryIcon className="size-4 text-muted-foreground" />}
        search={{
          placeholder: "Search runs…",
          matches: (run, n) =>
            `${runStatus(run.status).label} ${SOURCE_LABEL[run.source] ?? run.source} ${skipLabel(run.skipReason) ?? ""} ${run.error ?? ""} ${run.output ?? ""}`.toLowerCase().includes(n),
        }}
        fields={[
          { id: "status", label: "Status", of: (run) => run.status, optionLabel: (v) => runStatus(v as RoutineRun["status"]).label },
          { id: "source", label: "Source", of: (run) => run.source, optionLabel: (v) => SOURCE_LABEL[v as RoutineRun["source"]] ?? v },
        ]}
        onRowClick={(run) => void navigate(automationRunPath(routineId, run.id))}
        empty={
          <Empty size="lg" icon={HistoryIcon}>
            This automation has not run yet.
          </Empty>
        }
      />
  )
}

/** One run on a page of its own: the head, the whole of what it produced, and
    the actions the row carries. */
export function RunPage({
  run,
  hasOutputSchema,
  onCancel,
}: {
  run: RoutineRun
  hasOutputSchema: boolean
  onCancel?: (runId: string) => Promise<void>
}) {
  const navigate = useNavigate()
  const [stopping, setStopping] = React.useState(false)
  const stop = () => {
    if (!onCancel) return
    setStopping(true)
    void onCancel(run.id)
      .catch((err) => reportError(err, "Couldn't stop the run"))
      .finally(() => setStopping(false))
  }
  return (
    <div className="space-y-4">
      <RunHead run={run} />
      <RunDetail run={run} hasOutputSchema={hasOutputSchema} />
      <div className="flex flex-wrap gap-2">
        {run.status === "running" && onCancel && (
          <Button variant="outline" disabled={stopping} onClick={stop}>
            <SquareIcon data-icon="inline-start" />
            {stopping ? "Stopping\u2026" : "Stop"}
          </Button>
        )}
        {run.sessionId && (
          <Button variant="outline" onClick={() => void navigate(threadPath(run.sessionId!))}>
            <ExternalLinkIcon data-icon="inline-start" />
            Open this run&rsquo;s thread
          </Button>
        )}
      </div>
    </div>
  )
}

/** The status word, where it came from, and whether it was forced to ask. */
function RunHead({ run }: { run: RoutineRun }) {
  const tone = runStatus(run.status)
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <StatusBadge tone={tone.badge}>{tone.label}</StatusBadge>
      <StatusBadge dot={false}>{SOURCE_LABEL[run.source] ?? run.source}</StatusBadge>
      {run.dryRun && <StatusBadge tone="info" dot={false}>Forced to ask</StatusBadge>}
    </span>
  )
}

function RunResult({ run, hasOutputSchema }: { run: RoutineRun; hasOutputSchema: boolean }) {
  const tone = runStatus(run.status)
  const failedActions = run.actions.filter((a) => !a.ok)
  return (
    <div className="min-w-0 space-y-1 text-sm">
      {run.status === "skipped" && (run.skipReason || run.error) ? (
        <p className="text-pretty text-muted-foreground">
          <span className="font-medium text-foreground">{skipLabel(run.skipReason) ?? "Skipped"}</span>
          {run.error && run.error !== skipLabel(run.skipReason) && ` \u2014 ${run.error}`}
        </p>
      ) : run.error ? (
        <p className="text-pretty text-destructive">{run.error}</p>
      ) : hasOutputSchema && run.verdict !== null && run.verdict !== undefined ? (
        <pre className="truncate font-mono text-xs text-foreground">{compact(run.verdict)}</pre>
      ) : (
        <p className="text-pretty text-muted-foreground">{tone.meaning}</p>
      )}
      {failedActions.length > 0 && (
        <StatusBadge tone="warn" dot={false}>
          {failedActions.length === 1 ? "One follow-up action" : `${failedActions.length} follow-up actions`} failed
        </StatusBadge>
      )}
    </div>
  )
}

function RunDetail({ run, hasOutputSchema }: { run: RoutineRun; hasOutputSchema: boolean }) {
  const failedActions = run.actions.filter((a) => !a.ok)
  return (
    <div className="space-y-4">
      <RunResult run={run} hasOutputSchema={hasOutputSchema} />
      {failedActions.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Follow-up actions ran after the run - the run itself is unaffected.
        </p>
      )}
      {run.verdict != null && (
        <div>
          <h3 className="text-xs font-medium text-muted-foreground">Verdict</h3>
          <pre className="mt-1 overflow-x-auto font-mono text-xs whitespace-pre-wrap">
            {JSON.stringify(run.verdict, null, 2)}
          </pre>
        </div>
      )}
      {run.output && (
        <div>
          <h3 className="text-xs font-medium text-muted-foreground">Answer</h3>
          <p className="mt-1 max-h-64 overflow-y-auto text-sm whitespace-pre-wrap">{run.output}</p>
        </div>
      )}
      {run.actions.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-muted-foreground">Follow-up actions</h3>
          <ul className="mt-1 space-y-0.5 text-sm">
            {run.actions.map((action, i) => (
              <li key={i} className={action.ok ? "text-muted-foreground" : "text-destructive"}>
                {action.kind} {"\u2014"} {action.ok ? (action.ref ?? "done") : (action.error ?? "failed")}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/** A verdict on one line for the row. It is arbitrary JSON - the schema is the
    routine's - so there is nothing to key on; the shape is shown, truncated by
    the row, and the run page has the whole of it. */
function compact(verdict: unknown): string {
  if (typeof verdict === "string") return verdict
  try {
    return JSON.stringify(verdict)
  } catch {
    return String(verdict)
  }
}
