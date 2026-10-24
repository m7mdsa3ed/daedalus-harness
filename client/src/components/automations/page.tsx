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

/* A touch pointer gets the 44px floor `SurfaceHeader` already gives its own
   actions, here for every button below the header — section actions, row
   buttons, trigger and run controls, and the menu and popover triggers that wear a
   button's face (their `data-slot` replaces `button`). `contents` keeps the wrapper out of the
   layout; the selector reaches the page body through it. Portalled menus are
   outside it and keep their own sizing. */
const TOUCH_FLOOR =
  "contents [&_:is([data-slot=button],[data-slot=dropdown-menu-trigger],[data-slot=popover-trigger])]:pointer-coarse:min-h-11 [&_:is([data-slot=button],[data-slot=dropdown-menu-trigger],[data-slot=popover-trigger])]:pointer-coarse:min-w-11"

export function AutomationsPage({ actions }: { actions: Actions }) {
  const location = useLocation()
  const params = useParams()
  return <div className={TOUCH_FLOOR}>{face(location.pathname, params, actions)}</div>
}

function face(pathname: string, params: Readonly<Record<string, string | undefined>>, actions: Actions) {
  if (pathname.endsWith("/new")) return <NewAutomationPage actions={actions} />
  if (params.automationId && params.runId)
    return <AutomationRunPage key={params.runId} automationId={params.automationId} runId={params.runId} />
  if (params.automationId)
    return <AutomationDetailPage key={params.automationId} automationId={params.automationId} actions={actions} />
  return <AutomationsListPage />
}
