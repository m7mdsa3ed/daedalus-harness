/* ── /routines — the automation surface ──
   One route element, three faces picked from the path the way `SchedulePage`
   does it: `/routines` is the list, `/routines/new` the creation form, and
   `/routines/<id>` one routine — its runs, its triggers and its form on the
   same page, because those three are not separate concerns to the person
   looking at them. "Is it firing", "what did it decide" and "what is it allowed
   to do" get asked in one sitting, and a routine split across three screens is
   one whose autonomy you check somewhere other than where you set it. The
   detail page is *tabbed* rather than stacked, but one URL still holds all of
   it: `?tab=` picks what is in front, and a link to a routine lands on the
   overview, which says a little of each.

   Two reads are the page's own and nobody else's. The list page reads the
   newest run of every routine (one small request each, on the visit, never on
   a timer) so a row can say what happened last; the detail page reads the
   whole run list and the triggers. `useRoutines()` itself is loaded at boot
   and the sidebar reads it for free.

   Routines are outside /settings on purpose (see lib/router.tsx): settings is
   for things configured once, and a routine accumulates a history. */
import * as React from "react"
import {
  ActivityIcon,
  BotIcon,
  CalendarClockIcon,
  ChevronRightIcon,
  CoinsIcon,
  HistoryIcon,
  MoreVerticalIcon,
  PlayIcon,
  PlusIcon,
  PowerIcon,
  PowerOffIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  Trash2Icon,
  WorkflowIcon,
  ZapIcon,
} from "lucide-react"
import { useQueries } from "@tanstack/react-query"
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router"

import { useConfirm } from "@/components/confirm-dialog"
import { AgentIcon, ProfileIcon, ProjectIcon } from "@/components/entity-icon"
import { ErrorNote } from "@/components/error-note"
import { Notice } from "@/components/notice"
import { MetaFact, SurfaceHeader } from "@/components/page-primitives"
import { SettingsList, type ListAction, type ListColumn } from "@/components/settings/list"
import {
  EmptyCard,
  FormPageHeader,
  Group,
  Row,
  Section,
  StatStrip,
  StatusBadge,
  TabBar,
  type TabItem,
} from "@/components/settings/primitives"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import {
  blankDraft,
  draftOf,
  problemNote,
  RoutineForm,
  toInput,
  type RoutineDraft,
} from "@/components/routines/routine-form"
import { RunList } from "@/components/routines/runs"
import { RUN_STATUS, SOURCE_LABEL, runStatus } from "@/components/routines/status"
import { TriggersPanel } from "@/components/routines/triggers"
import { nextFireOf, TRIGGER_KIND, triggerTerms, untilLabel } from "@/components/routines/trigger-summary"
import type { Actions } from "@/lib/actions"
import { captureError, reportError, type InlineError } from "@/lib/errors"
import { newRoutinePath, routinePath, routinesPath, threadPath } from "@/lib/router"
import { api, profileSupports, type Routine, type RoutineRun } from "@/lib/settings"
import { useServer } from "@/lib/server-context"
import { routineRunsKey } from "@/lib/queries/keys"
import { useAgents, useProfiles, useProjects } from "@/lib/queries/catalog"
import {
  useCancelRoutineRun,
  useCreateRoutine,
  useDeleteRoutine,
  useRoutineRuns,
  useRoutineTriggers,
  useRoutines,
  useRunRoutine,
  useUpdateRoutine,
} from "@/lib/queries/routines"
import { shortAge } from "@/lib/time"
import { toast } from "@/lib/toast"

export function RoutinesPage({ actions }: { actions: Actions }) {
  const location = useLocation()
  const params = useParams()
  if (location.pathname.endsWith("/new")) return <NewRoutinePage actions={actions} />
  if (params.routineId)
    return <RoutineDetailPage key={params.routineId} routineId={params.routineId} actions={actions} />
  return <RoutinesListPage />
}

/* ── Shared readings ── */

/** How many kinds of tool this routine answers with `allow`. Zero means it
    asks a person for everything. */
const grantsOf = (routine: Routine) =>
  Object.values(routine.autonomy.permissions).filter((s) => s === "allow").length

/** Fire a routine by hand, as a toast-reporting callback both pages share.
    `dryRun` forces every question back to "ask" for this one run whatever the
    policy says — which is the run that clears the blanket grant's gate. */
function useFire() {
  const runRoutine = useRunRoutine()
  return React.useCallback(
    async (routine: Routine, dryRun: boolean) => {
      try {
        const started = await runRoutine.mutateAsync({ id: routine.id, dryRun })
        toast.success(dryRun ? "Dry run started — it will ask you for everything" : "Run started", {
          description: started.status === "skipped" ? (started.error ?? "Skipped") : undefined,
        })
      } catch (err) {
        reportError(err, "Couldn't start the run")
      }
    },
    [runRoutine]
  )
}

function useToggle() {
  const updateRoutine = useUpdateRoutine()
  return React.useCallback(
    (routine: Routine, enabled: boolean) =>
      updateRoutine.mutate(
        { id: routine.id, patch: { enabled } },
        {
          onSuccess: () => toast.success(enabled ? "Routine enabled" : "Routine disabled"),
          onError: (err) => reportError(err, "Couldn't update the routine"),
        }
      ),
    [updateRoutine]
  )
}

function useRemove() {
  const deleteRoutine = useDeleteRoutine()
  const confirm = useConfirm()
  return React.useCallback(
    async (routine: Routine): Promise<boolean> => {
      if (
        !(await confirm({
          title: `Delete “${routine.name}”?`,
          description:
            "The routine, its triggers and its whole run history go with it. The threads its runs created are untouched — they are ordinary threads and stay where they are.",
          destructive: true,
          confirmLabel: "Delete routine",
        }))
      )
        return false
      try {
        await deleteRoutine.mutateAsync(routine.id)
        toast.success("Routine deleted")
        return true
      } catch (err) {
        reportError(err, "Couldn't delete the routine")
        return false
      }
    },
    [confirm, deleteRoutine]
  )
}

/* ── The list ── */

function RoutinesListPage() {
  const routinesQuery = useRoutines()
  const routines = React.useMemo(() => routinesQuery.data ?? [], [routinesQuery.data])
  const projects = useProjects()
  const agents = useAgents()
  const navigate = useNavigate()
  const fire = useFire()
  const toggle = useToggle()
  const remove = useRemove()

  /* The newest run of each routine — the one read this page owns. Held in one
     map here rather than in each row so the stats can count across them. */
  const latest = useLatestRuns(routines)

  const enabled = routines.filter((r) => r.enabled).length
  const acting = routines.filter((r) => grantsOf(r) > 0).length
  const runningNow = routines.filter((r) => latest[r.id]?.status === "running").length
  const attention = routines.filter((r) => {
    const s = latest[r.id]?.status
    return s === "blocked" || s === "failed"
  }).length
  const lastFired = Object.values(latest).reduce<RoutineRun | null>(
    (best, run) => (run && (!best || run.startedAt > best.startedAt) ? run : best),
    null
  )

  const newRoutine = () => void navigate(newRoutinePath())
  const open = (routine: Routine) => void navigate(routinePath(routine.id))
  const pending = routinesQuery.isPending
  const skeleton = <Skeleton className="h-7 w-16" />

  /* Rows are flat, with the project as a column and a filter on it: a routine
     whose project is gone is worth seeing, so it reads "Project missing"
     rather than dropping out. */
  const columns = React.useMemo<ListColumn<Routine>[]>(
    () => [
      {
        id: "routine",
        header: "Routine",
        title: true,
        cell: (routine) => (
          <span className="inline-flex min-w-0 items-center gap-2">
            <span className={routine.enabled ? "truncate" : "truncate text-muted-foreground"}>{routine.name}</span>
            {routine.body.kind === "workflow" && (
              <WorkflowIcon className="size-3.5 shrink-0 text-muted-foreground" aria-label="Runs a workflow" />
            )}
            {!routine.enabled && <StatusBadge dot={false}>Disabled</StatusBadge>}
          </span>
        ),
      },
      {
        /* What happened last — a dot, a word and an age. Skeletoned until the
           read lands; "never run" once it has and there is nothing. */
        id: "last",
        header: "Last run",
        align: "end",
        width: "w-48",
        cell: (routine) => {
          const last = latest[routine.id]
          if (last === undefined) return <Skeleton className="h-4 w-24" />
          if (last === null) return <span className="text-xs text-muted-foreground/70">Never run</span>
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
        id: "agent",
        header: "Agent",
        cell: (routine) => (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <AgentIcon agentId={routine.agentId} className="size-3.5 shrink-0" />
            <span className="truncate">
              {agents.find((a) => a.id === routine.agentId)?.name ?? routine.agentId}
              {routine.model && ` · ${routine.model}`}
              {routine.description && ` · ${routine.description}`}
            </span>
          </span>
        ),
      },
      {
        id: "project",
        header: "Project",
        secondary: true,
        cell: (routine) => {
          const project = projects.find((p) => p.id === routine.projectId)
          return (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <ProjectIcon project={project} className="size-3.5 shrink-0" />
              <span className="truncate">{project?.name ?? "Project missing"}</span>
            </span>
          )
        },
      },
      {
        /* How much this routine decides on its own. Two states only — it
           either answers something with `allow` or it does not — because the
           row is a place to notice, not a place to audit; the form is where
           the ten kinds are read one at a time. */
        id: "autonomy",
        header: "Autonomy",
        secondary: true,
        cell: (routine) => {
          const grants = grantsOf(routine)
          return grants === 0 ? (
            <StatusBadge>Asks for everything</StatusBadge>
          ) : (
            <StatusBadge tone="warn">
              Acts without asking · {grants} kind{grants === 1 ? "" : "s"}
            </StatusBadge>
          )
        },
      },
    ],
    [latest, agents, projects]
  )

  const actions = React.useMemo<ListAction<Routine>[]>(
    () => [
      { id: "run", label: "Run now", icon: <PlayIcon />, position: "left", onClick: (r) => void fire(r, false) },
      {
        id: "dry",
        label: "Run now, forced to ask",
        icon: <ShieldCheckIcon />,
        position: "left",
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
      {
        id: "disable",
        label: "Disable routine",
        icon: <PowerOffIcon />,
        hidden: (r) => !r.enabled,
        onClick: (r) => toggle(r, false),
      },
      {
        id: "enable",
        label: "Enable routine",
        icon: <PowerIcon />,
        hidden: (r) => r.enabled,
        onClick: (r) => toggle(r, true),
      },
      { id: "delete", label: "Delete", icon: <Trash2Icon />, tone: "danger", onClick: (r) => void remove(r) },
    ],
    [fire, toggle, remove, latest, navigate]
  )

  const stats = [
    {
      label: "Routines",
      value: pending ? skeleton : routines.length,
      hint: enabled === routines.length ? "all enabled" : `${routines.length - enabled} disabled`,
    },
    {
      label: "Running now",
      value: pending ? skeleton : runningNow,
      hint: runningNow === 1 ? "run in progress" : "runs in progress",
    },
    {
      label: "Need a person",
      value: pending ? skeleton : attention,
      tone: attention > 0 ? ("warn" as const) : undefined,
      hint:
        attention > 0
          ? "last run blocked or failed"
          : acting > 0
            ? `${acting} act${acting === 1 ? "s" : ""} without asking`
            : "every routine asks for everything",
    },
    {
      label: "Last fired",
      value: pending ? skeleton : lastFired ? shortAge(lastFired.startedAt) : "—",
      hint: lastFired
        ? `${routines.find((r) => r.id === lastFired.routineId)?.name ?? "a routine"} · ${runStatus(lastFired.status).label.toLowerCase()}`
        : "nothing has run yet",
    },
  ]

  return (
    <>
      <SurfaceHeader
        title="Routines"
        description="Saved thread-starts that fire on their own — on a clock, a webhook or a commit. Each run is a real thread with its own transcript, and each routine decides in advance which of the agent's questions it answers for you."
        onBack={() => void navigate("/")}
        actions={
          <Button onClick={newRoutine}>
            <PlusIcon data-icon="inline-start" />
            New routine
          </Button>
        }
      />

      {routinesQuery.error && (
        <ErrorNote
          error={captureError(routinesQuery.error, "Couldn't read the routines")}
          onRetry={() => void routinesQuery.refetch()}
        />
      )}

      {routines.length === 0 && !pending ? (
        <EmptyCard
          icon={ZapIcon}
          text="No routines yet. A routine starts a thread the way you would, then answers for you while it runs."
          action={
            <Button size="sm" onClick={newRoutine}>
              <PlusIcon data-icon="inline-start" />
              New routine
            </Button>
          }
        />
      ) : (
        <>
          <StatStrip stats={stats} />
          <SettingsList
            columns={columns}
            rows={routines}
            rowId={(routine) => routine.id}
            loading={pending}
            actions={actions}
            onRowClick={open}
            search={{
              placeholder: "Filter by name, description or project",
              matches: (r, needle) =>
                r.name.toLowerCase().includes(needle) ||
                (r.description ?? "").toLowerCase().includes(needle) ||
                (projects.find((p) => p.id === r.projectId)?.name ?? "").toLowerCase().includes(needle),
            }}
          />
        </>
      )}
    </>
  )
}

/** The newest run of every routine in the list, keyed by routine id. One
    `limit=1` read per routine, on the visit; a fire or a stop invalidates the
    whole family (`routineRunsFamilyKey`) so a row moves with the routine's own
    page. `undefined` for a routine whose read has not landed, `null` for one
    that has never run. */
function useLatestRuns(routines: Routine[]): Record<string, RoutineRun | null | undefined> {
  const settings = useServer()
  const results = useQueries({
    queries: routines.map((r) => ({
      queryKey: routineRunsKey(settings, r.id, 1),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api<RoutineRun[]>(settings, `/api/routines/${encodeURIComponent(r.id)}/runs?limit=1`, { signal }),
    })),
  })
  const out: Record<string, RoutineRun | null | undefined> = {}
  routines.forEach((r, i) => {
    const data = results[i]?.data
    out[r.id] = data === undefined ? undefined : (data[0] ?? null)
  })
  return out
}

/* ── Creation ── */

function NewRoutinePage({ actions }: { actions: Actions }) {
  const createRoutine = useCreateRoutine()
  const profiles = useProfiles()
  const projects = useProjects()
  const agents = useAgents()
  const navigate = useNavigate()
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<InlineError | null>(null)

  /* Seeded from whatever is first and coherent, never from the remembered
     thread defaults: a routine is set up deliberately and the pickers below are
     right there, where a thread's defaults exist because opening a new thread
     should cost no decisions. */
  const [draft, setDraft] = React.useState<RoutineDraft>(() => {
    const project = projects[0]
    const agent = agents[0]
    const profile = agent
      ? profiles.find((p) => profileSupports(p, agent.id) && !p.hidden && !p.disabled)
      : undefined
    return blankDraft({
      projectId: project?.id ?? "",
      agentId: agent?.id ?? "",
      profileId: profile?.id ?? "",
    })
  })

  const back = () => void navigate(routinesPath())

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy) return
    const parsed = toInput(draft)
    if ("problem" in parsed) {
      setError(problemNote(parsed.problem))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const routine = await createRoutine.mutateAsync(parsed.input)
      toast.success("Routine created")
      // Straight to its triggers: a routine with no trigger is one that only
      // ever fires by hand, and the overview would say so in a smaller voice.
      void navigate(`${routinePath(routine.id)}?tab=triggers`)
    } catch (err) {
      setError(captureError(err, "Couldn't create the routine"))
      setBusy(false)
    }
  }

  if (projects.length === 0 || agents.length === 0) {
    return (
      <>
        <FormPageHeader title="New routine" description="" onBack={back} />
        <EmptyCard
          icon={BotIcon}
          text="A routine needs a project to run in and an agent to run it. Add those in Settings first."
        />
      </>
    )
  }

  return (
    <>
      <FormPageHeader
        title="New routine"
        description="It starts a thread exactly as the composer would — same agent, profile, model and tools — and then answers the agent's questions using the policy you set below."
        onBack={back}
      />
      <RoutineForm
        draft={draft}
        onChange={setDraft}
        actions={actions}
        onSubmit={submit}
        onCancel={back}
        busy={busy}
        error={error}
        submitLabel="Create routine"
      />
    </>
  )
}

/* ── One routine ── */

const TABS = ["overview", "runs", "triggers", "settings"] as const
type Tab = (typeof TABS)[number]
const isTab = (v: string | null): v is Tab => TABS.includes(v as Tab)
const TAB_LABEL: Record<Tab, string> = {
  overview: "Overview",
  runs: "Runs",
  triggers: "Triggers",
  settings: "Settings",
}

function RoutineDetailPage({
  routineId,
  actions,
}: {
  routineId: string
  actions: Actions
}) {
  const routines = useRoutines().data
  const projects = useProjects()
  const agents = useAgents()
  const profiles = useProfiles()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const routine = routines?.find((r) => r.id === routineId)

  /* The runs read lives in the cache; the query fetches on mount and the
     mutations (run, cancel) invalidate it, which is the refresh. A failed
     read leaves `data` undefined — skeletons, not "has never run" — and the
     error note says the request failed. Triggers are the same: read here, on
     this page, and by nothing else. */
  const runsQuery = useRoutineRuns(routineId)
  const runs = runsQuery.data
  const runsError = runsQuery.error ? captureError(runsQuery.error, "Couldn't read this routine's runs") : null
  const triggersQuery = useRoutineTriggers(routineId)
  const triggers = triggersQuery.data
  const cancelRoutineRun = useCancelRoutineRun()
  const updateRoutine = useUpdateRoutine()
  const fire = useFire()
  const toggle = useToggle()
  const remove = useRemove()

  const tab: Tab = isTab(params.get("tab")) ? (params.get("tab") as Tab) : "overview"
  const setTab = (next: Tab) =>
    setParams(
      (prev) => {
        const out = new URLSearchParams(prev)
        if (next === "overview") out.delete("tab")
        else out.set("tab", next)
        return out
      },
      { replace: true }
    )

  const [draft, setDraft] = React.useState<RoutineDraft | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<InlineError | null>(null)
  const [firing, setFiring] = React.useState(false)

  /* Reset the form when the routine arrives or is replaced by a save. The
     dependency is the row itself, so a save's answer (a new object) re-seeds
     the fields with what the server actually stored — including the fields it
     normalized — rather than leaving the form's own guess on screen. */
  React.useEffect(() => {
    if (routine) setDraft(draftOf(routine))
  }, [routine])

  const back = () => void navigate(routinesPath())

  if (!routine)
    return (
      <>
        <FormPageHeader title="Routine" description="" onBack={back} />
        <EmptyCard icon={ZapIcon} text="This routine no longer exists." />
      </>
    )

  const project = projects.find((p) => p.id === routine.projectId)
  const agent = agents.find((a) => a.id === routine.agentId)
  const profile = profiles.find((p) => p.id === routine.profileId)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy || !draft) return
    const parsed = toInput(draft)
    if ("problem" in parsed) {
      setError(problemNote(parsed.problem))
      return
    }
    setBusy(true)
    setError(null)
    try {
      await updateRoutine.mutateAsync({ id: routine.id, patch: parsed.input })
      toast.success("Routine saved")
    } catch (err) {
      setError(captureError(err, "Couldn't save the routine"))
    } finally {
      setBusy(false)
    }
  }

  const run = async (dryRun: boolean) => {
    if (firing) return
    setFiring(true)
    try {
      await fire(routine, dryRun)
      setTab("runs")
    } finally {
      setFiring(false)
    }
  }

  /* The numbers. Counted over what the page has read, which is the server's
     newest 50 — a routine that has run more than that says "50+" rather than
     a total it does not know. */
  const last = runs?.[0] ?? null
  const running = runs?.filter((r) => r.status === "running").length ?? 0
  const tokens = runs?.reduce((sum, r) => sum + (r.tokens ?? 0), 0)
  const outcomes = runs
    ? {
        completed: runs.filter((r) => r.status === "completed").length,
        failed: runs.filter((r) => r.status === "failed" || r.status === "blocked").length,
        skipped: runs.filter((r) => r.status === "skipped").length,
      }
    : null
  const nextFire = nextFireOf(triggers)
  const armed = triggers?.filter((t) => t.enabled) ?? []
  const grants = grantsOf(routine)

  const statTone = (status: string) => {
    const badge = runStatus(status).badge
    return badge === "bad" || badge === "warn" ? badge : undefined
  }
  const loadingRuns = runs === undefined && !runsError
  const skeleton = <Skeleton className="h-7 w-16" />
  const stats = [
    {
      label: "Last run",
      value: loadingRuns ? skeleton : last ? runStatus(last.status).label : "—",
      tone: last ? statTone(last.status) : undefined,
      hint: last
        ? `${shortAge(last.startedAt)} ago · ${SOURCE_LABEL[last.source] ?? last.source}`
        : runsError
          ? "couldn't read the runs"
          : "has not run yet",
    },
    {
      label: "Next fire",
      value: triggers === undefined && !triggersQuery.error ? skeleton : nextFire ? untilLabel(nextFire) : "—",
      hint: nextFire
        ? new Date(nextFire).toLocaleString()
        : !routine.enabled
          ? "the routine is disabled"
          : armed.length === 0
            ? "no trigger is armed — fires by hand only"
            : armed.some((t) => t.kind !== "schedule")
              ? "waits on a webhook or a commit"
              : "the sweep has not armed a clock yet",
    },
    {
      label: "Runs",
      value: loadingRuns ? skeleton : runs ? (runs.length >= 50 ? "50+" : runs.length) : "—",
      hint:
        running > 0
          ? `${running} running now`
          : outcomes
            ? `${outcomes.completed} completed · ${outcomes.failed} needed a person · ${outcomes.skipped} skipped`
            : "not read",
    },
    {
      label: "Tokens",
      value: loadingRuns ? skeleton : tokens === undefined ? "—" : tokens.toLocaleString(),
      hint: runs && runs.length >= 50 ? "across the newest 50 runs" : "across every run",
    },
  ]

  const tabItems: TabItem[] = [
    { id: "overview", label: TAB_LABEL.overview },
    { id: "runs", label: TAB_LABEL.runs, count: running > 0 ? running : undefined },
    {
      id: "triggers",
      label: TAB_LABEL.triggers,
      count: triggers && triggers.length > 0 ? triggers.length : undefined,
    },
    { id: "settings", label: TAB_LABEL.settings },
  ]

  const cancelRun = async (runId: string) => cancelRoutineRun.mutate({ routineId: routine.id, runId })

  return (
    <>
      <SurfaceHeader
        flush
        onBack={back}
        icon={<ProjectIcon project={project} className="size-11" />}
        title={
          <span className="inline-flex min-w-0 items-center gap-2">
            <span className="truncate">{routine.name}</span>
            {!routine.enabled && <StatusBadge dot={false}>Disabled</StatusBadge>}
          </span>
        }
        description={routine.description ?? undefined}
        meta={
          <>
            <MetaFact title="Project">
              <ProjectIcon project={project} className="size-3.5" />
              {project?.name ?? "Project missing"}
            </MetaFact>
            <MetaFact title="Agent">
              <AgentIcon agentId={routine.agentId} className="size-3.5" />
              {agent?.name ?? routine.agentId}
            </MetaFact>
            <MetaFact title="Profile">
              <ProfileIcon profile={profile} agentId={routine.agentId} className="size-3.5" />
              {profile?.name ?? routine.profileId}
            </MetaFact>
            {routine.model && <MetaFact title="Model">{routine.model}{routine.effort && ` · ${routine.effort}`}</MetaFact>}
            <span title="Autonomy">
              <StatusBadge tone={grants > 0 ? "warn" : "neutral"}>
                {grants > 0
                  ? `Acts without asking for ${grants} kind${grants === 1 ? "" : "s"} of tool`
                  : "Asks a person for everything"}
              </StatusBadge>
            </span>
          </>
        }
        actions={
          <>
            <div className="mr-1 flex items-center gap-2 text-xs text-muted-foreground">
              <Switch
                checked={routine.enabled}
                onCheckedChange={(enabled) => toggle(routine, enabled)}
                aria-label={routine.enabled ? "Disable routine" : "Enable routine"}
              />
              {routine.enabled ? "Enabled" : "Disabled"}
            </div>
            {/* The dry run is the first-class one and reads that way: it is
                what a person should press before granting anything, and the
                plain run is the one that behaves like the routine actually
                will. */}
            <Button variant="outline" disabled={firing} onClick={() => void run(true)}>
              <ShieldCheckIcon data-icon="inline-start" />
              Run, forced to ask
            </Button>
            <Button disabled={firing} onClick={() => void run(false)}>
              <PlayIcon data-icon="inline-start" />
              Run now
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="ghost" size="icon" title="More">
                    <MoreVerticalIcon />
                    <span className="sr-only">More actions</span>
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="w-52">
                {last?.sessionId && (
                  <DropdownMenuItem onClick={() => void navigate(threadPath(last.sessionId!))}>
                    <HistoryIcon />
                    Open last run's thread
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => {
                    void remove(routine).then((gone) => gone && back())
                  }}
                >
                  <Trash2Icon />
                  Delete routine
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <TabBar
        label="Routine"
        items={tabItems}
        value={tab}
        onChange={(id) => setTab(id as Tab)}
      />

      {tab !== "settings" && <StatStrip stats={stats} />}

      {!routine.dryRunCompleted && (
        <Notice className="mb-8">
          This routine has not completed a run yet, so it cannot be granted a blanket{" "}
          <strong className="font-medium text-foreground">Allow</strong>. Press{" "}
          <strong className="font-medium text-foreground">Run, forced to ask</strong> and watch
          what it does first — the per-kind answers in Settings are available either way.
        </Notice>
      )}

      <div role="tabpanel" aria-label={TAB_LABEL[tab]}>
        {tab === "overview" && (
          <>
            <Section
              label="Recent runs"
              action={
                runs && runs.length > 5 ? (
                  <Button variant="ghost" size="xs" onClick={() => setTab("runs")}>
                    All runs
                    <ChevronRightIcon data-icon="inline-end" />
                  </Button>
                ) : undefined
              }
            >
              <ErrorNote error={runsError} onRetry={() => void runsQuery.refetch()} />
              {runsError ? null : (
                <RunList
                  runs={runs?.slice(0, 5)}
                  hasOutputSchema={routine.output !== null}
                  onCancel={cancelRun}
                />
              )}
            </Section>

            <Group label={routine.body.kind === "workflow" ? "What it runs" : "What it asks"}>
              {routine.body.kind === "prompt" ? (
                <p className="max-h-64 overflow-y-auto py-3 text-sm whitespace-pre-wrap text-pretty">
                  {routine.body.text}
                </p>
              ) : (
                <p className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
                  <WorkflowIcon className="size-4" />
                  A declarative workflow, {Object.keys(routine.body.definition).length} top-level keys.
                  Open Settings to read it.
                </p>
              )}
            </Group>

            {(() => {
              const manage = (
                <Button variant="ghost" size="xs" onClick={() => setTab("triggers")}>
                  Manage
                  <ChevronRightIcon data-icon="inline-end" />
                </Button>
              )
              if (triggers !== undefined && triggers.length > 0 && !triggersQuery.error)
                return (
                  <Group label="Triggers" action={manage}>
                    {triggers.map((t) => {
                      const meta = TRIGGER_KIND[t.kind]
                      return (
                        <Row
                          key={t.id}
                          icon={<meta.icon className="size-4 text-muted-foreground" />}
                          title={
                            <>
                              {meta.label}
                              {!t.enabled && " · off"}
                            </>
                          }
                          subtitle={
                            <>
                              <span className="block truncate">{triggerTerms(t)}</span>
                              {t.enabled && t.nextFireAt !== null && (
                                <span className="block" title={new Date(t.nextFireAt).toLocaleString()}>
                                  Fires {untilLabel(t.nextFireAt)}
                                </span>
                              )}
                              {t.lastError && (
                                <StatusBadge tone="warn" dot={false}>
                                  {t.lastError}
                                </StatusBadge>
                              )}
                            </>
                          }
                        />
                      )
                    })}
                  </Group>
                )
              return (
                <Section label="Triggers" action={manage}>
                  {triggersQuery.error ? (
                    <ErrorNote
                      error={captureError(triggersQuery.error, "Couldn't read the triggers")}
                      onRetry={() => void triggersQuery.refetch()}
                    />
                  ) : triggers === undefined ? (
                    <div className="space-y-2">
                      <Skeleton className="h-10 w-full rounded-lg" />
                      <Skeleton className="h-10 w-full rounded-lg" />
                    </div>
                  ) : (
                    <EmptyCard icon={CalendarClockIcon} text="No triggers. This routine only fires when you press Run." />
                  )}
                </Section>
              )
            })()}

            <Group label="Policy">
              <Row title="Default">
                <span className="text-sm capitalize">{routine.autonomy.permissions.default}</span>
              </Row>
              <Row title="Questions">
                <span className="text-sm">
                  {routine.autonomy.elicitations === "ask" ? "Wait for a person" : "Decline and carry on"}
                </span>
              </Row>
              <Row title="Unanswered">
                <span className="text-sm">
                  {routine.autonomy.askTimeoutSeconds > 0
                    ? `${routine.autonomy.askFallback === "deny" ? "Denied" : "Cancelled"} after ${Math.round(routine.autonomy.askTimeoutSeconds / 60)} min`
                    : "Waits forever"}
                </span>
              </Row>
              <Row title="Ceiling">
                <span className="text-sm">
                  {routine.autonomy.maxRunSeconds > 0 ? `${Math.round(routine.autonomy.maxRunSeconds / 60)} min` : "none"}
                  {routine.autonomy.maxRunTokens ? ` · ${routine.autonomy.maxRunTokens.toLocaleString()} tokens` : ""}
                </span>
              </Row>
              <Row title="Overlap">
                <span className="text-sm">
                  {routine.overlap === "skip" ? "Skip while one is running" : "Queue behind it"}
                </span>
              </Row>
              <Row title="On finish">
                <span className="text-sm">
                  {routine.onFinish.length === 0 ? "nothing" : routine.onFinish.map((a) => a.kind).join(", ")}
                </span>
              </Row>
            </Group>
          </>
        )}

        {tab === "runs" && (
          <Section
            hint={`Newest first. ${Object.values(RUN_STATUS).map((s) => s.label).join(", ")} — each row says what its word means.`}
          >
            <ErrorNote error={runsError} onRetry={() => void runsQuery.refetch()} />
            {runsError ? null : (
              <RunList runs={runs} hasOutputSchema={routine.output !== null} onCancel={cancelRun} />
            )}
          </Section>
        )}

        {tab === "triggers" && <TriggersPanel routineId={routine.id} />}

        {tab === "settings" && draft && (
          <RoutineForm
            draft={draft}
            onChange={setDraft}
            actions={actions}
            routine={routine}
            onSubmit={submit}
            onCancel={back}
            busy={busy}
            error={error}
            submitLabel="Save routine"
            sectionBar={false}
          />
        )}
      </div>
    </>
  )
}
