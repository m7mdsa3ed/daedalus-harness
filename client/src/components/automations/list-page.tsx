/* ── /automations — the list ──
   One list for what used to be two: automations that start a thread per fire
   and automations pinned to one thread. A row says where it runs, when it
   fires, when it fires next and what happened last. The newest run and the
   triggers of every automation are the page's own reads (one small request
   each, on the visit, never on a timer — `useAutomationReads`), so a row can
   say what happened last and the tiles can count across all of them. */
import * as React from "react"
import { HistoryIcon, MessagesSquareIcon, PlayIcon, PlusIcon, ShieldCheckIcon, Trash2Icon, WorkflowIcon, ZapIcon } from "lucide-react"
import { useNavigate } from "react-router"

import { ProjectIcon } from "@/components/entity-icon"
import { ErrorNote } from "@/components/error-note"
import { SurfaceHeader } from "@/components/page-primitives"
import { SettingsList, type ListAction, type ListColumn } from "@/components/settings/list"
import { Section, StatStrip, StatusBadge } from "@/components/settings/primitives"
import { Empty } from "@/components/empty"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { inlineFromQuery } from "@/lib/errors"
import { useProjects } from "@/lib/queries/catalog"
import { useAutomationReads, useAutomations } from "@/lib/queries/automations"
import { automationPath, newAutomationPath, threadPath } from "@/lib/router"
import type { Routine, RoutineRun } from "@/lib/settings"
import { useStoreSelect } from "@/lib/store"
import { shortAge } from "@/lib/time"
import { useFire, useRemove, useToggle } from "./hooks"
import { runStatus } from "./status"
import { nextFireOf, triggersLine, untilLabel } from "./trigger-summary"

type State = "Active" | "Paused" | "Needs you"

export function AutomationsListPage() {
  const query = useAutomations()
  const automations = React.useMemo(() => query.data ?? [], [query.data])
  const projects = useProjects()
  const sessions = useStoreSelect((state) => state.sessions)
  const navigate = useNavigate()
  const fire = useFire()
  const toggle = useToggle()
  const remove = useRemove()
  const { latest, triggers } = useAutomationReads(automations)

  const needsYou = React.useCallback((r: Routine) => {
    const s = latest[r.id]?.status
    return s === "blocked" || s === "failed"
  }, [latest])
  const stateOf = React.useCallback(
    (r: Routine): State[] => [
      ...(needsYou(r) ? (["Needs you"] as const) : []),
      r.enabled ? "Active" : "Paused",
    ],
    [needsYou]
  )

  const enabled = automations.filter((r) => r.enabled).length
  const runningNow = automations.filter((r) => latest[r.id]?.status === "running").length
  const attention = automations.filter(needsYou).length
  const soonest = automations.reduce<{ at: number; name: string } | null>((best, r) => {
    const at = r.enabled ? nextFireOf(triggers[r.id]) : null
    return at !== null && (!best || at < best.at) ? { at, name: r.name } : best
  }, null)

  const newAutomation = () => void navigate(newAutomationPath())
  const pending = query.isPending
  const error = React.useMemo(() => inlineFromQuery(query.error, "Couldn't read the automations"), [query.error])

  const projectName = React.useCallback(
    (r: Routine) => projects.find((p) => p.id === r.projectId)?.name ?? "Project missing",
    [projects]
  )

  const columns = React.useMemo<ListColumn<Routine>[]>(
    () => [
      {
        id: "name",
        header: "Automation",
        title: true,
        cell: (r) => (
          <span className="inline-flex min-w-0 items-center gap-2">
            <span className={r.enabled ? "truncate" : "truncate text-muted-foreground"}>{r.name}</span>
            {r.body.kind === "workflow" && (
              <WorkflowIcon className="size-3.5 shrink-0 text-muted-foreground" aria-label="Runs a workflow" />
            )}
          </span>
        ),
      },
      {
        id: "runs-in",
        header: "Runs in",
        cell: (r) =>
          r.runsIn === "session" ? (
            <span className="inline-flex min-w-0 items-center gap-1.5" title="Delivers into one existing thread">
              <MessagesSquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">
                {sessions.find((s) => s.id === r.sessionId)?.title || "This thread"}
              </span>
            </span>
          ) : (
            <span className="inline-flex min-w-0 items-center gap-1.5" title="A new thread for every fire">
              <ProjectIcon project={projects.find((p) => p.id === r.projectId)} className="size-3.5 shrink-0" />
              <span className="truncate">{projectName(r)}</span>
            </span>
          ),
      },
      {
        id: "when",
        header: "Fires",
        secondary: true,
        cell: (r) => {
          const line = triggersLine(triggers[r.id])
          return line ? <span className="truncate">{line}</span> : <Skeleton className="h-4 w-28" />
        },
      },
      {
        id: "next",
        header: "Next run",
        secondary: true,
        width: "w-28 whitespace-nowrap",
        cell: (r) => {
          const ts = triggers[r.id]
          if (ts === undefined) return <Skeleton className="h-4 w-16" />
          const at = r.enabled ? nextFireOf(ts) : null
          return at === null ? (
            <span className="text-xs text-muted-foreground">{r.enabled ? "—" : "Paused"}</span>
          ) : (
            <span className="text-sm" title={new Date(at).toLocaleString()}>
              {untilLabel(at)}
            </span>
          )
        },
      },
      {
        id: "last",
        header: "Last result",
        align: "end",
        width: "w-44",
        cell: (r) => {
          const last: RoutineRun | null | undefined = latest[r.id]
          if (last === undefined) return <Skeleton className="h-4 w-24" />
          if (last === null) return <span className="text-xs text-muted-foreground">Never run</span>
          const tone = runStatus(last.status)
          return (
            <span className="inline-flex items-center gap-2" title={tone.meaning}>
              <StatusBadge tone={tone.badge}>{tone.label}</StatusBadge>
              <span className="text-xs text-muted-foreground" title={new Date(last.startedAt).toLocaleString()}>
                {shortAge(last.startedAt)}
              </span>
            </span>
          )
        },
      },
      {
        id: "enabled",
        header: "On",
        align: "end",
        width: "w-16",
        cell: (r) => (
          /* A switch in a clickable row: the click must not also open the row. */
          <span className="inline-flex" onClick={(event) => event.stopPropagation()}>
            <Switch
              checked={r.enabled}
              onCheckedChange={(on) => toggle(r, on)}
              aria-label={r.enabled ? `Pause ${r.name}` : `Resume ${r.name}`}
            />
          </span>
        ),
      },
    ],
    [latest, triggers, projects, projectName, sessions, toggle]
  )

  const actions = React.useMemo<ListAction<Routine>[]>(
    () => [
      { id: "run", label: "Run now", icon: <PlayIcon />, position: "left", onClick: (r) => void fire(r, false) },
      {
        id: "dry",
        label: "Run now, forced to ask",
        icon: <ShieldCheckIcon />,
        position: "left",
        hidden: (r) => r.runsIn === "session",
        onClick: (r) => void fire(r, true),
      },
      {
        id: "thread",
        label: "Open last run's thread",
        icon: <HistoryIcon />,
        position: "left",
        hidden: (r) => !latest[r.id]?.sessionId,
        onClick: (r) => void navigate(threadPath(latest[r.id]!.sessionId!)),
      },
      { id: "delete", label: "Delete", icon: <Trash2Icon />, tone: "danger", onClick: (r) => void remove(r) },
    ],
    [fire, remove, latest, navigate]
  )

  const stats = [
    {
      label: "Automations",
      value: automations.length,
      loading: pending,
      hint: enabled === automations.length ? "all active" : `${automations.length - enabled} paused`,
    },
    { label: "Running now", value: runningNow, loading: pending, hint: runningNow === 1 ? "run in progress" : "runs in progress" },
    {
      label: "Need you",
      value: attention,
      loading: pending,
      tone: attention > 0 ? ("warn" as const) : undefined,
      hint: attention > 0 ? "last run blocked or failed" : "nothing waiting on you",
    },
    {
      label: "Next run",
      value: soonest ? untilLabel(soonest.at) : "—",
      loading: pending,
      hint: soonest ? soonest.name : "nothing is scheduled",
    },
  ]

  return (
    <>
      <SurfaceHeader
        title="Automations"
        description="Prompts that run on their own — on a clock, a webhook or a commit — in a new thread each time or in a thread you already have. Each run is a real thread, and each automation decides in advance which of the agent's questions it answers for you."
        onBack={() => void navigate("/")}
        actions={
          <Button onClick={newAutomation}>
            <PlusIcon data-icon="inline-start" />
            New automation
          </Button>
        }
      />

      {error ? (
        <Section>
          <ErrorNote error={error} onRetry={() => void query.refetch()} />
        </Section>
      ) : automations.length === 0 && !pending ? (
        <Empty
          size="lg"
          icon={ZapIcon}
          action={
            <Button size="sm" onClick={newAutomation}>
              <PlusIcon data-icon="inline-start" />
              New automation
            </Button>
          }
        >
          No automations yet. Pick a template, or start blank — an automation runs a prompt for you on a schedule.
        </Empty>
      ) : (
        <>
          <StatStrip stats={stats} />
          <SettingsList
            columns={columns}
            rows={automations}
            rowId={(r) => r.id}
            loading={pending}
            actions={actions}
            onRowClick={(r) => void navigate(automationPath(r.id))}
            mark={(r) => <ZapIcon className={r.enabled ? "size-4 text-primary" : "size-4 text-muted-foreground"} />}
            fields={[
              { id: "state", label: "State", of: stateOf },
              { id: "project", label: "Project", of: projectName },
            ]}
            search={{
              placeholder: "Filter by name, description or project",
              matches: (r, needle) =>
                r.name.toLowerCase().includes(needle) ||
                (r.description ?? "").toLowerCase().includes(needle) ||
                projectName(r).toLowerCase().includes(needle),
            }}
          />
        </>
      )}
    </>
  )
}
