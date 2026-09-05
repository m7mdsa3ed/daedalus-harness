/* "Continue where you left off": the most recently active threads, top-level
   and not trashed, with the icons of the project and profile they run on. A
   row is the whole thread — click anywhere on it, not a caret on the side. */
import { ChevronRight, Plus } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ProfileIcon, ProjectIcon } from "@/components/entity-icon"
import { activityAt, type Profile, type Project, type SessionMeta } from "@/lib/settings"
import { shortAge } from "@/lib/time"

export function LandingRecent({
  sessions,
  projects,
  profiles,
  onNewThread,
  onOpenThread,
}: {
  sessions: SessionMeta[]
  projects: Project[]
  profiles: Profile[]
  onNewThread: () => void
  onOpenThread: (sessionId: string) => void
}) {
  return (
    <section aria-labelledby="landing-recent-title" className="mt-16">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 id="landing-recent-title" className="font-heading text-lg font-semibold tracking-tight">
            Continue where you left off
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Your most recently active threads, in one list.
          </p>
        </div>
        {sessions.length > 0 && (
          <Button variant="ghost" size="sm" onClick={onNewThread} className="shrink-0">
            <Plus /> New thread
          </Button>
        )}
      </div>

      {sessions.length === 0 ? (
        <div className="mt-4 flex flex-col items-center gap-3 rounded-2xl border border-dashed bg-card/40 px-6 py-10 text-center">
          <p className="text-sm text-pretty text-muted-foreground">
            No threads yet — every conversation starts here.
          </p>
          <Button onClick={onNewThread}>
            <Plus /> New thread
          </Button>
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-border overflow-hidden rounded-2xl border bg-card/60">
          {sessions.map((session) => {
            const project = projects.find((p) => p.id === session.projectId)
            const profile = profiles.find((p) => p.id === session.profileId)
            return (
              <li key={session.id}>
                <button
                  type="button"
                  onClick={() => onOpenThread(session.id)}
                  className="group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  {/* The two contexts the thread runs on, drawn as one stack —
                      the same picture the header's breadcrumb paints. */}
                  <span className="relative grid shrink-0 place-items-center">
                    <ProjectIcon project={project} className="size-8 rounded-lg ring-1 ring-border" />
                    <ProfileIcon
                      profile={profile}
                      agentId={session.agentId}
                      className="absolute -right-1.5 -bottom-1.5 size-4 rounded-full ring-2 ring-card"
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {session.title || "Untitled thread"}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {[project?.name, profile?.name].filter(Boolean).join(" · ") ||
                        "Draft thread"}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                    {shortAge(activityAt(session))}
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}