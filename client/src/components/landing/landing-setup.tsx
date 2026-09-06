/* The landing's "not ready" half: a thread needs one project and one profile
   before it can run, so while either catalog is empty the page's main body
   is these two setup steps instead of the recent-threads/features grid. */
import { Check, ChevronRight, FolderKanban, Server } from "lucide-react"

import { cn } from "@/lib/utils"

export function LandingSetup({
  projects,
  profiles,
  onOpenProjects,
  onOpenProfiles,
}: {
  projects: number
  profiles: number
  onOpenProjects: () => void
  onOpenProfiles: () => void
}) {
  const steps = [
    {
      id: "projects",
      icon: FolderKanban,
      title: "Create a project",
      description: "A directory, its MCP servers, skills and commands — where a thread runs.",
      done: projects > 0,
      onOpen: onOpenProjects,
    },
    {
      id: "profiles",
      icon: Server,
      title: "Add a profile",
      description: "Provider credentials, models and effort — what a thread runs on.",
      done: profiles > 0,
      onOpen: onOpenProfiles,
    },
  ]

  return (
    <section aria-labelledby="landing-setup-title" className="mx-auto mt-16 max-w-2xl">
      <div className="text-center">
        <h2 id="landing-setup-title" className="font-heading text-lg font-semibold tracking-tight">
          Finish the setup
        </h2>
        <p className="mx-auto mt-1 max-w-md text-sm text-pretty text-muted-foreground">
          Two things stand between you and a running thread. Either is one
          settings page away.
        </p>
      </div>

      <ol className="mt-6 grid gap-3 sm:grid-cols-2">
        {steps.map((step, index) => {
          const Icon = step.icon
          return (
            <li key={step.id}>
              <button
                type="button"
                onClick={step.onOpen}
                aria-label={`${step.title}${step.done ? " — done" : ""}`}
                className={cn(
                  "group flex h-full w-full flex-col gap-3 rounded-2xl border bg-card/60 p-5 text-left transition-all hover:-translate-y-0.5 hover:border-ring/50 hover:bg-card hover:shadow-glass focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  step.done && "border-transparent opacity-80 hover:opacity-100"
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  <span
                    className={cn(
                      "grid size-9 place-items-center rounded-xl bg-muted text-foreground/80",
                      step.done && "bg-primary/10 text-primary",
                      !step.done && "group-hover:bg-primary/10 group-hover:text-primary"
                    )}
                  >
                    {step.done ? <Check className="size-4" /> : <Icon className="size-4" />}
                  </span>
                  <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
                    Step {index + 1} of 2
                  </span>
                </span>
                <span>
                  <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                    {step.title}
                    {step.done && (
                      <span className="text-xs font-normal text-muted-foreground">— done</span>
                    )}
                  </span>
                  <span className="mt-1.5 block text-[13px] leading-relaxed text-pretty text-muted-foreground">
                    {step.description}
                  </span>
                </span>
                <span className="mt-auto inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors group-hover:text-primary">
                  {step.done ? "Reopened in settings" : "Set it up"}
                  <ChevronRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </button>
            </li>
          )
        })}
      </ol>
    </section>
  )
}