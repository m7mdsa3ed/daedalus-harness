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
import { Link, useNavigate } from "react-router"

import { Empty } from "@/components/empty"
import { Notice } from "@/components/notice"
import { Group, Row, Section, StatusBadge } from "@/components/settings/primitives"
import { SettingsList, type ListAction, type ListColumn } from "@/components/settings/list"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import { reportError } from "@/lib/errors"
import { automationPath, automationRunPath, threadPath } from "@/lib/router"
import type { OnFinishAction, RoutineRun } from "@/lib/settings"
import { shortAge } from "@/lib/time"
import { cn } from "@/lib/utils"
import { KIND_META, onFinishLabel } from "./on-finish"
import { SOURCE_LABEL, agoLabel, durationLabel, durationOf, runStatus, skipLabel } from "./status"

export function RunList({
  routineId,
  /** Undefined means "not read yet" and draws skeletons; an empty array means
      "this routine has never run" and draws the empty card. The store keys runs
      by routine precisely so those two can be told apart. */
  runs,
  hasOutputSchema,
  onCancel,
  compact = false,
}: {
  routineId: string
  runs: RoutineRun[] | undefined
  hasOutputSchema: boolean
  /** Stop a run that is still going. Omitted where there is nothing to act on. */
  onCancel?: (runId: string) => Promise<unknown> | void
  /** A few rows on an overview: no search, no filters, no view toggle. */
  compact?: boolean
}) {
  const navigate = useNavigate()
  const [stopping, setStopping] = React.useState<ReadonlySet<string>>(new Set())

  /* A row action in a list - so a failure is a toast, not an inline note. */
  const stop = (run: RoutineRun) => {
    if (!onCancel) return
    setStopping((prev) => new Set(prev).add(run.id))
    void Promise.resolve(onCancel(run.id))
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
        id: "duration",
        header: "Duration",
        secondary: true,
        width: "w-24 whitespace-nowrap",
        cell: (run) => (
          <span className="text-xs text-muted-foreground tabular-nums">
            {run.status === "running" ? "running" : durationLabel(durationOf(run))}
          </span>
        ),
      },
      {
        id: "when",
        header: "Started",
        align: "end",
        width: "w-28 whitespace-nowrap",
        cell: (run) => (
          <span className="text-xs text-muted-foreground" title={new Date(run.startedAt).toLocaleString()}>
            {shortAge(run.startedAt)}
          </span>
        ),
      },
      {
        id: "tokens",
        header: "Tokens",
        secondary: true,
        align: "end",
        width: "w-24 whitespace-nowrap",
        cell: (run) => (
          <span className="text-xs text-muted-foreground tabular-nums">
            {run.tokens === null ? "—" : run.tokens.toLocaleString()}
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
        label: "Open this run’s thread",
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
      /* The status dot is the row's; a run nobody has opened wears a ring
         around it. Not a second dot: the two would read as two readings of the
         same thing, and the ring means "this one is new" about exactly the dot
         it surrounds. */
      mark={(run) => (
        <span
          title={run.inboxState === "unread" ? "Not read yet" : undefined}
          className={cn(
            "size-2 shrink-0 rounded-full",
            runStatus(run.status).dot,
            run.inboxState === "unread" && "ring-2 ring-primary/50 ring-offset-2 ring-offset-background"
          )}
        />
      )}
      viewToggle={compact ? false : undefined}
      search={
        compact
          ? undefined
          : {
              placeholder: "Search runs…",
              matches: (run, n) =>
                `${runStatus(run.status).label} ${SOURCE_LABEL[run.source] ?? run.source} ${skipLabel(run.skipReason) ?? ""} ${run.error ?? ""} ${run.output ?? ""}`
                  .toLowerCase()
                  .includes(n),
            }
      }
      fields={
        compact
          ? undefined
          : [
              { id: "status", label: "Status", of: (run) => run.status, optionLabel: (v) => runStatus(v).label },
              { id: "source", label: "Source", of: (run) => run.source, optionLabel: (v) => SOURCE_LABEL[v] ?? v },
            ]
      }
      onRowClick={(run) => void navigate(automationRunPath(routineId, run.id))}
      empty={
        <Empty size="lg" icon={HistoryIcon}>
          This automation has not run yet.
        </Empty>
      }
    />
  )
}

/** The newest runs as a row of bars, oldest on the left: a health reading at a
    glance, each bar its run's page. 20 on a narrow panel, 50 from `@panel-sm`. */
export function RunStrip({ routineId, runs }: { routineId: string; runs: RoutineRun[] }) {
  const shown = runs.slice(0, 50)
  return (
    <ol className="flex h-10 items-end gap-0.5">
      {shown
        .map((r, i) => {
          const tone = runStatus(r.status)
          const when = new Date(r.startedAt).toLocaleString()
          return (
            <li key={r.id} className={cn("flex h-full max-w-3 flex-1 items-end", i >= 20 && "hidden @panel-sm:flex")}>
              <Link
                to={automationRunPath(routineId, r.id)}
                aria-label={`${tone.label}, started ${agoLabel(r.startedAt)}`}
                title={`${tone.label} · ${when}`}
                className={cn(
                  "block w-full rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  tone.dot,
                  r.status === "skipped" ? "h-1/2 opacity-60" : "h-full"
                )}
              />
            </li>
          )
        })
        .reverse()}
    </ol>
  )
}

/** One run on a page of its own: what it produced and what happened after.
    The head, Stop and Open thread are the page header's (run-page.tsx). */
export function RunPage({ run, hasOutputSchema }: { run: RoutineRun; hasOutputSchema: boolean }) {
  const navigate = useNavigate()
  const outcome = outcomeOf(run)
  const ended = run.endedAt === null ? null : new Date(run.endedAt).toLocaleString()
  return (
    <>
      {outcome && (
        <Section>
          <Notice tone={outcome.tone} title={outcome.title}>
            {outcome.body}
          </Notice>
        </Section>
      )}

      {hasOutputSchema && run.verdict != null && (
        <Group label="Verdict">
          <Row title={<span className="font-mono text-xs">{compact(run.verdict)}</span>} />
          <pre className="overflow-x-auto py-3 font-mono text-xs whitespace-pre-wrap break-words">
            {JSON.stringify(run.verdict, null, 2)}
          </pre>
        </Group>
      )}

      {run.output && (
        <Group label="Answer">
          <div className="py-3 text-sm/relaxed whitespace-pre-wrap break-words">{run.output}</div>
        </Group>
      )}

      {run.actions.length > 0 && (
        <Group
          label="Follow-up actions"
          count={run.actions.length}
          hint="They ran after the run; a failure here does not change the run's own result."
        >
          {run.actions.map((action, i) => {
            const known = action.kind in KIND_META
            return (
              <Row
                key={i}
                icon={known ? KIND_META[action.kind as OnFinishAction["kind"]].icon : undefined}
                title={known ? onFinishLabel(action as unknown as OnFinishAction) : action.kind}
                subtitle={action.ok ? action.ref : (action.error ?? undefined)}
              >
                <StatusBadge tone={action.ok ? "ok" : "bad"}>{action.ok ? "Done" : "Failed"}</StatusBadge>
              </Row>
            )
          })}
        </Group>
      )}

      {run.payload != null && (
        <Group label="Payload" hint="The caller's own words. The agent read them as untrusted input.">
          <Clamped text={prettyPayload(run.payload)} />
        </Group>
      )}

      <Group label="Details">
        <Row title="Started">{new Date(run.startedAt).toLocaleString()}</Row>
        <Row title="Ended">{ended ?? (run.status === "running" ? "Still running" : "—")}</Row>
        <Row title="Forced to ask" subtitle="Every question went to a person for this run.">
          {run.dryRun ? "Yes" : "No"}
        </Row>
        {run.inboxState && <Row title="Inbox">{INBOX_LABEL[run.inboxState]}</Row>}
        {run.headOid && (
          <Row title="HEAD" subtitle="The commit this run saw.">
            <span className="font-mono text-xs">{run.headOid.slice(0, 7)}</span>
            <CopyButton text={run.headOid} size="icon-xs" label="Copy commit id" />
          </Row>
        )}
        <Row title="Run id">
          <span className="max-w-48 truncate font-mono text-xs">{run.id}</span>
          <CopyButton text={run.id} size="icon-xs" label="Copy run id" />
        </Row>
        <Row title="Automation settings" subtitle="What this automation runs with now, which may differ from this run.">
          <Button
            variant="ghost"
            size="sm"
            className="pointer-coarse:h-11"
            onClick={() => void navigate(`${automationPath(run.routineId)}?tab=settings`)}
          >
            Open
          </Button>
        </Row>
      </Group>
    </>
  )
}

const INBOX_LABEL: Record<NonNullable<RoutineRun["inboxState"]>, string> = {
  unread: "Unread",
  read: "Read",
  archived: "Archived",
}

/** The one box saying how the run ended, when that is anything but fine. */
function outcomeOf(run: RoutineRun): { tone: "warn" | "error"; title: string; body: string } | null {
  const tone = runStatus(run.status)
  if (run.status === "skipped") {
    const why = skipLabel(run.skipReason)
    return { tone: "warn", title: why ?? tone.label, body: run.error && run.error !== why ? run.error : tone.meaning }
  }
  if (run.status === "blocked") return { tone: "warn", title: tone.label, body: run.error ?? tone.meaning }
  if (run.status === "failed") return { tone: "error", title: tone.label, body: run.error ?? tone.meaning }
  return null
}

/** A payload is text; when it is JSON it is shown pretty. */
function prettyPayload(payload: string): string {
  try {
    const parsed: unknown = JSON.parse(payload)
    return typeof parsed === "object" && parsed !== null ? JSON.stringify(parsed, null, 2) : payload
  } catch {
    return payload
  }
}

/** Long text clamped, with its own way to the rest. No inner scroller. */
function Clamped({ text }: { text: string }) {
  const [open, setOpen] = React.useState(false)
  const long = text.length > 600 || text.split("\n").length > 10
  return (
    <div className="py-3">
      <pre className={cn("font-mono text-xs whitespace-pre-wrap break-words", long && !open && "line-clamp-[10]")}>{text}</pre>
      {long && (
        <Button variant="ghost" size="sm" className="mt-2 -ml-2 pointer-coarse:h-11" onClick={() => setOpen((v) => !v)}>
          {open ? "Show less" : "Show all"}
        </Button>
      )}
    </div>
  )
}

/** The status word, where it came from, and whether it was forced to ask. */
export function RunHead({ run }: { run: RoutineRun }) {
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
          {run.error && run.error !== skipLabel(run.skipReason) && ` — ${run.error}`}
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
