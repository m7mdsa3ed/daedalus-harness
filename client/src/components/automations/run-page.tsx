/* ── /automations/:id/runs/:runId — one run ── */
import * as React from "react"
import { ExternalLinkIcon, HistoryIcon, SquareIcon } from "lucide-react"
import { useNavigate } from "react-router"

import { useNow } from "@/components/composer/agents-indicator"
import { Empty } from "@/components/empty"
import { ErrorNote } from "@/components/error-note"
import { MetaFact } from "@/components/page-primitives"
import { FormPageHeader, Section, StatStrip, type Tone } from "@/components/settings/primitives"
import { Button } from "@/components/ui/button"
import { GroupRowsSkeleton } from "@/components/ui/skeletons"
import { inlineFromQuery, reportError } from "@/lib/errors"
import {
  useAutomationRuns,
  useAutomationTriggers,
  useAutomations,
  useCancelAutomationRun,
  useMarkAutomationRunRead,
} from "@/lib/queries/automations"
import { automationPath, threadPath } from "@/lib/router"
import type { RoutineRun } from "@/lib/settings"
import { RunHead, RunPage } from "./runs"
import { SOURCE_LABEL, agoLabel, durationLabel, durationOf, runStatus } from "./status"
import { TRIGGER_KIND, triggerTitle } from "./trigger-summary"

/** The newest page every automation surface shares the cache of. */
const BASE_LIMIT = 50

export function AutomationRunPage({ automationId, runId }: { automationId: string; runId: string }) {
  const automation = useAutomations().data?.find((r) => r.id === automationId)
  const runsQuery = useAutomationRuns(automationId)
  const baseRun = runsQuery.data?.find((r) => r.id === runId)
  /* A link to a run older than the newest page: read further back once. */
  // ponytail: 1000-row ceiling; a by-id route when history outgrows it
  const deeper = runsQuery.data !== undefined && !baseRun && runsQuery.data.length >= BASE_LIMIT
  const deepQuery = useAutomationRuns(automationId, 1000, { enabled: deeper })
  const run = baseRun ?? (deeper ? deepQuery.data?.find((r) => r.id === runId) : undefined)

  const navigate = useNavigate()
  const back = () => void navigate(automationPath(automationId))
  const name = automation?.name ?? "the automation"

  /* Opening a run is reading it: this page is where the output is, so the dot
     on the row and the badge in the sidebar clear here and nowhere else. Quiet
     on failure — the run still reads "unread", which is the truth, and the
     next visit tries again. */
  const { mutateAsync: markRead } = useMarkAutomationRunRead()
  const unread = run?.inboxState === "unread"
  React.useEffect(() => {
    if (!unread) return
    void markRead({ routineId: automationId, runId }).catch(() => {})
  }, [unread, runId, automationId, markRead])

  const failed = runsQuery.error ? runsQuery : deeper && deepQuery.error ? deepQuery : null
  const error = failed ? inlineFromQuery(failed.error, "Couldn't read this automation's runs") : null

  if (!run) {
    const loading = runsQuery.isPending || (deeper && deepQuery.isPending)
    return (
      <>
        <FormPageHeader title={automation?.name ?? "Run"} onBack={back} />
        {error ? (
          <Section>
            <ErrorNote error={error} onRetry={() => void failed?.refetch()} />
          </Section>
        ) : loading ? (
          <GroupRowsSkeleton label />
        ) : (
          <Empty
            size="lg"
            icon={HistoryIcon}
            action={
              <Button variant="outline" onClick={back}>
                Back to {name}
              </Button>
            }
          >
            This run is no longer on record.
          </Empty>
        )}
      </>
    )
  }
  return <RunView automationId={automationId} run={run} hasOutputSchema={automation?.output != null} title={automation?.name ?? "Run"} onBack={back} />
}

function RunView({
  automationId,
  run,
  hasOutputSchema,
  title,
  onBack,
}: {
  automationId: string
  run: RoutineRun
  hasOutputSchema: boolean
  title: string
  onBack: () => void
}) {
  const navigate = useNavigate()
  const cancelRun = useCancelAutomationRun()
  const triggers = useAutomationTriggers(automationId).data
  const [stopping, setStopping] = React.useState(false)
  const running = run.status === "running"
  const now = useNow(running)
  const tone = runStatus(run.status)

  const trigger = run.triggerId ? triggers?.find((t) => t.id === run.triggerId) : undefined
  const firedBy = trigger ? triggerTitle(trigger, triggers ?? []) : (SOURCE_LABEL[run.source] ?? run.source)

  const stop = () => {
    setStopping(true)
    cancelRun
      .mutateAsync({ routineId: automationId, runId: run.id })
      .catch((err) => reportError(err, "Couldn't stop the run"))
      .finally(() => setStopping(false))
  }

  const okActions = run.actions.filter((a) => a.ok).length
  const statTone: Tone = tone.badge === "ok" || tone.badge === "warn" || tone.badge === "bad" ? tone.badge : "default"

  return (
    <>
      <FormPageHeader
        title={title}
        description={tone.meaning}
        onBack={onBack}
        meta={
          <>
            <RunHead run={run} />
            <MetaFact icon={HistoryIcon} title={new Date(run.startedAt).toLocaleString()}>
              Started {agoLabel(run.startedAt)}
            </MetaFact>
            <MetaFact icon={trigger ? TRIGGER_KIND[trigger.kind].icon : undefined}>Fired by {firedBy}</MetaFact>
          </>
        }
        actions={
          running || run.sessionId ? (
            <div className="flex flex-wrap items-center gap-2">
              {running && (
                <Button variant="outline" disabled={stopping} onClick={stop}>
                  <SquareIcon data-icon="inline-start" />
                  {stopping ? "Stopping…" : "Stop"}
                </Button>
              )}
              {run.sessionId && (
                <Button onClick={() => void navigate(threadPath(run.sessionId!))}>
                  <ExternalLinkIcon data-icon="inline-start" />
                  Open thread
                </Button>
              )}
            </div>
          ) : undefined
        }
      />
      <StatStrip
        stats={[
          { label: "Status", value: tone.label, tone: statTone },
          {
            label: "Duration",
            value: durationLabel(running ? now - run.startedAt : durationOf(run)),
            hint: running ? "still running" : undefined,
          },
          { label: "Tokens", value: run.tokens === null ? "—" : run.tokens.toLocaleString() },
          run.actions.length > 0
            ? {
                label: "Follow-ups",
                value: `${okActions} of ${run.actions.length} ok`,
                tone: okActions < run.actions.length ? "bad" : "default",
              }
            : {
                label: "Ended",
                value:
                  run.endedAt === null
                    ? "—"
                    : new Date(run.endedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
                hint: run.endedAt === null ? (running ? "still running" : "never started") : agoLabel(run.endedAt),
              },
        ]}
      />
      <RunPage run={run} hasOutputSchema={hasOutputSchema} />
    </>
  )
}
