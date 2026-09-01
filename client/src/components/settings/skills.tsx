import * as React from "react"
import { Navigate, useNavigate, useParams } from "react-router"
import { Input } from "@/components/ui/input"
import { type ServerSettings, type SkillDef } from "@/lib/settings"
import { useStoreSelect } from "@/lib/store"
import { FormPageHeader, PageForm, Field, FormActions } from "./primitives"
import { sectionMeta } from "./sections"
import { useSettingsPage } from "./layout"
import { LibraryImportPage, LibrarySection, saveLibraryEntry } from "./library"
import { captureError, type InlineError } from "@/lib/errors"
import { settingsPath } from "@/lib/router"

export function SkillsPage() {
  const { settings, actions } = useSettingsPage()
  const meta = sectionMeta("skills")
  const skills = useStoreSelect((store) => store.skills)
  return (
    <LibrarySection
      meta={meta}
      items={skills}
      endpoint="/api/skills"
      noun="skill"
      subtitle={(s) => s.path}
      settings={settings}
      refresh={actions.refreshSkills}
    />
  )
}

export function SkillImportPage() {
  const { actions } = useSettingsPage()
  return <LibraryImportPage meta={sectionMeta("skills")} kind="skills" endpoint="/api/skills" noun="skill" refresh={actions.refreshSkills} />
}

export function SkillFormPage() {
  const { entryId } = useParams()
  const navigate = useNavigate()
  const { settings, actions } = useSettingsPage()
  const skills = useStoreSelect((store) => store.skills)
  const skill = entryId === "new" ? null : skills.find((item) => item.id === entryId)
  if (entryId !== "new" && !skill) return <Navigate to={settingsPath("skills")} replace />
  return <SkillForm skill={skill ?? null} settings={settings} onDone={async (saved) => {
    if (saved) await actions.refreshSkills()
    void navigate(settingsPath("skills"))
  }} />
}

function SkillForm({
  skill,
  settings,
  onDone,
}: {
  skill: SkillDef | null
  settings: ServerSettings
  onDone: (saved: boolean) => void
}) {
  const [form, setForm] = React.useState(() => ({ name: skill?.name ?? "", path: skill?.path ?? "" }))
  const [busy, setBusy] = React.useState(false)
  const [saveError, setSaveError] = React.useState<InlineError | null>(null)
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setSaveError(null)
    try {
      await saveLibraryEntry(settings, "/api/skills", skill?.id, form)
      onDone(true)
    } catch (err) {
      setSaveError(captureError(err, "Couldn't save the skill"))
      setBusy(false)
    }
  }

  return (
    <>
      <FormPageHeader
        title={skill ? `Edit ${skill.name}` : "New skill"}
        description="Register a reusable skill directory on the server."
        onBack={() => onDone(false)}
      />
      <PageForm onSubmit={save}>
      <Field label="Name">
        <Input value={form.name} onChange={(e) => set({ name: e.target.value })} required />
      </Field>
      <Field label="Directory" hint="Path on the server holding SKILL.md — symlinked into the project.">
        <Input
          value={form.path}
          onChange={(e) => set({ path: e.target.value })}
          placeholder="/home/me/.claude/skills/my-skill"
          className="font-mono text-xs"
          required
        />
      </Field>
      <FormActions busy={busy} onCancel={() => onDone(false)} error={saveError} />
      </PageForm>
    </>
  )
}
