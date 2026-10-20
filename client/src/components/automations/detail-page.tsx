/* ── /automations/:id — one automation ──
   One URL, five tabs (`?tab=overview|runs|triggers|access|settings`, the
   overview carrying no param). The overview is a health reading — how often it
   finishes, what the last run did, when it fires next — and then a little of
   each tab, every value with a "Change" that lands on the field that sets it,
   because "is it firing", "what did it decide" and "what is it allowed to do"
   get asked in one sitting. Runs include the skipped ones, each with its reason.
   Triggers and runs are read on this page and the run page, nowhere else. */
import * as React from "react"
import {
  CalendarClockIcon,
  ChevronRightIcon,
  CopyIcon,
  HistoryIcon,
  MessagesSquareIcon,
  MoreVerticalIcon,
  PencilIcon,
  PlayIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react"
import { Link, Navigate, useNavigate, useSearchParams } from "react-router"

import { useConfirm } from "@/components/confirm-dialog"
import { AgentIcon, ProfileIcon, ProjectIcon } from "@/components/entity-icon"
import { ErrorNote } from "@/components/error-note"
import { Notice } from "@/components/notice"
import { MetaFact, SurfaceHeader } from "@/components/page-primitives"
import { Empty } from "@/components/empty"
import { GroupRowsSkeleton } from "@/components/ui/skeletons"
import { Skeleton } from "@/components/ui/skeleton"
import {
  FormPageHeader,
  Group,
  Row,
  Section,
  StatStrip,
  StatusBadge,
  TabBar,
  type TabItem,
  type Tone,
} from "@/components/settings/primitives"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Switch } from "@/components/ui/switch"
import type { Actions } from "@/lib/actions"
import { captureError, inlineFromQuery, type InlineError } from "@/lib/errors"
import { useAgents, useProfiles, useProjects } from "@/lib/queries/catalog"
import {
  useAutomationRuns,
  useAutomationTriggers,
  useAutomations,
  useCancelAutomationRun,
  useUpdateAutomation,
} from "@/lib/queries/automations"
import { automationRunPath, automationsPath, threadPath } from "@/lib/router"
import type { Routine } from "@/lib/settings"
import { useStoreSelect } from "@/lib/store"
import { toast } from "@/lib/toast"
import { AccessPanel } from "./access-panel"
import { AutomationForm, draftOf, problemNote, toInput, type AutomationDraft, type AutomationSectionId } from "./automation-form"
import { policySentence } from "./autonomy-control"
import { grantsOf, useDuplicate, useFire, useMinuteTick, useRemove, useToggle } from "./hooks"
import { onFinishLabel } from "./on-finish"
import { RunList, RunStrip } from "./runs"
import { SOURCE_LABEL, agoLabel, durationLabel, durationOf, healthOf, runStatus, secondsLabel } from "./status"
import { TriggersPanel } from "./triggers"
import { nextFireOf, TRIGGER_KIND, triggerTerms, triggerTitle, untilLabel } from "./trigger-summary"

const TABS = ["overview", "runs", "triggers", "access", "settings"] as const
type Tab = (typeof TABS)[number]
const isTab = (v: string | null): v is Tab => TABS.includes(v as Tab)
const TAB_LABEL: Record<Tab, string> = {
  overview: "Overview",
  runs: "Runs",
  triggers: "Triggers",
  access: "Access",
  settings: "Settings",
}

/** The server's default page of runs; anything past it is asked for by name. */
const PAGE = 50

const BADGE_TONE: Partial<Record<string, Tone>> = { ok: "ok", warn: "warn", bad: "bad" }

/** Body text longer than this draws clamped, with a Show all. */
const longText = (text: string) => text.length > 600 || text.split("\n").length > 10

export function AutomationDetailPage({ automationId, actions }: { automationId: string; actions: Actions }) {
  const automationsQuery = useAutomations()
  const automations = automationsQuery.data
  const projects = useProjects()
  const agents = useAgents()
  const profiles = useProfiles()
  const sessions = useStoreSelect((state) => state.sessions)
  const navigate = useNavigate()
  const confirm = useConfirm()
  const now = useMinuteTick()
  const [params, setParams] = useSearchParams()
  const routine = automations?.find((r) => r.id === automationId)

  /* The reads live in the cache; the query fetches on mount and the mutations
     (run, cancel) invalidate it, which is the refresh. A failed read leaves
     `data` undefined — skeletons, not "has never run". Older runs are a second
     key beside the first page, so the page keeps drawing the 50 it has while
     the longer list loads, and the run page reads the same cache. */
  const [limit, setLimit] = React.useState(PAGE)
  const baseRuns = useAutomationRuns(automationId)
  const moreRuns = useAutomationRuns(automationId, limit, { enabled: limit > PAGE })
  const runsQuery = limit > PAGE && moreRuns.data ? moreRuns : baseRuns
  const runs = runsQuery.data
  const runsError = React.useMemo(
    () => inlineFromQuery(runsQuery.error, "Couldn't read this automation's runs"),
    [runsQuery.error]
  )
  const moreError = React.useMemo(
    () => inlineFromQuery(moreRuns.error, "Couldn't read the older runs"),
    [moreRuns.error]
  )
  const triggersQuery = useAutomationTriggers(automationId)
  const triggers = triggersQuery.data
  const triggersError = React.useMemo(
    () => inlineFromQuery(triggersQuery.error, "Couldn't read the triggers"),
    [triggersQuery.error]
  )
  const listError = React.useMemo(
    () => inlineFromQuery(automationsQuery.error, "Couldn't read the automations"),
    [automationsQuery.error]
  )
  const cancelRun = useCancelAutomationRun()
  const update = useUpdateAutomation()
  const fire = useFire()
  const toggle = useToggle()
  const remove = useRemove()
  const duplicate = useDuplicate()

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

  /* ── The Settings tab's edit model ──
     `seed` is what the form was loaded from, `draft` what the person has typed.
     A routine that changes underneath (a toggle, another device, a save's own
     answer) reseeds a clean form and only *flags* a dirty one — overwriting
     somebody's half-written prompt because the list re-read is the bug. */
  const [seed, setSeed] = React.useState<AutomationDraft | null>(null)
  const [draft, setDraft] = React.useState<AutomationDraft | null>(null)
  const [stale, setStale] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<InlineError | null>(null)
  const [firing, setFiring] = React.useState(false)
  const [bodyOpen, setBodyOpen] = React.useState(false)
  const dirty = draft !== null && seed !== null && JSON.stringify(draft) !== JSON.stringify(seed)

  const reseed = React.useCallback((from: Routine) => {
    const next = draftOf(from)
    setSeed(next)
    setDraft(next)
    setStale(false)
  }, [])

  React.useEffect(() => {
    if (!routine) return
    if (!seed || !dirty) reseed(routine)
    else setStale(true)
    // Only a new routine row is news; the edit state is read as it stands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routine])

  /* Leaving a dirty Settings tab asks; the edits are dropped on yes. */
  const go = async (next: Tab) => {
    if (next === tab) return
    if (tab === "settings" && dirty) {
      const discard = await confirm({
        title: "Discard your edits?",
        description: "The changes in Settings have not been saved.",
        destructive: true,
        confirmLabel: "Discard",
      })
      if (!discard) return
      setDraft(seed)
    }
    setTab(next)
  }

  /* "Change" on an Overview fact: the owning tab, then the field. */
  const change = (owner: Tab, section?: AutomationSectionId) => {
    void go(owner)
    if (section)
      requestAnimationFrame(() =>
        document.getElementById(`automation-${section}`)?.scrollIntoView({ behavior: "smooth", block: "start" })
      )
  }

  const back = () => void navigate(automationsPath())

  if (!routine) {
    /* A row the list does not hold is a deleted automation or a stale link:
       the list is the honest destination. */
    if (automations !== undefined) return <Navigate to={automationsPath()} replace />
    return (
      <>
        <FormPageHeader title="Automation" onBack={back} />
        {listError ? (
          <Section>
            <ErrorNote error={listError} onRetry={() => void automationsQuery.refetch()} />
          </Section>
        ) : (
          <>
            <StatStrip
              stats={["Success", "Last run", "Next run", "Avg duration"].map((label) => ({ label, value: null, loading: true }))}
            />
            <GroupRowsSkeleton label />
          </>
        )}
      </>
    )
  }

  const session = routine.runsIn === "session"
  const pinnedThread = sessions.find((s) => s.id === routine.sessionId)
  const project = projects.find((p) => p.id === routine.projectId)
  const agent = agents.find((a) => a.id === routine.agentId)
  const profile = profiles.find((p) => p.id === routine.profileId)
  const agentName = agent?.name ?? routine.agentId
  const profileName = profile?.name ?? routine.profileId

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy || !draft) return
    const parsed = toInput(draft, "edit")
    if ("problem" in parsed) {
      setError(problemNote(parsed.problem))
      return
    }
    setBusy(true)
    setError(null)
    try {
      /* Pausing is the header switch's, live; a save must not undo a toggle
         made after the form was loaded. */
      const { enabled: _enabled, ...patch } = parsed.input
      await update.mutateAsync({ id: routine.id, patch })
      setSeed(draft)
      setStale(false)
      toast.success("Automation saved")
    } catch (err) {
      setError(captureError(err, "Couldn't save the automation"))
    } finally {
      setBusy(false)
    }
  }

  const run = async (dryRun: boolean) => {
    if (firing) return
    setFiring(true)
    try {
      await fire(routine, dryRun)
      if (!dirty) setTab("runs")
    } finally {
      setFiring(false)
    }
  }

  const last = runs?.[0] ?? null
  const health = healthOf(runs ?? [])
  const running = health.running
  const needsYou = last !== null && (last.status === "blocked" || last.status === "failed")
  const nextFire = routine.enabled ? nextFireOf(triggers) : null
  const armed = triggers?.filter((t) => t.enabled) ?? []
  const grants = grantsOf(routine)
  const loadingRuns = runs === undefined && !runsError
  const lastDuration = last ? durationOf(last) : null

  const stats = [
    {
      label: "Success",
      value: health.rate === null ? "—" : `${Math.round(health.rate * 100)}%`,
      loading: loadingRuns,
      tone: (health.rate === null ? "default" : health.rate >= 0.9 ? "ok" : health.rate >= 0.5 ? "warn" : "bad") as Tone,
      hint: health.finished > 0 ? `${health.completed} of ${health.finished} finished` : "no finished runs",
    },
    {
      label: "Last run",
      value: last ? runStatus(last.status).label : "—",
      loading: loadingRuns,
      tone: last ? (BADGE_TONE[runStatus(last.status).badge] ?? "default") : undefined,
      hint: last
        ? `${agoLabel(last.startedAt, now)} · ${SOURCE_LABEL[last.source] ?? last.source}`
        : runsError
          ? "couldn't read the runs"
          : "has not run yet",
    },
    {
      label: "Next run",
      value: nextFire ? untilLabel(nextFire, now) : "—",
      loading: triggers === undefined && !triggersError,
      hint: nextFire
        ? new Date(nextFire).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })
        : !routine.enabled
          ? "paused"
          : armed.length === 0
            ? "manual only"
            : armed.some((t) => t.kind !== "schedule")
              ? "webhook or commit"
              : "arming the clock",
    },
    {
      label: "Avg duration",
      value: durationLabel(health.avgMs),
      loading: loadingRuns,
      hint:
        last?.status === "running"
          ? "last still running"
          : lastDuration !== null
            ? `last ${durationLabel(lastDuration)}`
            : undefined,
    },
  ]

  const tabItems: TabItem[] = [
    { id: "overview", label: TAB_LABEL.overview },
    { id: "runs", label: TAB_LABEL.runs, count: running > 0 ? running : undefined },
    { id: "triggers", label: TAB_LABEL.triggers, count: triggers && triggers.length > 0 ? triggers.length : undefined },
    { id: "access", label: TAB_LABEL.access, count: (!session && grants) || undefined },
    { id: "settings", label: TAB_LABEL.settings, hint: dirty ? "Unsaved changes" : undefined },
  ]

  const stop = (runId: string) => cancelRun.mutateAsync({ routineId: routine.id, runId })

  const changeButton = (owner: Tab, section?: AutomationSectionId) => (
    <Button variant="ghost" size="sm" className="pointer-coarse:h-11" onClick={() => change(owner, section)}>
      Change
    </Button>
  )

  const limits = routine.autonomy
  const limitsLine = [
    `Stops after ${limits.maxRunSeconds > 0 ? secondsLabel(limits.maxRunSeconds) : "no time limit"}` +
      (limits.maxRunTokens ? `, ${limits.maxRunTokens.toLocaleString()} tokens` : "") +
      (limits.minQuotaPercent != null ? `, below ${limits.minQuotaPercent}% quota` : ""),
    limits.elicitations === "decline"
      ? "questions declined"
      : limits.askTimeoutSeconds > 0
        ? `wait ${secondsLabel(limits.askTimeoutSeconds)} then ${limits.askFallback === "deny" ? "deny" : "cancel"}`
        : "questions wait for a person",
  ].join(" · ")

  const carries = [
    [routine.links.mcpServerIds.length, "MCP server"],
    [routine.links.skillIds.length, "skill"],
    [routine.links.commandIds.length, "command"],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, word]) => `${n} ${word}${n === 1 ? "" : "s"}`)

  const bodyText = routine.body.kind === "prompt" ? routine.body.text : JSON.stringify(routine.body.definition, null, 2)
  const bodyLong = longText(bodyText)

  const outcomeLine = [
    health.completed > 0 && `${health.completed} completed`,
    health.failed > 0 && `${health.failed} needed you`,
    health.skipped > 0 && `${health.skipped} skipped`,
    running > 0 && `${running} running`,
  ]
    .filter(Boolean)
    .join(" · ")

  const overview = (
    <>
      {last && needsYou && (
        <Section>
          <Notice tone={last.status === "failed" ? "error" : "warn"} title={runStatus(last.status).label}>
            <p>{last.error ?? runStatus(last.status).meaning}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => void navigate(automationRunPath(routine.id, last.id))}>
                Open run
              </Button>
              {last.sessionId && (
                <Button size="sm" variant="outline" onClick={() => void navigate(threadPath(last.sessionId!))}>
                  Open thread
                </Button>
              )}
            </div>
          </Notice>
        </Section>
      )}

      {!session && !routine.dryRunCompleted && (
        <Section>
          <Notice
            tone="info"
            action={
              <Button size="sm" variant="outline" disabled={firing} onClick={() => void run(true)}>
                Run, forced to ask
              </Button>
            }
          >
            This automation has not completed a run yet, so it cannot be granted a blanket{" "}
            <strong className="font-medium text-foreground">Allow</strong>. Press{" "}
            <strong className="font-medium text-foreground">Run, forced to ask</strong> and watch what it does first — the
            per-kind answers in Access are available either way.
          </Notice>
        </Section>
      )}

      <Group
        label="Run history"
        action={
          <Button variant="ghost" size="sm" onClick={() => void go("runs")}>
            All runs
            <ChevronRightIcon data-icon="inline-end" />
          </Button>
        }
      >
        <div className="py-3">
          {runsError ? (
            <ErrorNote error={runsError} onRetry={() => void runsQuery.refetch()} />
          ) : runs === undefined ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <>
              {runs.length > 0 && <RunStrip routineId={routine.id} runs={runs} />}
              <p className="mt-2 text-xs text-muted-foreground">
                {outcomeLine || "No runs yet. Press Run now to start one."}
              </p>
            </>
          )}
        </div>
      </Group>

      {/* No runs is said once, by the history line above. */}
      {!runsError && runs?.length !== 0 && (
        <Section label="Recent runs">
          {runs === undefined ? (
            <GroupRowsSkeleton rows={3} className="mt-0" />
          ) : (
            <RunList
              routineId={routine.id}
              runs={runs.slice(0, 5)}
              hasOutputSchema={routine.output !== null}
              onCancel={stop}
              compact
            />
          )}
        </Section>
      )}

      {triggersError ? (
        <Section label="Triggers">
          <ErrorNote error={triggersError} onRetry={() => void triggersQuery.refetch()} />
        </Section>
      ) : triggers === undefined ? (
        <Section label="Triggers">
          <GroupRowsSkeleton rows={2} className="mt-0" />
        </Section>
      ) : triggers.length === 0 ? (
        <Section label="Triggers">
          <Empty
            icon={CalendarClockIcon}
            action={
              <Button size="sm" variant="outline" onClick={() => void go("triggers")}>
                Add a trigger
              </Button>
            }
          >
            No triggers. It runs only when you press Run now.
          </Empty>
        </Section>
      ) : (
        <Group
          label="Triggers"
          action={
            <Button variant="ghost" size="sm" onClick={() => void go("triggers")}>
              Manage
              <ChevronRightIcon data-icon="inline-end" />
            </Button>
          }
        >
          {triggers.map((t) => (
            <Row
              key={t.id}
              icon={TRIGGER_KIND[t.kind].icon}
              title={triggerTitle(t, triggers)}
              subtitle={
                <>
                  {triggerTerms(t)}
                  {t.lastError && <span className="block text-warning">{t.lastError}</span>}
                </>
              }
            >
              {!t.enabled ? (
                <StatusBadge dot={false}>Off</StatusBadge>
              ) : t.nextFireAt !== null ? (
                <span className="text-sm text-muted-foreground tabular-nums" title={new Date(t.nextFireAt).toLocaleString()}>
                  {untilLabel(t.nextFireAt, now)}
                </span>
              ) : null}
            </Row>
          ))}
        </Group>
      )}

      <Group
        label={routine.body.kind === "workflow" ? "What it runs" : "What it asks"}
        action={
          bodyLong ? (
            <Button variant="ghost" size="sm" onClick={() => setBodyOpen((open) => !open)}>
              {bodyOpen ? "Show less" : "Show all"}
            </Button>
          ) : undefined
        }
      >
        {routine.body.kind === "prompt" ? (
          <p className={`py-3 text-sm/relaxed whitespace-pre-wrap text-pretty ${bodyOpen ? "" : "line-clamp-[10]"}`}>
            {bodyText}
          </p>
        ) : (
          <pre className={`py-3 font-mono text-xs break-words whitespace-pre-wrap ${bodyOpen ? "" : "line-clamp-[14]"}`}>
            {bodyText}
          </pre>
        )}
      </Group>

      <Group label="Setup">
        {session ? (
          <Row
            title="Where"
            subtitle={
              <>
                Delivered into{" "}
                {pinnedThread ? (
                  <Link to={threadPath(pinnedThread.id)} className="text-foreground underline-offset-2 hover:underline">
                    {pinnedThread.title || "this thread"}
                  </Link>
                ) : (
                  "a thread that no longer exists"
                )}
              </>
            }
          >
            {changeButton("settings", "runs-in")}
          </Row>
        ) : (
          <Row
            title="Where"
            subtitle={`In ${project?.name ?? "a missing project"}, ${routine.worktree ? "in its own worktree" : "in the project's checkout"}`}
          >
            {changeButton("settings", "where")}
          </Row>
        )}
        {!session && (
          <Row
            title="Who"
            subtitle={
              <>
                {`${agentName} on ${profileName} · ${routine.model || "default model"} · ${routine.effort || "default effort"}`}
                {carries.length > 0 && <span className="block">Carries {carries.join(", ")}</span>}
              </>
            }
          >
            {changeButton("settings", "agent")}
          </Row>
        )}
        {session ? (
          <Row title="Access" subtitle="Uses the thread's own permissions" />
        ) : (
          <Row title="Access" subtitle={policySentence(routine.autonomy)}>
            {grants > 0 && <StatusBadge tone="warn">Acts alone on {grants}</StatusBadge>}
            {changeButton("access")}
          </Row>
        )}
        {!session && (
          <Row title="Limits" subtitle={limitsLine}>
            {changeButton("access")}
          </Row>
        )}
        <Row
          title="Overlap & catch-up"
          subtitle={[
            !session && (routine.overlap === "skip" ? "Skips a fire while one is running" : "Queues behind a running one"),
            routine.catchup === "once" ? "runs once to catch up after downtime" : "skips what was missed",
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          {changeButton("settings", "advanced")}
        </Row>
        <Row
          title="After it finishes"
          subtitle={routine.onFinish.length === 0 ? "Nothing" : routine.onFinish.map(onFinishLabel).join(" · ")}
        >
          {changeButton("settings", "after")}
        </Row>
        {!session && (
          <Row title="Answer" subtitle={routine.output ? "Returns a verdict against a schema" : "Answers in prose"}>
            {changeButton("settings", "advanced")}
          </Row>
        )}
        <Row
          title="History"
          subtitle={`Created ${new Date(routine.createdAt).toLocaleDateString()} · edited ${agoLabel(routine.updatedAt, now)}`}
        />
      </Group>
    </>
  )

  return (
    <>
      <SurfaceHeader
        onBack={back}
        icon={session ? MessagesSquareIcon : <ProjectIcon project={project} className="size-10" />}
        title={
          <span className="inline-flex min-w-0 items-center gap-2">
            <span className="truncate">{routine.name}</span>
            {running > 0 ? (
              <StatusBadge tone="info">Running</StatusBadge>
            ) : needsYou ? (
              <StatusBadge tone="warn">Needs you</StatusBadge>
            ) : null}
          </span>
        }
        description={routine.description ?? undefined}
        meta={
          session ? (
            <MetaFact title="Runs in">
              <MessagesSquareIcon className="size-3.5" />
              {pinnedThread ? (
                <Link to={threadPath(pinnedThread.id)} className="underline-offset-2 hover:underline">
                  {pinnedThread.title || "This thread"}
                </Link>
              ) : (
                "A thread that no longer exists"
              )}
            </MetaFact>
          ) : (
            <>
              <MetaFact title="Project">
                <ProjectIcon project={project} className="size-3.5" />
                {project?.name ?? "Project missing"}
                {routine.worktree && " · own worktree"}
              </MetaFact>
              <MetaFact title="Agent">
                <AgentIcon agentId={routine.agentId} className="size-3.5" />
                {[agentName, routine.model, routine.effort].filter(Boolean).join(" · ")}
              </MetaFact>
              <MetaFact title="Profile" className="hidden @panel-sm:inline-flex">
                <ProfileIcon profile={profile} agentId={routine.agentId} className="size-3.5" />
                {profileName}
              </MetaFact>
              {grants > 0 && (
                <button type="button" title="Open Access" onClick={() => void go("access")}>
                  <StatusBadge tone="warn">Acts alone on {grants}</StatusBadge>
                </button>
              )}
            </>
          )
        }
        actions={
          <div className="flex w-full items-center gap-2 @panel-sm:w-auto">
            <label className="mr-auto flex items-center gap-2 text-sm text-muted-foreground @panel-sm:mr-2">
              <Switch
                checked={routine.enabled}
                onCheckedChange={(on) => toggle(routine, on)}
                aria-label={routine.enabled ? "Pause automation" : "Resume automation"}
              />
              {routine.enabled ? "Active" : "Paused"}
            </label>
            {/* The dry run is the first-class one for a thread automation: it is
                what a person should press before granting anything. Narrow, it
                lives in the ⋮ menu. */}
            {!session && (
              <Button variant="outline" className="hidden @panel-sm:inline-flex" disabled={firing} onClick={() => void run(true)}>
                <ShieldCheckIcon data-icon="inline-start" />
                Run, forced to ask
              </Button>
            )}
            <Button disabled={firing} onClick={() => void run(false)}>
              <PlayIcon data-icon="inline-start" />
              Run now
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="outline" size="icon" className="shrink-0 pointer-coarse:size-11" title="More">
                    <MoreVerticalIcon />
                    <span className="sr-only">More actions</span>
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="w-52">
                {!session && (
                  <DropdownMenuItem disabled={firing} onClick={() => void run(true)}>
                    <ShieldCheckIcon />
                    Run, forced to ask
                  </DropdownMenuItem>
                )}
                {last?.sessionId && (
                  <DropdownMenuItem onClick={() => void navigate(threadPath(last.sessionId!))}>
                    <HistoryIcon />
                    Open last run&rsquo;s thread
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => void go("settings")}>
                  <PencilIcon />
                  Edit settings
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => duplicate(routine)}>
                  <CopyIcon />
                  Duplicate
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => {
                    void remove(routine).then((gone) => gone && back())
                  }}
                >
                  <Trash2Icon />
                  Delete automation
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
      />

      <TabBar label="Automation" items={tabItems} value={tab} onChange={(id) => void go(id as Tab)} />

      {(tab === "overview" || tab === "runs") && <StatStrip stats={stats} />}

      <div role="tabpanel" aria-label={TAB_LABEL[tab]}>
        {tab === "overview" && overview}

        {tab === "runs" && (
          <Section
            hint={`Newest first; skipped runs say why. ${health.tokens.toLocaleString()} tokens across these ${runs?.length ?? 0}.`}
          >
            {runsError ? (
              <ErrorNote error={runsError} onRetry={() => void runsQuery.refetch()} />
            ) : runs === undefined ? (
              <GroupRowsSkeleton rows={4} className="mt-0" />
            ) : (
              <>
                <RunList routineId={routine.id} runs={runs} hasOutputSchema={routine.output !== null} onCancel={stop} />
                <ErrorNote error={moreError} onRetry={() => void moreRuns.refetch()} className="mt-4" />
                {/* While the longer page loads the shorter one is still drawn,
                    so the button stays, disabled, rather than vanishing. */}
                {(runs.length >= limit || moreRuns.isFetching) && (
                  <Button
                    variant="outline"
                    className="mt-4 w-full @panel-sm:w-auto"
                    disabled={moreRuns.isFetching}
                    onClick={() => setLimit((l) => l + 100)}
                  >
                    {moreRuns.isFetching ? "Loading older runs…" : "Load older runs"}
                  </Button>
                )}
              </>
            )}
          </Section>
        )}

        {tab === "triggers" && <TriggersPanel routineId={routine.id} runsIn={routine.runsIn} />}

        {tab === "access" && <AccessPanel routine={routine} onEdit={() => void go("settings")} />}

        {tab === "settings" && draft && (
          <>
            {stale && (
              <div className="mb-8">
                <Notice
                  tone="info"
                  action={
                    <Button size="sm" variant="outline" onClick={() => reseed(routine)}>
                      Discard my edits
                    </Button>
                  }
                >
                  This automation changed since you began editing; saving keeps your version.
                </Notice>
              </div>
            )}
            <AutomationForm
              draft={draft}
              onChange={setDraft}
              actions={actions}
              mode="edit"
              routine={routine}
              onSubmit={submit}
              onCancel={() => {
                setDraft(seed)
                setTab("overview")
              }}
              busy={busy}
              error={error}
              submitLabel="Save automation"
              sectionBar={false}
              dirty={dirty}
              onOpenTriggers={() => void go("triggers")}
            />
          </>
        )}
      </div>
    </>
  )
}
