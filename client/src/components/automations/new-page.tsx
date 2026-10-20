/* ── /automations/new ──
   A template gallery first, then the form prefilled. "Blank" is one tile.
   The gallery is skipped when the caller already knows what it wants: a
   `?session=` (the composer's `/automate`, the thread footer) opens the form
   with Runs in = This thread pinned to that thread, and any text typed into
   the composer rides along in the route state. A template never saves
   anything — the form opens on it and a person reviews it. A `duplicateOf`
   in the route state (Duplicate, on the list and the detail page) skips the
   gallery too and opens the form on a paused copy of that automation and its
   triggers — never its webhook token, which is minted fresh or not at all. */
import * as React from "react"
import { BotIcon } from "lucide-react"
import { useLocation, useNavigate, useSearchParams } from "react-router"

import { Empty } from "@/components/empty"
import { FormPageHeader, Group, ChoiceTiles } from "@/components/settings/primitives"
import type { Actions } from "@/lib/actions"
import { captureError, reportError, type InlineError } from "@/lib/errors"
import { useAgents, useProfiles, useProjects } from "@/lib/queries/catalog"
import { useAutomationTriggers, useAutomations, useCreateAutomation, useCreateAutomationTriggers } from "@/lib/queries/automations"
import { defaultPlan, readPlan } from "@/lib/automation-schedule"
import { GroupRowsSkeleton } from "@/components/ui/skeletons"
import { automationPath, automationsPath } from "@/lib/router"
import { profileSupports, type Routine } from "@/lib/settings"
import { useStoreSelect } from "@/lib/store"
import { toast } from "@/lib/toast"
import { AutomationForm, applyTemplate, blankDraft, draftOf, problemNote, toInput, triggersOf, type AutomationDraft } from "./automation-form"
import { BLANK_TEMPLATE, TEMPLATES, TEMPLATE_GROUPS } from "./templates"

export interface NewAutomationState {
  defaultText?: string
  returnTo?: string
  /** An automation to copy. */
  duplicateOf?: string
}

export function NewAutomationPage({ actions }: { actions: Actions }) {
  const createAutomation = useCreateAutomation()
  const createTriggers = useCreateAutomationTriggers()
  const profiles = useProfiles()
  const projects = useProjects()
  const agents = useAgents()
  const sessions = useStoreSelect((state) => state.sessions)
  const navigate = useNavigate()
  const location = useLocation()
  const [params] = useSearchParams()
  const routeState = (location.state ?? {}) as NewAutomationState
  const pinned = params.get("session")
  const pinnedSession = pinned ? sessions.find((s) => s.id === pinned) : undefined
  const automations = useAutomations()
  const duplicateOf = routeState.duplicateOf
  const source = duplicateOf ? automations.data?.find((r) => r.id === duplicateOf) : undefined
  /* A copy waits for its source's triggers before the form opens; a source
     that is gone (or a list that will not read) falls back to a blank form. */
  const [seeded, setSeeded] = React.useState(!duplicateOf)
  const sourceGone = Boolean(duplicateOf) && !source && (automations.isError || automations.data !== undefined)
  React.useEffect(() => {
    if (sourceGone) setSeeded(true)
  }, [sourceGone])

  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<InlineError | null>(null)
  /* The gallery is a step, not a route: it is skipped when the caller already
     knows what it wants (a pinned thread, or words typed into the composer). */
  const [step, setStep] = React.useState<"gallery" | "form">(pinnedSession || routeState.defaultText || duplicateOf ? "form" : "gallery")

  /* Seeded from whatever is first and coherent, never from the remembered
     thread defaults: an automation is set up deliberately and the pickers are
     right there, where a thread's defaults exist because opening a new thread
     should cost no decisions. */
  const [draft, setDraft] = React.useState<AutomationDraft>(() => {
    const agent = agents[0]
    const profile = agent ? profiles.find((p) => profileSupports(p, agent.id) && !p.hidden && !p.disabled) : undefined
    const blank = blankDraft({
      projectId: pinnedSession?.projectId ?? projects[0]?.id ?? "",
      agentId: agent?.id ?? "",
      profileId: profile?.id ?? "",
    })
    return pinnedSession
      ? { ...blank, runsIn: "session", sessionId: pinnedSession.id, promptText: routeState.defaultText ?? "", plan: { ...blank.plan, preset: "once" } }
      : { ...blank, promptText: routeState.defaultText ?? "" }
  })

  const back = () => void navigate(routeState.returnTo ?? automationsPath())

  const choose = (id: string) => {
    const template = id === BLANK_TEMPLATE.id ? BLANK_TEMPLATE : TEMPLATES.find((t) => t.id === id)
    if (!template) return
    setDraft((prev) => (template.id === BLANK_TEMPLATE.id ? prev : applyTemplate(prev, template)))
    setStep("form")
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy) return
    const parsed = toInput(draft, "create")
    if ("problem" in parsed) {
      setError(problemNote(parsed.problem))
      return
    }
    setBusy(true)
    setError(null)
    let created: Routine
    try {
      /* A thread-pinned automation goes through the action: the thread may
         still be a draft the server has never seen. */
      created =
        draft.runsIn === "session"
          ? await actions.createSchedule(parsed.input)
          : await createAutomation.mutateAsync(parsed.input)
    } catch (err) {
      setError(captureError(err, "Couldn't create the automation"))
      setBusy(false)
      return
    }
    try {
      await createTriggers.mutateAsync({ routineId: created.id, inputs: triggersOf(draft) })
      toast.success("Automation created")
      // A webhook trigger has no token until one is minted, and it is shown once.
      void navigate(draft.apiTrigger ? `${automationPath(created.id)}?tab=triggers` : automationPath(created.id))
    } catch (err) {
      // The automation exists; only its trigger did not land. Say so where the fix is.
      reportError(err, "The automation was created, but its trigger was not saved")
      void navigate(`${automationPath(created.id)}?tab=triggers`)
    }
  }

  if (projects.length === 0 || agents.length === 0) {
    return (
      <>
        <FormPageHeader title="New automation" onBack={back} />
        <Empty size="lg" icon={BotIcon}>
          An automation needs a project to run in and an agent to run it. Add those in Settings first.
        </Empty>
      </>
    )
  }

  if (!seeded) {
    return (
      <>
        <FormPageHeader title="Duplicate automation" onBack={back} />
        {source && (
          <DuplicateSeed
            source={source}
            onSeed={(seed) => {
              setDraft(seed)
              setSeeded(true)
            }}
          />
        )}
        <GroupRowsSkeleton label />
      </>
    )
  }

  if (step === "gallery") {
    return (
      <>
        <FormPageHeader
          title="New automation"
          description="Start from a template and review it, or start blank. Nothing is saved until you press Create."
          onBack={back}
        />
        <Group>
          <ChoiceTiles
            label="Blank automation"
            value=""
            onChange={choose}
            choices={[{ value: BLANK_TEMPLATE.id, label: BLANK_TEMPLATE.label, hint: BLANK_TEMPLATE.blurb, icon: BLANK_TEMPLATE.icon }]}
          />
        </Group>
        {TEMPLATE_GROUPS.map((group) => (
          <Group key={group.id} label={group.label}>
            <ChoiceTiles
              label={group.label}
              value=""
              onChange={choose}
              choices={TEMPLATES.filter((t) => t.runsIn === group.id).map((t) => ({
                value: t.id,
                label: t.label,
                hint: t.blurb,
                icon: t.icon,
              }))}
            />
          </Group>
        ))}
      </>
    )
  }

  return (
    <>
      <FormPageHeader
        title={source ? "Duplicate automation" : "New automation"}
        description={
          source
            ? `A copy of “${source.name}”, paused until you turn it on. Review each section, then create it.`
            : "A prompt that runs on its own. Review each section, then create it — a fresh automation is worth running once by hand first."
        }
        onBack={back}
      />
      <AutomationForm
        draft={draft}
        onChange={setDraft}
        actions={actions}
        mode="create"
        onSubmit={submit}
        onCancel={back}
        busy={busy}
        error={error}
        submitLabel="Create automation"
        onBrowseTemplates={pinnedSession || source ? undefined : () => setStep("gallery")}
      />
    </>
  )
}

/** Reads the source's triggers and hands the copy's draft up once, when they
    have loaded — or on a failed read, with the form's own defaults. A
    component rather than a hook in the page so the read only exists when
    there is a source to read. */
function DuplicateSeed({ source, onSeed }: { source: Routine; onSeed: (draft: AutomationDraft) => void }) {
  const triggers = useAutomationTriggers(source.id)
  const done = triggers.data !== undefined || triggers.isError
  React.useEffect(() => {
    if (!done) return
    const base: AutomationDraft = { ...draftOf(source), name: `${source.name} (copy)`, enabled: false }
    const all = triggers.data
    if (!all) return onSeed(base)
    const schedule = all.find((t) => t.kind === "schedule")
    const git = all.find((t) => t.kind === "git")
    onSeed({
      ...base,
      // No clock on the source is no clock on the copy.
      plan: schedule ? readPlan(schedule) : defaultPlan({ preset: "manual" }),
      apiTrigger: all.some((t) => t.kind === "api"),
      // Newline-separated: `triggersOf` reads the draft's paths as lines.
      git: git ? { on: true, branch: git.branch ?? "", paths: git.paths.join("\n") } : base.git,
    })
    // Seed once; `onSeed` unmounts this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done])
  return null
}
