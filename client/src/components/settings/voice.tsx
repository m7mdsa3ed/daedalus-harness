import * as React from "react"
import { captureError, type InlineError } from "@/lib/errors"
import {
  useDeleteVoiceProvider,
  useSaveVoiceProvider,
  useVoiceProviders,
  type VoiceProviderId,
} from "@/lib/queries"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { ErrorNote } from "@/components/error-note"
import { PageForm, PageHeader, Group, Field, FormActions, Row } from "./primitives"
import { sectionMeta } from "./sections"

/* What each provider is called here and what its fields start as. The model
   and voice are typed, never picked from a list: both providers rename them
   every few months, and a list here would be the first thing to go stale. */
const PROVIDERS: { id: VoiceProviderId; label: string; model: string; voice: string; keyHint: string }[] = [
  { id: "openai", label: "OpenAI Realtime", model: "gpt-realtime", voice: "alloy", keyHint: "An OpenAI API key (sk-…)." },
  {
    id: "google",
    label: "Gemini Live",
    model: "gemini-3.1-flash-live-preview",
    voice: "Kore",
    keyHint: "A Gemini API key from Google AI Studio.",
  },
]

interface Draft {
  apiKey: string
  model: string
  voice: string
  isDefault: boolean
}

export function VoicePage() {
  const meta = sectionMeta("voice")
  const { data: rows, error: loadError, isLoading } = useVoiceProviders()
  const save = useSaveVoiceProvider()
  const remove = useDeleteVoiceProvider()
  const [drafts, setDrafts] = React.useState<Record<VoiceProviderId, Draft> | null>(null)
  const [saveError, setSaveError] = React.useState<InlineError | null>(null)

  /* The form is the rows as they were read; re-read after a save so a key that
     became "stored" says so and the default moves where the server put it. */
  const reset = React.useCallback(() => {
    if (!rows) return
    const of = (id: VoiceProviderId): Draft => {
      const row = rows.find((r) => r.provider === id)
      const preset = PROVIDERS.find((p) => p.id === id)!
      return { apiKey: "", model: row?.model ?? preset.model, voice: row?.voice ?? preset.voice, isDefault: row?.isDefault ?? false }
    }
    setDrafts({ openai: of("openai"), google: of("google") })
  }, [rows])
  React.useEffect(reset, [reset])

  const set = (id: VoiceProviderId, patch: Partial<Draft>) =>
    setDrafts((d) => {
      if (!d) return d
      const next = { ...d, [id]: { ...d[id], ...patch } }
      /* One default: turning one on turns the other off, as the server will. */
      if (patch.isDefault) for (const other of PROVIDERS) if (other.id !== id) next[other.id] = { ...next[other.id], isDefault: false }
      return next
    })

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!drafts) return
    setSaveError(null)
    try {
      /* A provider is saved when it already has a key or one was typed; the
         other is left alone rather than refused for a key nobody gave it. */
      for (const p of PROVIDERS) {
        const draft = drafts[p.id]
        const stored = rows?.some((r) => r.provider === p.id && r.hasKey)
        if (!stored && !draft.apiKey.trim()) continue
        await save.mutateAsync({ provider: p.id, ...draft })
      }
    } catch (err) {
      setSaveError(captureError(err, "Couldn't save the voice settings"))
    }
  }

  return (
    <>
      <PageHeader meta={meta} />
      {loadError && <ErrorNote error={captureError(loadError, "Couldn't load the voice backends")} />}
      {!isLoading && rows?.length === 0 && (
        <p className="mb-2 px-1 text-xs text-pretty text-muted-foreground">
          No voice backend yet — add a key for either provider to turn on voice mode in the composer.
        </p>
      )}
      {drafts && (
        <PageForm onSubmit={submit}>
          {PROVIDERS.map((p) => {
            const row = rows?.find((r) => r.provider === p.id)
            const draft = drafts[p.id]
            return (
              <Group key={p.id} label={p.label}>
                <Row
                  title="Use for voice mode"
                  subtitle={row ? "The backend the composer's voice button connects to." : "Save a key first."}
                >
                  <Switch
                    checked={draft.isDefault}
                    disabled={!row && !draft.apiKey}
                    onCheckedChange={(on) => set(p.id, { isDefault: on })}
                    aria-label={`Use ${p.label} for voice mode`}
                  />
                </Row>
                <div className="grid gap-4 py-4 @panel-sm:grid-cols-2">
                  <Field label="API key" hint={row?.hasKey ? "Stored — leave empty to keep it." : p.keyHint}>
                    <Input
                      type="password"
                      autoComplete="off"
                      value={draft.apiKey}
                      onChange={(e) => set(p.id, { apiKey: e.target.value })}
                    />
                  </Field>
                  <Field label="Model" hint="A realtime model the provider serves.">
                    <Input
                      value={draft.model}
                      onChange={(e) => set(p.id, { model: e.target.value })}
                      placeholder={p.model}
                      className="font-mono text-xs"
                      required
                    />
                  </Field>
                  <Field label="Voice" hint="Empty uses the provider's default.">
                    <Input
                      value={draft.voice}
                      onChange={(e) => set(p.id, { voice: e.target.value })}
                      placeholder={p.voice}
                      className="font-mono text-xs"
                    />
                  </Field>
                </div>
                {row && (
                  <Row title="Remove this backend" subtitle="Deletes the stored key.">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={remove.isPending}
                      onClick={() =>
                        remove.mutate(p.id, {
                          onError: (err) => setSaveError(captureError(err, `Couldn't remove ${p.label}`)),
                        })
                      }
                    >
                      Remove
                    </Button>
                  </Row>
                )}
              </Group>
            )
          })}
          <FormActions busy={save.isPending} onCancel={reset} error={saveError} />
        </PageForm>
      )}
      <p className="px-1 text-xs text-pretty text-muted-foreground">
        Keys stay on the server. A voice call is given a short-lived token minted from the key, with its instructions
        and tools bound in. Realtime audio is billed per token by the provider; the mic pauses while the agent works,
        so its silence is not streamed.
      </p>
    </>
  )
}
