/* ── /automations/:id/runs/:runId — one run ── */
import * as React from "react"
import { HistoryIcon } from "lucide-react"
import { Navigate, useNavigate } from "react-router"

import { ErrorNote } from "@/components/error-note"
import { MetaFact } from "@/components/page-primitives"
import { FormPageHeader, Section } from "@/components/settings/primitives"
import { GroupRowsSkeleton } from "@/components/ui/skeletons"
import { inlineFromQuery } from "@/lib/errors"
import { useAutomationRuns, useAutomations, useCancelAutomationRun } from "@/lib/queries/automations"
import { automationPath } from "@/lib/router"
import { RunPage } from "./runs"

export function AutomationRunPage({ automationId, runId }: { automationId: string; runId: string }) {
  const automation = useAutomations().data?.find((r) => r.id === automationId)
  const runsQuery = useAutomationRuns(automationId)
  const cancelRun = useCancelAutomationRun()
  const navigate = useNavigate()
  const back = () => void navigate(automationPath(automationId))
  const run = runsQuery.data?.find((r) => r.id === runId)
  const error = React.useMemo(
    () => inlineFromQuery(runsQuery.error, "Couldn't read this automation's runs"),
    [runsQuery.error]
  )

  if (!run) {
    /* A run the list does not hold is gone or a stale link: its automation's
       runs are the honest destination. */
    if (!error && runsQuery.data !== undefined) return <Navigate to={automationPath(automationId)} replace />
    return (
      <>
        <FormPageHeader title="Run" onBack={back} />
        {error ? (
          <Section>
            <ErrorNote error={error} onRetry={() => void runsQuery.refetch()} />
          </Section>
        ) : (
          <GroupRowsSkeleton label />
        )}
      </>
    )
  }
  return (
    <>
      <FormPageHeader
        title={automation ? `${automation.name} — run` : "Run"}
        meta={
          <>
            <MetaFact icon={HistoryIcon} title="Started">
              {new Date(run.startedAt).toLocaleString()}
            </MetaFact>
            {run.tokens !== null && <MetaFact title="Tokens">{run.tokens.toLocaleString()} tokens</MetaFact>}
          </>
        }
        onBack={back}
      />
      <RunPage
        run={run}
        hasOutputSchema={automation?.output != null}
        onCancel={(id) => cancelRun.mutateAsync({ routineId: automationId, runId: id }).then(() => undefined)}
      />
    </>
  )
}
