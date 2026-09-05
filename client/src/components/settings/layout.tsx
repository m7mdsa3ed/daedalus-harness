/* ── Settings layout route ──
   The frame every settings page renders inside: centered column, one error
   boundary per page, and the outlet context that hands each page the server
   connection and the actions. Pages read it back via useSettingsPage().

   The column's width is `settingsMaxWidth` (sections.ts) rather than a
   constant, because a couple of pages — the theme studio above all — are not
   forms and cannot be read at a form's measure. */
import { Outlet, useLocation, useOutletContext } from "react-router"
import { ErrorBoundary } from "@/components/error-boundary"
import { SettingsSectionSkeleton } from "@/components/ui/skeletons"
import type { Actions } from "@/lib/actions"
import { useScrollRestoration } from "@/lib/scroll-restoration"
import { cn } from "@/lib/utils"
import type { ServerSettings } from "@/lib/settings"
import { settingsMaxWidth } from "./sections"

export interface SettingsPageContext {
  settings: ServerSettings
  actions: Actions
  /** Opens the connect screen to store another server (App.tsx owns it). */
  onAddServer: () => void
}

export function useSettingsPage(): SettingsPageContext {
  return useOutletContext<SettingsPageContext>()
}

export function SettingsLayout({
  settings,
  actions,
  onAddServer,
  loading,
}: SettingsPageContext & { loading: boolean }) {
  const location = useLocation()
  // Coming back to a section lands where you left it, not at the top.
  const scrollRef = useScrollRestoration<HTMLDivElement>(location.pathname)
  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto pt-[var(--app-header-h)]">
      <div
        className={cn(
          "mx-auto w-full px-4 pt-6 pb-16 sm:px-8",
          settingsMaxWidth(location.pathname)
        )}
      >
        {loading ? (
          <SettingsSectionSkeleton />
        ) : (
          <ErrorBoundary name="settings" resetKeys={[location.pathname]}>
            <Outlet context={{ settings, actions, onAddServer } satisfies SettingsPageContext} />
          </ErrorBoundary>
        )}
      </div>
    </div>
  )
}
