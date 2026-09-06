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
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UserRoundIcon,
  WorkflowIcon,
  ZapIcon,
} from "lucide-react"
import { useQueries } from "@tanstack/react-query"
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router"

import { useConfirm } from "@/components/confirm-dialog"
import { AgentIcon, ProfileIcon, ProjectIcon } from "@/components/entity-icon"
import { ErrorNote } from "@/components/error-note"
import { MetaFact, StatGrid, StatTile, SurfaceCard, SurfaceHeader } from "@/components/page-primitives"
import { EmptyCard, FormPageHeader } from "@/components/settings/primitives"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
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
import { useAgents, usePersonas, useProfiles, useProjects } from "@/lib/queries/catalog"
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
import { cn } from "@/lib/utils"

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
  const navigate = useNavigate()
  const [query, setQuery] = React.useState("")

  /* The newest run of each routine — the one read this page owns. Held in one
     map here rather than in each row so the tiles can count across them. */
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

  const needle = query.trim().toLowerCase()
  const shown = needle
    ? routines.filter(
        (r) =>
          r.name.toLowerCase().includes(needle) ||
          (r.description ?? "").toLowerCase().includes(needle) ||
          (projects.find((p) => p.id === r.projectId)?.name ?? "").toLowerCase().includes(needle)
      )
    : routines

  /* Grouped by project, in the projects' own order, with the ones whose
     project is gone at the end under their own heading — a routine that can
     no longer fire is worth seeing, not hiding. */
  const groups = React.useMemo(() => {
    const byProject = new Map<string, Routine[]>()
    for (const r of shown) byProject.set(r.projectId, [...(byProject.get(r.projectId) ?? []), r])
    const ordered = projects
      .filter((p) => byProject.has(p.id))
      .map((p) => ({ key: p.id, project: p, routines: byProject.get(p.id)! }))
    const orphaned = [...byProject.entries()]
      .filter(([id]) => !projects.some((p) => p.id === id))
      .map(([id, rs]) => ({ key: id, project: undefined, routines: rs }))
    return [...ordered, ...orphaned]
  }, [shown, projects])

  const newRoutine = () => void navigate(newRoutinePath())

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

      {routines.length === 0 && !routinesQuery.isPending ? (
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
          <StatGrid>
            <StatTile
              icon={ZapIcon}
              label="Routines"
              value={routines.length}
              loading={routinesQuery.isPending}
              hint={
                enabled === routines.length
                  ? "all enabled"
                  : `${routines.length - enabled} disabled`
              }
            />
            <StatTile
              icon={ActivityIcon}
              label="Running now"
              value={runningNow}
              loading={routinesQuery.isPending}
              hint={runningNow === 1 ? "run in progress" : "runs in progress"}
            />
            <StatTile
              icon={attention > 0 ? ShieldAlertIcon : ShieldCheckIcon}
              label="Need a person"
              value={attention}
              loading={routinesQuery.isPending}
              tone={attention > 0 ? "text-amber-600 dark:text-amber-400" : undefined}
              hint={
                attention > 0
                  ? "last run blocked or failed"
                  : acting > 0
                    ? `${acting} act${acting === 1 ? "s" : ""} without asking`
                    : "every routine asks for everything"
              }
            />
            <StatTile
              icon={HistoryIcon}
              label="Last fired"
              value={lastFired ? shortAge(lastFired.startedAt) : "—"}
              loading={routinesQuery.isPending}
              hint={
                lastFired
                  ? `${routines.find((r) => r.id === lastFired.routineId)?.name ?? "a routine"} · ${runStatus(lastFired.status).label.toLowerCase()}`
                  : "nothing has run yet"
              }
            />
          </StatGrid>

          {routines.length > 5 && (
            <div className="relative mt-4">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter by name, description or project"
                className="pl-9"
                aria-label="Filter routines"
              />
            </div>
          )}

          {shown.length === 0 && routines.length > 0 ? (
            <p className="mt-6 text-center text-sm text-muted-foreground">
              No routine matches “{query.trim()}”.
            </p>
          ) : (
            <div className="mt-4 space-y-4">
              {groups.map((group) => (
                <SurfaceCard
                  key={group.key}
                  title={
                    <span className="inline-flex items-center gap-1.5">
                      <ProjectIcon project={group.project} className="size-3.5" />
                      {group.project?.name ?? "Project missing"}
                    </span>
                  }
                >
                  <div className="divide-y">
                    {group.routines.map((routine) => (
                      <RoutineRow key={routine.id} routine={routine} last={latest[routine.id]} />
                    ))}
                  </div>
                </SurfaceCard>
              ))}
            </div>
          )}
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

function RoutineRow({ routine, last }: { routine: Routine; last: RoutineRun | null | undefined }) {
  const agents = useAgents()
  const navigate = useNavigate()
  const fire = useFire()
  const toggle = useToggle()
  const remove = useRemove()
  const agent = agents.find((a) => a.id === routine.agentId)
  const grants = grantsOf(routine)
  const tone = last ? runStatus(last.status) : null
  const open = () => void navigate(routinePath(routine.id))

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:flex-nowrap">
      <AutonomyMark grants={grants} />
      <button type="button" onClick={open} className="min-w-0 flex-1 text-left">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn("truncate text-sm font-medium", !routine.enabled && "text-muted-foreground")}>
            {routine.name}
          </span>
          {routine.body.kind === "workflow" && (
            <WorkflowIcon className="size-3.5 shrink-0 text-muted-foreground" aria-label="Runs a workflow" />
          )}
          {!routine.enabled && (
            <span className="rounded-pill bg-muted px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase text-muted-foreground">
              Disabled
            </span>
          )}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <AgentIcon agentId={routine.agentId} className="size-3.5 shrink-0" />
          <span className="truncate">
            {agent?.name ?? routine.agentId}
            {routine.model && ` · ${routine.model}`}
            {routine.description && ` · ${routine.description}`}
          </span>
        </div>
      </button>

      {/* What happened last — a dot, a word and an age. Skeletoned until the
          read lands; "never run" once it has and there is nothing. */}
      <div className="flex w-full shrink-0 items-center gap-2 text-xs sm:w-40 sm:justify-end">
        {last === undefined ? (
          <Skeleton className="h-4 w-24" />
        ) : last === null ? (
          <span className="text-muted-foreground/70">Never run</span>
        ) : (
          <>
            <span aria-hidden className={cn("size-2 shrink-0 rounded-full", tone!.dot)} />
            <span className={cn("truncate", tone!.text)} title={tone!.meaning}>
              {tone!.label}
            </span>
            <span className="text-muted-foreground" title={new Date(last.startedAt).toLocaleString()}>
              {shortAge(last.startedAt)}
            </span>
          </>
        )}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <Switch
          checked={routine.enabled}
          onCheckedChange={(enabled) => toggle(routine, enabled)}
          aria-label={routine.enabled ? "Disable routine" : "Enable routine"}
        />
        <Button variant="ghost" size="icon-sm" title="Run now" onClick={() => void fire(routine, false)}>
          <PlayIcon />
          <span className="sr-only">Run {routine.name} now</span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="icon-sm" title="More">
                <MoreVerticalIcon />
                <span className="sr-only">More actions for {routine.name}</span>
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onClick={open}>
              <PencilIcon />
              Open
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void fire(routine, true)}>
              <ShieldCheckIcon />
              Run now, forced to ask
            </DropdownMenuItem>
            {last?.sessionId && (
              <DropdownMenuItem onClick={() => void navigate(threadPath(last.sessionId!))}>
                <HistoryIcon />
                Open last run's thread
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => void remove(routine)}>
              <Trash2Icon />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

/** How much this routine decides on its own, as a mark on the row. Two states
    only — it either answers something with `allow` or it does not — because the
    row is a place to notice, not a place to audit; the form is where the ten
    kinds are read one at a time. */
function AutonomyMark({ grants }: { grants: number }) {
  if (grants === 0)
    return (
      <ShieldCheckIcon
        className="size-4 shrink-0 text-muted-foreground"
        aria-label="Asks a person for everything"
      />
    )
  return (
    <ShieldAlertIcon
      className="size-4 shrink-0 text-amber-600 dark:text-amber-400"
      aria-label={`Acts without asking for ${grants} kind${grants === 1 ? "" : "s"} of tool`}
    />
  )
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
    const profile = agent ? profiles.find((p) => profileSupports(p, agent.id)) : undefined
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
  const personas = usePersonas()
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
  const persona = routine.personaId ? personas.find((p) => p.id === routine.personaId) : undefined

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

  return (
    <>
      <SurfaceHeader
        onBack={back}
        icon={<ProjectIcon project={project} className="size-11" />}
        title={
          <span className="inline-flex min-w-0 items-center gap-2">
            <span className="truncate">{routine.name}</span>
            {!routine.enabled && (
              <span className="rounded-pill bg-muted px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase text-muted-foreground">
                Disabled
              </span>
            )}
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
            {persona && <MetaFact icon={UserRoundIcon} title="Persona">{persona.name}</MetaFact>}
            <MetaFact
              icon={grants > 0 ? ShieldAlertIcon : ShieldCheckIcon}
              className={grants > 0 ? "text-amber-600 dark:text-amber-400" : undefined}
              title="Autonomy"
            >
              {grants > 0
                ? `Acts without asking for ${grants} kind${grants === 1 ? "" : "s"} of tool`
                : "Asks a person for everything"}
            </MetaFact>
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
                <DropdownMenuItem onClick={() => setTab("settings")}>
                  <PencilIcon />
                  Edit settings
                </DropdownMenuItem>
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

      <StatGrid>
        <StatTile
          icon={HistoryIcon}
          label="Last run"
          value={
            last ? (
              <span className={runStatus(last.status).text}>{runStatus(last.status).label}</span>
            ) : (
              "—"
            )
          }
          loading={runs === undefined && !runsError}
          hint={
            last
              ? `${shortAge(last.startedAt)} ago · ${SOURCE_LABEL[last.source] ?? last.source}`
              : runsError
                ? "couldn't read the runs"
                : "has not run yet"
          }
        />
        <StatTile
          icon={CalendarClockIcon}
          label="Next fire"
          value={nextFire ? untilLabel(nextFire) : "—"}
          loading={triggers === undefined && !triggersQuery.error}
          hint={
            nextFire
              ? new Date(nextFire).toLocaleString()
              : !routine.enabled
                ? "the routine is disabled"
                : armed.length === 0
                  ? "no trigger is armed — fires by hand only"
                  : armed.some((t) => t.kind !== "schedule")
                    ? "waits on a webhook or a commit"
                    : "the sweep has not armed a clock yet"
          }
        />
        <StatTile
          icon={ActivityIcon}
          label="Runs"
          value={runs ? (runs.length >= 50 ? "50+" : runs.length) : "—"}
          loading={runs === undefined && !runsError}
          tone={running > 0 ? "text-primary" : undefined}
          hint={
            running > 0
              ? `${running} running now`
              : outcomes
                ? `${outcomes.completed} completed · ${outcomes.failed} needed a person · ${outcomes.skipped} skipped`
                : "not read"
          }
        />
        <StatTile
          icon={CoinsIcon}
          label="Tokens"
          value={tokens === undefined ? "—" : tokens.toLocaleString()}
          loading={runs === undefined && !runsError}
          hint={runs && runs.length >= 50 ? "across the newest 50 runs" : "across every run"}
        />
      </StatGrid>

      {!routine.dryRunCompleted && (
        <p className="mt-4 rounded-lg border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
          This routine has not completed a run yet, so it cannot be granted a blanket{" "}
          <strong className="font-medium text-foreground">Allow</strong>. Press{" "}
          <strong className="font-medium text-foreground">Run, forced to ask</strong> and watch
          what it does first — the per-kind answers in Settings are available either way.
        </p>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="mt-6">
        <TabsList variant="line" className="w-full justify-start border-b">
          <TabsTrigger value="overview" className="flex-none">Overview</TabsTrigger>
          <TabsTrigger value="runs" className="flex-none">
            Runs
            {running > 0 && (
              <span className="rounded-pill bg-primary/10 px-1.5 text-[10px] font-medium text-primary">
                {running}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="triggers" className="flex-none">
            Triggers
            {triggers && triggers.length > 0 && (
              <span className="rounded-pill bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
                {triggers.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="settings" className="flex-none">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="pt-4">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="space-y-4">
              <SurfaceCard
                title="Recent runs"
                action={
                  runs && runs.length > 5 ? (
                    <Button variant="ghost" size="xs" onClick={() => setTab("runs")}>
                      All runs
                      <ChevronRightIcon data-icon="inline-end" />
                    </Button>
                  ) : undefined
                }
              >
                <div className="p-3">
                  <ErrorNote error={runsError} onRetry={() => void runsQuery.refetch()} />
                  {runsError ? null : (
                    <RunList
                      runs={runs?.slice(0, 5)}
                      hasOutputSchema={routine.output !== null}
                      onCancel={async (runId) => cancelRoutineRun.mutate({ routineId: routine.id, runId })}
                    />
                  )}
                </div>
              </SurfaceCard>
              <SurfaceCard title={routine.body.kind === "workflow" ? "What it runs" : "What it asks"}>
                {routine.body.kind === "prompt" ? (
                  <p className="max-h-64 overflow-y-auto px-4 py-3 text-sm whitespace-pre-wrap text-pretty">
                    {routine.body.text}
                  </p>
                ) : (
                  <p className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
                    <WorkflowIcon className="size-4" />
                    A declarative workflow, {Object.keys(routine.body.definition).length} top-level keys.
                    Open Settings to read it.
                  </p>
                )}
              </SurfaceCard>
            </div>
            <div className="space-y-4">
              <SurfaceCard
                title="Triggers"
                action={
                  <Button variant="ghost" size="xs" onClick={() => setTab("triggers")}>
                    Manage
                    <ChevronRightIcon data-icon="inline-end" />
                  </Button>
                }
              >
                {triggersQuery.error ? (
                  <div className="p-3">
                    <ErrorNote
                      error={captureError(triggersQuery.error, "Couldn't read the triggers")}
                      onRetry={() => void triggersQuery.refetch()}
                    />
                  </div>
                ) : triggers === undefined ? (
                  <div className="space-y-2 p-3">
                    <Skeleton className="h-10 w-full rounded-lg" />
                    <Skeleton className="h-10 w-full rounded-lg" />
                  </div>
                ) : triggers.length === 0 ? (
                  <p className="px-4 py-3 text-xs text-muted-foreground">
                    No triggers. This routine only fires when you press Run.
                  </p>
                ) : (
                  <ul className="divide-y">
                    {triggers.map((t) => {
                      const meta = TRIGGER_KIND[t.kind]
                      return (
                        <li key={t.id} className="flex items-start gap-2.5 px-4 py-2.5 text-xs">
                          <meta.icon
                            className={cn("mt-0.5 size-3.5 shrink-0", t.enabled ? "text-foreground" : "text-muted-foreground/60")}
                          />
                          <div className="min-w-0 flex-1">
                            <div className={cn("font-medium", !t.enabled && "text-muted-foreground")}>
                              {meta.label}
                              {!t.enabled && " · off"}
                            </div>
                            <div className="truncate text-muted-foreground">{triggerTerms(t)}</div>
                            {t.enabled && t.nextFireAt !== null && (
                              <div className="text-muted-foreground" title={new Date(t.nextFireAt).toLocaleString()}>
                                Fires {untilLabel(t.nextFireAt)}
                              </div>
                            )}
                            {t.lastError && (
                              <div className="text-amber-600 dark:text-amber-400">{t.lastError}</div>
                            )}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </SurfaceCard>
              <SurfaceCard title="Policy">
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 px-4 py-3 text-xs">
                  <dt className="text-muted-foreground">Default</dt>
                  <dd className="capitalize">{routine.autonomy.permissions.default}</dd>
                  <dt className="text-muted-foreground">Questions</dt>
                  <dd>{routine.autonomy.elicitations === "ask" ? "Wait for a person" : "Decline and carry on"}</dd>
                  <dt className="text-muted-foreground">Unanswered</dt>
                  <dd>
                    {routine.autonomy.askTimeoutSeconds > 0
                      ? `${routine.autonomy.askFallback === "deny" ? "Denied" : "Cancelled"} after ${Math.round(routine.autonomy.askTimeoutSeconds / 60)} min`
                      : "Waits forever"}
                  </dd>
                  <dt className="text-muted-foreground">Ceiling</dt>
                  <dd>
                    {routine.autonomy.maxRunSeconds > 0 ? `${Math.round(routine.autonomy.maxRunSeconds / 60)} min` : "none"}
                    {routine.autonomy.maxRunTokens ? ` · ${routine.autonomy.maxRunTokens.toLocaleString()} tokens` : ""}
                  </dd>
                  <dt className="text-muted-foreground">Overlap</dt>
                  <dd>{routine.overlap === "skip" ? "Skip while one is running" : "Queue behind it"}</dd>
                  <dt className="text-muted-foreground">On finish</dt>
                  <dd>
                    {routine.onFinish.length === 0
                      ? "nothing"
                      : routine.onFinish.map((a) => a.kind).join(", ")}
                  </dd>
                </dl>
              </SurfaceCard>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="runs" className="pt-4">
          <p className="mb-3 text-xs text-muted-foreground">
            Newest first. {Object.values(RUN_STATUS).map((s) => s.label).join(", ")} — each row says what its word means.
          </p>
          <ErrorNote error={runsError} onRetry={() => void runsQuery.refetch()} />
          {runsError ? null : (
            <RunList
              runs={runs}
              hasOutputSchema={routine.output !== null}
              onCancel={async (runId) => cancelRoutineRun.mutate({ routineId: routine.id, runId })}
            />
          )}
        </TabsContent>

        <TabsContent value="triggers" className="pt-4">
          <TriggersPanel routineId={routine.id} />
        </TabsContent>

        <TabsContent value="settings" className="pt-4">
          {draft && (
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
            />
          )}
        </TabsContent>
      </Tabs>
    </>
  )
}
