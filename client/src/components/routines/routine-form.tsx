/* ── The routine form ──
   A routine is a saved thread-start, so the half of this form that decides
   *how* the thread starts is drawn by the composer's own controls, not by
   copies of them: `DraftScopeRow` (agent, project, and the tools menu) and
   `DraftConfigPopover` (profile, persona, model, effort), verbatim. That is a
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
   form adds to them, and the reason it exists. */
import * as React from "react"

import { DraftConfigPopover, DraftScopeRow } from "@/components/draft-config"
import { ErrorNote } from "@/components/error-note"
import { Field, FormSection, PageForm } from "@/components/settings/primitives"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
  type ServerSettings,
  type SessionMeta,
} from "@/lib/settings"
import { useProjects } from "@/lib/queries/catalog"
import { useRoutines } from "@/lib/queries/routines"
import { AutonomyControl } from "./autonomy-control"
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
  personaId: string
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
    personaId: routine.personaId ?? "",
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
    personaId: "",
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

/** What a `RoutineDraft` is worth sending, or the sentence that says why it is
    not. Parsing happens exactly here — a form that validated on every keystroke
    would be arguing with a half-typed schema. */
export function toInput(draft: RoutineDraft): { input: RoutineInput } | { problem: string } {
  if (!draft.name.trim()) return { problem: "Give the routine a name." }
  if (!draft.projectId) return { problem: "Pick a project — it is the directory every run works in." }
  if (!draft.profileId || !draft.agentId) return { problem: "Pick an agent and a profile." }

  let body: RoutineBody
  if (draft.bodyKind === "prompt") {
    if (!draft.promptText.trim()) return { problem: "A prompt routine needs a prompt." }
    body = { kind: "prompt", text: draft.promptText.trim() }
  } else {
    const parsed = parseObject(draft.workflowText)
    if ("problem" in parsed) return { problem: `Workflow definition: ${parsed.problem}` }
    body = { kind: "workflow", definition: parsed.value }
  }

  let output: Record<string, unknown> | null = null
  if (draft.outputText.trim()) {
    const parsed = parseObject(draft.outputText)
    if ("problem" in parsed) return { problem: `Output schema: ${parsed.problem}` }
    output = parsed.value
  }

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
      personaId: draft.personaId || null,
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
}) {
  const projects = useProjects()
  const routines = useRoutines().data ?? []
  const patch = React.useCallback(
    (next: Partial<RoutineDraft>) => onChange({ ...draft, ...next }),
    [draft, onChange]
  )

  const project = projects.find((p) => p.id === draft.projectId)

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
      personaId: draft.personaId,
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

  return (
    <PageForm onSubmit={onSubmit}>
      <FormSection label="Routine">
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
      </FormSection>

      <FormSection label="How each run starts">
        {/* The composer's own controls. A run is `POST /api/sessions` with
            these values and then one prompt, so anything a thread can be
            started with, a routine can be started with, and nothing else. */}
        <div className="rounded-xl border">
          <DraftScopeRow meta={meta} actions={facade} remember={false} />
          <div className="border-t px-1 py-0.5">
            <DraftConfigPopover meta={meta} actions={facade} remember={false} />
          </div>
        </div>
        {project ? (
          <p className="px-1 text-xs text-muted-foreground">
            Every run works in{" "}
            <code className="font-mono text-foreground">{project.cwd}</code>.
          </p>
        ) : (
          <p className="px-1 text-xs text-destructive">
            Pick a project: it is the working directory every run of this routine acts in.
          </p>
        )}
      </FormSection>

      <FormSection label="What it runs">
        <Field label="Body">
          <Select
            value={draft.bodyKind}
            onValueChange={(v) => v && patch({ bodyKind: v as RoutineBody["kind"] })}
          >
            <SelectTrigger className="w-full">
              <SelectValue>
                {draft.bodyKind === "prompt" ? "A prompt" : "A workflow definition"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="prompt">A prompt</SelectItem>
              <SelectItem value="workflow">A workflow definition</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {draft.bodyKind === "prompt" ? (
          <Field label="Prompt" hint="Sent as the run's first message, exactly as typed.">
            <Textarea
              rows={6}
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
               step, and the one that answered would be the wrong one — so a
               definition the server refuses comes back as a 400 and is drawn
               by the note at the foot of this form. */
            hint="Named steps or phases, with dependsOn edges and {{inputs}} templates. The server validates it on save and says what is wrong."
          >
            <Textarea
              className="font-mono text-xs"
              rows={14}
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
            rows={6}
            value={draft.outputText}
            onChange={(e) => patch({ outputText: e.target.value })}
            placeholder={'{\n  "type": "object",\n  "properties": { "needsAttention": { "type": "boolean" } }\n}'}
          />
        </Field>
      </FormSection>

      <FormSection label="Autonomy">
        <AutonomyControl
          policy={draft.autonomy}
          onChange={(autonomy) => patch({ autonomy })}
          cwd={project?.cwd ?? ""}
          projectName={project?.name ?? "this project"}
          dryRunCompleted={routine?.dryRunCompleted ?? false}
        />
      </FormSection>

      <FormSection label="When a run overlaps">
        <Field
          label="If the previous run is still going"
          hint="Skip is what stops a nightly review that is still running from becoming two agents in one directory."
        >
          <Select
            value={draft.overlap}
            onValueChange={(v) => v && patch({ overlap: v as RoutineOverlap })}
          >
            <SelectTrigger className="w-full">
              <SelectValue>
                {draft.overlap === "skip" ? "Skip this fire" : "Queue behind it"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="skip">Skip this fire</SelectItem>
              <SelectItem value="queue">Queue behind it</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </FormSection>

      <FormSection label="When a run finishes">
        <OnFinishEditor
          value={draft.onFinish}
          onChange={(onFinish) => patch({ onFinish })}
          routines={routines.filter((r) => r.id !== routine?.id)}
        />
      </FormSection>

      <footer className="flex flex-col gap-3 border-t pt-4">
        <ErrorNote error={error} />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : submitLabel}
          </Button>
        </div>
      </footer>
    </PageForm>
  )
}
