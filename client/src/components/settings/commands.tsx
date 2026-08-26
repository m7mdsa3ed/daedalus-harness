import * as React from "react"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { type CommandDef, type ServerSettings } from "@/lib/settings"
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

export function CommandsPage() {
  const { settings, actions } = useSettingsPage()
  const meta = sectionMeta("commands")
  const { state } = useStore()
  return (
    <LibrarySection
      meta={meta}
      items={state.commands}
      endpoint="/api/commands"
      importKind="commands"
      noun="command"
      subtitle={(c) => `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}`}
      settings={settings}
      refresh={actions.refreshCommands}
      renderForm={(command, onDone) => (
        <CommandForm command={command} settings={settings} onDone={onDone} />
      )}
    />
  )
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
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await saveLibraryEntry(settings, "/api/commands", command?.id, {
        ...form,
        argumentHint: form.argumentHint.trim() || null,
      })
      onDone(true)
    } catch (err) {
      reportError(err, "Couldn't save the command")
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <ResponsiveDialogHeader>
        <ResponsiveDialogTitle>
          {command ? `Edit /${command.name}` : "New command"}
        </ResponsiveDialogTitle>
      </ResponsiveDialogHeader>
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
      <FormActions busy={busy} onCancel={() => onDone(false)} />
    </form>
  )
}
