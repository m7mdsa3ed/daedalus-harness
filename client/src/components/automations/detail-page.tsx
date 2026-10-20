/* ── /automations/:id — one automation ──
   One URL, five tabs (`?tab=overview|runs|triggers|access|settings`, the
   overview carrying no param). The overview says a little of each — the newest
   five runs, the triggers with their next fire, the policy as facts — because
   "is it firing", "what did it decide" and "what is it allowed to do" get asked
   in one sitting. Runs include the skipped ones, each with its reason.
   Triggers and runs are read on this page and nowhere else. */
import * as React from "react"
import {
  CalendarClockIcon,
  ChevronRightIcon,
  HistoryIcon,
  MessagesSquareIcon,
  MoreVerticalIcon,
  PlayIcon,
  ShieldCheckIcon,
  Trash2Icon,
  WorkflowIcon,
} from "lucide-react"
import { Link, Navigate, useNavigate, useSearchParams } from "react-router"

import { AgentIcon, ProfileIcon, ProjectIcon } from "@/components/entity-icon"
import { ErrorNote } from "@/components/error-note"
import { Notice } from "@/components/notice"
import { MetaFact, SurfaceHeader } from "@/components/page-primitives"
import { Empty } from "@/components/empty"
import { GroupRowsSkeleton } from "@/components/ui/skeletons"
import {
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
import { automationsPath, threadPath } from "@/lib/router"
import { useStoreSelect } from "@/lib/store"
import { shortAge } from "@/lib/time"
import { toast } from "@/lib/toast"
import { AccessPanel } from "./access-panel"
import { AutomationForm, draftOf, problemNote, toInput, type AutomationDraft } from "./automation-form"
import { grantsOf, useFire, useRemove, useToggle } from "./hooks"
import { RunList } from "./runs"
import { RUN_STATUS, SOURCE_LABEL, runStatus } from "./status"
import { TriggersPanel } from "./triggers"
import { nextFireOf, TRIGGER_KIND, triggerTerms, untilLabel } from "./trigger-summary"

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

export function AutomationDetailPage({ automationId, actions }: { automationId: string; actions: Actions }) {
  const automationsQuery = useAutomations()
  const automations = automationsQuery.data
  const projects = useProjects()
  const agents = useAgents()
  const profiles = useProfiles()
  const sessions = useStoreSelect((state) => state.sessions)
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const routine = automations?.find((r) => r.id === automationId)

  /* The reads live in the cache; the query fetches on mount and the mutations
     (run, cancel) invalidate it, which is the refresh. A failed read leaves
     `data` undefined — skeletons, not "has never run". */
  const runsQuery = useAutomationRuns(automationId)
  const runs = runsQuery.data
  const runsError = React.useMemo(
    () => inlineFromQuery(runsQuery.error, "Couldn't read this automation's runs"),
    [runsQuery.error]
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

  const [draft, setDraft] = React.useState<AutomationDraft | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<InlineError | null>(null)
  const [firing, setFiring] = React.useState(false)

  /* Reset the form when the automation arrives or is replaced by a save, so a
     save's answer re-seeds the fields with what the server actually stored. */
  React.useEffect(() => {
    if (routine) setDraft(draftOf(routine))
  }, [routine])

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
              stats={["Last run", "Next run", "Runs", "Tokens"].map((label) => ({ label, value: null, loading: true }))}
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
      await update.mutateAsync({ id: routine.id, patch: parsed.input })
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
      setTab("runs")
    } finally {
      setFiring(false)
    }
  }

  /* Counted over what the page has read — the server's newest 50 — so a
     busy automation says "50+" rather than a total it does not know. */
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
  const nextFire = routine.enabled ? nextFireOf(triggers) : null
  const armed = triggers?.filter((t) => t.enabled) ?? []
  const grants = grantsOf(routine)

  const statTone = (status: string) => {
    const badge = runStatus(status).badge
    return badge === "bad" || badge === "warn" ? badge : undefined
  }
  const loadingRuns = runs === undefined && !runsError
  const stats = [
    {
      label: "Last run",
      value: last ? runStatus(last.status).label : "—",
      loading: loadingRuns,
      tone: last ? statTone(last.status) : undefined,
      hint: last
        ? `${shortAge(last.startedAt)} ago · ${SOURCE_LABEL[last.source] ?? last.source}`
        : runsError
          ? "couldn't read the runs"
          : "has not run yet",
    },
    {
      label: "Next run",
      value: nextFire ? untilLabel(nextFire) : "—",
      loading: triggers === undefined && !triggersQuery.error,
      hint: nextFire
        ? new Date(nextFire).toLocaleString()
        : !routine.enabled
          ? "paused"
          : armed.length === 0
            ? "no trigger is armed — runs by hand only"
            : armed.some((t) => t.kind !== "schedule")
              ? "waits on a webhook or a commit"
              : "the sweep has not armed a clock yet",
    },
    {
      label: "Runs",
      value: runs ? (runs.length >= 50 ? "50+" : runs.length) : "—",
      loading: loadingRuns,
      hint:
        running > 0
          ? `${running} running now`
          : outcomes
            ? `${outcomes.completed} completed · ${outcomes.failed} needed a person · ${outcomes.skipped} skipped`
            : "not read",
    },
    {
      label: "Tokens",
      value: tokens === undefined ? "—" : tokens.toLocaleString(),
      loading: loadingRuns,
      hint: runs && runs.length >= 50 ? "across the newest 50 runs" : "across every run",
    },
  ]

  const tabItems: TabItem[] = [
    { id: "overview", label: TAB_LABEL.overview },
    { id: "runs", label: TAB_LABEL.runs, count: running > 0 ? running : undefined },
    { id: "triggers", label: TAB_LABEL.triggers, count: triggers && triggers.length > 0 ? triggers.length : undefined },
    { id: "access", label: TAB_LABEL.access, dot: !session && grants > 0 },
    { id: "settings", label: TAB_LABEL.settings },
  ]

  const stop = async (runId: string) => cancelRun.mutate({ routineId: routine.id, runId })

  return (
    <>
      <SurfaceHeader
        onBack={back}
        icon={session ? MessagesSquareIcon : <ProjectIcon project={project} className="size-10" />}
        title={
          <span className="inline-flex min-w-0 items-center gap-2">
            <span className="truncate">{routine.name}</span>
            {!routine.enabled && <StatusBadge dot={false}>Paused</StatusBadge>}
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
                {agent?.name ?? routine.agentId}
              </MetaFact>
              <MetaFact title="Profile">
                <ProfileIcon profile={profile} agentId={routine.agentId} className="size-3.5" />
                {profile?.name ?? routine.profileId}
              </MetaFact>
              {routine.model && (
                <MetaFact title="Model">
                  {routine.model}
                  {routine.effort && ` · ${routine.effort}`}
                </MetaFact>
              )}
              <span title="Access">
                <StatusBadge tone={grants > 0 ? "warn" : "neutral"}>
                  {grants > 0 ? `Acts without asking for ${grants} kind${grants === 1 ? "" : "s"} of tool` : "Asks a person for everything"}
                </StatusBadge>
              </span>
            </>
          )
        }
        actions={
          <>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch
                checked={routine.enabled}
                onCheckedChange={(on) => toggle(routine, on)}
                aria-label={routine.enabled ? "Pause automation" : "Resume automation"}
              />
              {routine.enabled ? "Active" : "Paused"}
            </div>
            {/* The dry run is the first-class one for a thread automation: it is
                what a person should press before granting anything. */}
            {!session && (
              <Button variant="outline" disabled={firing} onClick={() => void run(true)}>
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
                    Open last run&rsquo;s thread
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
                  Delete automation
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <TabBar label="Automation" items={tabItems} value={tab} onChange={(id) => setTab(id as Tab)} />

      {tab !== "settings" && <StatStrip stats={stats} />}

      {!session && !routine.dryRunCompleted && (
        <Section>
          <Notice>
            This automation has not completed a run yet, so it cannot be granted a blanket{" "}
            <strong className="font-medium text-foreground">Allow</strong>. Press{" "}
            <strong className="font-medium text-foreground">Run, forced to ask</strong> and watch what it does first — the
            per-kind answers in Access are available either way.
          </Notice>
        </Section>
      )}

      <div role="tabpanel" aria-label={TAB_LABEL[tab]}>
        {tab === "overview" && (
          <>
            <Section
              label="Recent runs"
              action={
                runs && runs.length > 5 ? (
                  <Button variant="ghost" size="sm" onClick={() => setTab("runs")}>
                    All runs
                    <ChevronRightIcon data-icon="inline-end" />
                  </Button>
                ) : undefined
              }
            >
              <ErrorNote error={runsError} onRetry={() => void runsQuery.refetch()} />
              {runsError ? null : (
                <RunList routineId={routine.id} runs={runs?.slice(0, 5)} hasOutputSchema={routine.output !== null} onCancel={stop} />
              )}
            </Section>

            <Group label={routine.body.kind === "workflow" ? "What it runs" : "What it asks"}>
              {routine.body.kind === "prompt" ? (
                <p className="max-h-64 overflow-y-auto py-3 text-sm whitespace-pre-wrap text-pretty">{routine.body.text}</p>
              ) : (
                <p className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
                  <WorkflowIcon className="size-4" />
                  A declarative workflow, {Object.keys(routine.body.definition).length} top-level keys. Open Settings to read it.
                </p>
              )}
            </Group>

            {(() => {
              const manage = (
                <Button variant="ghost" size="sm" onClick={() => setTab("triggers")}>
                  Manage
                  <ChevronRightIcon data-icon="inline-end" />
                </Button>
              )
              if (triggers !== undefined && triggers.length > 0 && !triggersError)
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
                  {triggersError ? (
                    <ErrorNote error={triggersError} onRetry={() => void triggersQuery.refetch()} />
                  ) : triggers === undefined ? (
                    <GroupRowsSkeleton rows={2} className="mt-0" />
                  ) : (
                    <Empty icon={CalendarClockIcon}>No triggers. This automation only runs when you press Run now.</Empty>
                  )}
                </Section>
              )
            })()}

            <Group label="Behaviour">
              {!session && (
                <Row title="Overlap">
                  <span className="text-sm">{routine.overlap === "skip" ? "Skip while one is running" : "Queue behind it"}</span>
                </Row>
              )}
              <Row title="After the server was off">
                <span className="text-sm">{routine.catchup === "once" ? "Run once to catch up" : "Skip what was missed"}</span>
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
            hint={`Newest first, skipped ones included with their reason. ${Object.values(RUN_STATUS).map((s) => s.label).join(", ")} — each row says what its word means.`}
          >
            <ErrorNote error={runsError} onRetry={() => void runsQuery.refetch()} />
            {runsError ? null : <RunList routineId={routine.id} runs={runs} hasOutputSchema={routine.output !== null} onCancel={stop} />}
          </Section>
        )}

        {tab === "triggers" && <TriggersPanel routineId={routine.id} />}

        {tab === "access" && <AccessPanel routine={routine} onEdit={() => setTab("settings")} />}

        {tab === "settings" && draft && (
          <AutomationForm
            draft={draft}
            onChange={setDraft}
            actions={actions}
            mode="edit"
            routine={routine}
            onSubmit={submit}
            onCancel={back}
            busy={busy}
            error={error}
            submitLabel="Save automation"
            sectionBar={false}
          />
        )}
      </div>
    </>
  )
}
