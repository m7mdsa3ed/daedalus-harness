/* The landing's "not ready" half: a thread needs one project and one profile
   before it can run, so while either catalog is empty the page's main body
   is these two setup steps instead of the recent-threads/features grid. */
import { Check, ChevronRight, FolderKanban, Server } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
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
    <section aria-labelledby="landing-setup-title">
      <div>
        <h2 id="landing-setup-title" className="font-heading text-base font-medium">
          Finish the setup
        </h2>
        <p className="mt-1 max-w-md text-sm text-pretty text-muted-foreground">
          Two things stand between you and a running thread. Either is one
          settings page away.
        </p>
      </div>

      <ol className="mt-6 grid gap-3 @panel-sm:grid-cols-2">
        {steps.map((step, index) => {
          const Icon = step.icon
          return (
            <li key={step.id}>
              <Item
                variant="outline"
                className={cn("h-full items-start text-left hover:bg-muted", step.done && "opacity-80")}
                render={
                  <button
                    type="button"
                    onClick={step.onOpen}
                    aria-label={`${step.title}${step.done ? " — done" : ""}`}
                  />
                }
              >
                <ItemMedia variant="icon" className={cn("size-9 rounded-lg bg-muted", step.done && "bg-primary/10 text-primary")}>
                  {step.done ? <Check /> : <Icon />}
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>
                    {step.title}
                    {step.done && <span className="font-normal text-muted-foreground">— done</span>}
                  </ItemTitle>
                  <ItemDescription>{step.description}</ItemDescription>
                  <span className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
                    {step.done ? "Reopened in settings" : "Set it up"}
                    <ChevronRight className="size-3.5" />
                  </span>
                </ItemContent>
                <Badge variant="secondary" className="tabular-nums">
                  Step {index + 1} of 2
                </Badge>
              </Item>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
