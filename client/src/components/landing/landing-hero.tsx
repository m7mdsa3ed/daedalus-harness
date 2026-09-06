/* The hero: the mark, a headline, the two ways in (a thread, an app) and the
   live numbers of the workspace behind them. All data, no invented figures —
   the four counts come straight from the store and the catalogs. */
import { Plus, Settings2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Logo } from "@/components/ui/logo"

export interface LandingStats {
  threads: number
  projects: number
  profiles: number
  routines: number
}

const STATS: { key: keyof LandingStats; label: string }[] = [
  { key: "threads", label: "Threads" },
  { key: "projects", label: "Projects" },
  { key: "profiles", label: "Profiles" },
  { key: "routines", label: "Routines" },
]

export function LandingHero({
  ready,
  stats,
  onNewThread,
  onOpenSettings,
}: {
  ready: boolean
  stats: LandingStats
  onNewThread: () => void
  onOpenSettings: () => void
}) {
  return (
    <header className="text-center">
      <div className="inline-flex items-center gap-2 rounded-full border bg-card/60 px-3 py-1 text-xs font-medium text-muted-foreground shadow-glass">
        <Logo idle className="size-3.5 text-primary" />
        AI agent harness
      </div>

      <h1 className="mx-auto mt-6 max-w-3xl font-heading text-4xl font-semibold tracking-tight text-balance sm:text-6xl">
        One workshop for every{" "}
        <span className="text-primary">coding agent.</span>
      </h1>

      <p className="mx-auto mt-4 max-w-2xl text-base text-pretty text-muted-foreground sm:text-lg">
        Daedalus spawns the agents you already trust — Claude Code, Codex and
        more — inside one workspace, with projects, profiles, schedules and
        boards wrapped around every thread.
      </p>

      <div className="mt-8 flex flex-wrap items-center justify-center gap-2.5">
        {ready ? (
          <Button size="lg" onClick={onNewThread}>
            <Plus /> New thread
          </Button>
        ) : (
          <Button size="lg" onClick={onOpenSettings}>
            <Settings2 /> Finish the setup
          </Button>
        )}
      </div>

      <dl className="mx-auto mt-12 grid max-w-2xl grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-4">
        {STATS.map(({ key, label }) => (
          <div key={key} className="flex flex-col items-center gap-1">
            <dt className="order-2 text-[11px] font-medium tracking-wide uppercase text-muted-foreground">
              {label}
            </dt>
            <dd className="order-1 font-mono text-2xl font-semibold tabular-nums text-foreground">
              {stats[key]}
            </dd>
          </div>
        ))}
      </dl>
    </header>
  )
}