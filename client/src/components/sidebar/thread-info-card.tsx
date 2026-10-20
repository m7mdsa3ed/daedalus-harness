/* ── The ⋯ menu's reading ── what the row does not say. */
import * as React from "react"
import { AgentIcon, ProjectIcon } from "@/components/entity-icon"
import { activityAt, type SessionMeta } from "@/lib/settings"
import { useAgents, useProfiles, useProjects } from "@/lib/queries/catalog"
import { useStoreSelect } from "@/lib/store"
import type { ThreadStatus } from "./thread-row"

/** What the row does not say: the thread's status, who runs it and where,
    and when it began. It rides on the ⋯ menu, above the actions. */
export function ThreadInfoCard({
  session,
  state,
  trash,
}: {
  session: SessionMeta
  state: ThreadStatus
  trash: boolean
}) {
  /* Three catalog reads. This card is rendered per row of the sidebar; the
     catalog lives in the query cache, so only a refresh of one of these three
     re-renders it — never a token from some other open thread. */
  const project = useProjects().find((p) => p.id === session.projectId)
  const profile = useProfiles().find((p) => p.id === session.profileId)?.name
  const agent = useAgents().find((a) => a.id === session.agentId)?.name ?? session.agentId
  /* The parent's title, not the row: a string compares by value, so this stays
     quiet through the parent thread's own stream. */
  const parentTitle = useStoreSelect((s) =>
    session.parentSessionId
      ? s.sessions.find((row) => row.id === session.parentSessionId)?.title
      : undefined
  )
  const asideOfTitle = useStoreSelect((s) =>
    session.asideQuote && session.forkedFromSessionId
      ? s.sessions.find((row) => row.id === session.forkedFromSessionId)?.title
      : undefined
  )
  const when = (ts: number) =>
    new Date(ts).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
  /* One reading, in the order it matters. The connection states are new here:
     a thread that had lost its socket used to say "Idle" in this card, which is
     the reading the card exists to prevent — and so is the failed turn, which
     was only ever visible by opening the transcript and scrolling to the end. */
  const status = trash
    ? "In Trash"
    : state === "waiting"
      ? "Needs you"
      : state === "running"
        ? "Running"
        : state === "reconnecting"
          ? "Reconnecting"
          : state === "offline"
            ? "Waiting for the server"
            : state === "failed"
              ? "Last turn failed"
              : state === "connecting"
                ? "Opening"
                : state === "gone"
                  ? "Deleted"
                  : state === "stopped" || session.exited
                    ? "Stopped"
                    : session.draft
                      ? "Not started"
                      : "Idle"
  const rows: [string, React.ReactNode][] = [
    ["Status", status],
    [
      "Agent",
      <span key="agent" className="flex items-center gap-1.5">
        <AgentIcon agentId={session.agentId} className="size-3.5" />
        {agent}
      </span>,
    ],
    ["Profile", profile ?? "—"],
    ["Model", [session.model, session.effort].filter(Boolean).join(" · ") || "Agent's own"],
    [
      "Project",
      <span key="project" className="flex items-center gap-1.5">
        {project && <ProjectIcon project={project} className="size-3.5" />}
        {project?.name ?? "Other"}
      </span>,
    ],
    ["Started", when(session.createdAt)],
  ]
  /* The list orders by activity now, so the card says what the position means
     — and only when it differs from the start, since a thread with one turn in
     it would otherwise print the same timestamp twice. */
  if (activityAt(session) - session.createdAt > 60_000)
    rows.push(["Last active", when(activityAt(session))])
  /* Why it failed, in the card rather than on the row: the row has space for a
     mark, and the card is where a reading is explained. One clipped line like
     every other value here — the failure itself, with its detail and a Retry,
     is a row in the transcript. */
  if (!trash && session.lastTurnError)
    rows.push([
      "Failure",
      <span key="failure" className="text-destructive" title={session.lastTurnError}>
        {session.lastTurnError}
      </span>,
    ])
  if (session.parentSessionId) rows.push(["Step of", parentTitle ?? "a workflow"])
  if (session.asideQuote) {
    rows.push(["Aside of", asideOfTitle ?? "a thread no longer held"])
    rows.push(["On", <span key="on" title={session.asideQuote}>“{session.asideQuote}”</span>])
  }
  if (trash && session.deletedAt) rows.push(["Deleted", when(session.deletedAt)])
  return (
    <div className="flex flex-col gap-2 text-left text-sm">
      <p className="text-sm font-medium leading-snug">{session.title}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {rows.map(([label, value]) => (
          <React.Fragment key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 truncate">{value}</dd>
          </React.Fragment>
        ))}
      </dl>
    </div>
  )
}
