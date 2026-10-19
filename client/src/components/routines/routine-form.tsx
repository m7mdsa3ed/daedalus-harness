/* ── The routine form ──
   A routine is a saved thread-start, so the half of this form that decides
   *how* the thread starts is drawn by the composer's own controls, not by
   copies of them: `DraftScopeRow` (project and the tools menu) and
   `DraftConfigPopover` (agent, profile, model, effort), verbatim. That is a
   constraint and not a convenience — a routine that needed a picker the draft
   composer does not have would be a routine that can start a thread you could
   not start by hand, which is the one thing the shape is meant to prevent.

   Those two components write through `actions.configureDraft(meta.id, …)`,
   which dispatches into the store's draft-session slice. A routine is not a
   draft session and must never appear in the sidebar as one, so what they are
   handed here is a **facade**: a `SessionMeta` built from the form's own state
   and never dispatched anywhere, and an `Actions` whose two draft writers are
   replaced by this form's setter. Everything else on the object is the real
   thing — `learnAgentOptions` in particular, because the model and effort rows
   only exist once the agent's option set is known, and probing for it is
   exactly what should happen when you pick a profile here.

   The facade cannot intercept everything, though: those components also call
   `saveThreadDefaults()` on every pick, which is a localStorage habit store the
   next ⌘N reads. Editing a nightly job must not silently change what a new
   thread opens on, so they take `remember={false}` here — the one prop this
   form adds to them, and the reason it exists.

   ── The layout ──
   Six `FormSection`s down one column, with the kit's `FormShell` bar above
   them (a scroll-spied `TabBar` of anchors, no side rail). Stacked, because a
   routine is the widest thing in the harness a person configures in one
   sitting and the autonomy section is worth reading in context. Two things
   keep it honest:

   - **A section that is not ready says so on the bar** (a dot), and submitting
     scrolls to it. `problemOf` is the one validator; `toInput` calls it.
   - **Save is always on screen.** The action bar is sticky, so the distance
     between changing a permission and committing it is zero wherever you are.

   `sectionBar={false}` is for the routine page's Settings tab, which already
   sits under that page's own `TabBar`: two tracks one under the other are two
   navigations for one page, and the outer one is the one the page is about.
   Every section is always mounted: `DraftScopeRow` probes the agent's option
   set on mount, and a half-typed JSON schema keeps its cursor. */
import * as React from "react"

import { DraftConfigPopover, DraftScopeRow } from "@/components/draft-config"
import { ErrorNote } from "@/components/error-note"
import { Field, FormSection, FormShell, INSET, PageForm, Segmented, StatusBadge } from "@/components/settings/primitives"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import type { Actions } from "@/lib/actions"
import type { InlineError } from "@/lib/errors"
import {
  ASK_EVERYTHING,
  type AutonomyPolicy,
  type OnFinishAction,
  type Routine,
  type RoutineBody,
  type RoutineInput,
  type RoutineOverlap,
  type SessionMeta,
} from "@/lib/settings"
import { useAgents, useProjects } from "@/lib/queries/catalog"
import { useRoutines } from "@/lib/queries/routines"
import { AutonomyLimits, AutonomyPermissions } from "./autonomy-control"
import { OnFinishEditor } from "./on-finish"

/** Everything the form holds. `RoutineInput` with the links kept nested and the
    two JSON fields kept as *text*, because a half-typed JSON schema is not a
    `Record` and a form that could only hold parseable values would delete what
    you were in the middle of writing. They are parsed once, on submit. */
export interface RoutineDraft {
  name: string
  description: string
  enabled: boolean
  projectId: string
  profileId: string
  agentId: string
  model: string
  effort: string
  configChoices: Record<string, string | boolean>
  mcpServerIds: string[]
  skillIds: string[]
  commandIds: string[]
  bodyKind: RoutineBody["kind"]
  promptText: string
  workflowText: string
  outputText: string
  onFinish: OnFinishAction[]
  overlap: RoutineOverlap
  autonomy: AutonomyPolicy
}

/** A routine, back into the form's shape. */
export function draftOf(routine: Routine): RoutineDraft {
  return {
    name: routine.name,
    description: routine.description ?? "",
    enabled: routine.enabled,
    projectId: routine.projectId,
    profileId: routine.profileId,
    agentId: routine.agentId,
    model: routine.model,
    effort: routine.effort,
    configChoices: routine.configChoices,
    mcpServerIds: routine.links.mcpServerIds,
    skillIds: routine.links.skillIds,
    commandIds: routine.links.commandIds,
    bodyKind: routine.body.kind,
    promptText: routine.body.kind === "prompt" ? routine.body.text : "",
    workflowText:
      routine.body.kind === "workflow" ? JSON.stringify(routine.body.definition, null, 2) : "",
    outputText: routine.output ? JSON.stringify(routine.output, null, 2) : "",
    onFinish: routine.onFinish,
    overlap: routine.overlap,
    autonomy: routine.autonomy,
  }
}

/** A blank routine. It opens on `ASK_EVERYTHING` deliberately: a policy that
    started anywhere else would be a grant made by a default rather than by a
    person, which is the whole thing the autonomy control is built around. */
export function blankDraft(seed: {
  projectId: string
  profileId: string
  agentId: string
}): RoutineDraft {
  return {
    name: "",
    description: "",
    enabled: true,
    ...seed,
    model: "",
    effort: "",
    configChoices: {},
    mcpServerIds: [],
    skillIds: [],
    commandIds: [],
    bodyKind: "prompt",
    promptText: "",
    workflowText: "",
    outputText: "",
    onFinish: [],
    overlap: "skip",
    autonomy: ASK_EVERYTHING,
  }
}

/* ── Sections ── */

const SECTIONS = [
  {
    id: "basics",
    label: "Basics",
    title: "Basics",
    blurb: "What this routine is called, and whether its triggers are live.",
  },
  {
    id: "start",
    label: "How it starts",
    title: "How each run starts",
    blurb:
      "A run is one POST /api/sessions with these values and then one message, so a routine can start any thread you could start by hand — and nothing else.",
  },
  {
    id: "body",
    label: "What it runs",
    title: "What it runs",
    blurb: "The message the run opens with, or a whole declarative workflow.",
  },
  {
    id: "autonomy",
    label: "Autonomy",
    title: "Autonomy",
    blurb:
      "Which of the agent's questions the harness answers for you, kind by kind. This is the section worth reading twice.",
  },
  {
    id: "limits",
    label: "Limits",
    title: "Limits and overlap",
    blurb:
      "What an unanswered question falls through to, what a run may spend, and what a fire does when the last run is still going.",
  },
  {
    id: "finish",
    label: "When it finishes",
    title: "When a run finishes",
    blurb:
      "Where the answer goes. A transcript nobody opens is not a result — this is the difference between routines you read and routines you accumulate.",
  },
] as const satisfies readonly {
  id: string
  label: string
  title: string
  blurb: string
}[]

export type RoutineSectionId = (typeof SECTIONS)[number]["id"]

/** The one validator, and the reason it names a section: a complaint the form
    cannot point at is a complaint you go looking for. `toInput` calls it, the
    bar draws it, and submitting from any section scrolls to the one it names. */
export function problemOf(draft: RoutineDraft): { section: RoutineSectionId; problem: string } | null {
  if (!draft.name.trim()) return { section: "basics", problem: "Give the routine a name." }
  if (!draft.projectId)
    return { section: "start", problem: "Pick a project — it is the directory every run works in." }
  if (!draft.profileId || !draft.agentId)
    return { section: "start", problem: "Pick an agent and a profile." }

  if (draft.bodyKind === "prompt") {
    if (!draft.promptText.trim())
      return { section: "body", problem: "A prompt routine needs a prompt." }
  } else {
    const parsed = parseObject(draft.workflowText)
    if ("problem" in parsed)
      return { section: "body", problem: `Workflow definition: ${parsed.problem}` }
  }

  if (draft.outputText.trim()) {
    const parsed = parseObject(draft.outputText)
    if ("problem" in parsed) return { section: "body", problem: `Output schema: ${parsed.problem}` }
  }
  return null
}

/** What a `RoutineDraft` is worth sending, or the sentence that says why it is
    not. Parsing happens exactly here — a form that validated on every keystroke
    would be arguing with a half-typed schema. */
export function toInput(draft: RoutineDraft): { input: RoutineInput } | { problem: string } {
  const complaint = problemOf(draft)
  if (complaint) return { problem: complaint.problem }

  const body: RoutineBody =
    draft.bodyKind === "prompt"
      ? { kind: "prompt", text: draft.promptText.trim() }
      : { kind: "workflow", definition: (parseObject(draft.workflowText) as { value: Record<string, unknown> }).value }

  const output = draft.outputText.trim()
    ? (parseObject(draft.outputText) as { value: Record<string, unknown> }).value
    : null

  return {
    input: {
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      enabled: draft.enabled,
      projectId: draft.projectId,
      profileId: draft.profileId,
      agentId: draft.agentId,
      model: draft.model,
      effort: draft.effort,
      configChoices: draft.configChoices,
      body,
      output,
      onFinish: draft.onFinish,
      overlap: draft.overlap,
      autonomy: draft.autonomy,
      mcpServerIds: draft.mcpServerIds,
      skillIds: draft.skillIds,
      commandIds: draft.commandIds,
    },
  }
}

/** A validity complaint, in the shape `ErrorNote` draws. Deliberately not run
    through `captureError`: nothing was thrown, nothing reached the server, and
    logging it to the console beside real failures would make a blank name field
    read as a bug. `kind: "unknown"` is the honest class — it is not an RPC, an
    HTTP status or a network failure. */
export function problemNote(problem: string): InlineError {
  return {
    title: "This routine is not ready to save",
    detail: problem,
    kind: "unknown",
    text: `This routine is not ready to save\n${problem}`,
  }
}

function parseObject(text: string): { value: Record<string, unknown> } | { problem: string } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    return { problem: err instanceof Error ? err.message : "not valid JSON" }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { problem: "expected a JSON object." }
  return { value: value as Record<string, unknown> }
}

/** How many kinds this routine answers with `allow`. The rail's one number, and
    the same reading the list page's shield uses. */
const grantCount = (policy: AutonomyPolicy) =>
  Object.values(policy.permissions).filter((s) => s === "allow").length

export function RoutineForm({
  draft,
  onChange,
  actions,
  /** The routine being edited, for the two things a draft cannot know: whether
      a run has completed (the blanket-grant gate) and which routines exist to
      chain to. Absent while creating. */
  routine,
  onSubmit,
  onCancel,
  busy,
  error,
  submitLabel,
  sectionBar = true,
}: {
  draft: RoutineDraft
  onChange: (next: RoutineDraft) => void
  actions: Actions
  routine?: Routine
  onSubmit: (event: React.FormEvent) => void
  onCancel: () => void
  busy: boolean
  error: InlineError | null
  submitLabel: string
  /** Draw the scroll-spied section bar. Off inside a tab of a page that has
      its own `TabBar` (see the header comment). */
  sectionBar?: boolean
}) {
  const projects = useProjects()
  const agents = useAgents()
  const routines = useRoutines().data ?? []
  const patch = React.useCallback(
    (next: Partial<RoutineDraft>) => onChange({ ...draft, ...next }),
    [draft, onChange]
  )

  const project = projects.find((p) => p.id === draft.projectId)
  const agent = agents.find((a) => a.id === draft.agentId)
  const complaint = problemOf(draft)
  const grants = grantCount(draft.autonomy)

  const autonomySummary =
    grants === 0
      ? "Asks a person for everything"
      : `Acts without asking for ${grants} kind${grants === 1 ? "" : "s"}`

  /* The bar's items. Stable between renders unless the validator's verdict
     moves, because `FormShell` re-observes its sections whenever this changes. */
  const broken = complaint?.section
  const bar = React.useMemo(
    () =>
      SECTIONS.map((s) => ({
        id: sectionId(s.id),
        label: s.label,
        dot: broken === s.id,
      })),
    [broken]
  )

  /* The facade the composer's own pickers are driven through — see the header
     comment. `meta.id` is the routine's (or "new"): it is never dispatched, so
     it only has to be stable for React, not unique in the store. */
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
      configureDraft: (_id, next) => patch(next as Partial<RoutineDraft>),
      chooseDraftConfigOption: (_id, configId, value) =>
        patch({ configChoices: { ...draft.configChoices, [configId]: value } }),
    }),
    [actions, patch, draft.configChoices]
  )

  /* Submitting from any section is submitting the whole routine, so a form that
     is not ready shows you *where* before the parent's error note says what. */
  const submit = (event: React.FormEvent) => {
    if (complaint)
      document.getElementById(sectionId(complaint.section))?.scrollIntoView({ behavior: "smooth", block: "start" })
    onSubmit(event)
  }

  const section = (id: RoutineSectionId, children: React.ReactNode) => {
    const entry = SECTIONS.find((s) => s.id === id)!
    return (
      <FormSection id={sectionId(id)} label={entry.title} hint={entry.blurb}>
        {children}
      </FormSection>
    )
  }

  const body = (
    <>
      {section(
        "basics",
        <>
          <Field label="Name">
            <Input
              value={draft.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="Nightly review"
            />
          </Field>
          <Field label="Description" hint="What it is for, in the list.">
            <Input
              value={draft.description}
              onChange={(e) => patch({ description: e.target.value })}
              placeholder="Optional"
            />
          </Field>
          <label className="flex items-center gap-2.5">
            <Switch checked={draft.enabled} onCheckedChange={(on) => patch({ enabled: on })} />
            <span className="text-sm">
              Enabled
              <span className="ml-1.5 text-xs text-muted-foreground">
                — off keeps the routine and its history, and makes every trigger inert.
              </span>
            </span>
          </label>
        </>
      )}

      {section(
        "start",
        <>
          {/* The composer's own controls. A run is `POST /api/sessions` with
              these values and then one prompt, so anything a thread can be
              started with, a routine can be started with, and nothing else. */}
          <div className={INSET}>
            {/* Pinned below, unlike the composer's copy: this row is near the
                top of a form page, where there is room under it. */}
            <DraftScopeRow meta={meta} actions={facade} remember={false} />
            <div className="border-t px-1 py-0.5">
              <DraftConfigPopover meta={meta} actions={facade} remember={false} />
            </div>
          </div>
          {project ? (
            <p className="px-1 text-xs text-muted-foreground">
              Every run works in <code className="font-mono text-foreground">{project.cwd}</code>.
            </p>
          ) : (
            <p className="px-1 text-xs text-destructive">
              Pick a project: it is the working directory every run of this routine acts in.
            </p>
          )}
        </>
      )}

      {section(
        "body",
        <>
          <Field label="Body">
            <Segmented
              label="Body"
              value={draft.bodyKind}
              onChange={(kind) => patch({ bodyKind: kind })}
              options={[
                { value: "prompt", label: "A prompt" },
                { value: "workflow", label: "A workflow definition" },
              ]}
            />
          </Field>
          {draft.bodyKind === "prompt" ? (
            <Field label="Prompt" hint="Sent as the run's first message, exactly as typed.">
              <Textarea
                rows={10}
                value={draft.promptText}
                onChange={(e) => patch({ promptText: e.target.value })}
                placeholder="Review everything that changed today and tell me what needs attention."
              />
            </Field>
          ) : (
            <Field
              label="Workflow definition (JSON)"
              /* Shape-checked here, validated for real by the server: there is
                 one workflow schema and it is `server/src/workflow-schema.ts`. A
                 second copy in the client would be a second thing to keep in
                 step, and the one that answered would be the wrong one - so a
                 definition the server refuses comes back as a 400 and is drawn
                 by the note in the action bar. */
              hint="Named steps or phases, with dependsOn edges and {{inputs}} templates. The server validates it on save and says what is wrong."
            >
              <Textarea
                className="font-mono text-xs"
                rows={16}
                value={draft.workflowText}
                onChange={(e) => patch({ workflowText: e.target.value })}
                placeholder={'{\n  "name": "nightly",\n  "phases": [\n    { "name": "scan", "steps": [ … ] }\n  ]\n}'}
              />
            </Field>
          )}
          <Field
            label="Answer schema (JSON Schema, optional)"
            hint="Declaring one buys the run a repair turn and gives each run a structured verdict — which is what the run list leads with. Leave it blank and a run says only that its turn ended."
          >
            <Textarea
              className="font-mono text-xs"
              rows={8}
              value={draft.outputText}
              onChange={(e) => patch({ outputText: e.target.value })}
              placeholder={'{\n  "type": "object",\n  "properties": { "needsAttention": { "type": "boolean" } }\n}'}
            />
          </Field>
        </>
      )}

      {section(
        "autonomy",
        <AutonomyPermissions
          policy={draft.autonomy}
          onChange={(autonomy) => patch({ autonomy })}
          cwd={project?.cwd ?? ""}
          projectName={project?.name ?? "this project"}
          dryRunCompleted={routine?.dryRunCompleted ?? false}
        />
      )}

      {section(
        "limits",
        <>
          <AutonomyLimits policy={draft.autonomy} onChange={(autonomy) => patch({ autonomy })} />
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
        </>
      )}

      {section(
        "finish",
        <OnFinishEditor
          value={draft.onFinish}
          onChange={(onFinish) => patch({ onFinish })}
          routines={routines.filter((r) => r.id !== routine?.id)}
        />
      )}
    </>
  )

  return (
    <PageForm onSubmit={submit}>
      {sectionBar ? <FormShell sections={bar}>{body}</FormShell> : body}

      {/* Sticky, so the distance between changing a permission and committing
          it is zero from every section. The autonomy reading rides along: the
          one fact worth having in view whichever section is in front. */}
      <footer className="sticky bottom-0 z-10 mt-6 flex flex-col gap-3 border-t bg-background/95 pt-3 pb-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <ErrorNote error={error} />
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={grants > 0 ? "warn" : "neutral"}>{autonomySummary}</StatusBadge>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : submitLabel}
            </Button>
          </div>
        </div>
      </footer>
    </PageForm>
  )
}

/** The anchor a section is scrolled to. Prefixed: `start` and `body` are ids
    the rest of the document may well own. */
const sectionId = (id: RoutineSectionId) => `routine-${id}`
