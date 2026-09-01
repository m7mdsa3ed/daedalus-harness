import * as React from "react"
import { Navigate, useNavigate, useParams } from "react-router"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { type CommandDef, type ServerSettings } from "@/lib/settings"
import { useStoreSelect } from "@/lib/store"
import { FormPageHeader, PageForm, Field, FormActions } from "./primitives"
import { sectionMeta } from "./sections"
import { useSettingsPage } from "./layout"
import { LibraryImportPage, LibrarySection, saveLibraryEntry } from "./library"
import { captureError, type InlineError } from "@/lib/errors"
import { settingsPath } from "@/lib/router"

export function CommandsPage() {
  const { settings, actions } = useSettingsPage()
  const meta = sectionMeta("commands")
  const commands = useStoreSelect((store) => store.commands)
  return (
    <LibrarySection
      meta={meta}
      items={commands}
      endpoint="/api/commands"
      noun="command"
      subtitle={(c) => `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}`}
      settings={settings}
      refresh={actions.refreshCommands}
    />
  )
}

export function CommandImportPage() {
  const { actions } = useSettingsPage()
  return <LibraryImportPage meta={sectionMeta("commands")} kind="commands" endpoint="/api/commands" noun="command" refresh={actions.refreshCommands} />
}

export function CommandFormPage() {
  const { entryId } = useParams()
  const navigate = useNavigate()
  const { settings, actions } = useSettingsPage()
  const commands = useStoreSelect((store) => store.commands)
  const command = entryId === "new" ? null : commands.find((item) => item.id === entryId)
  if (entryId !== "new" && !command) return <Navigate to={settingsPath("commands")} replace />
  return <CommandForm command={command ?? null} settings={settings} onDone={async (saved) => {
    if (saved) await actions.refreshCommands()
    void navigate(settingsPath("commands"))
  }} />
}

function CommandForm({
  command,
  settings,
  onDone,
}: {
  command: CommandDef | null
  settings: ServerSettings
  onDone: (saved: boolean) => void
}) {
  const [form, setForm] = React.useState(() => ({
    name: command?.name ?? "",
    description: command?.description ?? "",
    argumentHint: command?.argumentHint ?? "",
    content: command?.content ?? "",
  }))
  const [busy, setBusy] = React.useState(false)
  const [saveError, setSaveError] = React.useState<InlineError | null>(null)
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setSaveError(null)
    try {
      await saveLibraryEntry(settings, "/api/commands", command?.id, {
        ...form,
        argumentHint: form.argumentHint.trim() || null,
      })
      onDone(true)
    } catch (err) {
      setSaveError(captureError(err, "Couldn't save the command"))
      setBusy(false)
    }
  }

  return (
    <>
      <FormPageHeader
        title={command ? `Edit /${command.name}` : "New command"}
        description="Define the reusable prompt and autocomplete metadata for this slash command."
        onBack={() => onDone(false)}
      />
      <PageForm onSubmit={save}>
      <Field label="Name" hint="Typed as /name in the composer; also the filename on disk.">
        <Input
          value={form.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="review-pr"
          pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]*"
          title="Letters, digits, . _ - only"
          className="font-mono text-xs"
          required
        />
      </Field>
      <Field label="Description" hint="Shown next to the name in the autocomplete menu.">
        <Input
          value={form.description}
          onChange={(e) => set({ description: e.target.value })}
          required
        />
      </Field>
      <Field label="Argument hint" hint="Optional placeholder for what follows the name, e.g. [pr-number].">
        <Input
          value={form.argumentHint}
          onChange={(e) => set({ argumentHint: e.target.value })}
          className="font-mono text-xs"
        />
      </Field>
      <Field
        label="Prompt"
        hint="Markdown the agent receives when the command runs. $ARGUMENTS is replaced with whatever was typed after the name."
      >
        <Textarea
          value={form.content}
          onChange={(e) => set({ content: e.target.value })}
          rows={8}
          className="font-mono text-xs"
          required
        />
      </Field>
      <FormActions busy={busy} onCancel={() => onDone(false)} error={saveError} />
      </PageForm>
    </>
  )
}
