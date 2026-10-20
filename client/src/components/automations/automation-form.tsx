/* ── The automation form ──
   One form for the create page and the detail page's Settings tab. Its
   sections follow the order a person decides things in: what to say, where it
   runs, when, where on disk, who runs it, what it may do, what happens after —
   and an Advanced fold for the rest.

   ── Runs in ──
   `New thread` mints a thread per fire, the way the composer would; `This
   thread` delivers the prompt into one existing thread, which keeps its own
   agent, model and permissions. So for `This thread` the Where, Agent and
   Access sections are not drawn at all — the server derives them from the
   thread, and a control that is ignored is a control that lies.

   ── The facade ──
   The Where and Agent sections are drawn by the composer's own controls
   (`DraftScopeRow`, `DraftConfigPopover`), verbatim, so an automation cannot
   start a thread the composer could not. Those write through
   `actions.configureDraft`, which dispatches into the draft-session slice; an
   automation is not a draft session and must never show up in the sidebar as
   one, so they are handed a facade: a `SessionMeta` built from this form's
   state, never dispatched, and an `Actions` whose two draft writers are
   replaced by this form's setter. `remember={false}` keeps them from saving
   the pick as the next new thread's default.

   ── When ──
   Triggers are rows of their own on the server. On create, the form's When
   section (and the Advanced fold's webhook and commit switches) become
   trigger rows written right after the automation; on an existing automation
   they are edited in the Triggers tab, and the form says so rather than
   holding a second copy. `problemOf` is the one validator, it names a section,
   and `toInput` calls it. Every section is always mounted. */
import * as React from "react"
import { ChevronRightIcon } from "lucide-react"

import { DraftConfigPopover, DraftScopeRow } from "@/components/draft-config"
import { Notice } from "@/components/notice"
import {
  FIELD_GRID,
  Field,
  FormActions,
  FormSection,
  FormShell,
  INSET,
  PageForm,
  Section,
  Segmented,
  StatusBadge,
} from "@/components/settings/primitives"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import type { Actions } from "@/lib/actions"
import { defaultPlan, planProblem, planToTrigger, type SchedulePlan } from "@/lib/automation-schedule"
import type { InlineError } from "@/lib/errors"
import { useProjects } from "@/lib/queries/catalog"
import { useAutomations } from "@/lib/queries/automations"
import {
  ASK_EVERYTHING,
  isListed,
  type AutonomyPolicy,
  type OnFinishAction,
  type Routine,
  type RoutineBody,
  type RoutineCatchup,
  type RoutineInput,
  type RoutineOverlap,
  type RoutineRunsIn,
  type RoutineTriggerInput,
  type SessionMeta,
} from "@/lib/settings"
import { useStoreSelect } from "@/lib/store"
import { lines } from "@/components/settings/primitives"
import { AutonomyLimits, AutonomyPermissions } from "./autonomy-control"
import { OnFinishEditor } from "./on-finish"
import { SchedulePicker } from "./schedule-picker"
import type { AutomationTemplate } from "./templates"

/** Everything the form holds. The routine's input with the links kept nested and
    the two JSON fields kept as *text*, because a half-typed JSON schema is not
    a `Record` and a form that could only hold parseable values would delete
    what you were in the middle of writing. They are parsed once, on submit. */
export interface AutomationDraft {
  name: string
  description: string
  enabled: boolean
  runsIn: RoutineRunsIn
  sessionId: string
  projectId: string
  profileId: string
  agentId: string
  model: string
  effort: string
  configChoices: Record<string, string | boolean>
  mcpServerIds: string[]
  skillIds: string[]
  commandIds: string[]
  worktree: boolean
  bodyKind: RoutineBody["kind"]
  promptText: string
  workflowText: string
  outputText: string
  onFinish: OnFinishAction[]
  overlap: RoutineOverlap
  catchup: RoutineCatchup
  autonomy: AutonomyPolicy
  /** Create only: the first schedule trigger. */
  plan: SchedulePlan
  /** Create only: also add a webhook trigger. */
  apiTrigger: boolean
  /** Create only: also add a commit trigger. */
  git: { on: boolean; branch: string; paths: string }
}

/** An automation, back into the form's shape. */
export function draftOf(routine: Routine): AutomationDraft {
  return {
    name: routine.name,
    description: routine.description ?? "",
    enabled: routine.enabled,
    runsIn: routine.runsIn,
    sessionId: routine.sessionId ?? "",
    projectId: routine.projectId,
    profileId: routine.profileId,
    agentId: routine.agentId,
    model: routine.model,
    effort: routine.effort,
    configChoices: routine.configChoices,
    mcpServerIds: routine.links.mcpServerIds,
    skillIds: routine.links.skillIds,
    commandIds: routine.links.commandIds,
    worktree: routine.worktree,
    bodyKind: routine.body.kind,
    promptText: routine.body.kind === "prompt" ? routine.body.text : "",
    workflowText: routine.body.kind === "workflow" ? JSON.stringify(routine.body.definition, null, 2) : "",
    outputText: routine.output ? JSON.stringify(routine.output, null, 2) : "",
    onFinish: routine.onFinish,
    overlap: routine.overlap,
    catchup: routine.catchup,
    autonomy: routine.autonomy,
    plan: defaultPlan(),
    apiTrigger: false,
    git: { on: false, branch: "", paths: "" },
  }
}

/** A blank automation. It opens on `ASK_EVERYTHING` deliberately: a policy that
    started anywhere else would be a grant made by a default rather than by a
    person, which is the whole thing the autonomy control is built around. */
export function blankDraft(seed: { projectId: string; profileId: string; agentId: string }): AutomationDraft {
  return {
    name: "",
    description: "",
    enabled: true,
    runsIn: "thread",
    sessionId: "",
    ...seed,
    model: "",
    effort: "",
    configChoices: {},
    mcpServerIds: [],
    skillIds: [],
    commandIds: [],
    worktree: false,
    bodyKind: "prompt",
    promptText: "",
    workflowText: "",
    outputText: "",
    onFinish: [],
    overlap: "skip",
    catchup: "once",
    autonomy: ASK_EVERYTHING,
    plan: defaultPlan(),
    apiTrigger: false,
    git: { on: false, branch: "", paths: "" },
  }
}

/** A template poured over a draft. Only what the template says: the pickers a
    person already set (project, agent) stay. */
export function applyTemplate(draft: AutomationDraft, template: AutomationTemplate): AutomationDraft {
  return {
    ...draft,
    name: template.name,
    runsIn: template.runsIn,
    bodyKind: "prompt",
    promptText: template.prompt,
    plan: defaultPlan(template.plan),
    apiTrigger: Boolean(template.api),
    git: { ...draft.git, on: Boolean(template.git) },
  }
}

/* ── Sections ── */

const SECTIONS = [
  { id: "prompt", label: "Prompt", title: "What it does", blurb: "Name it, and say what to do and what success looks like. An unattended run has nobody to ask." },
  { id: "runs-in", label: "Runs in", title: "Runs in", blurb: "A new thread for every fire, or a message into a thread that already exists." },
  { id: "when", label: "When", title: "When", blurb: "A clock the server keeps, browser or no browser. Webhooks and commits are under Advanced." },
  { id: "where", label: "Where", title: "Where", blurb: "The directory every run works in, and whether each run gets a checkout of its own." },
  { id: "agent", label: "Agent", title: "Agent", blurb: "Which profile, model and effort answer. Anything a thread can start with, an automation can." },
  { id: "access", label: "Access", title: "Access", blurb: "Which of the agent's questions the harness answers for you, kind by kind. The section worth reading twice." },
  { id: "after", label: "After", title: "After it finishes", blurb: "Where the answer goes. A transcript nobody opens is not a result." },
  { id: "advanced", label: "Advanced", title: "Advanced", blurb: "Overlap, catch-up, webhook, commit trigger, answer schema." },
] as const satisfies readonly { id: string; label: string; title: string; blurb: string }[]

export type AutomationSectionId = (typeof SECTIONS)[number]["id"]

type Mode = "create" | "edit"

/** The one validator, and the reason it names a section: a complaint the form
    cannot point at is a complaint you go looking for. */
export function problemOf(
  draft: AutomationDraft,
  mode: Mode
): { section: AutomationSectionId; problem: string } | null {
  if (!draft.name.trim()) return { section: "prompt", problem: "Give the automation a name." }
  if (draft.bodyKind === "prompt") {
    if (!draft.promptText.trim()) return { section: "prompt", problem: "An automation needs a prompt." }
  } else {
    const parsed = parseObject(draft.workflowText)
    if ("problem" in parsed) return { section: "prompt", problem: `Workflow definition: ${parsed.problem}` }
  }
  if (draft.runsIn === "session") {
    if (!draft.sessionId) return { section: "runs-in", problem: "Pick the thread it runs in." }
  } else {
    if (!draft.projectId) return { section: "where", problem: "Pick a project — it is the directory every run works in." }
    if (!draft.profileId || !draft.agentId) return { section: "agent", problem: "Pick an agent and a profile." }
  }
  if (mode === "create") {
    const clock = planProblem(draft.plan)
    if (clock) return { section: "when", problem: clock }
  }
  if (draft.outputText.trim()) {
    const parsed = parseObject(draft.outputText)
    if ("problem" in parsed) return { section: "advanced", problem: `Answer schema: ${parsed.problem}` }
  }
  return null
}

/** What a draft is worth sending, or the sentence that says why it is not. */
export function toInput(draft: AutomationDraft, mode: Mode): { input: RoutineInput } | { problem: string } {
  const complaint = problemOf(draft, mode)
  if (complaint) return { problem: complaint.problem }

  const session = draft.runsIn === "session"
  const body: RoutineBody =
    draft.bodyKind === "prompt" || session
      ? { kind: "prompt", text: draft.promptText.trim() }
      : { kind: "workflow", definition: (parseObject(draft.workflowText) as { value: Record<string, unknown> }).value }
  const output = draft.outputText.trim() ? (parseObject(draft.outputText) as { value: Record<string, unknown> }).value : null

  return {
    input: {
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      enabled: draft.enabled,
      runsIn: draft.runsIn,
      sessionId: session ? draft.sessionId : null,
      catchup: draft.catchup,
      worktree: session ? false : draft.worktree,
      ...(session
        ? {}
        : {
            projectId: draft.projectId,
            profileId: draft.profileId,
            agentId: draft.agentId,
            model: draft.model,
            effort: draft.effort,
            configChoices: draft.configChoices,
            autonomy: draft.autonomy,
            mcpServerIds: draft.mcpServerIds,
            skillIds: draft.skillIds,
            commandIds: draft.commandIds,
          }),
      body,
      output,
      onFinish: draft.onFinish,
      overlap: session ? "skip" : draft.overlap,
    },
  }
}

/** The trigger rows a new automation is written with: the clock (or the manual
    marker, when nothing else fires it), plus the webhook and commit switches. */
export function triggersOf(draft: AutomationDraft): RoutineTriggerInput[] {
  const out: RoutineTriggerInput[] = []
  const clock = planToTrigger(draft.plan)
  const others: RoutineTriggerInput[] = []
  if (draft.apiTrigger) others.push({ kind: "api" })
  if (draft.git.on && draft.runsIn === "thread")
    others.push({ kind: "git", branch: draft.git.branch.trim() || null, paths: lines(draft.git.paths) })
  if (clock.kind !== "manual" || others.length === 0) out.push(clock)
  return [...out, ...others]
}

/** A validity complaint, in the shape `ErrorNote` draws. Deliberately not run
    through `captureError`: nothing was thrown, nothing reached the server. */
export function problemNote(problem: string): InlineError {
  return {
    title: "This automation is not ready to save",
    detail: problem,
    kind: "unknown",
    text: `This automation is not ready to save\n${problem}`,
  }
}

function parseObject(text: string): { value: Record<string, unknown> } | { problem: string } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    return { problem: err instanceof Error ? err.message : "not valid JSON" }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { problem: "expected a JSON object." }
  return { value: value as Record<string, unknown> }
}

const grantCount = (policy: AutonomyPolicy) => Object.values(policy.permissions).filter((s) => s === "allow").length

const sectionId = (id: AutomationSectionId) => `automation-${id}`

export function AutomationForm({
  draft,
  onChange,
  actions,
  mode,
  /** The automation being edited, for the two things a draft cannot know:
      whether a run has completed (the blanket-grant gate) and which others
      exist to chain to. Absent while creating. */
  routine,
  onSubmit,
  onCancel,
  busy,
  error,
  submitLabel,
  sectionBar = true,
  onBrowseTemplates,
}: {
  draft: AutomationDraft
  onChange: (next: AutomationDraft) => void
  actions: Actions
  mode: Mode
  routine?: Routine
  onSubmit: (event: React.FormEvent) => void
  onCancel: () => void
  busy: boolean
  error: InlineError | null
  submitLabel: string
  /** Draw the scroll-spied section bar. Off inside a tab of a page that has its own `TabBar`. */
  sectionBar?: boolean
  /** Create only: back to the gallery. */
  onBrowseTemplates?: () => void
}) {
  const projects = useProjects()
  const automations = useAutomations().data ?? []
  const allSessions = useStoreSelect((state) => state.sessions)
  const threads = React.useMemo(() => allSessions.filter((s) => isListed(s) && !s.deletedAt), [allSessions])
  const session = draft.runsIn === "session"

  const patch = React.useCallback(
    (next: Partial<AutomationDraft>) => onChange({ ...draft, ...next }),
    [draft, onChange]
  )

  const project = projects.find((p) => p.id === draft.projectId)
  const complaint = problemOf(draft, mode)
  const grants = grantCount(draft.autonomy)
  const broken = complaint?.section
  const [advancedOpen, setAdvancedOpen] = React.useState(false)

  const visible = React.useMemo(
    () =>
      SECTIONS.filter(
        (s) =>
          !(s.id === "when" && mode === "edit") &&
          !(session && (s.id === "where" || s.id === "agent" || s.id === "access"))
      ),
    [mode, session]
  )
  const bar = React.useMemo(
    () => visible.map((s) => ({ id: sectionId(s.id), label: s.label, dot: broken === s.id })),
    [visible, broken]
  )

  const meta = React.useMemo<SessionMeta>(
    () => ({
      id: routine?.id ?? "new",
      profileId: draft.profileId,
      projectId: draft.projectId,
      agentId: draft.agentId,
      model: draft.model,
      effort: draft.effort,
      configChoices: draft.configChoices,
      mcpServerIds: draft.mcpServerIds,
      skillIds: draft.skillIds,
      commandIds: draft.commandIds,
      title: draft.name,
      createdAt: 0,
      deletedAt: null,
      attached: false,
      exited: false,
      promptActive: false,
      cursor: 0,
      draft: true,
    }),
    [routine?.id, draft]
  )

  const facade = React.useMemo<Actions>(
    () => ({
      ...actions,
      configureDraft: (_id, next) => patch(next as Partial<AutomationDraft>),
      chooseDraftConfigOption: (_id, configId, value) =>
        patch({ configChoices: { ...draft.configChoices, [configId]: value } }),
    }),
    [actions, patch, draft.configChoices]
  )

  /* Submitting from any section is submitting the whole automation, so a form
     that is not ready shows you *where* before the parent's note says what. */
  const submit = (event: React.FormEvent) => {
    if (complaint) {
      if (complaint.section === "advanced") setAdvancedOpen(true)
      document.getElementById(sectionId(complaint.section))?.scrollIntoView({ behavior: "smooth", block: "start" })
    }
    onSubmit(event)
  }

  const section = (id: AutomationSectionId, children: React.ReactNode) => {
    if (!visible.some((s) => s.id === id)) return null
    const entry = SECTIONS.find((s) => s.id === id)!
    return (
      <FormSection id={sectionId(id)} label={entry.title} hint={entry.blurb}>
        {children}
      </FormSection>
    )
  }

  const body = (
    <>
      {onBrowseTemplates && (
        <div className="flex justify-end">
          <Button type="button" variant="outline" size="sm" className="pointer-coarse:h-11" onClick={onBrowseTemplates}>
            Browse templates
          </Button>
        </div>
      )}

      {section(
        "prompt",
        <>
          <Field label="Name">
            <Input value={draft.name} onChange={(e) => patch({ name: e.target.value })} placeholder="Daily repo brief" />
          </Field>
          {!session && (
            <Field label="Body">
              <Segmented
                label="Body"
                value={draft.bodyKind}
                onChange={(kind) => patch({ bodyKind: kind })}
                options={[
                  { value: "prompt", label: "A prompt" },
                  { value: "workflow", label: "A workflow" },
                ]}
              />
            </Field>
          )}
          {draft.bodyKind === "prompt" || session ? (
            <Field
              label="Prompt"
              hint="Make it self-contained and say what success looks like — nobody is there to answer a clarifying question. Sent exactly as typed."
            >
              <Textarea
                rows={10}
                value={draft.promptText}
                onChange={(e) => patch({ promptText: e.target.value })}
                placeholder="Review everything that changed today and tell me what needs attention. If nothing did, say so in one line."
              />
            </Field>
          ) : (
            <Field
              label="Workflow definition (JSON)"
              hint="Named steps or phases, with dependsOn edges and {{inputs}} templates. The server validates it on save and says what is wrong."
            >
              <Textarea
                className="font-mono"
                rows={16}
                value={draft.workflowText}
                onChange={(e) => patch({ workflowText: e.target.value })}
                placeholder={'{\n  "name": "nightly",\n  "phases": [\n    { "name": "scan", "steps": [ … ] }\n  ]\n}'}
              />
            </Field>
          )}
          <Field label="Description" hint="What it is for, in the list.">
            <Input value={draft.description} onChange={(e) => patch({ description: e.target.value })} placeholder="Optional" />
          </Field>
        </>
      )}

      {section(
        "runs-in",
        <>
          <Segmented
            label="Runs in"
            disabled={mode === "edit"}
            value={draft.runsIn}
            onChange={(runsIn) => patch({ runsIn, ...(runsIn === "session" ? { bodyKind: "prompt" as const } : {}) })}
            options={[
              { value: "thread", label: "New thread" },
              { value: "session", label: "This thread" },
            ]}
          />
          {session ? (
            <>
              <Field
                label="Thread"
                hint="The prompt is delivered into this thread on every fire, queued if a turn is running. The thread keeps its own agent, model and permissions."
              >
                <Select value={draft.sessionId} onValueChange={(v) => v && patch({ sessionId: v })}>
                  <SelectTrigger className="w-full">
                    <SelectValue>
                      {threads.find((t) => t.id === draft.sessionId)?.title || (draft.sessionId ? "Untitled thread" : "Select a thread")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {threads.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.title || "Untitled thread"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {threads.length === 0 && (
                <Notice tone="warn">No thread to pin to yet — send a message in one first, or choose New thread.</Notice>
              )}
            </>
          ) : (
            <p className="px-1 text-xs text-muted-foreground">
              Every fire starts a fresh thread, exactly as the composer would, and links it back to its run.
            </p>
          )}
        </>
      )}

      {section(
        "when",
        <SchedulePicker plan={draft.plan} onChange={(plan) => patch({ plan })} />
      )}
      {mode === "edit" && (
        <Section>
          <Notice tone="info">When it fires — the schedule, a webhook, a commit — is edited in the Triggers tab.</Notice>
        </Section>
      )}

      {section(
        "where",
        <>
          <div className={INSET}>
            <DraftScopeRow meta={meta} actions={facade} remember={false} />
          </div>
          {project ? (
            <p className="px-1 text-xs text-muted-foreground">
              Every run works in <code className="font-mono text-foreground">{project.cwd}</code>.
            </p>
          ) : (
            <p className="px-1 text-sm text-destructive">Pick a project: it is the directory every run acts in.</p>
          )}
          <label className="flex items-start gap-2.5">
            <Switch className="mt-0.5" checked={draft.worktree} onCheckedChange={(worktree) => patch({ worktree })} />
            <span className="text-sm">
              Give each run its own git worktree
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Runs on a branch of their own, so two of them — or a run and you — never edit the same files.
                Only at a repository root.
              </span>
            </span>
          </label>
        </>
      )}

      {section(
        "agent",
        <div className={INSET}>
          <div className="px-1 py-0.5">
            <DraftConfigPopover meta={meta} actions={facade} remember={false} />
          </div>
        </div>
      )}

      {section(
        "access",
        <>
          <AutonomyPermissions
            policy={draft.autonomy}
            onChange={(autonomy) => patch({ autonomy })}
            cwd={project?.cwd ?? ""}
            projectName={project?.name ?? "this project"}
            dryRunCompleted={routine?.dryRunCompleted ?? false}
          />
          <AutonomyLimits policy={draft.autonomy} onChange={(autonomy) => patch({ autonomy })} />
        </>
      )}

      {section(
        "after",
        <OnFinishEditor
          value={draft.onFinish}
          onChange={(onFinish) => patch({ onFinish })}
          routines={automations.filter((r) => r.id !== routine?.id)}
        />
      )}

      {section(
        "advanced",
        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <CollapsibleTrigger className="group flex w-full items-center gap-2 text-sm font-medium">
            <ChevronRightIcon className="size-4 transition-transform group-data-[panel-open]:rotate-90" aria-hidden />
            {advancedOpen ? "Hide" : "Show"} overlap, catch-up, webhook and commit triggers
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-4 pt-4">
            <label className="flex items-center gap-2.5">
              <Switch checked={draft.enabled} onCheckedChange={(on) => patch({ enabled: on })} />
              <span className="text-sm">
                Enabled
                <span className="ml-1.5 text-xs text-muted-foreground">
                  — off keeps the automation and its history, and makes every trigger inert.
                </span>
              </span>
            </label>
            {!session && (
              <Field
                label="If the previous run is still going"
                hint="Skip is what stops a nightly review that is still running from becoming two agents in one directory."
              >
                <Segmented
                  label="If the previous run is still going"
                  value={draft.overlap}
                  onChange={(overlap) => patch({ overlap })}
                  options={[
                    { value: "skip", label: "Skip this fire" },
                    { value: "queue", label: "Queue behind it" },
                  ]}
                />
              </Field>
            )}
            <Field
              label="After the server was off"
              hint="On boot or wake: run once for the newest slot missed in the last 7 days, or only record the missed ones as skipped."
            >
              <Segmented
                label="After the server was off"
                value={draft.catchup}
                onChange={(catchup) => patch({ catchup })}
                options={[
                  { value: "once", label: "Run once to catch up" },
                  { value: "none", label: "Skip what was missed" },
                ]}
              />
            </Field>
            {mode === "create" && (
              <>
                <label className="flex items-start gap-2.5">
                  <Switch className="mt-0.5" checked={draft.apiTrigger} onCheckedChange={(apiTrigger) => patch({ apiTrigger })} />
                  <span className="text-sm">
                    API trigger
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      A POST to a URL fires it. The token is minted from the Triggers tab and shown once.
                    </span>
                  </span>
                </label>
                {!session && (
                  <div className="space-y-3">
                    <label className="flex items-start gap-2.5">
                      <Switch
                        className="mt-0.5"
                        checked={draft.git.on}
                        onCheckedChange={(on) => patch({ git: { ...draft.git, on } })}
                      />
                      <span className="text-sm">
                        Commit trigger
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          The project's HEAD moving fires it, debounced.
                        </span>
                      </span>
                    </label>
                    {draft.git.on && (
                      <div className={FIELD_GRID}>
                        <Field label="Branch" hint="Blank fires on any branch.">
                          <Input
                            placeholder="any branch"
                            value={draft.git.branch}
                            onChange={(e) => patch({ git: { ...draft.git, branch: e.target.value } })}
                          />
                        </Field>
                        <Field label="Paths" hint="One glob per line. Empty means any path.">
                          <Textarea
                            className="font-mono"
                            rows={2}
                            value={draft.git.paths}
                            onChange={(e) => patch({ git: { ...draft.git, paths: e.target.value } })}
                          />
                        </Field>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
            {!session && (
              <Field
                label="Answer schema (JSON Schema, optional)"
                hint="Declaring one buys the run a repair turn and a structured verdict, which is what the run list leads with. Blank, a run says only that its turn ended."
              >
                <Textarea
                  className="font-mono"
                  rows={8}
                  value={draft.outputText}
                  onChange={(e) => patch({ outputText: e.target.value })}
                  placeholder={'{\n  "type": "object",\n  "properties": { "needsAttention": { "type": "boolean" } }\n}'}
                />
              </Field>
            )}
          </CollapsibleContent>
        </Collapsible>
      )}
    </>
  )

  return (
    <PageForm onSubmit={submit}>
      {sectionBar ? <FormShell sections={bar}>{body}</FormShell> : body}

      {/* Sticky, so the distance between changing a setting and committing it is
          zero from every section. */}
      <FormActions
        busy={busy}
        onCancel={onCancel}
        error={error}
        submitLabel={submitLabel}
        leading={
          !session && (
            <StatusBadge tone={grants > 0 ? "warn" : "neutral"}>
              {grants === 0 ? "Asks a person for everything" : `Acts without asking for ${grants} kind${grants === 1 ? "" : "s"}`}
            </StatusBadge>
          )
        }
      />
    </PageForm>
  )
}
