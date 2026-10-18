/* ── Settings layout route ──
   The frame every settings page renders inside: one scroller, one error
   boundary per page, and the outlet context that hands each page the server
   connection and the actions. Pages read it back via useSettingsPage().

   ── Where the section list is ──
   In the **app sidebar** (`components/sidebar/settings-nav.tsx`), which swaps
   its content while the panel in front of you is a settings page. Settings had
   a second sidebar of its own here — a column inside the tab, on the app's
   sidebar material — because an earlier attempt to put the nav in the app
   sidebar followed the *route* and rewrote the sidebar of a chat you were
   reading beside it. The dock writes the focused panel's path to the URL now,
   so the route is the active panel, and one sidebar can answer for both. Two
   sidebars side by side was, in the end, two columns of nav before any setting.

   ── A phone drills down ──
   The app sidebar is a drawer there and closes the moment you pick anything,
   so the overview page is the list of sections and a section is one level
   below it: `BackToSettings` is the way up. No dropdown of sections - the
   sidebar is the one vertical navigation, and the phone's form of it is a list.

   The restored scroll position (`useScrollRestoration`) is this scroller's —
   coming back to a section lands where you left it. */
import * as React from "react"
import { ArrowLeft } from "lucide-react"
import { Outlet, useLocation, useNavigate, useOutletContext } from "react-router"
import { ErrorBoundary } from "@/components/error-boundary"
import { PageFrame } from "@/components/page-primitives"
import { Button } from "@/components/ui/button"
import { useSidebar } from "@/components/ui/sidebar"
import { SettingsSectionSkeleton } from "@/components/ui/skeletons"
import { settingsSectionFor } from "@/components/sidebar/settings-nav"
import type { Actions } from "@/lib/actions"
import { settingsPath, settingsRootPath } from "@/lib/router"
import { useScrollRestoration } from "@/lib/scroll-restoration"
import type { ServerSettings } from "@/lib/settings"
import { isFullWidthSettings, isWideSettings, type SettingsSectionId } from "./sections"

export interface SettingsPageContext {
  settings: ServerSettings
  actions: Actions
  /** Opens the connect screen to store another server (App.tsx owns it). */
  onAddServer: () => void
}

export function useSettingsPage(): SettingsPageContext {
  return useOutletContext<SettingsPageContext>()
}

/** The way back on a phone, where the app sidebar is a drawer that closed when
    you tapped Settings. The overview is the list of sections, so a section is
    one level down and this is its back link - the drill-down every phone
    settings app uses. It replaced a dropdown of all twenty sections: a second
    way to navigate, and one the desktop does not have. */
function BackToSettings({ go }: { go: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="-ml-2 mb-3 h-11 text-muted-foreground"
      onClick={go}
    >
      <ArrowLeft />
      Settings
    </Button>
  )
}

export function SettingsLayout({
  settings,
  actions,
  onAddServer,
  loading,
}: SettingsPageContext & { loading: boolean }) {
  const location = useLocation()
  const navigate = useNavigate()
  const scrollRef = useScrollRestoration<HTMLDivElement>(location.pathname)
  const section = settingsSectionFor(location.pathname)
  /* The device, not the panel's width: a narrow settings panel on a desktop
     still has the app sidebar beside it, and a drawer is only a drawer on a
     phone. This is the `useIsMobile`/`@panel-*` split docs/client.md draws. */
  const { isMobile } = useSidebar()
  const go = React.useCallback(
    (id: SettingsSectionId | null) => void navigate(id ? settingsPath(id) : settingsRootPath()),
    [navigate]
  )

  /* The theme studio is two columns of its own and takes the whole frame. It
     keeps its Back button, so nothing is unreachable. */
  const bare = isFullWidthSettings(location.pathname)

  const page = loading ? (
    <SettingsSectionSkeleton />
  ) : (
    <ErrorBoundary name="settings" resetKeys={[location.pathname]}>
      <Outlet context={{ settings, actions, onAddServer } satisfies SettingsPageContext} />
    </ErrorBoundary>
  )

  return (
    <PageFrame
      scrollRef={scrollRef}
      width={isWideSettings(location.pathname) ? "full" : "settings"}
      gutter="panel"
      className={bare ? undefined : "pb-24"}
    >
      {!bare && !loading && isMobile && section !== null && <BackToSettings go={() => go(null)} />}
      {page}
    </PageFrame>
  )
}
