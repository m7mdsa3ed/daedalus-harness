/* ── /automations — the list ──
   One list for what used to be two: automations that start a thread per fire
   and automations pinned to one thread. A row says where it runs, when it
   fires, when it fires next and what happened last. The newest run and the
   triggers of every automation are the page's own reads (one small request
   each, on the visit, never on a timer — `useAutomationReads`), so a row can
   say what happened last and the tiles can count across all of them. A read
   that failed says so in its cell and once above the table, with a retry —
   never an endless skeleton. */
import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  CopyIcon,
  HistoryIcon,
  MessagesSquareIcon,
  PauseIcon,
  PencilIcon,
  PlayCircleIcon,
  PlayIcon,
  PlusIcon,
  ShieldCheckIcon,
  Trash2Icon,
  WorkflowIcon,
  ZapIcon,
} from "lucide-react"
import { useNavigate } from "react-router"

import { ProjectIcon } from "@/components/entity-icon"
import { ErrorNote } from "@/components/error-note"
import { SurfaceHeader } from "@/components/page-primitives"
import { SettingsList, type ListAction, type ListColumn } from "@/components/settings/list"
import { Section, StatStrip, StatusBadge } from "@/components/settings/primitives"
import { Empty } from "@/components/empty"
import { Button } from "@/components/ui/busy-button"
import { TitleCell } from "@/components/ui/data-table"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { inlineFromQuery } from "@/lib/errors"
import { automationRunsKey, automationTriggersKey } from "@/lib/queries"
import { useProjects } from "@/lib/queries/catalog"
import { useAutomationReads, useAutomations } from "@/lib/queries/automations"
import { automationPath, newAutomationPath, threadPath } from "@/lib/router"
import { useServer } from "@/lib/server-context"
import type { Routine, RoutineRun } from "@/lib/settings"
import { useStoreSelect } from "@/lib/store"
import { shortAge } from "@/lib/time"
import { cn } from "@/lib/utils"
import { useDuplicate, useFire, useMinuteTick, useRemove, useToggle } from "./hooks"
import { runStatus } from "./status"
import { nextFireOf, triggersLine, untilLabel } from "./trigger-summary"

type State = "Needs you" | "Running" | "Active" | "Paused"

const unread = <span className="text-xs text-destructive">Couldn't read</span>

export function AutomationsListPage() {
  const query = useAutomations()
  const automations = React.useMemo(() => query.data ?? [], [query.data])
  const projects = useProjects()
  const sessions = useStoreSelect((state) => state.sessions)
  const navigate = useNavigate()
  const fire = useFire()
  const toggle = useToggle()
  const remove = useRemove()
  const duplicate = useDuplicate()
  const now = useMinuteTick()
  const settings = useServer()
  const qc = useQueryClient()
  const { latest, triggers } = useAutomationReads(automations)

  /* `useAutomationReads` hands back data only, and its observers re-render on
     data — an error leaves data undefined, so the failure is read off the
     cache, subscribed to so a failure (and a retry's success) redraws. */
  const runsKey = React.useCallback((id: string) => automationRunsKey(settings, id, 1), [settings])
  const trigKey = React.useCallback((id: string) => automationTriggersKey(settings, id), [settings])
  const failedSnapshot = React.useCallback(
    () =>
      automations
        .map((r) => {
          const runs = qc.getQueryState(runsKey(r.id))?.status === "error" ? "r" : ""
          const trig = qc.getQueryState(trigKey(r.id))?.status === "error" ? "t" : ""
          return runs || trig ? `${r.id}:${runs}${trig}` : ""
        })
        .filter(Boolean)
        .join(","),
    [automations, qc, runsKey, trigKey]
  )
  const failedSig = React.useSyncExternalStore(qc.getQueryCache().subscribe, failedSnapshot)
  const failed = React.useMemo(() => {
    const map: Record<string, { runs: boolean; triggers: boolean }> = {}
    for (const entry of failedSig ? failedSig.split(",") : []) {
      const cut = entry.lastIndexOf(":")
      const flags = entry.slice(cut + 1)
      map[entry.slice(0, cut)] = { runs: flags.includes("r"), triggers: flags.includes("t") }
    }
    return map
  }, [failedSig])
  const failedIds = Object.keys(failed)
  const readError = React.useMemo(() => {
    const ids = Object.keys(failed)
    if (ids.length === 0) return null
    const first = ids.map((id) => qc.getQueryState(runsKey(id))?.error ?? qc.getQueryState(trigKey(id))?.error).find(Boolean)
    const n = ids.length
    return inlineFromQuery(first ?? new Error("Read failed"), `Couldn't read the last run or triggers of ${n} automation${n === 1 ? "" : "s"}`)
  }, [failed, qc, runsKey, trigKey])
  const retryReads = () => {
    for (const id of failedIds) {
      if (failed[id].runs) void qc.refetchQueries({ queryKey: runsKey(id) })
      if (failed[id].triggers) void qc.refetchQueries({ queryKey: trigKey(id) })
    }
  }

  const needsYou = React.useCallback((r: Routine) => {
    const s = latest[r.id]?.status
    return s === "blocked" || s === "failed"
  }, [latest])
  const stateOf = React.useCallback(
    (r: Routine): State[] => [
      ...(needsYou(r) ? (["Needs you"] as const) : []),
      ...(latest[r.id]?.status === "running" ? (["Running"] as const) : []),
      r.enabled ? "Active" : "Paused",
    ],
    [needsYou, latest]
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

  /** "every day at 09:00 · next in 3h", or "… · Paused". */
  const subtitleOf = React.useCallback(
    (r: Routine): React.ReactNode => {
      if (failed[r.id]?.triggers) return unread
      const ts = triggers[r.id]
      if (ts === undefined) return <Skeleton className="h-3 w-28" />
      const at = r.enabled ? nextFireOf(ts) : null
      const tail = !r.enabled ? "Paused" : at !== null ? `next ${untilLabel(at, now)}` : ""
      return [triggersLine(ts), tail].filter(Boolean).join(" · ")
    },
    [failed, triggers, now]
  )

  const lastResult = React.useCallback(
    (r: Routine) => {
      if (failed[r.id]?.runs) return unread
      const last: RoutineRun | null | undefined = latest[r.id]
      if (last === undefined) return <Skeleton className="h-4 w-24" />
      if (last === null) return <span className="text-xs text-muted-foreground">Never run</span>
      const tone = runStatus(last.status)
      return (
        <span className="inline-flex items-center gap-2" title={tone.meaning}>
          <StatusBadge tone={tone.badge}>{tone.label}</StatusBadge>
          <span className="text-xs text-muted-foreground" title={new Date(last.startedAt).toLocaleString()}>
            {shortAge(last.startedAt, now)}
          </span>
        </span>
      )
    },
    [failed, latest, now]
  )

  const enabledSwitch = React.useCallback(
    (r: Routine) => (
      <Switch
        checked={r.enabled}
        onCheckedChange={(on) => toggle(r, on)}
        aria-label={r.enabled ? `Pause ${r.name}` : `Resume ${r.name}`}
      />
    ),
    [toggle]
  )

  const markOf = React.useCallback(
    (r: Routine) => (
      <span className={cn("inline-flex", !r.enabled && "opacity-50")}>
        {r.runsIn === "session" ? (
          <MessagesSquareIcon className="size-4" />
        ) : (
          <ProjectIcon project={projects.find((p) => p.id === r.projectId)} className="size-4" />
        )}
      </span>
    ),
    [projects]
  )

  const columns = React.useMemo<ListColumn<Routine>[]>(
    () => [
      {
        id: "name",
        header: "Automation",
        title: true,
        cell: (r) => (
          <TitleCell
            title={
              <span className="inline-flex min-w-0 max-w-full items-center gap-2">
                <span className={r.enabled ? "truncate" : "truncate text-muted-foreground"}>{r.name}</span>
                {r.body.kind === "workflow" && (
                  <WorkflowIcon className="size-3.5 shrink-0 text-muted-foreground" aria-label="Runs a workflow" />
                )}
              </span>
            }
            subtitle={subtitleOf(r)}
          />
        ),
      },
      {
        id: "runs-in",
        header: "Runs in",
        secondary: true,
        width: "w-48",
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
        id: "next",
        header: "Next run",
        width: "w-24 whitespace-nowrap",
        cell: (r) => {
          if (failed[r.id]?.triggers) return unread
          const ts = triggers[r.id]
          if (ts === undefined) return <Skeleton className="h-4 w-16" />
          const at = r.enabled ? nextFireOf(ts) : null
          return at === null ? (
            <span className="text-xs text-muted-foreground">{r.enabled ? "—" : "Paused"}</span>
          ) : (
            <span className="text-sm" title={new Date(at).toLocaleString()}>
              {untilLabel(at, now)}
            </span>
          )
        },
      },
      { id: "last", header: "Last result", align: "end", width: "w-44", cell: lastResult },
      {
        id: "enabled",
        header: "On",
        align: "end",
        width: "w-16",
        cell: (r) => (
          /* A switch in a clickable row: the click must not also open the row. */
          <span className="inline-flex" onClick={(event) => event.stopPropagation()}>
            {enabledSwitch(r)}
          </span>
        ),
      },
    ],
    [failed, triggers, now, projects, projectName, sessions, subtitleOf, lastResult, enabledSwitch]
  )

  const renderCard = React.useCallback(
    (r: Routine) => (
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          {markOf(r)}
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className={cn("truncate text-sm font-medium", !r.enabled && "text-muted-foreground")}>{r.name}</span>
            {r.body.kind === "workflow" && (
              <WorkflowIcon className="size-3.5 shrink-0 text-muted-foreground" aria-label="Runs a workflow" />
            )}
            {needsYou(r) && <StatusBadge tone="warn">Needs you</StatusBadge>}
          </div>
          <div className="truncate text-xs text-muted-foreground">{subtitleOf(r)}</div>
          <div className="flex min-w-0 items-center">{lastResult(r)}</div>
        </div>
        <span className="inline-flex shrink-0 pointer-coarse:p-2" onClick={(event) => event.stopPropagation()}>
          {enabledSwitch(r)}
        </span>
      </div>
    ),
    [markOf, needsYou, subtitleOf, lastResult, enabledSwitch]
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
      { id: "pause", label: "Pause", icon: <PauseIcon />, hidden: (r) => !r.enabled, onClick: (r) => toggle(r, false) },
      { id: "resume", label: "Resume", icon: <PlayCircleIcon />, hidden: (r) => r.enabled, onClick: (r) => toggle(r, true) },
      {
        id: "edit",
        label: "Edit settings",
        icon: <PencilIcon />,
        onClick: (r) => void navigate(`${automationPath(r.id)}?tab=settings`),
      },
      { id: "duplicate", label: "Duplicate", icon: <CopyIcon />, onClick: duplicate },
      { id: "delete", label: "Delete", icon: <Trash2Icon />, tone: "danger", onClick: (r) => void remove(r) },
    ],
    [fire, toggle, duplicate, remove, latest, navigate]
  )

  const stats = [
    {
      label: "Active",
      value: enabled,
      loading: pending,
      hint: enabled === automations.length ? "all on" : `${automations.length - enabled} paused`,
    },
    {
      label: "Next run",
      value: soonest ? untilLabel(soonest.at, now) : "—",
      loading: pending,
      hint: soonest ? soonest.name : "nothing armed",
    },
    { label: "Running now", value: runningNow, loading: pending, hint: "in progress" },
    {
      label: "Need you",
      value: attention,
      loading: pending,
      tone: attention > 0 ? ("warn" as const) : undefined,
      hint: "blocked or failed",
    },
  ]

  return (
    <>
      <SurfaceHeader
        title="Automations"
        description="Prompts that run on their own: on a clock, a webhook or a commit, each run a real thread."
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
          {readError && (
            <Section>
              <ErrorNote error={readError} onRetry={retryReads} />
            </Section>
          )}
          <Section>
            <SettingsList
              columns={columns}
              rows={automations}
              rowId={(r) => r.id}
              loading={pending}
              actions={actions}
              onRowClick={(r) => void navigate(automationPath(r.id))}
              mark={markOf}
              renderCard={renderCard}
              fields={[
                { id: "state", label: "State", of: stateOf },
                { id: "runs-in", label: "Runs in", of: (r) => (r.runsIn === "session" ? "This thread" : r.continueThread ? "Same thread" : "New thread") },
                { id: "project", label: "Project", of: projectName },
              ]}
              search={{
                placeholder: "Filter by name, description, project or trigger",
                matches: (r, needle) =>
                  r.name.toLowerCase().includes(needle) ||
                  (r.description ?? "").toLowerCase().includes(needle) ||
                  projectName(r).toLowerCase().includes(needle) ||
                  triggersLine(triggers[r.id]).toLowerCase().includes(needle),
              }}
            />
          </Section>
        </>
      )}
    </>
  )
}
