/* The landing's "not ready" half: the first-run wizard. A thread needs an agent
   that can run, a profile to run it on, and a project to run it in; until all
   three hold, the page's main body is these steps instead of the composer —
   and the composer, once they do, is step four.

   Every step's state is measured (`useSetupState`), never a flag: deleting the
   last project brings this back, and every device sees the same steps. The
   agents step does its work in place (install, log in — `AgentSetupRow`); the
   other two open the settings page that already holds their form.

   A rail of the steps beside the one being worked on. The step in front is the
   reader's pick, else the first one not yet true — so finishing a step moves
   the page on by itself, and a pick is never taken away from under them. */
import * as React from "react"
import {
  ArrowLeft,
  ArrowRight,
  Check,
  FolderKanban,
  MessageSquare,
  Server,
  TerminalSquare,
  type LucideIcon,
} from "lucide-react"

import { AgentSetupRow } from "@/components/agent-setup-row"
import { PAGE_TITLE } from "@/components/page-primitives"
import { StatusBadge } from "@/components/settings/primitives"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { useAgentSetup, type SetupState } from "@/lib/agent-setup"
import { useAgents, useAgentsStatus } from "@/lib/queries/catalog"
import { cn } from "@/lib/utils"

type Step = {
  id: string
  icon: LucideIcon
  title: string
  /** One line for the rail. */
  short: string
  /** What it is and why it is asked for. */
  why: string
  done: boolean
  /** Ticks without the reader doing it, e.g. a logged-in agent is a profile. */
  optional?: string
  body?: React.ReactNode
  action?: { label: string; onOpen: () => void }
}

export function LandingSetup({
  state,
  onOpenProjects,
  onOpenProfiles,
}: {
  state: SetupState
  onOpenProjects: () => void
  onOpenProfiles: () => void
}) {
  const agents = useAgents()
  const { status } = useAgentsStatus()
  const setup = useAgentSetup()
  const byAgent = new Map((status?.agents ?? []).map((s) => [s.agentId, s]))

  const steps: Step[] = [
    {
      id: "agents",
      icon: TerminalSquare,
      title: "Install and log in an agent",
      short: "The program that does the work",
      why: "An agent is the program that reads your code and makes the changes. It runs on this server, so you install and log it in here once, and every device you connect shares it. One ready agent is enough to start; add others whenever you like.",
      done: state.agents,
      body: (
        <div className="grid gap-2 @panel-lg:grid-cols-2">
          {agents.map((agent) => (
            <AgentSetupRow key={agent.id} agent={agent} status={byAgent.get(agent.id)} setup={setup} />
          ))}
        </div>
      ),
    },
    {
      id: "profiles",
      icon: Server,
      title: "Choose what it runs on",
      short: "Whose account pays for the work",
      why: "A profile says which account and models a thread uses. An agent you logged in already brings its own account, so this step ticks itself. Add a profile when you want an API key, a coding plan or a provider such as OpenRouter instead.",
      optional: state.profile ? "Done by the agent's own login. A profile is optional." : undefined,
      done: state.profile,
      action: { label: "Add a profile", onOpen: onOpenProfiles },
    },
    {
      id: "projects",
      icon: FolderKanban,
      title: "Create a project",
      short: "The folder the agents work in",
      why: "A project is a folder on the server. Threads started in it run there and can read and change its files. Point it at the repository you want help with; you can add more projects at any time.",
      done: state.project,
      action: { label: state.project ? "Open projects" : "Create a project", onOpen: onOpenProjects },
    },
    {
      id: "thread",
      icon: MessageSquare,
      title: "Start your first thread",
      short: "Ask for something",
      why: "When the steps above are done, this page turns into a composer. Write what you want done, and the agent gets to work in your project. Every thread is kept, so you can come back to it from the sidebar.",
      done: false,
    },
  ]

  const required = steps.slice(0, 3)
  const doneCount = required.filter((s) => s.done).length
  const [picked, setPicked] = React.useState<string | null>(null)
  const index = Math.max(
    0,
    steps.findIndex((s) => s.id === (picked ?? steps.find((s) => !s.done)?.id)),
  )
  const step = steps[index]
  const Icon = step.icon
  const go = (i: number) => setPicked(steps[i].id)

  return (
    <section aria-label="Set up the harness" className="flex flex-col gap-8">
      <header className="flex flex-col gap-4 @panel-md:flex-row @panel-md:items-end @panel-md:justify-between">
        <div className="flex max-w-2xl flex-col gap-1.5">
          <h1 className={PAGE_TITLE}>Set up the harness</h1>
          <p className="text-sm text-pretty text-muted-foreground">
            Three things stand between you and your first thread. Each step ticks itself as soon as it is
            true, and everything here can be changed later in Settings.
          </p>
        </div>
        <Progress value={(doneCount / required.length) * 100} className="w-full @panel-md:w-64">
          <span className="text-sm font-medium">
            {doneCount} of {required.length} done
          </span>
        </Progress>
      </header>

      <div className="grid gap-6 @panel-md:grid-cols-[16rem_minmax(0,1fr)] @panel-lg:grid-cols-[20rem_minmax(0,1fr)]">
        <ol className="flex flex-col gap-1" aria-label="Steps">
          {steps.map((s, i) => {
            const current = i === index
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => go(i)}
                  aria-current={current ? "step" : undefined}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-lg p-3 text-left transition-colors hover:bg-muted",
                    current && "bg-muted",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium",
                      s.done
                        ? "border-primary bg-primary text-primary-foreground"
                        : current
                          ? "border-primary text-primary"
                          : "text-muted-foreground",
                    )}
                  >
                    {s.done ? <Check className="size-4" /> : i + 1}
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className={cn("text-sm font-medium", !current && !s.done && "text-muted-foreground")}>
                      {s.title}
                    </span>
                    <span className="text-xs text-muted-foreground">{s.done ? "Done" : s.short}</span>
                  </span>
                </button>
              </li>
            )
          })}
        </ol>

        <article className="flex min-w-0 flex-col gap-6 rounded-xl border bg-card p-5 @panel-sm:p-8">
          <div className="flex items-start gap-4">
            <span
              className={cn(
                "flex size-11 shrink-0 items-center justify-center rounded-lg bg-muted",
                step.done && "bg-primary/10 text-primary",
              )}
            >
              {step.done ? <Check className="size-5" /> : <Icon className="size-5" />}
            </span>
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  Step {index + 1} of {steps.length}
                </span>
                {step.done && <StatusBadge tone="ok">Done</StatusBadge>}
              </div>
              <h2 className="font-heading text-lg font-semibold">{step.title}</h2>
              <p className="max-w-prose text-sm text-pretty text-muted-foreground">{step.why}</p>
              {step.optional && <p className="text-sm text-foreground">{step.optional}</p>}
            </div>
          </div>

          {step.body}

          <div className="mt-auto flex flex-wrap items-center gap-2 border-t pt-5">
            {step.action && (
              <Button variant={step.done ? "outline" : "default"} onClick={step.action.onOpen}>
                {step.action.label}
                <ArrowRight />
              </Button>
            )}
            <div className="ml-auto flex gap-2">
              {index > 0 && (
                <Button variant="ghost" onClick={() => go(index - 1)}>
                  <ArrowLeft />
                  Back
                </Button>
              )}
              {index < steps.length - 1 && (
                <Button variant={step.done && !step.action ? "default" : "outline"} onClick={() => go(index + 1)}>
                  {step.done ? "Next step" : "Skip for now"}
                  <ArrowRight />
                </Button>
              )}
            </div>
          </div>
        </article>
      </div>
    </section>
  )
}
