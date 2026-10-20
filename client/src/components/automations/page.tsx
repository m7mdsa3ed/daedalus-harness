/* ── /automations — the surface ──
   One route element, four faces picked from the path: `/automations` the list,
   `/automations/new` the gallery and form, `/automations/<id>` one automation
   and `/automations/<id>/runs/<runId>` one run. Automations are outside
   /settings on purpose (see lib/router.tsx): settings is for things configured
   once, and an automation accumulates a history. Each face is its own file in
   this directory. */
import { useLocation, useParams } from "react-router"

import type { Actions } from "@/lib/actions"
import { AutomationDetailPage } from "./detail-page"
import { AutomationsListPage } from "./list-page"
import { NewAutomationPage } from "./new-page"
import { AutomationRunPage } from "./run-page"

export function AutomationsPage({ actions }: { actions: Actions }) {
  const location = useLocation()
  const params = useParams()
  if (location.pathname.endsWith("/new")) return <NewAutomationPage actions={actions} />
  if (params.automationId && params.runId)
    return <AutomationRunPage key={params.runId} automationId={params.automationId} runId={params.runId} />
  if (params.automationId)
    return <AutomationDetailPage key={params.automationId} automationId={params.automationId} actions={actions} />
  return <AutomationsListPage />
}
