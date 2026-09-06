import * as React from "react"
import { Textarea } from "@/components/ui/textarea"
import { useRules, useSaveRules } from "@/lib/queries/catalog"
import { captureError, type InlineError } from "@/lib/errors"
import { Field, FormActions, PageForm, PageHeader } from "./primitives"
import { sectionMeta } from "./sections"
import { useSettingsPage } from "./layout"

/* ── Rules ──
   The standing instruction block every thread spawns with — beneath any
   project's own rules and above its persona, folded into the spawn by
   server/src/rules.ts through the door each runtime already opens. One
   resource written whole, so this page is a textarea rather than a library:
   the block is what you would otherwise retype into every persona. */

export function RulesPage() {
  const { settings } = useSettingsPage()
  const meta = sectionMeta("rules")
  const saved = useRules()
  const save = useSaveRules()
  /* Null until the first keystroke, so the page shows what the server holds
     both while the read is in flight and once a save has landed. */
  const [draft, setDraft] = React.useState<string | null>(null)
  const [error, setError] = React.useState<InlineError | null>(null)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    save.mutate(
      { rules: draft ?? saved },
      {
        onSuccess: () => setDraft(null),
        onError: (err) => setError(captureError(err, "Couldn't save the rules")),
      },
    )
  }

  return (
    <>
      <PageHeader meta={meta} />
      <PageForm onSubmit={submit}>
        <Field
          label="Global rules"
          hint="Given to every thread of every agent at spawn, beneath the project's own rules (edited with the project) and above its persona — appended to the agent's own system prompt, never a replacement. A change reaches a live thread when it respawns."
        >
          <Textarea
            value={draft ?? saved}
            onChange={(e) => setDraft(e.target.value)}
            rows={14}
            className="font-mono text-xs"
            placeholder="Prefer the smallest change that works. Never commit uninvited. …"
          />
        </Field>
        <FormActions busy={save.isPending} onCancel={() => setDraft(null)} error={error} />
      </PageForm>
    </>
  )
}
