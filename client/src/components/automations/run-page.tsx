/* ── /automations/:id/runs/:runId — one run ── */
import { HistoryIcon } from "lucide-react"
import { useNavigate } from "react-router"

import { ErrorNote } from "@/components/error-note"
import { EmptyCard, FormPageHeader } from "@/components/settings/primitives"
import { Skeleton } from "@/components/ui/skeleton"
import { captureError } from "@/lib/errors"
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
  const error = runsQuery.error ? captureError(runsQuery.error, "Couldn't read this automation's runs") : null

  if (!run) {
    return (
      <>
        <FormPageHeader title="Run" onBack={back} />
        {error ? (
          <ErrorNote error={error} onRetry={() => void runsQuery.refetch()} />
        ) : runsQuery.data === undefined ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <EmptyCard icon={HistoryIcon} text="This run no longer exists." />
        )}
      </>
    )
  }
  return (
    <>
      <FormPageHeader
        title={automation ? `${automation.name} — run` : "Run"}
        description={`${new Date(run.startedAt).toLocaleString()}${run.tokens !== null ? ` · ${run.tokens.toLocaleString()} tokens` : ""}`}
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
