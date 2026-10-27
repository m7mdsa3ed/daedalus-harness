import * as React from "react"
import { Navigate, useNavigate, useParams } from "react-router"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { type Persona, type ServerSettings } from "@/lib/settings"
import { useInvalidateCatalog, usePersonas } from "@/lib/queries/catalog"
import { FIELD_GRID, FormPageHeader, PageForm, Field, FormActions, FormSection } from "./primitives"
import { sectionMeta } from "./sections"
import { useSettingsPage } from "./layout"
import { LibrarySection, saveLibraryEntry } from "./library"
import { captureError, type InlineError } from "@/lib/errors"
import { settingsPath } from "@/lib/router"

/**
 * Personas: how a whole thread is worked on. A library page like Commands, with
 * no Import — no agent has a persona to give; it is the harness's own, carried
 * into each runtime at spawn (`server/src/personas.ts`).
 */
export function PersonasPage() {
  const { settings } = useSettingsPage()
  const invalidate = useInvalidateCatalog()
  const personas = usePersonas()
  return (
    <LibrarySection
      meta={sectionMeta("personas")}
      items={personas}
      endpoint="/api/personas"
      noun="persona"
      importable={false}
      subtitle={(p) => p.description || p.prompt.split("\n")[0]!}
      rowDetail={(p) => p.description || p.prompt.split("\n")[0]}
      settings={settings}
      refresh={() => invalidate("personas")}
      slice="personas"
    />
  )
}

export function PersonaFormPage() {
  const { entryId } = useParams()
  const navigate = useNavigate()
  const { settings } = useSettingsPage()
  const invalidate = useInvalidateCatalog()
  const personas = usePersonas()
  const persona = entryId === "new" ? null : personas.find((item) => item.id === entryId)
  if (entryId !== "new" && !persona) return <Navigate to={settingsPath("personas")} replace />
  return <PersonaForm persona={persona ?? null} settings={settings} onDone={async (saved) => {
    if (saved) await invalidate("personas")
    void navigate(settingsPath("personas"))
  }} />
}

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
        ...form,
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
        description="Instructions a whole thread runs under. Threads pick one in their settings menu."
        onBack={() => onDone(false)}
      />
      <PageForm
        onSubmit={save}
        aiBuilder={{
          title: "persona",
          value: form,
          onApply: (value) => setForm((current) => ({ ...current, ...value })),
          schema: {
            type: "object",
            properties: {
              name: { type: "string", description: "Short name shown in the thread's settings menu.", examples: ["Quick fix"] },
              description: { type: "string", description: "One line for the library list.", examples: ["The smallest correct change. No refactors."] },
              prompt: { type: "string", description: "Instructions appended to the agent's own system prompt for the whole thread.", examples: ["Make the smallest change that fixes the problem. Do not refactor surrounding code."] },
            },
            required: ["name", "prompt"],
            additionalProperties: false,
          },
        }}
      >
        <FormSection id="identity" label="Identity">
          <div className={FIELD_GRID}>
            <Field label="Name" hint="What the thread's settings menu calls it.">
              <Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Quick fix" required />
            </Field>
            <Field label="Order" hint="Where it sits in every menu. Ties break by name.">
              <Input
                type="number"
                step={10}
                value={form.sortOrder}
                onChange={(e) => set({ sortOrder: e.target.value })}
                className="font-mono"
              />
            </Field>
          </div>
          <Field label="Description" hint="One line, for the library list. Optional.">
            <Input
              value={form.description}
              onChange={(e) => set({ description: e.target.value })}
              placeholder="The smallest correct change. No refactors."
            />
          </Field>
        </FormSection>
        <FormSection id="instructions" label="Instructions">
          <Field
            label="Instructions"
            hint="Appended to the agent's own system prompt, above the rules — never a replacement, so write additions rather than a whole prompt. A change reaches a thread on its next restart."
          >
            <Textarea
              value={form.prompt}
              onChange={(e) => set({ prompt: e.target.value })}
              rows={12}
              className="font-mono"
              required
            />
          </Field>
        </FormSection>
        <FormActions busy={busy} onCancel={() => onDone(false)} error={saveError} />
      </PageForm>
    </>
  )
}
