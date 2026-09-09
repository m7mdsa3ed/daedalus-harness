/* ── A route as a tab ──
   Every page that is not a thread — settings, a project, the inbox, the
   schedules, the landing console — is a `page` panel, so it can stand in the
   dock beside the chat it is about instead of replacing the whole column.

   The panel does not know the pages. It renders the app's one route table
   (`PageRoutesProvider`, handed down by app-shell, which is where every route
   element's props live) against *its own* path, through React Router's
   `<Routes location>`: the same `<Route>` elements, matched against the
   panel's params rather than the address bar. What a page reads through
   `useLocation` is still the address bar — which is this panel's path
   whenever it is the active tab, because the dock writes the focused panel's
   path to the URL and the URL opens or repoints the panel for it
   (`openPage` in dock.tsx, app-shell's route effect).

   The title is written forward only: `headingFor` answers `null` before boot,
   and a restored tab keeps its serialized title rather than flashing the
   kind's placeholder. The `h1` is for the document — a page whose only name is
   a `div` in a third-party tab strip has none for a screen reader to land on.

   `--app-header-h` is re-pointed at the measured overlap: every route pads
   its own scroller by the header's height, which was right for a page filling
   the column under a floating header and is wrong inside a card that starts
   below the tab strip. The measurement is what the other panels pad by
   (`lib/workspace/panel-overlap.ts`); zero before the first frame, as a page
   that does not pad is a better first frame than one that jumps. */
import * as React from "react"
import type { IDockviewPanelProps } from "dockview-react"
import { Routes } from "react-router"

import type { PageHeading } from "@/components/routes"

export interface PageRoutes {
  /** The `<Route>` elements, as app-shell writes them. */
  routes: React.ReactNode
  /** What a route is called — the tab's title. */
  headingFor: (path: string) => PageHeading | null
}

const PageRoutesContext = React.createContext<PageRoutes>({
  routes: null,
  headingFor: () => null,
})

export const PageRoutesProvider = PageRoutesContext.Provider

export function PagePanel(props: IDockviewPanelProps<{ path: string }>) {
  const { routes, headingFor } = React.useContext(PageRoutesContext)
  const path = props.params.path
  const title = headingFor(path)?.title
  React.useEffect(() => {
    if (title) props.api.setTitle(title)
  }, [props.api, title])
  return (
    <div className="flex h-full min-h-0 flex-col [--app-header-h:var(--dock-content-overlap,0px)]">
      {title && <h1 className="sr-only">{title}</h1>}
      <Routes location={path}>{routes}</Routes>
    </div>
  )
}
