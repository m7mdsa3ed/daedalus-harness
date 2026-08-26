import * as React from "react"
import { Input } from "@/components/ui/input"
import { type ServerSettings, type SkillDef } from "@/lib/settings"
import { useStore } from "@/lib/store"
import { Field, FormActions } from "./primitives"
import { sectionMeta } from "./sections"
import { useSettingsPage } from "./layout"
import { LibrarySection, saveLibraryEntry } from "./library"
import { reportError } from "@/lib/errors"
import {
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"

export function SkillsPage() {
  const { settings, actions } = useSettingsPage()
  const meta = sectionMeta("skills")
  const { state } = useStore()
  return (
    <LibrarySection
      meta={meta}
      items={state.skills}
      endpoint="/api/skills"
      importKind="skills"
      noun="skill"
      subtitle={(s) => s.path}
      settings={settings}
      refresh={actions.refreshSkills}
      renderForm={(skill, onDone) => <SkillForm skill={skill} settings={settings} onDone={onDone} />}
    />
  )
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
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await saveLibraryEntry(settings, "/api/skills", skill?.id, form)
      onDone(true)
    } catch (err) {
      reportError(err, "Couldn't save the skill")
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <ResponsiveDialogHeader>
        <ResponsiveDialogTitle>{skill ? `Edit ${skill.name}` : "New skill"}</ResponsiveDialogTitle>
      </ResponsiveDialogHeader>
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
      <FormActions busy={busy} onCancel={() => onDone(false)} />
    </form>
  )
}
