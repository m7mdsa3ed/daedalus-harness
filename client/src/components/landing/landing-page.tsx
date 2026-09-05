/* ── The landing page ──
   `/` with no thread open: the front door of the app. A hero with the live
   numbers, the threads that were recently being worked on, and the surfaces
   Daedalus puts around a thread. It replaces the old two-line empty state
   with an actual *page* — same place in the shell, same callbacks, so the
   shell's contract (start a thread, open a settings section) survives. */
import * as React from "react"
import { useNavigate } from "react-router"

import { LandingHero, type LandingStats } from "@/components/landing/landing-hero"
import { LandingRecent } from "@/components/landing/landing-recent"
import { LandingFeatures } from "@/components/landing/landing-features"
import { LandingSetup } from "@/components/landing/landing-setup"
import { LandingSkeleton } from "@/components/landing/landing-skeleton"
import { Logo } from "@/components/ui/logo"
import { useProfiles, useProjects } from "@/lib/queries/catalog"
import { useRoutines } from "@/lib/queries/routines"
import {
  boardPath,
  buildPath,
  routinesPath,
  schedulesPath,
  threadPath,
} from "@/lib/router"
import { activityAt, isTopLevel } from "@/lib/settings"
import { useStoreSelect } from "@/lib/store"
import type { SettingsSectionId } from "@/components/settings/sections"

/** The three feature cards that live under Settings, in the paths the cards
    carry → the section ids the shell's settings opener expects. */
const SETTINGS_TARGETS: Record<string, SettingsSectionId> = {
  "/settings/agents": "agents",
  "/settings/projects": "projects",
  "/settings/profiles": "profiles",
}

export function LandingPage({
  loading,
  ready,
  onNewThread,
  onOpenSettings,
}: {
  loading: boolean
  ready: boolean
  onNewThread: () => void
  onOpenSettings: (section?: SettingsSectionId) => void
}) {
  const sessions = useStoreSelect((state) => state.sessions)
  const projects = useProjects()
  const profiles = useProfiles()
  const routines = useRoutines().data ?? []
  const navigate = useNavigate()

  const { threads, recent } = React.useMemo(() => {
    const live = sessions.filter(isTopLevel).filter((session) => !session.deletedAt)
    const ordered = [...live].sort((a, b) => activityAt(b) - activityAt(a))
    return { threads: live.length, recent: ordered.slice(0, 5) }
  }, [sessions])

  if (loading) return <LandingSkeleton />

  const stats: LandingStats = {
    threads,
    projects: projects.length,
    profiles: profiles.length,
    routines: routines.length,
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* The atmosphere behind the hero: two theme-aware glows and a faint
          dot grid, clipped to the top of the page so it scrolls away and does
          not fight the surfaces lower down. Purely decorative. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[720px] overflow-hidden"
      >
        <div className="absolute inset-0 bg-[radial-gradient(58%_46%_at_50%_0%,color-mix(in_oklch,var(--primary)_16%,transparent)_0%,transparent_62%)]" />
        <div className="absolute -left-40 top-40 size-96 rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklch,var(--chart-3)_14%,transparent),transparent)] blur-2xl" />
        <div className="absolute -right-40 top-8 size-[28rem] rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklch,var(--chart-2)_12%,transparent),transparent)] blur-2xl" />
        <div className="absolute inset-0 [background-image:radial-gradient(color-mix(in_oklch,var(--foreground)_7%,transparent)_1px,transparent_1px)] [background-size:26px_26px] [mask-image:linear-gradient(to_bottom,black,transparent_75%)]" />
      </div>

      <main className="relative mx-auto w-full max-w-6xl px-4 pt-[calc(var(--app-header-h)+2.5rem)] pb-16 sm:px-8 sm:pt-[calc(var(--app-header-h)+4rem)]">
        <LandingHero
          ready={ready}
          stats={stats}
          onNewThread={onNewThread}
          onBuild={() => void navigate(buildPath())}
          onOpenSettings={() => onOpenSettings("projects")}
        />

        {ready ? (
          <>
            <LandingRecent
              sessions={recent}
              projects={projects}
              profiles={profiles}
              onNewThread={onNewThread}
              onOpenThread={(sessionId) => void navigate(threadPath(sessionId))}
            />
            <LandingFeatures
              counts={{ projects: projects.length, profiles: profiles.length, routines: routines.length }}
              onOpen={(to) => {
                /* The three cards that live under Settings open through the
                    shell's own opener (it knows the section ids); the rest are
                    plain routes. */
                const section = SETTINGS_TARGETS[to]
                if (section) {
                  onOpenSettings(section)
                  return
                }
                void navigate(to)
              }}
            />
          </>
        ) : (
          <LandingSetup
            projects={projects.length}
            profiles={profiles.length}
            onOpenProjects={() => onOpenSettings("projects")}
            onOpenProfiles={() => onOpenSettings("profiles")}
          />
        )}

        <footer className="mt-16 flex flex-col items-center justify-between gap-3 border-t pt-6 text-xs text-muted-foreground sm:flex-row">
          <div className="flex items-center gap-2">
            <Logo idle className="size-4 text-primary" />
            <span className="brand-script text-sm text-foreground">Daedalus</span>
            <span className="hidden sm:inline">— the harness for coding agents</span>
          </div>
          <nav aria-label="Landing links" className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
            <button type="button" onClick={() => void navigate(schedulesPath())} className="rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Schedules
            </button>
            <button type="button" onClick={() => void navigate(routinesPath())} className="rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Routines
            </button>
            <button type="button" onClick={() => void navigate(boardPath())} className="rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Tasks
            </button>
            <button type="button" onClick={() => void navigate(buildPath())} className="rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Build an app
            </button>
          </nav>
        </footer>
      </main>
    </div>
  )
}