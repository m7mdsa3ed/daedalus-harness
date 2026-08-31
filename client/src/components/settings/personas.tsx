import * as React from "react"
import { Navigate, useNavigate, useParams } from "react-router"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { type Persona, type ServerSettings } from "@/lib/settings"
import { useStore } from "@/lib/store"
import { FormPageHeader, PageForm, Field, FormActions } from "./primitives"
import { sectionMeta } from "./sections"
import { useSettingsPage } from "./layout"
import { LibrarySection, saveLibraryEntry } from "./library"
import { captureError, type InlineError } from "@/lib/errors"
import { settingsPath } from "@/lib/router"

/**
 * Personas: the reusable half of "how do you want this thread worked on".
 *
 * A library page like Skills and Commands, with one thing missing on purpose —
 * there is no Import. The other three libraries import from the agents' own
 * configs, and no agent has a persona to give: a persona is the harness's
 * concept, translated per runtime at spawn (`server/src/personas.ts`).
 *
 * The built-ins are editable and deletable like anything else here. They carry
 * a `seededVersion` so a later release can offer a *new* one without putting
 * back the ones you cleaned out — the same contract the agent registry has.
 */
export function PersonasPage() {
  const { settings, actions } = useSettingsPage()
  const meta = sectionMeta("personas")
  const { state } = useStore()
  return (
    <LibrarySection
      meta={meta}
      items={state.personas}
      endpoint="/api/personas"
      noun="persona"
      importable={false}
      /* The description if there is one, else the first line of the prompt:
         a persona with no description is still a persona, and the prompt is
         what it actually does. */
      subtitle={(p) => p.description || p.prompt.split("\n")[0]}
      settings={settings}
      refresh={actions.refreshPersonas}
    />
  )
}

export function PersonaFormPage() {
  const { entryId } = useParams()
  const navigate = useNavigate()
  const { settings, actions } = useSettingsPage()
  const { state } = useStore()
  const persona = entryId === "new" ? null : state.personas.find((item) => item.id === entryId)
  if (entryId !== "new" && !persona) return <Navigate to={settingsPath("personas")} replace />
  return (
    <PersonaForm
      persona={persona ?? null}
      settings={settings}
      onDone={async (saved) => {
        if (saved) await actions.refreshPersonas()
        void navigate(settingsPath("personas"))
      }}
    />
  )
}

/** The sentinel the two numeric-ish fields use for "say nothing". Empty string
    rather than a number, because 0 is a real value in both — "no thinking" and
    "sort first" — and a select that cannot tell them apart would silently turn
    every persona's thinking off. */
const UNSET = ""

function PersonaForm({
  persona,
  settings,
  onDone,
}: {
  persona: Persona | null
  settings: ServerSettings
  onDone: (saved: boolean) => void
}) {
  const [form, setForm] = React.useState(() => ({
    name: persona?.name ?? "",
    description: persona?.description ?? "",
    prompt: persona?.prompt ?? "",
    thinking: persona?.thinking === null || persona?.thinking === undefined ? UNSET : String(persona.thinking),
    effort: persona?.effort ?? "",
    sortOrder: String(persona?.sortOrder ?? 0),
  }))
  const [busy, setBusy] = React.useState(false)
  const [saveError, setSaveError] = React.useState<InlineError | null>(null)
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setSaveError(null)
    try {
      await saveLibraryEntry(settings, "/api/personas", persona?.id, {
        name: form.name,
        description: form.description,
        prompt: form.prompt,
        thinking: form.thinking === UNSET ? null : Number(form.thinking),
        effort: form.effort.trim() || null,
        sortOrder: Number(form.sortOrder) || 0,
      })
      onDone(true)
    } catch (err) {
      setSaveError(captureError(err, "Couldn't save the persona"))
      setBusy(false)
    }
  }

  return (
    <>
      <FormPageHeader
        title={persona ? `Edit ${persona.name}` : "New persona"}
        description="Instructions appended to the agent's own system prompt, plus the two dials that go with them. Threads pick one in their settings menu."
        onBack={() => onDone(false)}
      />
      <PageForm onSubmit={save}>
        <Field label="Name" hint="What the thread's settings menu calls it.">
          <Input
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="Quick fix"
            required
          />
        </Field>
        <Field label="Description" hint="One line, for the library list. Optional.">
          <Input
            value={form.description}
            onChange={(e) => set({ description: e.target.value })}
            placeholder="The smallest correct change. No refactors."
          />
        </Field>
        <Field
          label="Instructions"
          hint="Appended to the agent's own system prompt — never a replacement, so write additions rather than a whole prompt. Avoid contradicting the runtime's own rules about tools and permissions; an instruction that fights them is one the agent has to resolve mid-turn."
        >
          <Textarea
            value={form.prompt}
            onChange={(e) => set({ prompt: e.target.value })}
            rows={12}
            className="font-mono text-xs"
            required
          />
        </Field>
        <Field
          label="Thinking budget"
          hint="Tokens of extended thinking. 0 turns it off; leave empty to keep the runtime's own default. A separate axis from effort, and only runtimes that expose it (Claude Code) honour it."
        >
          <Input
            type="number"
            min={0}
            step={1000}
            value={form.thinking}
            onChange={(e) => set({ thinking: e.target.value })}
            placeholder="unchanged"
            className="font-mono text-xs"
          />
        </Field>
        <Field
          label="Effort"
          hint="Applied when this persona is picked, and never again — the thread's own effort row stays the user's afterwards. Leave empty for no opinion. A value the agent does not offer costs the pick, not the thread."
        >
          <Input
            value={form.effort}
            onChange={(e) => set({ effort: e.target.value })}
            placeholder="high"
            className="font-mono text-xs"
          />
        </Field>
        <Field label="Order" hint="Where it sits in every menu. Ties break by name.">
          <Input
            type="number"
            step={10}
            value={form.sortOrder}
            onChange={(e) => set({ sortOrder: e.target.value })}
            className="font-mono text-xs"
          />
        </Field>
        <FormActions busy={busy} onCancel={() => onDone(false)} error={saveError} />
      </PageForm>
    </>
  )
}
