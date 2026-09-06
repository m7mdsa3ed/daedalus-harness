/* The six surfaces Daedalus puts around a thread, as cards that go somewhere.
   Data stays out of the copy; the one live number each card may carry (a
   count of what it owns) comes in as `counts` so this stays a presentational
   grid. */
import {
  ArrowUpRight,
  Bot,
  CalendarClock,
  Layers,
  SlidersHorizontal,
  SquareKanban,
  Workflow,
  type LucideIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"

export interface LandingCounts {
  projects: number
  profiles: number
  routines: number
}

interface Feature {
  id: string
  icon: LucideIcon
  title: string
  copy: string
  to: string
  countKey?: keyof LandingCounts
  countLabel?: string
}

const FEATURES: Feature[] = [
  {
    id: "agents",
    icon: Bot,
    title: "Coding agents",
    copy: "Claude Code, Codex and more, spawned from the credentials and models you already pay for.",
    to: "/settings/agents",
  },
  {
    id: "projects",
    icon: Layers,
    title: "Projects",
    copy: "A directory with its MCP servers, skills and commands attached — the ground a thread runs on.",
    to: "/settings/projects",
    countKey: "projects",
  },
  {
    id: "profiles",
    icon: SlidersHorizontal,
    title: "Profiles & models",
    copy: "One provider per profile; the model and effort are the thread's, chosen where they matter.",
    to: "/settings/profiles",
    countKey: "profiles",
  },
  {
    id: "schedules",
    icon: CalendarClock,
    title: "Schedules",
    copy: "A message at the right time, in the right thread — once, or on repeat.",
    to: "/schedules",
  },
  {
    id: "routines",
    icon: Workflow,
    title: "Routines",
    copy: "Multi-step turns with their own autonomy and clock, run by the harness end to end.",
    to: "/routines",
    countKey: "routines",
  },
  {
    id: "tasks",
    icon: SquareKanban,
    title: "Task boards",
    copy: "Columns, sprints and custom fields for the work your agents ship.",
    to: "/board",
  },
]

export function LandingFeatures({
  counts,
  onOpen,
}: {
  counts: LandingCounts
  onOpen: (to: string) => void
}) {
  return (
    <section aria-labelledby="landing-features-title" className="mt-16">
      <div className="max-w-2xl">
        <h2
          id="landing-features-title"
          className="font-heading text-lg font-semibold tracking-tight"
        >
          Built around the thread
        </h2>
        <p className="mt-1 text-sm text-pretty text-muted-foreground">
          The thread is the unit of work; everything else is how a thread is
          aimed, fed and kept track of.
        </p>
      </div>

      <ul className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((feature) => {
          const Icon = feature.icon
          const count = feature.countKey ? counts[feature.countKey] : null
          return (
            <li key={feature.id}>
              <button
                type="button"
                onClick={() => onOpen(feature.to)}
                aria-label={`${feature.title}${count !== null ? `, ${count}` : ""}`}
                className="group flex h-full w-full flex-col gap-3 rounded-2xl border bg-card/60 p-5 text-left transition-all hover:-translate-y-0.5 hover:border-ring/50 hover:bg-card hover:shadow-glass focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="grid size-10 place-items-center rounded-xl bg-muted text-foreground/80 transition-colors group-hover:bg-primary/10 group-hover:text-primary">
                  <Icon className="size-5" />
                </span>
                <span>
                  <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                    {feature.title}
                    {count !== null && (
                      <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
                        {count}
                      </span>
                    )}
                  </span>
                  <span className="mt-1.5 block text-[13px] leading-relaxed text-pretty text-muted-foreground">
                    {feature.copy}
                  </span>
                </span>
                <span
                  className={cn(
                    "mt-auto inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors group-hover:text-primary"
                  )}
                >
                  Open
                  <ArrowUpRight className="size-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}