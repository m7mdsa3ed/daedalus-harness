/* ── /routines — the automation surface ──
   One route element, three faces picked from the path the way `SchedulePage`
   does it: `/routines` is the list, `/routines/new` the creation form, and
   `/routines/<id>` one routine — its runs, its triggers and its form on the
   same page, because those three are not separate concerns to the person
   looking at them. "Is it firing", "what did it decide" and "what is it allowed
   to do" get asked in one sitting, and a routine split across three screens is
   one whose autonomy you check somewhere other than where you set it.

   Routines are outside /settings on purpose (see lib/router.tsx): settings is
   for things configured once, and a routine accumulates a history. */
import * as React from "react"
import {
  BotIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  Trash2Icon,
  ZapIcon,
} from "lucide-react"
import { useLocation, useNavigate, useParams } from "react-router"

import { useConfirm } from "@/components/confirm-dialog"
import { ProjectIcon } from "@/components/entity-icon"
import { ErrorNote } from "@/components/error-note"
import { EmptyCard, FormPageHeader, FormSection, Group } from "@/components/settings/primitives"
import { Button } from "@/components/ui/button"
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
import { TriggersPanel } from "@/components/routines/triggers"
import { runStatus } from "@/components/routines/status"
import type { Actions } from "@/lib/actions"
import { captureError, reportError, type InlineError } from "@/lib/errors"
import { newRoutinePath, routinePath, routinesPath } from "@/lib/router"
import { profileSupports, type Routine, type ServerSettings } from "@/lib/settings"
import { useStore } from "@/lib/store"
import { shortAge } from "@/lib/time"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"

export function RoutinesPage({ actions, settings }: { actions: Actions; settings: ServerSettings }) {
  const location = useLocation()
  const params = useParams()
  if (location.pathname.endsWith("/new")) return <NewRoutinePage actions={actions} settings={settings} />
  if (params.routineId)
    return <RoutineDetailPage routineId={params.routineId} actions={actions} settings={settings} />
  return <RoutinesListPage actions={actions} />
}

/* ── The list ── */

function RoutinesListPage({ actions }: { actions: Actions }) {
  const { state } = useStore()
  const navigate = useNavigate()

  return (
    <>
      <FormPageHeader
        title="Routines"
        description="Saved thread-starts that fire on their own — on a clock, a webhook or a commit. Each run is a real thread with its own transcript, and each routine decides in advance which of the agent's questions it answers for you."
        onBack={() => void navigate("/")}
      />
      {state.routines.length === 0 ? (
        <EmptyCard
          icon={ZapIcon}
          text="No routines yet. A routine starts a thread the way you would, then answers for you while it runs."
          action={
            <Button size="sm" onClick={() => void navigate(newRoutinePath())}>
              <PlusIcon data-icon="inline-start" />
              New routine
            </Button>
          }
        />
      ) : (
        <>
          <div className="mb-4 flex justify-end">
            <Button size="sm" variant="outline" onClick={() => void navigate(newRoutinePath())}>
              <PlusIcon data-icon="inline-start" />
              New routine
            </Button>
          </div>
          <Group>
            {state.routines.map((routine) => (
              <RoutineRow key={routine.id} routine={routine} actions={actions} />
            ))}
          </Group>
        </>
      )}
    </>
  )
}

function RoutineRow({ routine, actions }: { routine: Routine; actions: Actions }) {
  const { state } = useStore()
  const navigate = useNavigate()
  const project = state.projects.find((p) => p.id === routine.projectId)
  const runs = state.routineRuns[routine.id]
  const last = runs?.[0]

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:flex-nowrap">
      <AutonomyMark routine={routine} />
      <button
        type="button"
        onClick={() => void navigate(routinePath(routine.id))}
        className="min-w-0 flex-1 text-left"
      >
        <div className={cn("truncate text-sm font-medium", !routine.enabled && "text-muted-foreground")}>
          {routine.name}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <ProjectIcon project={project} className="size-3.5 shrink-0" />
          <span className="truncate">
            {project?.name ?? "Project missing"}
            {routine.description && ` · ${routine.description}`}
            {!routine.enabled && " · disabled"}
            {/* The last run when this page happens to know one — the runs list
                is read per routine and on demand, so most rows say nothing
                here and that is honest rather than a gap. */}
            {last && ` · ${runStatus(last.status).label.toLowerCase()} ${shortAge(last.startedAt)}`}
          </span>
        </div>
      </button>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <Switch
          checked={routine.enabled}
          onCheckedChange={(enabled) =>
            actions
              .updateRoutine(routine.id, { enabled })
              .then(() => toast.success(enabled ? "Routine enabled" : "Routine disabled"))
              .catch((err) => reportError(err, "Couldn't update the routine"))
          }
          aria-label={routine.enabled ? "Disable routine" : "Enable routine"}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          title="Open"
          onClick={() => void navigate(routinePath(routine.id))}
        >
          <PencilIcon />
          <span className="sr-only">Open {routine.name}</span>
        </Button>
      </div>
    </div>
  )
}

/** How much this routine decides on its own, as a mark on the row. Two states
    only — it either answers something with `allow` or it does not — because the
    row is a place to notice, not a place to audit; the form is where the ten
    kinds are read one at a time. */
function AutonomyMark({ routine }: { routine: Routine }) {
  const grants = Object.values(routine.autonomy.permissions).filter((s) => s === "allow").length
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

function NewRoutinePage({ actions, settings }: { actions: Actions; settings: ServerSettings }) {
  const { state } = useStore()
  const navigate = useNavigate()
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<InlineError | null>(null)

  /* Seeded from whatever is first and coherent, never from the remembered
     thread defaults: a routine is set up deliberately and the pickers below are
     right there, where a thread's defaults exist because opening a new thread
     should cost no decisions. */
  const [draft, setDraft] = React.useState<RoutineDraft>(() => {
    const project = state.projects[0]
    const agent = state.agents[0]
    const profile = agent ? state.profiles.find((p) => profileSupports(p, agent.id)) : undefined
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
      const routine = await actions.createRoutine(parsed.input)
      toast.success("Routine created")
      // Straight to its own page: triggers live there, and a routine with no
      // trigger is one that only ever fires by hand.
      void navigate(routinePath(routine.id))
    } catch (err) {
      setError(captureError(err, "Couldn't create the routine"))
      setBusy(false)
    }
  }

  if (state.projects.length === 0 || state.agents.length === 0) {
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
        settings={settings}
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

function RoutineDetailPage({
  routineId,
  actions,
  settings,
}: {
  routineId: string
  actions: Actions
  settings: ServerSettings
}) {
  const { state } = useStore()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const routine = state.routines.find((r) => r.id === routineId)
  const runs = state.routineRuns[routineId]

  const [draft, setDraft] = React.useState<RoutineDraft | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<InlineError | null>(null)
  const [runsError, setRunsError] = React.useState<InlineError | null>(null)
  const [firing, setFiring] = React.useState(false)

  /* Reset the form when the routine arrives or is replaced by a save. The
     dependency is the row itself, so a save's answer (a new object) re-seeds
     the fields with what the server actually stored — including the fields it
     normalized — rather than leaving the form's own guess on screen. */
  React.useEffect(() => {
    if (routine) setDraft(draftOf(routine))
  }, [routine])

  const loadRuns = React.useCallback(async () => {
    setRunsError(null)
    try {
      await actions.refreshRoutineRuns(routineId)
    } catch (err) {
      setRunsError(captureError(err, "Couldn't read this routine's runs"))
    }
  }, [actions, routineId])

  React.useEffect(() => {
    void loadRuns()
  }, [loadRuns])

  const back = () => void navigate(routinesPath())

  if (!routine)
    return (
      <>
        <FormPageHeader title="Routine" description="" onBack={back} />
        <EmptyCard icon={ZapIcon} text="This routine no longer exists." />
      </>
    )

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
      await actions.updateRoutine(routine.id, parsed.input)
      toast.success("Routine saved")
    } catch (err) {
      setError(captureError(err, "Couldn't save the routine"))
    } finally {
      setBusy(false)
    }
  }

  /** Fire it by hand. `dryRun` forces every question back to "ask" for this one
      run whatever the policy says — which is the run that clears the blanket
      grant's gate, and the reason the two buttons are worth having separately. */
  const run = async (dryRun: boolean) => {
    if (firing) return
    setFiring(true)
    try {
      const started = await actions.runRoutine(routine.id, { dryRun })
      toast.success(dryRun ? "Dry run started — it will ask you for everything" : "Run started", {
        description: started.status === "skipped" ? (started.error ?? "Skipped") : undefined,
      })
    } catch (err) {
      reportError(err, "Couldn't start the run")
    } finally {
      setFiring(false)
    }
  }

  const remove = async () => {
    if (
      !(await confirm({
        title: `Delete “${routine.name}”?`,
        description:
          "The routine, its triggers and its whole run history go with it. The threads its runs created are untouched — they are ordinary threads and stay where they are.",
        destructive: true,
        confirmLabel: "Delete routine",
      }))
    )
      return
    try {
      await actions.deleteRoutine(routine.id)
      back()
    } catch (err) {
      reportError(err, "Couldn't delete the routine")
    }
  }

  return (
    <>
      <FormPageHeader
        title={routine.name}
        description={routine.description ?? undefined}
        onBack={back}
      />

      <div className="mb-6 flex flex-wrap gap-2">
        {/* The dry run is the first-class one and reads that way: it is what a
            person should press before granting anything, and the plain run is
            the one that behaves like the routine actually will. */}
        <Button size="sm" disabled={firing} onClick={() => void run(true)}>
          <ShieldCheckIcon data-icon="inline-start" />
          Run now, forced to ask
        </Button>
        <Button size="sm" variant="outline" disabled={firing} onClick={() => void run(false)}>
          <PlayIcon data-icon="inline-start" />
          Run now
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto text-muted-foreground hover:text-destructive"
          onClick={() => void remove()}
        >
          <Trash2Icon data-icon="inline-start" />
          Delete
        </Button>
      </div>

      {!routine.dryRunCompleted && (
        <p className="mb-6 rounded-lg border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
          This routine has not completed a run yet, so it cannot be granted a blanket{" "}
          <strong className="font-medium text-foreground">Allow</strong>. Press{" "}
          <strong className="font-medium text-foreground">Run now, forced to ask</strong> and watch
          what it does first — the per-kind answers below are available either way.
        </p>
      )}

      <div className="space-y-8">
        <FormSection label="Triggers">
          <TriggersPanel routineId={routine.id} actions={actions} settings={settings} />
        </FormSection>

        <FormSection label="Runs">
          <ErrorNote error={runsError} onRetry={() => void loadRuns()} />
          {/* A failed read leaves the store's entry undefined, which draws
              skeletons rather than "has never run" — the note above is what
              says the request failed. The two are not the same screen. */}
          {runsError ? null : (
            <RunList
              runs={runs}
              hasOutputSchema={routine.output !== null}
              onCancel={(runId) => actions.cancelRoutineRun(routine.id, runId)}
            />
          )}
        </FormSection>

        {draft && (
          <RoutineForm
            draft={draft}
            onChange={setDraft}
            actions={actions}
            settings={settings}
            routine={routine}
            onSubmit={submit}
            onCancel={back}
            busy={busy}
            error={error}
            submitLabel="Save routine"
          />
        )}
      </div>
    </>
  )
}
