/* ── The two routine pages ──
   `RunRoutinePage` is a doing page in the shape of every other second screen
   here: `PaletteItem[]` through `ItemList`, ranked by the palette's own matcher.

   `RoutineActivityPage` is the odd one — a *reading* page in a palette of
   commands. It is here rather than on the routines index for one reason: the
   question it answers ("what have these been doing while I wasn't looking?") is
   asked from wherever you happen to be, and a standing grant to run commands
   unattended is only tolerable if checking on it costs one chord. A page you
   have to navigate to is a page you check the week after you stop trusting it.

   What it can and cannot say is worth stating plainly, because the gap is not
   an oversight. Runs, verdicts and statuses are rows in SQLite and are all
   here. **Individual auto-answered permissions are not**: the bridge emits
   `request_answered` with its `auto` stamp live to whoever is attached, and
   that event is not one of the four journaled kinds — so after the fact the
   only durable trace of the policy having answered is a run whose fallback
   fired, which the engine records as `status: "blocked"`. Those are surfaced
   first-class. A grant that went the routine's way leaves no row anywhere; what
   it *did* is in the run's own thread, which every row here opens. Inventing a
   count from nothing would be worse than saying so. */
import * as React from "react"
import { AlertTriangle, Bot, History, Loader2, Zap } from "lucide-react"
import { useNavigate } from "react-router"

import { CommandGroup } from "@/components/ui/command"
import { RUN_STATUS } from "@/components/routines/status"
import { useSidebar } from "@/components/ui/sidebar"
import { reportError } from "@/lib/errors"
import { routinePath, routinesPath, threadPath } from "@/lib/router"
import { useRunRoutine, useRoutines } from "@/lib/queries/routines"
import { routineRunsKey } from "@/lib/queries/keys"
import { useQueryClient } from "@tanstack/react-query"
import { useServer } from "@/lib/server-context"
import { api, type Routine, type RoutineRun } from "@/lib/settings"
import { useProjects } from "@/lib/queries/catalog"
import { shortAge } from "@/lib/time"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"
import { usePalette } from "./context"
import { ItemList, Row, type PaletteItem } from "./list"

/** Runs read per routine, and rows drawn in total. Both small on purpose: this
    is a digest, not the archive — the archive is the routine's own page. */
const RUNS_PER_ROUTINE = 10
const DIGEST_LIMIT = 30

/** When this device last read the digest. Device-local like every other
    reading preference (`view-options`, `pins`): "since you last looked" is a
    fact about a person at a screen, not about the install. */
const SEEN_KEY = "ui.routineDigestSeenAt"

/** Fire a routine, and say so — the palette is gone by the time the server
    answers, so a toast is the only place the outcome can land.

    The first run of any routine is forced to ask, which is not a nicety: the
    engine refuses a blanket-`allow` routine that has never completed one
    (`preflight`), and a plain run there would come back as a `skipped` row the
    user never sees. Sending the dry run instead does what they meant. */
function fire(routine: Routine, run: (id: string, opts: { dryRun?: boolean }) => Promise<unknown>) {
  const dryRun = !routine.dryRunCompleted
  run(routine.id, { dryRun })
    .then(() =>
      toast.success(
        dryRun ? `${routine.name} started — forced to ask` : `${routine.name} started`,
        dryRun
          ? { description: "Its first run answers nothing for you, whatever it has been granted." }
          : undefined
      )
    )
    .catch((err) => reportError(err, "Couldn't run the routine"))
}

/** Every routine as something to fire now. */
export function RunRoutinePage() {
  const palette = usePalette()
  const projects = useProjects()
  const allRoutines = useRoutines().data ?? []
  const runRoutine = useRunRoutine()
  const navigate = useNavigate()

  const projectName = (id: string) =>
    projects.find((project) => project.id === id)?.name ?? "no project"

  const items: PaletteItem[] = allRoutines.map((routine) => ({
    id: `routine:${routine.id}`,
    group: "Run now",
    title: routine.name,
    keywords: `routine automation ${routine.description ?? ""} ${projectName(routine.projectId)}`,
    icon: <Zap className={routine.enabled ? undefined : "opacity-50"} />,
    trailing: (
      <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        {/* A disabled routine is still listed and still selectable, because the
            engine answers a fire on one with a `skipped` run rather than an
            error — so the honest thing is to say it will not do anything, not
            to hide the row and leave the reason unguessable. */}
        {!routine.enabled && <span className="text-amber-600 dark:text-amber-400">Disabled</span>}
        {!routine.dryRunCompleted && routine.enabled && <span>First run · forced to ask</span>}
        <span className="truncate">{projectName(routine.projectId)}</span>
      </span>
    ),
    onSelect: () =>
      palette.run(() =>
        fire(routine, (id, opts) => runRoutine.mutateAsync({ id, ...opts }))
      ),
  }))

  items.push({
    id: "routine:manage",
    group: "",
    title: "Manage routines…",
    keywords: "new edit triggers autonomy schedule webhook git",
    icon: <Zap />,
    rank: "bottom",
    onSelect: () => palette.run(() => void navigate(routinesPath())),
  })

  return <ItemList items={items} query={palette.query} />
}

/**
 * What every routine has done lately, newest first.
 *
 * Cheap by construction: one `GET /api/routines/:id/runs` per routine on open
 * (there is no cross-routine runs route, and adding one is the server's call,
 * not the palette's), into the store slice the routines page already fills, so
 * reopening the page within a session redraws from memory while the refresh
 * runs behind it.
 */
export function RoutineActivityPage() {
  const palette = usePalette()
  const allRoutines = useRoutines().data ?? []
  const navigate = useNavigate()
  const { setOpenMobile } = useSidebar()
  const query = palette.query.trim().toLowerCase()

  const [loading, setLoading] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  /* Read once, on open, *before* the read is recorded — otherwise the marker
     would clear itself in the same frame it was drawn. */
  const [seenAt] = React.useState(() => Number(localStorage.getItem(SEEN_KEY) ?? 0) || 0)

  const routines = allRoutines
  const settings = useServer()
  const qc = useQueryClient()
  const [fetched, setFetched] = React.useState<RoutineRun[]>([])

  React.useEffect(() => {
    if (routines.length === 0) return
    let live = true
    setLoading(true)
    setFailed(false)
    /* `fetchQuery` serves the cache first and refetches behind it when stale —
       the same bargain the store slice gave (reopening redraws from memory),
       now per routine and on the shared clock. */
    Promise.allSettled(
      routines.map((routine) =>
        qc.fetchQuery({
          queryKey: routineRunsKey(settings, routine.id, RUNS_PER_ROUTINE),
          queryFn: ({ signal }) =>
            api<RoutineRun[]>(
              settings,
              `/api/routines/${encodeURIComponent(routine.id)}/runs?limit=${RUNS_PER_ROUTINE}`,
              { signal }
            ),
          staleTime: 15_000,
        })
      )
    )
      .then((results) => {
        if (!live) return
        // One routine's read failing is not the same as the page failing, but
        // it *is* a hole in a list whose whole job is completeness — so any
        // rejection says so rather than letting the digest read as thorough.
        setFailed(results.some((result) => result.status === "rejected"))
        setFetched(
          results.flatMap((result) => (result.status === "fulfilled" ? result.value : []))
        )
        setLoading(false)
      })
    try {
      localStorage.setItem(SEEN_KEY, String(Date.now()))
    } catch {
      // A forgotten marker costs a "New" dot, not the page.
    }
    return () => {
      live = false
    }
  }, [routines, qc, settings])

  const nameOf = (routineId: string) =>
    routines.find((routine) => routine.id === routineId)?.name ?? "Deleted routine"

  const runs: RoutineRun[] = fetched
    .filter((run) => !query || nameOf(run.routineId).toLowerCase().includes(query))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, DIGEST_LIMIT)

  /* The runs a person has to do something about, counted over everything read
     rather than over the visible slice: "3 need you" under a list capped at 30
     must mean three, not three of the first thirty. */
  const needsYou = fetched.filter(
    (run) => run.status === "blocked" || run.status === "failed"
  ).length

  const open = (run: RoutineRun) =>
    palette.run(() => {
      setOpenMobile(false)
      void navigate(run.sessionId ? threadPath(run.sessionId) : routinePath(run.routineId))
    })

  return (
    <>
      {needsYou > 0 && (
        <Note tone="warn">
          <AlertTriangle className="size-3.5 shrink-0" />
          {needsYou} run{needsYou === 1 ? "" : "s"} need{needsYou === 1 ? "s" : ""} you — blocked or
          failed.
        </Note>
      )}

      <CommandGroup heading="Recent runs">
        {runs.map((run) => (
          <Row key={run.id} item={runItem(run, nameOf(run.routineId), seenAt, () => open(run))} />
        ))}
        {runs.length === 0 &&
          /* Three different answers that a bare empty list would render
             identically — and one of them ("the request never arrived") is a
             failure, which must never be drawn as emptiness. */
          (routines.length === 0 ? (
            <Note>No routines yet.</Note>
          ) : loading ? (
            <Note>
              <Loader2 className="size-3.5 animate-spin" />
              Reading run history…
            </Note>
          ) : failed ? (
            <Note tone="warn">
              <AlertTriangle className="size-3.5 shrink-0" />
              Couldn't read the run history.
            </Note>
          ) : query ? (
            <Note>No routine named “{palette.query.trim()}” has run.</Note>
          ) : (
            <Note>Nothing has run yet.</Note>
          ))}
        {runs.length > 0 && failed && (
          <Note tone="warn">
            <AlertTriangle className="size-3.5 shrink-0" />
            Some routines' history couldn't be read — this list is incomplete.
          </Note>
        )}
      </CommandGroup>

      {/* Said once, at the foot, and not per row: the alternative to stating it
          is a reader who assumes an empty Blocked column means nothing was ever
          auto-answered. See this file's header. */}
      <Note>
        <History className="size-3.5 shrink-0" />
        Blocked means an auto-answer settled a question nobody came to. Grants the routine
        answered its own way aren't listed anywhere — open a run to see what it actually did.
      </Note>
    </>
  )
}

/** One run: the routine, then the thing it is *about* — its verdict where it
    declared an answer schema, its error where something went wrong, and only
    otherwise what its status actually means. A bare "Completed" on the second
    line reads as a finding, which is the one thing it is not. */
function runItem(run: RoutineRun, name: string, seenAt: number, onSelect: () => void): PaletteItem {
  const tone = RUN_STATUS[run.status]
  const fresh = run.startedAt > seenAt
  const detail =
    run.error ??
    (run.verdict !== null && run.verdict !== undefined ? summarise(run.verdict) : null) ??
    tone.meaning

  return {
    id: `run:${run.id}`,
    group: "Recent runs",
    title: name,
    // Ordered by time here, not by match — the digest's whole claim is that it
    // is in the order things happened.
    always: true,
    className: "items-start",
    icon: <Bot className={cn("mt-0.5", tone.text)} />,
    render: (
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          {fresh && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="New" />}
          <span className="truncate">{name}</span>
          <span className={cn("shrink-0 rounded-pill px-1.5 py-px text-[10px]", tone.chip)}>
            {tone.label}
          </span>
          {run.dryRun && (
            <span className="shrink-0 text-[10px] text-muted-foreground">forced to ask</span>
          )}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">{detail}</span>
      </span>
    ),
    trailing: (
      <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {shortAge(run.startedAt)}
      </span>
    ),
    onSelect,
  }
}

/** A verdict is whatever the routine's own JSON schema said it would be, so
    there is nothing to render it *as* — one line of compact JSON is the honest
    shape, and the run's thread has the rest. */
function summarise(verdict: unknown): string | null {
  if (typeof verdict === "string") return verdict
  try {
    const text = JSON.stringify(verdict)
    return text && text !== "{}" ? text : null
  } catch {
    return null
  }
}

/** A line about the list rather than an entry in it — not a cmdk item, so ↑/↓
    walk straight past it. */
function Note({ children, tone }: { children: React.ReactNode; tone?: "warn" }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 py-2 text-xs",
        tone === "warn" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
      )}
    >
      {children}
    </div>
  )
}
