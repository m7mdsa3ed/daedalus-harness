/* ── Settings layout route ──
   The frame every settings page renders inside: centered column, one error
   boundary per page, and the outlet context that hands each page the server
   connection and the actions. Pages read it back via useSettingsPage(). */
import { Outlet, useLocation, useOutletContext } from "react-router"
import { ErrorBoundary } from "@/components/error-boundary"
import { SettingsSectionSkeleton } from "@/components/ui/skeletons"
import type { Actions } from "@/lib/actions"
import { useScrollRestoration } from "@/lib/scroll-restoration"
import type { ServerSettings } from "@/lib/settings"

export interface SettingsPageContext {
  settings: ServerSettings
  actions: Actions
}

export function useSettingsPage(): SettingsPageContext {
  return useOutletContext<SettingsPageContext>()
}

export function SettingsLayout({
  settings,
  actions,
  loading,
}: SettingsPageContext & { loading: boolean }) {
  const location = useLocation()
  // Coming back to a section lands where you left it, not at the top.
  const scrollRef = useScrollRestoration<HTMLDivElement>(location.pathname)
  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 pt-6 pb-16 sm:px-8">
        {loading ? (
          <SettingsSectionSkeleton />
        ) : (
          <ErrorBoundary name="settings" resetKeys={[location.pathname]}>
            <Outlet context={{ settings, actions } satisfies SettingsPageContext} />
          </ErrorBoundary>
        )}
      </div>
    </div>
  )
}
